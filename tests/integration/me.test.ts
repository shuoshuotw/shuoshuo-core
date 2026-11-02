import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { PATCH } from "@/app/v1/me/route";
import { generateKey, toBytea } from "@/lib/auth/api-key";
import type { Database } from "@/lib/database.types";
import { contentHash } from "@/lib/quotes/normalize";
import { draw, resetPool } from "@/lib/quotes/pool";
import { admin, call, createUser, SEED, type TestUser } from "./helpers";

type Functions = Database["private"]["Functions"];
type Reply = Awaited<ReturnType<typeof call>>;
const users: string[] = [];
const quotes: string[] = [];
const cases: string[] = [];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const readPaths = ["/v1/me", "/v1/me/quotes", "/v1/me/favorites", "/v1/me/likes", `/v1/me/quote-states?ids=${SEED.quote(1, 1)}`];

async function checked<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> {
  const { data, error } = await query;
  if (error) throw error;
  return data as NonNullable<T>;
}

async function fixtureRpc<Name extends keyof Functions>(name: Name, args: Functions[Name]["Args"]) {
  return await checked(admin.schema("private").rpc(name, args)) as Functions[Name]["Returns"];
}

async function newUser() {
  const user = await createUser(`卡五${randomUUID().replaceAll("-", "").slice(0, 24)}`);
  users.push(user.id);
  return user;
}

async function newKey(user: TestUser, scopes = ["quotes:read", "me:read"]) {
  const key = generateKey("test");
  await checked(admin.from("api_keys").insert({ user_id: user.id, name: "card-5", key_prefix: key.prefix, key_hash: toBytea(key.hash), scopes }));
  return key.secret;
}

async function expectedMe(user: TestUser) {
  const profile = await checked(admin.from("profiles").select("username, created_at").eq("id", user.id).single());
  return {
    id: user.id, username: profile.username, avatar_url: null, likes_public: true, favorites_public: true,
    roles: [], standing: { status: "active", suspended_until: null, strike_count: 0, strike_limit: 4, can_submit: true, can_comment: true },
    pending_notices: [], created_at: new Date(profile.created_at).toISOString(),
  };
}

