import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, encodeCursor, iso, olderThan, pageOf } from "@/lib/http/pagination";
import { json, route, withRoute } from "@/lib/http/with-route";
import { clientIp, enforceAction, enforceRateLimit } from "@/lib/ratelimit";
import { toStanding } from "@/lib/standing";

vi.mock("@/lib/env", () => ({
  env: () => ({
    API_KEY_ENV: "test",
    CORS_ALLOWED_ORIGINS: "https://shuoshuotw.xyz",
    INTERNAL_HMAC_SECRETS: "s",
  }),
}));
vi.mock("@/lib/supabase", () => ({ db: () => ({}) }));

const context = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });
const request = (path: string, init?: RequestInit) => new Request(`https://api.test${path}`, init);
vi.spyOn(console, "log").mockImplementation(() => {});

describe("ApiError", () => {
  it("builds the §8.1 envelope", () => {
    expect(new ApiError("QUOTE_NOT_FOUND").body("req_1")).toEqual({
      error: {
        code: "QUOTE_NOT_FOUND",
        status: 404,
        message: "找不到這則說說",
        message_en: "Quote not found",
        docs_url: "https://docs.shuoshuotw.xyz/errors#QUOTE_NOT_FOUND",
        request_id: "req_1",
      },
    });
  });

  it("uses an endpoint's wording without changing the code", () => {
    const body = new ApiError("NOT_RESOURCE_OWNER", { variant: "pin" }).body("r").error;
    expect(body).toMatchObject({ code: "NOT_RESOURCE_OWNER", message: "只有說說提交者可置頂" });
  });
});

