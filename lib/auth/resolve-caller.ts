import { cachedKey, hashKey, isValidKeyFormat, lookupKey, touchLastUsed } from "@/lib/auth/api-key";
import type { Caller } from "@/lib/auth/caller";
import { verifyInternalHeader } from "@/lib/auth/internal-hmac";
import { verifyJwt } from "@/lib/auth/jwt";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/http/api-error";
import { clientIp, guardCredentialLookup, recordCredentialFailure } from "@/lib/ratelimit";

const CREDENTIAL_PARAMS = ["api_key", "apikey", "token", "access_token"];

// §4.2. An invalid credential is always a 401, never a downgrade to anonymous, even on public routes.
export async function resolveCaller(request: Request): Promise<Caller> {
  const url = new URL(request.url);
  if (CREDENTIAL_PARAMS.some((name) => url.searchParams.has(name))) {
    throw new ApiError("CREDENTIAL_IN_QUERY");
  }

  const ip = clientIp(request.headers);
  const base = { ip, internal: false };

  const internalHeader = request.headers.get("x-shuoshuo-internal");
  if (internalHeader !== null) {
    const secrets = env().INTERNAL_HMAC_SECRETS.split(",");
    if (!verifyInternalHeader(internalHeader, request.method, url.pathname + url.search, secrets)) {
      throw new ApiError("INTERNAL_AUTH_INVALID");
    }
    base.internal = true;
  }

  const authorization = request.headers.get("authorization");
  if (authorization === null) return { ...base, type: "anonymous" };

  const token = /^Bearer (.+)$/.exec(authorization)?.[1];
  if (!token) throw new ApiError("TOKEN_INVALID");

  return token.startsWith("shuoshuo_") ? await fromApiKey(token, base) : await fromJwt(token, base);
}

async function fromApiKey(key: string, base: { ip: string; internal: boolean }): Promise<Caller> {
  if (!isValidKeyFormat(key)) throw new ApiError("API_KEY_INVALID");

  const hash = hashKey(key);
  let found = cachedKey(hash);
  if (found === undefined) {
    await guardCredentialLookup(base.ip);
    found = await lookupKey(hash);
  }
  if (found === "invalid" || found === "revoked") {
    await recordCredentialFailure(base.ip);
    throw new ApiError(found === "invalid" ? "API_KEY_INVALID" : "API_KEY_REVOKED");
  }
  touchLastUsed(found.keyId);
  return { ...base, type: "api_key", ...found };
}

async function fromJwt(token: string, base: { ip: string; internal: boolean }): Promise<Caller> {
  await guardCredentialLookup(base.ip);
  try {
    return { ...base, type: "user", token, ...(await verifyJwt(token)) };
  } catch (error) {
    if (error instanceof ApiError && error.code !== "SERVICE_UNAVAILABLE") await recordCredentialFailure(base.ip);
    throw error;
  }
}