async function newQuote(user: TestUser, status: "published" | "under_review" | "removed" | "deleted" = "published", createdAt?: string) {
  const content = `卡五說說${randomUUID()}`;
  const id = await fixtureRpc("create_quote", {
    actor: user.id, content, content_hash: toBytea(contentHash(content)), category: "original", source_from: "卡五整合測試", commit_from: "api",
  });
  quotes.push(id);
  if (status !== "published" || createdAt) {
    await checked(admin.from("quotes").update({
      status, ...(createdAt ? { created_at: createdAt } : {}),
      ...(status === "removed" ? { removed_reason: "spam", removed_at: "2026-01-02T03:04:05.123456Z" } : {}),
    }).eq("id", id));
  }
  const profile = await checked(admin.from("profiles").select("username").eq("id", user.id).single());
  const row = await checked(admin.from("quotes").select("created_at").eq("id", id).single());
  return {
    id, content, length: Array.from(content).length, category: { key: "original", name: "原創" }, source_from: "卡五整合測試",
    submitter: { id: user.id, username: profile.username, deleted: false },
    stats: { like_count: 0, favorite_count: 0, comment_count: 0 }, status, commit_from: "api", edited_at: null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function expectSuccess(response: Reply, data: unknown, pagination?: { limit: number; next_cursor: unknown; has_more: boolean }, rate = 120) {
  expect(response.status, response.raw).toBe(200);
  const requestId = response.headers.get("x-request-id");
  expect(requestId).toMatch(/^req_/);
  expect(JSON.parse(response.raw)).toEqual({ data, meta: { request_id: requestId, ...(pagination ? { pagination } : {}) } });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("ratelimit-limit")).toBe(String(rate));
}

function expectError(response: Reply, status: number, code: string) {
  expect(response.status, response.raw).toBe(status);
  expect(response.error?.code).toBe(code);
  expect(JSON.parse(response.raw).error).toMatchObject({
    status, message: expect.any(String), message_en: expect.any(String),
    request_id: response.headers.get("x-request-id"), docs_url: `https://docs.shuoshuotw.xyz/errors#${code}`,
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
}

afterAll(async () => {
  resetPool();
  if (users.length) {
    await checked(admin.from("appeals").delete().in("user_id", users));
    await checked(admin.from("sanctions").delete().in("user_id", users));
    await checked(admin.from("violations").delete().in("user_id", users));
  }
  if (cases.length) await checked(admin.from("moderation_cases").delete().in("id", cases));
  if (quotes.length) await checked(admin.from("quotes").delete().in("id", quotes));
  if (users.length) {
    await checked(admin.from("profiles").delete().in("id", users));
    for (const id of users) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
    }
  }
});

describe("personal profile and settings", () => {
  it("PV-04: returns the complete profile and public defaults for JWT and me:read keys", async () => {
    const user = await newUser();
    const expected = await expectedMe(user);
    expectSuccess(await call("/v1/me", { token: user.token }), expected);
    expectSuccess(await call("/v1/me", { token: await newKey(user) }), expected, undefined, 300);
    await checked(admin.from("user_roles").insert({ user_id: user.id, role: "admin" }));
    await checked(admin.from("profiles").update({ avatar_url: "https://example.com/avatar.png" }).eq("id", user.id));
    expectSuccess(await call("/v1/me", { token: user.token }), { ...expected, roles: ["admin"], avatar_url: "https://example.com/avatar.png" });
  });

  it("updates all supported fields, preserves omitted fields and isolates other users", async () => {
    const user = await newUser();
    const other = await newUser();
    const expected = await expectedMe(user);
    const otherBefore = await expectedMe(other);
    const username = `中文_AZ-09${randomUUID().replaceAll("-", "").slice(0, 15)}`;
    const updated = { ...expected, username, likes_public: false, favorites_public: false };
    expectSuccess(await call("/v1/me", { method: "PATCH", token: user.token, body: { username, likes_public: false, favorites_public: false } }), updated, undefined, 10);
    expectSuccess(await call("/v1/me", { method: "PATCH", token: user.token, body: { likes_public: true } }), { ...updated, likes_public: true }, undefined, 10);
    expectSuccess(await call("/v1/me", { token: user.token }), { ...updated, likes_public: true });
    expectSuccess(await call("/v1/me", { token: other.token }), otherBefore);
  });

  it("rejects case-insensitive username conflicts without partially changing privacy", async () => {
    const user = await newUser();
    const other = await newUser();
    const taken = (await expectedMe(other)).username;
    const before = await expectedMe(user);
    expectError(await call("/v1/me", { method: "PATCH", token: user.token, body: { username: taken.toUpperCase(), likes_public: false } }), 409, "USERNAME_TAKEN");
    expectSuccess(await call("/v1/me", { token: user.token }), before);
  });

  it.each([
    {}, { unknown: true }, { username: "a" }, { username: "a".repeat(31) }, { username: "名字😀" },
    { username: "名 字" }, { username: "名字\n" }, { username: "éé" }, { username: 12 }, { likes_public: "false" }, { favorites_public: null },
  ])("rejects invalid PATCH body %j", async (body) => {
    const user = await newUser();
    const before = await expectedMe(user);
    expectError(await call("/v1/me", { method: "PATCH", token: user.token, body }), 400, "VALIDATION_FAILED");
    expectSuccess(await call("/v1/me", { token: user.token }), before);
  });

  it("normalizes NFC and measures username limits in code points", async () => {
    const user = await newUser();
    const expected = await expectedMe(user);
    const raw = `豈${randomUUID().slice(0, 6)}`;
    expectSuccess(await call("/v1/me", { method: "PATCH", token: user.token, body: { username: raw } }), { ...expected, username: raw.normalize("NFC") }, undefined, 10);
    const name = `𠀀${randomUUID().replaceAll("-", "").slice(0, 29)}`;
    expect(Array.from(name)).toHaveLength(30);
    expectSuccess(await call("/v1/me", { method: "PATCH", token: user.token, body: { username: name } }), { ...expected, username: name }, undefined, 10);
  });

  it("enforces five username changes per hour while privacy-only updates keep working", async () => {
    const user = await newUser();
    for (let i = 0; i < 5; i += 1) {
      const response = await call("/v1/me", { method: "PATCH", token: user.token, body: { username: `額度${randomUUID().slice(0, 8)}` } });
      expect(response.status, response.raw).toBe(200);
    }
    const limited = await call("/v1/me", { method: "PATCH", token: user.token, body: { username: `額度${randomUUID().slice(0, 8)}` } });
    expectError(limited, 429, "RATE_LIMITED");
    expect(JSON.parse(limited.raw).error.details).toEqual({ scope: "username_change", limit: 5, window_seconds: 3600, retry_after_seconds: expect.any(Number) });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const before = JSON.parse((await call("/v1/me", { token: user.token })).raw).data;
    expectSuccess(await call("/v1/me", { method: "PATCH", token: user.token, body: { favorites_public: false } }), { ...before, favorites_public: false }, undefined, 10);
  });

  it("synchronizes a successful rename into the existing quote pool", async () => {
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    const user = await newUser();
    const quote = await newQuote(user);
    resetPool({ original: { quotes: [quote], total: 1 } }, Date.now());
    const username = `池中${randomUUID().slice(0, 8)}`;
    try {
      const response = await PATCH(new Request("http://localhost/v1/me", {
        method: "PATCH", headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json", "cf-connecting-ip": "127.0.0.5" },
        body: JSON.stringify({ username }),
      }), { params: Promise.resolve({}) });
      expect(response.status, await response.text()).toBe(200);
      expect(draw({ categories: ["original"] })?.submitter).toEqual({ id: user.id, username, deleted: false });
      expect(JSON.parse((await call("/v1/me", { token: user.token })).raw).data.username).toBe(username);
    } finally {
      resetPool();
    }
  });

  it("computes suspended, expired and banned standing and allows every banned personal read", async () => {
    const user = await newUser();
    const expected = await expectedMe(user);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await checked(admin.from("account_standing").update({ suspended_until: future, strike_count: 1 }).eq("user_id", user.id));
    expectSuccess(await call("/v1/me", { token: user.token }), { ...expected, standing: { ...expected.standing, status: "suspended", suspended_until: future, strike_count: 1, can_submit: false, can_comment: false } });
    expectSuccess(await call("/v1/me", { method: "PATCH", token: user.token, body: { likes_public: false } }), { ...expected, likes_public: false, standing: { ...expected.standing, status: "suspended", suspended_until: future, strike_count: 1, can_submit: false, can_comment: false } }, undefined, 10);
    const past = "2020-01-01T00:00:00.000Z";
    await checked(admin.from("account_standing").update({ suspended_until: past }).eq("user_id", user.id));
    expectSuccess(await call("/v1/me", { token: user.token }), { ...expected, likes_public: false, standing: { ...expected.standing, suspended_until: past, strike_count: 1 } });
    await checked(admin.from("account_standing").update({ status: "banned", strike_count: 4 }).eq("user_id", user.id));
    expectSuccess(await call("/v1/me", { token: user.token }), { ...expected, likes_public: false, standing: { ...expected.standing, status: "banned", suspended_until: past, strike_count: 4, can_submit: false, can_comment: false } });
    for (const path of readPaths.slice(1)) {
      expectSuccess(await call(path, { token: user.token }), path.includes("quote-states")
        ? { states: { [SEED.quote(1, 1)]: { liked: false, favorited: false } } } : [],
      path.includes("quote-states") ? undefined : { limit: 20, next_cursor: null, has_more: false });
    }
    for (const body of [{ likes_public: true }, { username: `封號${randomUUID().slice(0, 8)}` }]) {
      expectError(await call("/v1/me", { method: "PATCH", token: user.token, body }), 403, "ACCOUNT_BANNED");
    }
    expect((await checked(admin.from("profiles").select("username, likes_public").eq("id", user.id).single())))
      .toEqual({ username: expected.username, likes_public: false });
  });

  it("returns open notices, omits lifted, expired, overturned, appealed and stale records and never includes another user's notices", async () => {
    const user = await newUser();
    const other = await newUser();
    const expected = await expectedMe(user);
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    async function violation(owner: TestUser, fields: { overturned_at?: string; created_at?: string } = {}) {
      const row = await checked(admin.from("moderation_cases").insert({ target_type: "comment", target_id: randomUUID(), status: "resolved", resolution: "uphold" }).select("id").single());
      cases.push(row.id);
      return checked(admin.from("violations").insert({ user_id: owner.id, case_id: row.id, reason: "spam", counts_as_strike: false, ...fields }).select("id, created_at").single());
    }
    async function sanction(fields: { user_id?: string; violation_id?: string; starts_at?: string; ends_at?: string; lifted_at?: string }) {
      return checked(admin.from("sanctions").insert({ user_id: user.id, kind: "submit_suspension", source: "manual", reason: "fixture", ...fields }).select("id, starts_at").single());
    }
    async function appeal(violationId: string, fields: { status?: "rejected"; decided_at?: string } = {}) {
      await checked(admin.from("appeals").insert({ user_id: user.id, violation_id: violationId, statement: "這則留言沒有違反任何社群規範，請協助重新審視。", ...fields }));
    }

    const open = await violation(user);
    const nearlyStale = await violation(user, { created_at: daysAgo(29) });
    const appealPending = await violation(user);
    await appeal(appealPending.id);
    const appealDecided = await violation(user);
    await appeal(appealDecided.id, { status: "rejected", decided_at: new Date().toISOString() });
    await violation(user, { created_at: daysAgo(31) });
    await violation(user, { overturned_at: new Date().toISOString() });
    await violation(other);

    const running = await sanction({ starts_at: "2020-01-02T03:04:05.123456Z", ends_at: new Date(Date.now() + 86_400_000).toISOString() });
    const permanent = await sanction({ starts_at: "2020-01-02T03:04:06.123456Z" });
    // Its sanction has expired, and that sanction speaks for this removal, so neither appears
    const linked = await violation(user);
    await sanction({ violation_id: linked.id, starts_at: "2020-01-02T03:04:07.123456Z", ends_at: "2020-01-03T00:00:00Z" });
    await sanction({ lifted_at: new Date().toISOString() });
    await sanction({ user_id: other.id });

    const notices = [
      ...[open, nearlyStale, appealPending].map((row) => ({ type: "removal", id: row.id, created_at: new Date(row.created_at).toISOString() })),
      ...[running, permanent].map((row) => ({ type: "sanction", id: row.id, created_at: new Date(row.starts_at).toISOString() })),
    ].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    expectSuccess(await call("/v1/me", { token: user.token }), { ...expected, pending_notices: notices });
  });
});

describe("personal lists", () => {
  it("lists only the caller's nondeleted quotes with full OwnQuote fields, status filters and stable microsecond pagination", async () => {
    const user = await newUser();
    const other = await newUser();
    const timestamp = "2026-01-01T00:00:00.123456Z";
    const published = await newQuote(user, "published", timestamp);
    const review = await newQuote(user, "under_review", timestamp);
    const removed = await newQuote(user, "removed", "2026-01-01T00:00:00.123455Z");
    await newQuote(user, "deleted", timestamp);
    await newQuote(other, "published", timestamp);
    const own = (quote: typeof published) => ({ ...quote, removed_reason: quote.status === "removed" ? "spam" : null, removed_at: quote.status === "removed" ? "2026-01-02T03:04:05.123Z" : null });
    const expected = [published, review].sort((a, b) => b.id.localeCompare(a.id)).concat(removed).map(own);
    const first = await call("/v1/me/quotes?limit=1&ignored=ok", { token: user.token });
    expectSuccess(first, [expected[0]], { limit: 1, next_cursor: expect.any(String), has_more: true });
    const cursor = JSON.parse(first.raw).meta.pagination.next_cursor;
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString())).toEqual({ c: "2026-01-01T00:00:00.123456+00:00", i: expected[0]!.id });
    const second = await call(`/v1/me/quotes?limit=1&cursor=${cursor}`, { token: user.token });
    expectSuccess(second, [expected[1]], { limit: 1, next_cursor: expect.any(String), has_more: true });
    const third = await call(`/v1/me/quotes?limit=1&cursor=${JSON.parse(second.raw).meta.pagination.next_cursor}`, { token: user.token });
    expectSuccess(third, [expected[2]], { limit: 1, next_cursor: null, has_more: false });
    const key = await newKey(user);
    for (const quote of [published, review, removed]) {
      expectSuccess(await call(`/v1/me/quotes?status=${quote.status}`, { token: key }), [own(quote)], { limit: 20, next_cursor: null, has_more: false }, 300);
    }
  });

  it.each([
    { table: "quote_likes", path: "/v1/me/likes", field: "liked_at", kind: "like", count: "like_count" },
    { table: "quote_favorites", path: "/v1/me/favorites", field: "favorited_at", kind: "favorite", count: "favorite_count" },
  ] as const)("preserves $table placeholders and paginates by raw reaction time and quote_id", async ({ table, path, field, kind, count }) => {
    const user = await newUser();
    const other = await newUser();
    const published = await newQuote(other);
    const review = await newQuote(other);
    const removed = await newQuote(other);
    const deleted = await newQuote(other);
    const items = [published, review, removed, deleted].sort((a, b) => b.id.localeCompare(a.id));
    for (const quote of items) await fixtureRpc("set_reaction", { actor: user.id, quote_id: quote.id, kind, value: true });
    await checked(admin.from(table).update({ created_at: "2026-01-01T00:00:00.123456Z" }).eq("user_id", user.id));
    await checked(admin.from("quotes").update({ status: "under_review" }).eq("id", review.id));
    await checked(admin.from("quotes").update({ status: "removed" }).eq("id", removed.id));
    await checked(admin.from("quotes").update({ status: "deleted" }).eq("id", deleted.id));
    await checked(admin.from("profiles").update({ likes_public: false, favorites_public: false }).eq("id", user.id));
    const expected = items.map((quote) => ({ [field]: "2026-01-01T00:00:00.123Z", quote: [removed.id, deleted.id].includes(quote.id) ? null : {
      ...quote, status: quote.id === review.id ? "under_review" : "published", stats: { ...quote.stats, [count]: 1 },
    } }));
    const key = await newKey(user);
    let cursor: string | null = null;
    for (let i = 0; i < expected.length; i += 1) {
      const response = await call(`${path}?limit=1${cursor ? `&cursor=${cursor}` : ""}`, { token: i % 2 ? key : user.token });
      const more = i < expected.length - 1;
      expectSuccess(response, [expected[i]], { limit: 1, next_cursor: more ? expect.any(String) : null, has_more: more }, i % 2 ? 300 : 120);
      cursor = JSON.parse(response.raw).meta.pagination.next_cursor;
      if (cursor) expect(JSON.parse(Buffer.from(cursor, "base64url").toString())).toEqual({ c: "2026-01-01T00:00:00.123456+00:00", i: items[i]!.id });
    }
    expectSuccess(await call(path, { token: other.token }), [], { limit: 20, next_cursor: null, has_more: false });
  });

  it("rejects invalid list limits, cursors and quote statuses", async () => {
    const user = await newUser();
    for (const path of ["/v1/me/quotes", "/v1/me/likes", "/v1/me/favorites"]) {
      for (const limit of ["0", "101", "1.5", "bad"]) expectError(await call(`${path}?limit=${limit}`, { token: user.token }), 400, "VALIDATION_FAILED");
      expectSuccess(await call(`${path}?limit=100`, { token: user.token }), [], { limit: 100, next_cursor: null, has_more: false });
      expectError(await call(`${path}?cursor=invalid`, { token: user.token }), 400, "INVALID_CURSOR");
    }
    expectError(await call("/v1/me/quotes?status=deleted", { token: user.token }), 400, "VALIDATION_FAILED");
  });
});

