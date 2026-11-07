import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as createKeyRoute } from "@/app/v1/me/api-keys/route";
import { POST as regenerateKeyRoute } from "@/app/v1/me/api-keys/[id]/regenerate/route";
import { hashKey, toBytea } from "@/lib/auth/api-key";
import type { components } from "@/openapi/types";
import { admin, call, createUser, type TestUser } from "./helpers";

type ApiKey = components["schemas"]["ApiKey"];
type SecretKey = components["schemas"]["ApiKeyWithSecret"];
type Reply = Awaited<ReturnType<typeof call>>;
const ROOT = "/v1/me/api-keys";
const ALL_SCOPES = ["quotes:read", "quotes:write", "reactions:write", "comments:write", "me:read"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const users: TestUser[] = [];

async function newUser() {
  const user = await createUser();
  users.push(user);
  return user;
}

function success<T>(response: Reply, status = 200): T {
  expect(response.status).toBe(status);
  const body = JSON.parse(response.raw);
  expect(Object.keys(body).sort()).toEqual(["data", "meta"]);
  expect(body.meta).toEqual({ request_id: response.headers.get("x-request-id") });
  expect(body.meta.request_id).toMatch(/^req_/);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("ratelimit-limit")).toMatch(/^\d+$/);
  return body.data as T;
}

