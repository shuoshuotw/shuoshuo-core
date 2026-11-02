import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import type { ApiKeyScope, Caller, IdentifiedCaller } from "@/lib/auth/caller";
import { hasRecentAuth } from "@/lib/auth/jwt";
import { resolveCaller } from "@/lib/auth/resolve-caller";
import { env } from "@/lib/env";
import { ApiError, type ErrorCode } from "@/lib/http/api-error";
import { type ActionQuota, enforceRateLimit, type RateClass } from "@/lib/ratelimit";
import { db } from "@/lib/supabase";

const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CACHE_CONTROL = {
  "C-NONE": "no-store",
  "C-5": "public, s-maxage=5",
  "C-30": "public, s-maxage=30, stale-while-revalidate=60",
  "C-DAY": "public, s-maxage=86400, stale-while-revalidate=604800",
} as const;

export type AuthMode = "public" | "user_or_key" | "user" | "admin" | "internal" | "listing";

export type RouteConfig<Query, Body> = {
  /** §4.5 and the operation's `x-auth` in openapi.yaml */
  auth: AuthMode;
  /** The scope an API Key needs on `user_or_key` routes */
  scope?: ApiKeyScope;
  /** null only for /v1/health* */
  rate: RateClass | null;
  action?: ActionQuota;
  cache?: keyof typeof CACHE_CONTROL;
  /** online: confirm the session with Auth. recent: also require authentication within 10 minutes (§7.4). */
  session?: "online" | "recent";
  /** Answer ACCOUNT_BANNED before the handler; for §8.8 reads, which have no RPC to do it */
  rejectBanned?: boolean;
  /** The error for a non-UUID {id} (§8.1) */
  idNotFound?: ErrorCode;
  query?: z.ZodType<Query>;
  body?: z.ZodType<Body>;
};

export type RouteContext<Query, Body> = {
  request: Request;
  requestId: string;
  caller: Caller;
  params: Record<string, string>;
  query: Query;
  body: Body;
};

export type AuthedContext<Query, Body> = Omit<RouteContext<Query, Body>, "caller"> & { caller: IdentifiedCaller };

type Handler<Query, Body> = (context: RouteContext<Query, Body>) => Promise<Response> | Response;
type NextHandler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

function newRequestId() {
  return `req_${randomBytes(12).toString("base64url")}`;
}

// §10.7
function corsHeaders(request: Request): Record<string, string> {
  const { pathname } = new URL(request.url);
  const firstParty = pathname === "/v1/me" || pathname.startsWith("/v1/me/") || pathname.startsWith("/v1/admin/");
  let origin = "*";
  if (firstParty) {
    const allowed = env().CORS_ALLOWED_ORIGINS.split(",");
    const asked = request.headers.get("origin");
    origin = asked && allowed.includes(asked) ? asked : (allowed[0] as string);
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "X-Request-Id, X-Quote-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After",
    "Access-Control-Max-Age": "86400",
    ...(firstParty ? { Vary: "Origin" } : {}),
  };
}

function authorize(caller: Caller, config: { auth: AuthMode; scope?: ApiKeyScope }) {
  switch (config.auth) {
    case "public":
      return;
    case "internal":
      // Hidden from everyone else: not even the endpoint's existence is revealed (§8.10.3)
      if (!caller.internal) throw new ApiError("ROUTE_NOT_FOUND");
      return;
    case "listing":
      if (caller.type === "anonymous" && !caller.internal) throw new ApiError("AUTHENTICATION_REQUIRED");
      return;
    case "user_or_key":
      if (caller.type === "anonymous") throw new ApiError("AUTHENTICATION_REQUIRED");
      if (caller.type === "api_key" && config.scope && !caller.scopes.includes(config.scope)) {
        throw new ApiError("INSUFFICIENT_SCOPE", { details: { required_scope: config.scope } });
      }
      return;
    case "user":
    case "admin":
      if (caller.type === "anonymous") throw new ApiError("AUTHENTICATION_REQUIRED");
      if (caller.type === "api_key") throw new ApiError("API_KEY_NOT_ALLOWED");
      return;
  }
}