describe("quote states and authorization", () => {
  it("returns the caller's states for existing and nonexistent IDs, including exactly 50 IDs", async () => {
    const user = await newUser();
    const other = await newUser();
    const first = await newQuote(other);
    const second = await newQuote(other);
    await fixtureRpc("set_reaction", { actor: user.id, quote_id: first.id, kind: "like", value: true });
    await fixtureRpc("set_reaction", { actor: user.id, quote_id: second.id, kind: "favorite", value: true });
    await fixtureRpc("set_reaction", { actor: other.id, quote_id: second.id, kind: "like", value: true });
    const ids = [first.id, second.id, ...Array.from({ length: 48 }, () => randomUUID())];
    const expected = { states: Object.fromEntries(ids.map((id) => [id, { liked: id === first.id, favorited: id === second.id }])) };
    for (const [token, rate] of [[user.token, 120], [await newKey(user), 300]] as const) {
      expectSuccess(await call(`/v1/me/quote-states?ids=${ids.join(",").toUpperCase()}`, { token }), expected, undefined, rate);
    }
    expectSuccess(await call(`/v1/me/quote-states?ids=${first.id},${second.id}`, { token: other.token }), { states: {
      [first.id]: { liked: false, favorited: false }, [second.id]: { liked: true, favorited: false },
    } });
  });

  it("rejects absent, empty, malformed and more than 50 IDs, counting duplicates toward the limit", async () => {
    const user = await newUser();
    for (const query of ["", "?ids=", "?ids=bad", `?ids=${randomUUID()},`, `?ids=${Array.from({ length: 51 }, () => randomUUID()).join(",")}`, `?ids=${Array(51).fill(SEED.quote(1, 1)).join(",")}`]) {
      expectError(await call(`/v1/me/quote-states${query}`, { token: user.token }), 400, "VALIDATION_FAILED");
    }
  });

  it("rejects anonymous reads, insufficient scopes and all API keys on PATCH", async () => {
    const user = await newUser();
    const key = await newKey(user, ["quotes:read"]);
    for (const path of readPaths) {
      expectError(await call(path), 401, "AUTHENTICATION_REQUIRED");
      const response = await call(path, { token: key });
      expectError(response, 403, "INSUFFICIENT_SCOPE");
      expect(JSON.parse(response.raw).error.details).toEqual({ required_scope: "me:read" });
    }
    expectError(await call("/v1/me", { method: "PATCH", body: { likes_public: false } }), 401, "AUTHENTICATION_REQUIRED");
    expectError(await call("/v1/me", { method: "PATCH", token: await newKey(user), body: { likes_public: false } }), 403, "API_KEY_NOT_ALLOWED");
  });
});
