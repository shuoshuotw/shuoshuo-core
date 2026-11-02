import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKey, toBytea } from "@/lib/auth/api-key";
import { contentHash } from "@/lib/quotes/normalize";
import type { components } from "@/openapi/types";
import { admin, call, createUser, SEED, type TestUser } from "./helpers";

type Quote = components["schemas"]["Quote"];
type ListMeta = components["schemas"]["ListMeta"];
type Reaction = { liked_at?: string; favorited_at?: string; quote: Quote | null };
type FixtureQuote = { id: string; content: string; created_at: string; status: string };
const users: TestUser[] = [];
const quoteIds: string[] = [];
const CACHE = "public, s-maxage=30, stale-while-revalidate=60";
const kinds = ["likes", "favorites"] as const;

async function fixtureQuote(user: TestUser, status = "published", created_at = "2026-01-01T00:00:00.000001Z"): Promise<FixtureQuote> {
  const content = `使用者測試${randomUUID()}`;
  const { data, error } = await admin.from("quotes").insert({
    content, original_content: content, content_hash: toBytea(contentHash(content)),
    category_key: "other", source_from: "card-3", submitter_id: user.id, commit_from: "api", status, created_at,
    ...(status === "removed" ? { removed_reason: "spam" } : {}),
  }).select("id, content, created_at, status").single();
  if (error) throw error;
  quoteIds.push(data.id);
  return data;
}

async function keyFor(user: TestUser, scopes: string[]) {
  const key = generateKey("test");
  const { error } = await admin.from("api_keys").insert({
    user_id: user.id, name: "card-3", key_prefix: key.prefix, key_hash: toBytea(key.hash), scopes,
  });
  if (error) throw error;
  return key.secret;
}