function keyFields(key: ApiKey, withSecret = false) {
  expect(Object.keys(key).sort()).toEqual([
    "created_at", "expires_at", "id", "key_prefix", "last_used_at", "name", "regenerated_at", "scopes",
    ...(withSecret ? ["secret"] : []),
  ].sort());
  expect(key.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(key.key_prefix).toMatch(/^shuoshuo_test_[0-9A-Za-z]{8}$/);
  expect(key.created_at).toMatch(ISO);
  if (key.expires_at !== null) expect(key.expires_at).toMatch(ISO);
  if (key.last_used_at !== null) expect(key.last_used_at).toMatch(ISO);
  if (key.regenerated_at !== null) expect(key.regenerated_at).toMatch(ISO);
}

function failure(response: Reply, status: number, code: string) {
  expect([response.status, response.error?.code]).toEqual([status, code]);
  expect(JSON.parse(response.raw).error.request_id).toBe(response.headers.get("x-request-id"));
  expect(response.headers.get("cache-control")).toBe("no-store");
}

async function createKey(user: TestUser, body: unknown = { name: `金鑰${randomUUID()}` }) {
  const response = await call(ROOT, { method: "POST", token: user.token, body });
  const key = success<SecretKey>(response, 201);
  keyFields(key, true);
  // Assert a boolean so a failed assertion cannot print a full credential.
  expect(new RegExp(`^${key.key_prefix}_[0-9A-Za-z]{43}$`).test(key.secret)).toBe(true);
  return key;
}

function operations(id: string) {
  return [
    { method: "GET", path: ROOT },
    { method: "POST", path: ROOT, body: { name: `拒絕${randomUUID()}` } },
    { method: "GET", path: `${ROOT}/${id}` },
    { method: "DELETE", path: `${ROOT}/${id}` },
    { method: "POST", path: `${ROOT}/${id}/regenerate` },
  ];
}

describe("API key management (SEC-04 through SEC-08)", () => {
  beforeAll(() => {
    // Direct handler checks below use real Auth and RPCs while capturing their process's logs.
    process.loadEnvFile(".env.local");
  });

  afterAll(async () => {
    for (const user of users) {
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) throw error;
    }
  });

  it("creates, lists and reads the complete public fields without exposing stored credentials", async () => {
    const user = await newUser();
    const other = await newUser();
    const first = await createKey(user);
    const second = await createKey(user, { name: `完整${randomUUID()}`, scopes: ["me:read", "quotes:write", "me:read"] });
    await createKey(other);
    expect(first.scopes).toEqual(["quotes:read"]);
    expect(first.last_used_at).toBeNull();
    expect(first.regenerated_at).toBeNull();
    expect(second.scopes).toEqual(["quotes:read", "me:read", "quotes:write"]);

    const changed = await admin.from("api_keys").update({
      created_at: "2026-01-01T00:00:00.123456Z",
      last_used_at: "2026-01-02T00:00:00.234567Z",
      regenerated_at: "2026-01-03T00:00:00.345678Z",
    }).eq("id", first.id).eq("user_id", user.id);
    if (changed.error) throw changed.error;

    const list = success<ApiKey[]>(await call(`${ROOT}?ignored=1&limit=1`, { token: user.token }));
    expect(list.map((key) => key.id)).toEqual([second.id, first.id]);
    list.forEach((key) => keyFields(key));
    const { secret: _secret, ...publicSecond } = second;
    expect(list[0]).toEqual(publicSecond);
    const detail = success<ApiKey>(await call(`${ROOT}/${first.id}`, { token: user.token }));
    keyFields(detail);
    expect(detail).toEqual({
      id: first.id, name: first.name, key_prefix: first.key_prefix, scopes: ["quotes:read"], expires_at: first.expires_at,
      created_at: "2026-01-01T00:00:00.123Z", last_used_at: "2026-01-02T00:00:00.234Z",
      regenerated_at: "2026-01-03T00:00:00.345Z",
    });
    expect(list[1]).toEqual(detail);

    const stored = await admin.from("api_keys").select("*").eq("id", first.id).single();
    if (stored.error) throw stored.error;
    expect(stored.data.key_hash === toBytea(hashKey(first.secret))).toBe(true);
    expect(JSON.stringify(stored.data).includes(first.secret)).toBe(false);
    expect(stored.data).not.toHaveProperty("secret");
  });

  it("accepts name boundaries in Unicode code points and adds the mandatory scope to an empty array", async () => {
    const user = await newUser();
    for (const name of ["名", "名".repeat(50), "😀".repeat(50)]) {
      const key = await createKey(user, { name, scopes: [] });
      expect(key.name).toBe(name);
      expect(key.scopes).toEqual(["quotes:read"]);
    }
  });

  it("rejects invalid bodies, unknown fields and unsupported scopes before creating any keys", async () => {
    const user = await newUser();
    const bodies = [
      {}, null, [], { name: "" }, { name: "名".repeat(51) }, { name: "😀".repeat(51) }, { name: 42 },
      { name: "有效", scopes: ["admin"] }, { name: "有效", scopes: null }, { name: "有效", scopes: "quotes:read" },
      { name: "有效", scopes: [1] }, { name: "有效", secret: "unexpected" },
    ];
    for (const body of bodies) {
      const response = await call(ROOT, { method: "POST", token: user.token, body });
      failure(response, 400, "VALIDATION_FAILED");
      expect(JSON.parse(response.raw).error.details.fields.length).toBeGreaterThan(0);
    }
    expect(success<ApiKey[]>(await call(ROOT, { token: user.token }))).toEqual([]);
  });

  it("answers the input transport errors without creating keys", async () => {
    const user = await newUser();
    for (const [body, contentType, status, code] of [
      ["{", "application/json", 400, "INVALID_JSON"],
      ["{}", "text/plain", 415, "UNSUPPORTED_MEDIA_TYPE"],
      [JSON.stringify({ name: "名".repeat(6000) }), "application/json", 413, "PAYLOAD_TOO_LARGE"],
    ] as const) {
      const response = await fetch(`${process.env.CORE_URL ?? "http://localhost:5001"}${ROOT}`, {
        method: "POST", headers: { authorization: `Bearer ${user.token}`, "content-type": contentType,
          "cf-connecting-ip": `10.249.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}` }, body,
      });
      expect([response.status, (await response.json()).error.code]).toEqual([status, code]);
    }
    expect(success<ApiKey[]>(await call(ROOT, { token: user.token }))).toEqual([]);
  });

  it("SEC-04 hides other users' keys on reads, revocation and regeneration without changing them", async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const key = await createKey(owner);
    expect(success<ApiKey[]>(await call(ROOT, { token: stranger.token }))).toEqual([]);
    for (const { method, path } of operations(key.id).slice(2)) {
      failure(await call(path, { method, token: stranger.token }), 404, "API_KEY_NOT_FOUND");
    }
    const detail = success<ApiKey>(await call(`${ROOT}/${key.id}`, { token: owner.token }));
    const { secret: _secret, ...publicKey } = key;
    expect(detail).toEqual(publicKey);
    expect((await call("/v1/categories", { token: key.secret })).status).toBe(200);
  });

  it("uses API_KEY_NOT_FOUND for malformed and missing IDs on every item operation", async () => {
    const user = await newUser();
    for (const id of ["not-a-uuid", randomUUID()]) {
      for (const { method, path } of operations(id).slice(2)) {
        failure(await call(path, { method, token: user.token }), 404, "API_KEY_NOT_FOUND");
      }
    }
  });

  it("SEC-05 rejects anonymous callers and both minimal and fully scoped API keys on all five operations", async () => {
    const user = await newUser();
    const minimal = await createKey(user);
    const full = await createKey(user, { name: "全部權限", scopes: ALL_SCOPES });
    expect(full.scopes).toEqual(ALL_SCOPES);
    for (const { method, path, body } of operations(minimal.id)) {
      failure(await call(path, { method, body }), 401, "AUTHENTICATION_REQUIRED");
      for (const token of [minimal.secret, full.secret]) {
        failure(await call(path, { method, token, body }), 403, "API_KEY_NOT_ALLOWED");
      }
    }
    expect(success<ApiKey[]>(await call(ROOT, { token: user.token })).map((key) => key.id).sort())
      .toEqual([minimal.id, full.id].sort());
  });

  it("rejects banned users on all five operations and permits suspended users to manage keys", async () => {
    const user = await newUser();
    const key = await createKey(user);
    const banned = await admin.from("account_standing").update({ status: "banned" }).eq("user_id", user.id);
    if (banned.error) throw banned.error;
    for (const { method, path, body } of operations(key.id)) {
      failure(await call(path, { method, token: user.token, body }), 403, "ACCOUNT_BANNED");
    }
    const suspended = await admin.from("account_standing").update({
      status: "active", suspended_until: new Date(Date.now() + 3600_000).toISOString(),
    }).eq("user_id", user.id);
    if (suspended.error) throw suspended.error;
    expect(success<ApiKey[]>(await call(ROOT, { token: user.token }))).toHaveLength(1);
    keyFields(success<ApiKey>(await call(`${ROOT}/${key.id}`, { token: user.token })));
    await createKey(user);
    keyFields(success<SecretKey>(await call(`${ROOT}/${key.id}/regenerate`, { method: "POST", token: user.token })), true);
    expect((await call(`${ROOT}/${key.id}`, { method: "DELETE", token: user.token })).status).toBe(204);
  });

  it("SEC-07 regenerates in place, invalidates a cached old key within 15 seconds and revokes the replacement", { timeout: 40_000 }, async () => {
    const user = await newUser();
    const key = await createKey(user, { name: `輪替${randomUUID()}`, scopes: ALL_SCOPES });
    expect((await call("/v1/categories", { token: key.secret })).status).toBe(200);
    const warmedAt = Date.now();
    const regenerated = success<SecretKey>(await call(`${ROOT}/${key.id}/regenerate`, { method: "POST", token: user.token }));
    keyFields(regenerated, true);
    expect(regenerated.id).toBe(key.id);
    expect(regenerated.name).toBe(key.name);
    expect(regenerated.scopes).toEqual(key.scopes);
    expect(regenerated.created_at).toBe(key.created_at);
    expect(regenerated.regenerated_at).toMatch(ISO);
    expect(regenerated.secret === key.secret).toBe(false);
    expect(regenerated.key_prefix === key.key_prefix).toBe(false);
    expect(new RegExp(`^${regenerated.key_prefix}_[0-9A-Za-z]{43}$`).test(regenerated.secret)).toBe(true);
    const stored = await admin.from("api_keys").select("key_hash").eq("id", key.id).single();
    if (stored.error) throw stored.error;
    expect(stored.data.key_hash === toBytea(hashKey(regenerated.secret))).toBe(true);
    const { secret: _secret, ...publicKey } = regenerated;
    expect(success<ApiKey>(await call(`${ROOT}/${key.id}`, { token: user.token }))).toEqual(publicKey);

    // Sleep to the cache's original expiry, rather than accepting a delay beyond its 15s lifetime.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, warmedAt + 15_000 - Date.now())));
    failure(await call("/v1/categories", { token: key.secret }), 401, "API_KEY_INVALID");
    expect((await call("/v1/categories", { token: regenerated.secret })).status).toBe(200);
    const replacementWarmedAt = Date.now();
    const deleted = await call(`${ROOT}/${key.id}`, { method: "DELETE", token: user.token });
    expect(deleted.status).toBe(204);
    expect(deleted.raw).toBe("");
    expect(deleted.headers.get("cache-control")).toBe("no-store");
    const revoked = await admin.from("api_keys").select("revoked_at, revoked_reason").eq("id", key.id).single();
    if (revoked.error) throw revoked.error;
    expect(revoked.data.revoked_at).not.toBeNull();
    expect(revoked.data.revoked_reason).toBe("user");
    expect(success<ApiKey[]>(await call(ROOT, { token: user.token }))).toEqual([]);
    for (const { method, path } of operations(key.id).slice(2)) {
      failure(await call(path, { method, token: user.token }), 404, "API_KEY_NOT_FOUND");
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, replacementWarmedAt + 15_000 - Date.now())));
    failure(await call("/v1/categories", { token: regenerated.secret }), 401, "API_KEY_REVOKED");
  });

  it("SEC-08 serializes concurrent creation at exactly ten active keys and frees a slot on revocation", async () => {
    const user = await newUser();
    const keys = await Promise.all(Array.from({ length: 10 }, () => createKey(user)));
    expect(new Set(keys.map((key) => key.id)).size).toBe(10);
    const list = success<ApiKey[]>(await call(ROOT, { token: user.token }));
    expect(list.map((key) => key.id).sort()).toEqual(keys.map((key) => key.id).sort());
    const stored = await admin.from("api_keys").select("id").eq("user_id", user.id).is("revoked_at", null);
    if (stored.error) throw stored.error;
    expect(stored.data.map((key) => key.id).sort()).toEqual(keys.map((key) => key.id).sort());
    failure(await call(ROOT, { method: "POST", token: user.token, body: { name: "超額" } }), 409, "API_KEY_LIMIT_REACHED");
    expect((await call(`${ROOT}/${keys[0]!.id}`, { method: "DELETE", token: user.token })).status).toBe(204);
    const replacement = await createKey(user);
    expect(success<ApiKey[]>(await call(ROOT, { token: user.token })).map((key) => key.id).sort())
      .toEqual([...keys.slice(1).map((key) => key.id), replacement.id].sort());
  });

  it("enforces the shared create/delete action quota and the separate regeneration quota", async () => {
    const user = await newUser();
    const key = await createKey(user);
    expect((await call(`${ROOT}/${key.id}`, { method: "DELETE", token: user.token })).status).toBe(204);
    for (let i = 0; i < 18; i += 1) {
      failure(await call(`${ROOT}/${randomUUID()}`, { method: "DELETE", token: user.token }), 404, "API_KEY_NOT_FOUND");
    }
    const limited = await call(ROOT, { method: "POST", token: user.token, body: { name: "限額" } });
    failure(limited, 429, "RATE_LIMITED");
    expect(JSON.parse(limited.raw).error.details).toMatchObject({ scope: "api_key_write", limit: 20, window_seconds: 3600 });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    for (let i = 0; i < 10; i += 1) {
      failure(await call(`${ROOT}/${randomUUID()}/regenerate`, { method: "POST", token: user.token }), 404, "API_KEY_NOT_FOUND");
    }
    const regenLimited = await call(`${ROOT}/${randomUUID()}/regenerate`, { method: "POST", token: user.token });
    failure(regenLimited, 429, "RATE_LIMITED");
    expect(JSON.parse(regenLimited.raw).error.details).toMatchObject({ scope: "api_key_regenerate", limit: 10, window_seconds: 3600 });
  });

  it("SEC-06 keeps secrets out of live handler logs and audit metadata", async () => {
    const user = await newUser();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const request = (path: string, body?: unknown) => new Request(`http://localhost${path}`, {
        method: "POST", headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const created = await createKeyRoute(request(ROOT, { name: "日誌" }), { params: Promise.resolve({}) });
      expect(created.status).toBe(201);
      const key = (await created.json()).data as SecretKey;
      const regenerated = await regenerateKeyRoute(request(`${ROOT}/${key.id}/regenerate`), { params: Promise.resolve({ id: key.id }) });
      expect(regenerated.status).toBe(200);
      const replacement = (await regenerated.json()).data as SecretKey;
      const audit = await admin.from("audit_logs").select("action, metadata, request_id")
        .eq("actor_id", user.id).eq("target_id", key.id);
      if (audit.error) throw audit.error;
      expect(audit.data.map((entry) => entry.action).sort()).toEqual(["api_key.create", "api_key.regenerate"]);
      expect(audit.data.map((entry) => entry.request_id).sort()).toEqual([
        created.headers.get("x-request-id"), regenerated.headers.get("x-request-id"),
      ].sort());
      expect(log.mock.calls).toHaveLength(2);
      for (const secret of [key.secret, replacement.secret]) {
        expect(JSON.stringify(log.mock.calls).includes(secret)).toBe(false);
        expect(JSON.stringify(errorLog.mock.calls).includes(secret)).toBe(false);
        expect(JSON.stringify(audit.data).includes(secret)).toBe(false);
      }
      expect(errorLog.mock.calls).toHaveLength(0);
    } finally {
      log.mockRestore();
      errorLog.mockRestore();
    }
  });

  it("requires recent authentication for creation and regeneration with real Auth and RPCs", async () => {
    const user = await newUser();
    const key = await createKey(user);
    const claims = JSON.parse(Buffer.from(user.token.split(".")[1]!, "base64url").toString()) as {
      amr: { method: string; timestamp: number }[];
    };
    const authenticatedAt = claims.amr.find((entry) => entry.method === "password")?.timestamp;
    expect(authenticatedAt).toBeTypeOf("number");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((authenticatedAt! + 601) * 1000);
    try {
      for (const [handler, path, params, body] of [
        [createKeyRoute, ROOT, {} as Record<string, string>, { name: "過期驗證" }],
        [regenerateKeyRoute, `${ROOT}/${key.id}/regenerate`, { id: key.id }, undefined],
      ] as const) {
        const response = await handler(new Request(`http://localhost${path}`, {
          method: "POST", headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }), { params: Promise.resolve(params) });
        expect([response.status, (await response.json()).error.code]).toEqual([403, "REAUTH_REQUIRED"]);
      }
    } finally {
      vi.useRealTimers();
    }
    const { secret: _secret, ...publicKey } = key;
    expect(success<ApiKey>(await call(`${ROOT}/${key.id}`, { token: user.token }))).toEqual(publicKey);
    expect(success<ApiKey[]>(await call(ROOT, { token: user.token }))).toEqual([publicKey]);
  });

  it("§8.8.2 keys last 90 days unless asked, and one without an end date needs the account's leave", async () => {
    const user = await newUser();
    const before = Date.now();
    const days = (key: SecretKey) => (Date.parse(key.expires_at!) - before) / 86_400_000;
    expect(days(await createKey(user))).toBeCloseTo(90, 2);
    expect(days(await createKey(user, { name: `短${randomUUID()}`, expires_in_days: 30 }))).toBeCloseTo(30, 2);
    failure(await call(ROOT, { method: "POST", token: user.token, body: { name: "七天", expires_in_days: 7 } }), 400, "VALIDATION_FAILED");
    failure(await call(ROOT, { method: "POST", token: user.token, body: { name: "永久", expires_in_days: null } }), 403, "API_KEY_PERMANENT_DISABLED");
    expect((await call("/v1/me", { method: "PATCH", token: user.token, body: { allow_permanent_api_keys: true } })).status).toBe(200);
    const forever = await createKey(user, { name: `永久${randomUUID()}`, expires_in_days: null });
    expect(forever.expires_at).toBeNull();
    // Taking the leave back revokes every key that never expires, and only those
    expect((await call("/v1/me", { method: "PATCH", token: user.token, body: { allow_permanent_api_keys: false } })).status).toBe(200);
    const left = success<ApiKey[]>(await call(ROOT, { token: user.token }));
    expect(left.map((key) => key.id)).not.toContain(forever.id);
    expect(left).toHaveLength(2);
  });

  it("§8.8.2 refuses a key past its end date", { timeout: 40_000 }, async () => {
    const user = await newUser();
    const key = await createKey(user);
    expect((await call("/v1/categories", { token: key.secret })).status).toBe(200);
    const changed = await admin.from("api_keys").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", key.id);
    if (changed.error) throw changed.error;
    // The lookup is kept for up to 15 seconds (§7.5), as with a revocation
    await new Promise((resolve) => setTimeout(resolve, 15_500));
    failure(await call("/v1/categories", { token: key.secret }), 401, "API_KEY_EXPIRED");
  });
});