async function checkRole(caller: Caller) {
  if (caller.type !== "user") throw new ApiError("AUTHENTICATION_REQUIRED");
  const { data, error } = await db().from("user_roles").select("role").eq("user_id", caller.userId).eq("role", "admin");
  if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
  if (!data.length) throw new ApiError("FORBIDDEN_ROLE");
}

async function checkSession(caller: Caller, mode: "online" | "recent") {
  if (caller.type !== "user") throw new ApiError("API_KEY_NOT_ALLOWED");
  const { error } = await db().auth.getUser(caller.token);
  if (error) throw new ApiError("TOKEN_INVALID", { cause: error });
  if (mode === "recent" && !hasRecentAuth(caller.amr)) throw new ApiError("REAUTH_REQUIRED");
}

async function checkNotBanned(caller: Caller) {
  if (caller.type === "anonymous") return;
  const { data, error } = await db().from("account_standing").select("status").eq("user_id", caller.userId).maybeSingle();
  if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
  if (!data) throw new ApiError("TOKEN_INVALID");
  if (data.status === "banned") throw new ApiError("ACCOUNT_BANNED");
}

const MESSAGES: Record<string, (issue: z.core.$ZodIssue) => [string, string]> = {
  too_big: (issue) => {
    const max = (issue as z.core.$ZodIssueTooBig).maximum;
    return [`不可大於 ${max}`, `Must be at most ${max}`];
  },
  too_small: (issue) => {
    const min = (issue as z.core.$ZodIssueTooSmall).minimum;
    return [`不可小於 ${min}`, `Must be at least ${min}`];
  },
  invalid_type: () => ["型別不符", "Invalid type"],
  invalid_format: () => ["格式不符", "Invalid format"],
  invalid_value: () => ["值不在允許範圍", "Value is not allowed"],
  unrecognized_keys: () => ["包含未知欄位", "Contains unknown fields"],
};

export function validationError(error: z.ZodError): ApiError {
  return new ApiError("VALIDATION_FAILED", {
    details: {
      fields: error.issues.map((issue) => {
        const [message, message_en] = MESSAGES[issue.code]?.(issue) ?? [issue.message, issue.message];
        return { field: issue.path.join("."), code: issue.code, message, message_en };
      }),
    },
  });
}