async function hmacCall(path: string, token?: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = process.env.INTERNAL_HMAC_SECRETS!.split(",")[0]!;
  const signature = createHmac("sha256", secret).update(`${timestamp}.GET.${path}`).digest("hex");
  const response = await fetch(`${process.env.CORE_URL ?? "http://localhost:3001"}${path}`, {
    headers: {
      "x-shuoshuo-internal": `v1.${timestamp}.${signature}`,
      "cf-connecting-ip": `10.249.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await response.json();
  return { status: response.status, headers: response.headers, ...body };
}

function expectError(response: { status: number; error?: { code: string } }, status: number, code: string) {
  expect([response.status, response.error?.code]).toEqual([status, code]);
}

afterAll(async () => {
  if (quoteIds.length) {
    const { error } = await admin.from("quotes").delete().in("id", quoteIds);
    if (error) throw error;
  }
  for (const user of users) {
    const auth = await admin.auth.admin.deleteUser(user.id);
    if (auth.error) throw auth.error;
    const { error } = await admin.from("profiles").delete().eq("id", user.id);
    if (error) throw error;
  }
});

describe("public users", () => {
  let owner: TestUser;
  let other: TestUser;
  let username: string;
  let base: string;
  let quotes: FixtureQuote[];
  let ownerReadKey: string;
  let ownerMeKey: string;
  let otherKey: string;
  const reactionTimes = [
    "2026-02-01T00:00:00.123456Z", "2026-02-01T00:00:00.123455Z",
    "2026-02-01T00:00:00.123455Z", "2026-02-01T00:00:00.123454Z", "2026-02-01T00:00:00.123453Z",
  ];

  function expectedQuote(quote: FixtureQuote): Quote {
    return {
      id: quote.id, content: quote.content, length: Array.from(quote.content).length,
      category: { key: "other", name: "其他" }, source_from: "card-3",
      submitter: { id: owner.id, username, deleted: false },
      stats: { like_count: 1, favorite_count: 1, comment_count: 0 },
      status: quote.status as Quote["status"], commit_from: "api", edited_at: null,
      created_at: new Date(quote.created_at).toISOString(),
    };
  }

  beforeAll(async () => {
    process.loadEnvFile(".env.local");
    owner = await createUser(); users.push(owner);
    other = await createUser(); users.push(other);
    username = `中文_Ab-${randomUUID().slice(0, 12)}`;
    base = `/v1/users/${encodeURIComponent(username)}`;
    const profile = await admin.from("profiles").update({ username }).eq("id", owner.id);
    if (profile.error) throw profile.error;
    quotes = [];
    for (const [index, status] of ["published", "published", "under_review", "removed", "deleted"].entries()) {
      quotes.push(await fixtureQuote(owner, status, index === 0 ? "2026-01-01T00:00:00.123456Z" : "2026-01-01T00:00:00.123455Z"));
    }
    for (const table of ["quote_likes", "quote_favorites"]) {
      const { error } = await admin.from(table).insert(quotes.map((quote, index) => ({ user_id: owner.id, quote_id: quote.id, created_at: reactionTimes[index] })));
      if (error) throw error;
    }
    ownerReadKey = await keyFor(owner, ["quotes:read"]);
    ownerMeKey = await keyFor(owner, ["quotes:read", "me:read"]);
    otherKey = await keyFor(other, ["quotes:read", "me:read"]);
  });

  it("PV-05: URL-encoded names are case-insensitive, wildcard characters are literal, and the profile has only contract fields", async () => {
    const response = await call(`/v1/users/${encodeURIComponent(username.toUpperCase())}`);
    expect(response.status).toBe(200);
    const profile = await admin.from("profiles").select("created_at").eq("id", owner.id).single();
    if (profile.error) throw profile.error;
    expect(response.data).toEqual({
      id: owner.id, username, avatar_url: null, likes_public: true, favorites_public: true,
      quote_count: 2, created_at: new Date(profile.data.created_at).toISOString(),
    });
    expect(response.meta).toEqual({ request_id: response.headers.get("x-request-id") });
    expect(response.headers.get("cache-control")).toBe(CACHE);
    expect(response.headers.has("ratelimit-limit")).toBe(false);
    const unchanged = await call(base, { token: other.token });
    expect(unchanged.data).toEqual(response.data);
    const distractor = await createUser(); users.push(distractor);
    const updated = await admin.from("profiles").update({ username: username.replace("_", "X") }).eq("id", distractor.id);
    if (updated.error) throw updated.error;
    expect((await call(base)).data).toEqual(response.data);
    for (const name of ["%", "*", username.replace("_", "%"), username.replace("_", "*"), username.replace("_", "__"), `missing-${randomUUID()}`]) {
      for (const suffix of ["", "/quotes", "/likes", "/favorites"]) {
        expectError(await call(`/v1/users/${encodeURIComponent(name)}${suffix}`, { token: other.token }), 404, "USER_NOT_FOUND");
      }
    }
    expect((await call(`/v1/users/${encodeURIComponent(username.replace("_", "X"))}`)).status).toBe(200);
  });

  it("GET /quotes exposes only this user's published quotes and preserves microseconds in cursors", async () => {
    const expected = quotes.filter((quote) => quote.status === "published")
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const first = await call(`${base}/quotes?limit=1&ignored=yes`);
    expect(first.status).toBe(200);
    expect(first.data).toEqual([expectedQuote(expected[0]!)]);
    expect(first.headers.get("cache-control")).toBe(CACHE);
    const meta = first.meta as unknown as ListMeta;
    expect(meta).toEqual({ request_id: first.headers.get("x-request-id"), pagination: { limit: 1, has_more: true, next_cursor: expect.any(String) } });
    expect(JSON.parse(Buffer.from(meta.pagination.next_cursor!, "base64url").toString())).toEqual({ c: expected[0]!.created_at, i: expected[0]!.id });
    const second = await call(`${base}/quotes?limit=1&cursor=${encodeURIComponent(meta.pagination.next_cursor!)}`);
    expect(second.status).toBe(200);
    expect(second.data).toEqual([expectedQuote(expected[1]!)]);
    expect((second.meta as unknown as ListMeta).pagination).toEqual({ limit: 1, has_more: false, next_cursor: null });
  });

  it.each(kinds)("GET /%s returns complete reaction rows, including null for removed/deleted quotes, in reaction order", async (kind) => {
    const table = kind === "likes" ? "quote_likes" : "quote_favorites";
    const field = kind === "likes" ? "liked_at" : "favorited_at";
    const stored = await admin.from(table).select("quote_id, created_at").eq("user_id", owner.id)
      .order("created_at", { ascending: false }).order("quote_id", { ascending: false });
    if (stored.error) throw stored.error;
    const seen: Reaction[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < quotes.length; page += 1) {
      const response = await call(`${base}/${kind}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: other.token });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const storedRow = stored.data[page]!;
      const quote = quotes.find((item) => item.id === storedRow.quote_id)!;
      expect(response.data).toEqual([{
        [field]: new Date(storedRow.created_at).toISOString(),
        quote: ["removed", "deleted"].includes(quote.status) ? null : expectedQuote(quote),
      }]);
      const { pagination } = response.meta as unknown as ListMeta;
      expect(pagination).toEqual({ limit: 1, has_more: page < quotes.length - 1, next_cursor: page < quotes.length - 1 ? expect.any(String) : null });
      if (pagination.next_cursor) {
        expect(JSON.parse(Buffer.from(pagination.next_cursor, "base64url").toString())).toEqual({ c: storedRow.created_at, i: storedRow.quote_id });
      }
      seen.push(...response.data as unknown as Reaction[]);
      cursor = pagination.next_cursor;
    }
    expect(seen).toHaveLength(quotes.length);
    expect(seen.filter((item) => item.quote === null)).toHaveLength(2);
  });

  it.each(kinds)("PV-01/PV-02: /%s enforces the visibility × JWT/key/HMAC matrix", async (kind) => {
    const path = `${base}/${kind}`;
    const field = kind === "likes" ? "likes_public" : "favorites_public";
    const privateCode = kind === "likes" ? "USER_LIKES_PRIVATE" : "USER_FAVORITES_PRIVATE";
    expectError(await call(path), 401, "AUTHENTICATION_REQUIRED");
    for (const token of [owner.token, other.token, ownerReadKey, ownerMeKey, otherKey]) {
      expect((await call(path, { token })).status).toBe(200);
    }
    expect((await hmacCall(path)).status).toBe(200);
    const hidden = await admin.from("profiles").update({ [field]: false }).eq("id", owner.id);
    if (hidden.error) throw hidden.error;
    try {
      expectError(await call(path), 401, "AUTHENTICATION_REQUIRED");
      for (const token of [other.token, ownerReadKey, otherKey]) {
        const denied = await call(path, { token });
        expectError(denied, 403, privateCode);
        expect(denied.data).toBeUndefined();
        expect(denied.headers.get("cache-control")).toBe("no-store");
      }
      for (const token of [owner.token, ownerMeKey]) expect((await call(path, { token })).status).toBe(200);
      expectError(await hmacCall(path), 403, privateCode);
      expectError(await hmacCall(path, other.token), 403, privateCode);
      expectError(await hmacCall(path, ownerReadKey), 403, privateCode);
      expect((await hmacCall(path, owner.token)).status).toBe(200);
      expect((await hmacCall(path, ownerMeKey)).status).toBe(200);
      const otherKind = kind === "likes" ? "favorites" : "likes";
      expect((await call(`${base}/${otherKind}`, { token: otherKey })).status).toBe(200);
    } finally {
      const restored = await admin.from("profiles").update({ [field]: true }).eq("id", owner.id);
      if (restored.error) throw restored.error;
    }
  });

  it("PV-05: deleted users are 404 on all four routes and a replacement with the same name resolves to its own ID", async () => {
    const deleted = await createUser(); users.push(deleted);
    const name = `刪除_${randomUUID().slice(0, 12)}`;
    const changed = await admin.from("profiles").update({ username: name, deleted_at: new Date().toISOString() }).eq("id", deleted.id);
    if (changed.error) throw changed.error;
    await fixtureQuote(deleted);
    const path = `/v1/users/${encodeURIComponent(name)}`;
    for (const suffix of ["", "/quotes", "/likes", "/favorites"]) {
      const response = await call(`${path}${suffix}`, { token: other.token });
      expectError(response, 404, "USER_NOT_FOUND");
      expect(response.headers.get("cache-control")).toBe(["", "/quotes"].includes(suffix) ? CACHE : "no-store");
    }
    const replacement = await createUser(); users.push(replacement);
    const renamed = await admin.from("profiles").update({ username: name }).eq("id", replacement.id);
    if (renamed.error) throw renamed.error;
    const found = await call(path);
    expect(found.status).toBe(200);
    expect(found.data).toMatchObject({ id: replacement.id, username: name, quote_count: 0 });
    expect((await call(`${path}/quotes`)).data).toEqual([]);
  });

  it("validates pagination, returns empty lists for a new user, and reads seed profiles without changing them", async () => {
    for (const suffix of ["quotes", ...kinds]) {
      expectError(await call(`${base}/${suffix}?cursor=invalid`, { token: owner.token }), 400, "INVALID_CURSOR");
      const badTime = Buffer.from(JSON.stringify({ c: "not-a-timestamp", i: randomUUID() })).toString("base64url");
      expectError(await call(`${base}/${suffix}?cursor=${badTime}`, { token: owner.token }), 400, "INVALID_CURSOR");
      for (const limit of ["0", "101", "1.5"]) expectError(await call(`${base}/${suffix}?limit=${limit}`, { token: owner.token }), 400, "VALIDATION_FAILED");
    }
    const profile = await admin.from("profiles").select("username").eq("id", other.id).single();
    if (profile.error) throw profile.error;
    for (const suffix of ["quotes", ...kinds]) {
      const response = await call(`/v1/users/${encodeURIComponent(profile.data.username)}/${suffix}`, { token: owner.token });
      expect(response.status).toBe(200);
      expect(response.data).toEqual([]);
      expect((response.meta as unknown as ListMeta).pagination).toEqual({ limit: 20, next_cursor: null, has_more: false });
    }
    const seed = await admin.from("profiles").select("username").eq("id", SEED.alice).single();
    if (seed.error) throw seed.error;
    expect((await call(`/v1/users/${encodeURIComponent(seed.data.username)}`)).status).toBe(200);
  });
});
