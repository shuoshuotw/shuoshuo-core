import { beforeAll, describe, expect, it } from "vitest";
import { generateKey, toBytea } from "@/lib/auth/api-key";
import { admin, call, createUser, type TestUser } from "./helpers";

// TEST_PLAN DT-1 against the real stack
describe("caller resolution", () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createUser();
  });

  it("#4 anonymous is allowed on a public route", async () => {
    expect((await call("/v1/categories")).status).toBe(200);
  });

  it("#8 accepts a real Supabase JWT", async () => {
    expect((await call("/v1/categories", { token: user.token })).status).toBe(200);
  });

  it("#10 rejects a tampered JWT even on a public route", async () => {
    const tampered = `${user.token.slice(0, -4)}AAAA`;
    const response = await call("/v1/categories", { token: tampered });
    expect([response.status, response.error?.code]).toEqual([401, "TOKEN_INVALID"]);
  });

  it("#5 and #6 accept an active key, then answer API_KEY_REVOKED once its cache expires", { timeout: 30_000 }, async () => {
    const key = generateKey("test");
    const { data, error } = await admin
      .from("api_keys")
      .insert({ user_id: user.id, name: "test", key_prefix: key.prefix, key_hash: toBytea(key.hash), scopes: ["quotes:read"] })
      .select("id")
      .single();
    if (error) throw error;
    expect((await call("/v1/categories", { token: key.secret })).status).toBe(200);

    await admin.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", data.id);
    await new Promise((resolve) => setTimeout(resolve, 16_000));
    const response = await call("/v1/categories", { token: key.secret });
    expect([response.status, response.error?.code]).toEqual([401, "API_KEY_REVOKED"]);
  });

  it("#7 rejects an unknown but well-formed key", async () => {
    const response = await call("/v1/categories", { token: generateKey("test").secret });
    expect([response.status, response.error?.code]).toEqual([401, "API_KEY_INVALID"]);
  });

  it("AUTH-GUARD answers 429 after 20 failures from one IP", async () => {
    const ip = "10.250.250.250";
    for (let i = 0; i < 20; i += 1) await call("/v1/categories", { token: generateKey("test").secret, ip });
    const response = await call("/v1/categories", { token: generateKey("test").secret, ip });
    expect(response.status).toBe(429);
    expect(response.raw).toContain('"scope":"auth_guard"');
  });
});
