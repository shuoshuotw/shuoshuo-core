import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AmrEntry } from "@/lib/auth/caller";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/http/api-error";
import { singleton } from "@/lib/runtime/singleton";

export type VerifiedJwt = { userId: string; aal: string; sessionId: string; amr: AmrEntry[] };

const remoteJwks = () => singleton("jwks", () => createRemoteJWKSet(new URL(env().SUPABASE_JWKS_URL)));

export async function verifyJwt(
  token: string,
  jwks: JWTVerifyGetKey = remoteJwks(),
  issuer: string = env().SUPABASE_JWT_ISSUER,
): Promise<VerifiedJwt> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      // Pinned, so alg:none and HS256 signed with the public key are rejected (DT-1 #10)
      algorithms: ["ES256"],
      issuer,
      audience: "authenticated",
    });
    if (!payload.sub) throw new errors.JWTInvalid("missing sub");
    return {
      userId: payload.sub,
      aal: String(payload.aal ?? "aal1"),
      sessionId: String(payload.session_id ?? ""),
      amr: Array.isArray(payload.amr) ? (payload.amr as AmrEntry[]) : [],
    };
  } catch (cause) {
    if (cause instanceof errors.JWTExpired) throw new ApiError("TOKEN_EXPIRED", { cause });
    // An unreachable JWKS endpoint is our outage, not a bad token
    if (cause instanceof errors.JOSEError && !(cause instanceof errors.JWKSTimeout)) {
      throw new ApiError("TOKEN_INVALID", { cause });
    }
    throw new ApiError("SERVICE_UNAVAILABLE", { cause });
  }
}

const RECENT_AUTH_SECONDS = 600;

// §7.4: a refreshed token does not count as having just authenticated (SEC-09b)
export function hasRecentAuth(amr: AmrEntry[], now = Date.now()): boolean {
  const latest = Math.max(0, ...amr.filter((entry) => entry.method !== "token_refresh").map((entry) => entry.timestamp));
  return now / 1000 - latest <= RECENT_AUTH_SECONDS;
}