async function readBody<Body>(request: Request, schema: z.ZodType<Body>): Promise<Body> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE");
  }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) throw new ApiError("PAYLOAD_TOO_LARGE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch (cause) {
    throw new ApiError("INVALID_JSON", { cause });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function readQuery<Query>(request: Request, schema: z.ZodType<Query>): Query {
  const result = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function hashIp(ip: string) {
  // Salted per day so logs cannot follow one address across days (§10.8)
  return createHash("sha256").update(`${new Date().toISOString().slice(0, 10)}:${ip}`).digest("hex").slice(0, 16);
}

function logRequest(entry: { request: Request; requestId: string; status: number; started: number; caller?: Caller }) {
  const { request, requestId, status, started, caller } = entry;
  console.log(JSON.stringify({
    request_id: requestId,
    route: `${request.method} ${new URL(request.url).pathname}`,
    status,
    duration_ms: Date.now() - started,
    caller_type: caller?.type,
    key_id: caller?.type === "api_key" ? caller.keyId : undefined,
    user_id: caller && caller.type !== "anonymous" ? caller.userId : undefined,
    ip_hash: caller ? hashIp(caller.ip) : undefined,
  }));
}

export function errorResponse(error: unknown, request: Request, requestId: string, cache: keyof typeof CACHE_CONTROL = "C-NONE") {
  const apiError = error instanceof ApiError ? error : new ApiError("INTERNAL_ERROR", { cause: error });
  if (apiError.status >= 500) {
    console.error(JSON.stringify({ request_id: requestId, code: apiError.code, cause: String(apiError.cause ?? "") }));
  }
  // §8.1: only 404 and 410 share the route's CDN caching. A cached 429 or 5xx would hit everyone.
  const cacheable = apiError.status === 404 || apiError.status === 410;
  return Response.json(apiError.body(requestId), {
    status: apiError.status,
    headers: {
      ...corsHeaders(request),
      "X-Request-Id": requestId,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": cacheable ? CACHE_CONTROL[cache] : "no-store",
      ...apiError.headers,
    },
  });
}

export function withRoute<Query = undefined, Body = undefined>(
  config: RouteConfig<Query, Body>,
  handler: Handler<Query, Body>,
): NextHandler {
  const cache = config.cache ?? "C-NONE";
  return async (request, context) => {
    const requestId = newRequestId();
    const started = Date.now();
    let caller: Caller | undefined;
    let response: Response;
    try {
      caller = await resolveCaller(request);
      authorize(caller, config);
      const rateHeaders = config.rate ? await enforceRateLimit(caller, config.rate, config.action) : {};
      if (config.auth === "admin") await checkRole(caller);
      if (config.session) await checkSession(caller, config.session);
      if (config.rejectBanned) await checkNotBanned(caller);

      const params = await context.params;
      if (config.idNotFound && params.id !== undefined && !UUID.test(params.id)) throw new ApiError(config.idNotFound);

      const query = config.query ? readQuery(request, config.query) : (undefined as Query);
      const body = config.body ? await readBody(request, config.body) : (undefined as Body);

      const result = await handler({ request, requestId, caller, params, query, body });
      const headers = new Headers(result.headers);
      for (const [name, value] of Object.entries(corsHeaders(request))) headers.set(name, value);
      headers.set("X-Request-Id", requestId);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Cache-Control", CACHE_CONTROL[cache]);
      // §8.1: a CDN-cached response must not carry one caller's quota
      if (cache === "C-NONE") for (const [name, value] of Object.entries(rateHeaders)) headers.set(name, value);
      response = new Response(result.body, { status: result.status, headers });
    } catch (error) {
      response = errorResponse(error, request, requestId, cache);
    }
    logRequest({ request, requestId, status: response.status, started, caller });
    return response;
  };
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];

function methodNotAllowed(allowed: string): NextHandler {
  return async (request) => {
    const error = new ApiError("METHOD_NOT_ALLOWED", { headers: { Allow: allowed } });
    return errorResponse(error, request, newRequestId());
  };
}

/**
 * Every route file: `export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({ GET: withRoute(...) });`
 * Next would answer an unexported method with an empty 405; §8.1 requires the JSON error envelope.
 */
export function route(handlers: Partial<Record<Method, NextHandler>>): Record<Method | "OPTIONS", NextHandler> {
  const allowed = [...Object.keys(handlers), "OPTIONS"].join(", ");
  const fallback = methodNotAllowed(allowed);
  const all = Object.fromEntries(METHODS.map((method) => [method, handlers[method] ?? fallback])) as Record<Method, NextHandler>;
  return {
    ...all,
    OPTIONS: async (request) => new Response(null, { status: 204, headers: { ...corsHeaders(request), Allow: allowed } }),
  };
}

export function json(data: unknown, requestId: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return Response.json({ data, meta: { request_id: requestId } }, init);
}

export function jsonList(
  items: unknown[],
  pagination: { limit: number; next_cursor: string | null; has_more: boolean },
  requestId: string,
) {
  return Response.json({ data: items, meta: { request_id: requestId, pagination } });
}

export function text(content: string, headers: Record<string, string> = {}) {
  return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

export function noContent() {
  return new Response(null, { status: 204 });
}

/** For handlers on `user_or_key`, `user` and `admin` routes, where `withRoute` has already rejected anonymous callers */
export function identified(caller: Caller): IdentifiedCaller {
  if (caller.type === "anonymous") throw new ApiError("AUTHENTICATION_REQUIRED");
  return caller;
}