describe("pagination", () => {
  const id = "00000000-0000-4000-8000-000000000001";

  it("round-trips a cursor and keeps microseconds", () => {
    const key = { c: "2026-11-01T09:30:00.123456+00:00", i: id };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
  });

  it("treats no cursor as the first page", () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it.each([
    "garbage",
    Buffer.from("{}").toString("base64url"),
    Buffer.from('{"c":"x","i":"no"}').toString("base64url"),
    encodeCursor({ c: "2026-11-01T09:30:00Z,status.eq.deleted", i: id }),
    encodeCursor({ c: "2026-13-45T09:30:00Z", i: id }),
  ])(
    "rejects %s with INVALID_CURSOR",
    (cursor) => {
      expect(() => decodeCursor(cursor)).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
    },
  );

  it("reports has_more only with an extra row", () => {
    const rows = [1, 2, 3].map((n) => ({ created_at: `2026-11-01T09:30:0${n}Z`, id }));
    const page = pageOf(rows, 2, (r) => ({ c: r.created_at, i: r.id }));
    expect(page.items).toHaveLength(2);
    expect(page.pagination.has_more).toBe(true);
    expect(decodeCursor(page.pagination.next_cursor as string)).toEqual({ c: "2026-11-01T09:30:02Z", i: id });
    expect(pageOf(rows, 3, (r) => ({ c: r.created_at, i: r.id })).pagination).toEqual({ limit: 3, next_cursor: null, has_more: false });
  });

  it("builds a keyset filter", () => {
    expect(olderThan({ c: "T", i: id })).toBe(`created_at.lt.T,and(created_at.eq.T,id.lt.${id})`);
    expect(olderThan({ c: "T", i: id }, "created_at", "quote_id")).toBe(`created_at.lt.T,and(created_at.eq.T,quote_id.lt.${id})`);
  });

  it("formats time as §8.1 requires", () => {
    expect(iso("2026-11-01T09:30:00.123456+00:00")).toBe("2026-11-01T09:30:00.123Z");
    expect(iso(null)).toBeNull();
  });
});

describe("clientIp (§10.4)", () => {
  const ip = (value?: string) => clientIp(new Headers(value ? { "cf-connecting-ip": value } : {}));

  it("uses CF-Connecting-IP only", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6" }))).toBe("unknown");
  });

  it("groups IPv6 by /64", () => {
    expect(ip("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ip("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ip("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });
});

describe("rate limits (§8.2.3)", () => {
  const anon = (address: string) => ({ type: "anonymous" as const, internal: false, ip: address });

  it("limits anonymous callers to 60 per minute per IP", async () => {
    for (let i = 0; i < 60; i += 1) await enforceRateLimit(anon("9.9.9.1"), "RL-PUBLIC");
    await expect(enforceRateLimit(anon("9.9.9.1"), "RL-PUBLIC")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { scope: "anonymous", limit: 60, window_seconds: 60 },
    });
    await expect(enforceRateLimit(anon("9.9.9.2"), "RL-PUBLIC")).resolves.toMatchObject({ "RateLimit-Limit": "60" });
  });

  it("reports the tightest of several limits", async () => {
    const user = { type: "user" as const, userId: "u-action", internal: false, ip: "1.1.1.1", aal: "aal1", sessionId: "s", amr: [], token: "t" };
    const headers = await enforceRateLimit(user, "RL-WRITE", "account_delete");
    expect(headers).toMatchObject({ "RateLimit-Limit": "3", "RateLimit-Remaining": "2" });
  });

  it("names the action when its quota runs out", async () => {
    const user = { type: "user" as const, userId: "u-action-2", internal: false, ip: "1.1.1.1", aal: "aal1", sessionId: "s", amr: [], token: "t" };
    for (let i = 0; i < 3; i += 1) await enforceRateLimit(user, "RL-WRITE", "account_delete");
    await expect(enforceRateLimit(user, "RL-WRITE", "account_delete")).rejects.toMatchObject({ details: { scope: "account_delete", window_seconds: 3600 } });
  });
});

describe("enforceAction", () => {
  it("limits renames to 5 per hour", async () => {
    for (let i = 0; i < 5; i += 1) await enforceAction("u-rename", "username_change");
    await expect(enforceAction("u-rename", "username_change")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { scope: "username_change", limit: 5, window_seconds: 3600 },
    });
  });
});

describe("toStanding (§9.5)", () => {
  const now = Date.parse("2026-11-02T00:00:00Z");

  it("computes suspended from suspended_until", () => {
    expect(toStanding({ status: "active", suspended_until: "2026-11-03T00:00:00Z", strike_count: 1 }, now)).toEqual({
      status: "suspended",
      suspended_until: "2026-11-03T00:00:00.000Z",
      strike_count: 1,
      strike_limit: 4,
      can_submit: false,
      can_comment: false,
    });
  });

  it("treats an expired suspension as active", () => {
    expect(toStanding({ status: "active", suspended_until: "2026-11-01T00:00:00Z", strike_count: 1 }, now)).toMatchObject({ status: "active", can_submit: true });
  });

  it("lets banned win over a suspension", () => {
    expect(toStanding({ status: "banned", suspended_until: "2026-11-03T00:00:00Z", strike_count: 4 }, now)).toMatchObject({ status: "banned", can_comment: false });
  });
});

describe("withRoute", () => {
  const ok = withRoute({ auth: "public", rate: null }, ({ requestId }) => json({ ok: true }, requestId));

  it("adds the §8.1 headers", async () => {
    const response = await ok(request("/v1/x"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/^req_/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("declares the charset on error responses (§8.1)", async () => {
    const response = await ok(request("/v1/x?api_key=secret"), context());
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it.each(["api_key", "apikey", "token", "access_token"])("rejects %s in the query string", async (name) => {
    const response = await ok(request(`/v1/x?${name}=secret`), context());
    expect((await response.json()).error.code).toBe("CREDENTIAL_IN_QUERY");
  });

  it("answers 401 for a bad internal header rather than downgrading to anonymous", async () => {
    const response = await ok(request("/v1/x", { headers: { "x-shuoshuo-internal": "v1.1.bad" } }), context());
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("INTERNAL_AUTH_INVALID");
  });

  it("answers 401 for a malformed API key on a public route", async () => {
    const response = await ok(request("/v1/x", { headers: { authorization: "Bearer shuoshuo_live_bad" } }), context());
    expect((await response.json()).error.code).toBe("API_KEY_INVALID");
  });

  it.each([
    ["user_or_key", "AUTHENTICATION_REQUIRED"],
    ["user", "AUTHENTICATION_REQUIRED"],
    ["admin", "AUTHENTICATION_REQUIRED"],
    ["listing", "AUTHENTICATION_REQUIRED"],
    ["internal", "ROUTE_NOT_FOUND"],
  ] as const)("rejects an anonymous caller on %s", async (auth, code) => {
    const handler = withRoute({ auth, rate: null }, () => new Response("reached"));
    expect((await (await handler(request("/v1/x"), context())).json()).error.code).toBe(code);
  });

  it("answers a non-UUID id with the resource's 404", async () => {
    const handler = withRoute({ auth: "public", rate: null, idNotFound: "QUOTE_NOT_FOUND" }, () => new Response("reached"));
    const response = await handler(request("/v1/quotes/not-a-uuid"), context({ id: "not-a-uuid" }));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("QUOTE_NOT_FOUND");
  });

  it("caches 404 with the route but never 5xx (§8.1)", async () => {
    const notFound = withRoute({ auth: "public", rate: null, cache: "C-30" }, () => {
      throw new ApiError("QUOTE_NOT_FOUND");
    });
    expect((await notFound(request("/v1/x"), context())).headers.get("cache-control")).toContain("s-maxage=30");
    const broken = withRoute({ auth: "public", rate: null, cache: "C-30" }, () => {
      throw new Error("boom");
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await broken(request("/v1/x"), context());
    errorLog.mockRestore();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
  });

  it("omits rate headers on CDN-cached responses", async () => {
    const handler = withRoute({ auth: "public", rate: "RL-PUBLIC", cache: "C-30" }, ({ requestId }) => json({}, requestId));
    const response = await handler(request("/v1/x", { headers: { "cf-connecting-ip": "8.8.4.4" } }), context());
    expect(response.headers.get("ratelimit-limit")).toBeNull();
  });

  describe("input", () => {
    const body = z.strictObject({ name: z.string().max(3) });
    const handler = withRoute({ auth: "public", rate: null, body }, ({ requestId, body: value }) => json(value, requestId));
    const post = (payload: string, type = "application/json") =>
      handler(request("/v1/x", { method: "POST", body: payload, headers: { "content-type": type } }), context());

    it("accepts a valid body", async () => {
      expect((await (await post('{"name":"ab"}')).json()).data).toEqual({ name: "ab" });
    });

    it("rejects other content types with 415", async () => {
      expect((await post('{"name":"ab"}', "text/plain")).status).toBe(415);
    });

    it("rejects invalid JSON", async () => {
      expect((await (await post("{")).json()).error.code).toBe("INVALID_JSON");
    });

    it("rejects bodies over 16 KB", async () => {
      expect((await post(JSON.stringify({ name: "x".repeat(17 * 1024) }))).status).toBe(413);
    });

    it("rejects unknown fields (§8.1)", async () => {
      const error = (await (await post('{"name":"ab","extra":1}')).json()).error;
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.details.fields[0].code).toBe("unrecognized_keys");
    });

    it("explains a failed field in both languages", async () => {
      const field = (await (await post('{"name":"abcd"}')).json()).error.details.fields[0];
      expect(field).toEqual({ field: "name", code: "too_big", message: "不可大於 3", message_en: "Must be at most 3" });
    });

    it("ignores unknown query parameters (§8.1)", async () => {
      const q = z.object({ limit: z.coerce.number().default(20) });
      const reader = withRoute({ auth: "public", rate: null, query: q }, ({ requestId, query }) => json(query, requestId));
      expect((await (await reader(request("/v1/x?_=123&limit=5"), context())).json()).data).toEqual({ limit: 5 });
    });
  });
});

describe("route", () => {
  const handlers = route({ GET: withRoute({ auth: "public", rate: null }, ({ requestId }) => json({}, requestId)) });

  it("answers an unexported method with the JSON envelope", async () => {
    const response = await handlers.DELETE(request("/v1/x", { method: "DELETE" }), context());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, OPTIONS");
    expect((await response.json()).error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("restricts /v1/me and /v1/admin to the site origin (§10.7)", async () => {
    for (const path of ["/v1/me", "/v1/me/api-keys", "/v1/admin/cases"]) {
      const response = await handlers.OPTIONS(request(path, { headers: { origin: "https://evil.example" } }), context());
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://shuoshuotw.xyz");
    }
    const open = await handlers.OPTIONS(request("/v1/quotes"), context());
    expect(open.headers.get("access-control-allow-origin")).toBe("*");
    expect(open.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
