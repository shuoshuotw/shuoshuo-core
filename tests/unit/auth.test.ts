import { createHmac } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { generateKey, hashKey, isValidKeyFormat } from "@/lib/auth/api-key";
import { verifyInternalHeader } from "@/lib/auth/internal-hmac";
import { hasRecentAuth, verifyJwt } from "@/lib/auth/jwt";
import { ApiError } from "@/lib/http/api-error";

const ISSUER = "https://test.supabase.co/auth/v1";

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof ApiError ? error.code : `unexpected: ${String(error)}`;
  }
}

describe("verifyJwt (DT-1 #8 to #10)", () => {
  let privateKey: CryptoKey;
  let jwks: ReturnType<typeof createLocalJWKSet>;

  const token = (claims: Record<string, unknown> = {}, options: { exp?: string; issuer?: string; audience?: string } = {}) =>
    new SignJWT({ aal: "aal1", session_id: "s1", amr: [{ method: "oauth", timestamp: 1 }], ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setSubject("00000000-0000-4000-a000-000000000002")
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? "authenticated")
      .setExpirationTime(options.exp ?? "15m")
      .sign(privateKey);

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
    jwks = createLocalJWKSet({ keys: [jwk] });
  });

  it("accepts a valid token and returns its identity", async () => {
    const result = await verifyJwt(await token(), jwks, ISSUER);
    expect(result).toMatchObject({ userId: "00000000-0000-4000-a000-000000000002", aal: "aal1", sessionId: "s1" });
  });

  it("answers TOKEN_EXPIRED for an expired token", async () => {
    expect(await codeOf(verifyJwt(await token({}, { exp: "-1m" }), jwks, ISSUER))).toBe("TOKEN_EXPIRED");
  });

  it("answers TOKEN_INVALID for the wrong issuer, audience, or a bad signature", async () => {
    expect(await codeOf(verifyJwt(await token({}, { issuer: "https://other.supabase.co/auth/v1" }), jwks, ISSUER))).toBe("TOKEN_INVALID");
    expect(await codeOf(verifyJwt(await token({}, { audience: "anon" }), jwks, ISSUER))).toBe("TOKEN_INVALID");
    const other = await generateKeyPair("ES256");
    const forged = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k1" }).setSubject("x").setIssuer(ISSUER).setAudience("authenticated").setExpirationTime("15m").sign(other.privateKey);
    expect(await codeOf(verifyJwt(forged, jwks, ISSUER))).toBe("TOKEN_INVALID");
  });

  it("answers TOKEN_INVALID for alg:none", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const none = `${encode({ alg: "none" })}.${encode({ sub: "x", iss: ISSUER, aud: "authenticated", exp: 9999999999 })}.`;
    expect(await codeOf(verifyJwt(none, jwks, ISSUER))).toBe("TOKEN_INVALID");
  });
});

describe("hasRecentAuth (SEC-09b)", () => {
  const now = 1_800_000_000_000;
  const seconds = now / 1000;

  it("accepts authentication within 10 minutes", () => {
    expect(hasRecentAuth([{ method: "oauth", timestamp: seconds - 599 }], now)).toBe(true);
  });

  it("rejects older authentication", () => {
    expect(hasRecentAuth([{ method: "oauth", timestamp: seconds - 601 }], now)).toBe(false);
  });

  it("does not count token_refresh", () => {
    expect(hasRecentAuth([{ method: "oauth", timestamp: seconds - 3600 }, { method: "token_refresh", timestamp: seconds }], now)).toBe(false);
  });

  it("rejects an empty amr", () => {
    expect(hasRecentAuth([], now)).toBe(false);
  });
});

describe("internal HMAC (SEC-20)", () => {
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const sign = (secret: string, method = "GET", path = "/v1/quotes?limit=1", at = ts) =>
    `v1.${at}.${createHmac("sha256", secret).update(`${at}.${method}.${path}`).digest("hex")}`;

  it("accepts a valid signature, and any secret during rotation", () => {
    expect(verifyInternalHeader(sign("old"), "GET", "/v1/quotes?limit=1", ["new", "old"], now)).toBe(true);
  });

  it("rejects a changed method, query, or secret", () => {
    expect(verifyInternalHeader(sign("s"), "POST", "/v1/quotes?limit=1", ["s"], now)).toBe(false);
    expect(verifyInternalHeader(sign("s"), "GET", "/v1/quotes?limit=2", ["s"], now)).toBe(false);
    expect(verifyInternalHeader(sign("x"), "GET", "/v1/quotes?limit=1", ["s"], now)).toBe(false);
  });

  it("rejects timestamps outside 60 seconds, in both directions", () => {
    const old = String(now / 1000 - 61);
    const future = String(now / 1000 + 61);
    expect(verifyInternalHeader(sign("s", "GET", "/p", old), "GET", "/p", ["s"], now)).toBe(false);
    expect(verifyInternalHeader(sign("s", "GET", "/p", future), "GET", "/p", ["s"], now)).toBe(false);
  });

  it("rejects malformed headers", () => {
    for (const header of ["", "v1", "v1.abc.def", "v2.1.2", `${sign("s")}.extra`]) {
      expect(verifyInternalHeader(header, "GET", "/v1/quotes?limit=1", ["s"], now)).toBe(false);
    }
  });
});

describe("API key format (§7.5)", () => {
  it("generates keys of the documented shape", () => {
    const { secret, prefix, hash } = generateKey("live");
    expect(secret).toMatch(/^shuoshuo_live_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}$/);
    expect(secret.startsWith(`${prefix}_`)).toBe(true);
    expect(hash.equals(hashKey(secret))).toBe(true);
  });

  it("never repeats", () => {
    expect(generateKey("live").secret).not.toBe(generateKey("live").secret);
  });

  it("rejects a key from another environment and malformed keys", () => {
    const { secret } = generateKey("test");
    expect(isValidKeyFormat(secret, "test")).toBe(true);
    expect(isValidKeyFormat(secret, "live")).toBe(false);
    expect(isValidKeyFormat("shuoshuo_live_short_short", "live")).toBe(false);
  });
});
