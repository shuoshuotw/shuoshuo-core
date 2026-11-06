import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKey, toBytea } from "@/lib/auth/api-key";
import type { Database } from "@/lib/database.types";
import catalog from "@/lib/http/error-catalog.json";
import { decodeCursor, encodeCursor } from "@/lib/http/pagination";
import { contentHash } from "@/lib/quotes/normalize";
import type { components } from "@/openapi/types";
import { admin, call, createUser, SEED, type TestUser } from "./helpers";

type Quote = components["schemas"]["Quote"];
type Pagination = components["schemas"]["ListMeta"]["pagination"];
type QuoteInsert = Database["public"]["Tables"]["quotes"]["Insert"];
type Reply<T = Quote> = {
  status: number;
  headers: Headers;
  raw: string;
  data: T;
  meta: { request_id: string; pagination?: Pagination };
  error?: { code: string; details?: Record<string, unknown> };
};
const CACHE = "public, s-maxage=30, stale-while-revalidate=60";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const users: TestUser[] = [];
const quoteIds: string[] = [];

async function request<T = Quote>(path: string, options?: Parameters<typeof call>[1]) {
  return await call(path, options) as unknown as Reply<T>;
}

async function newUser() {
  const user = await createUser();
  users.push(user);
  return user;
}

async function fixture(user: TestUser, change: Partial<QuoteInsert> = {}) {
  const content = `說說測試${randomUUID()}`;
  const row = {
    id: randomUUID(), content, original_content: change.content ?? content,
    category_key: "original", source_from: `來源${randomUUID()}`,
    submitter_id: user.id, commit_from: "web" as const, ...change,
    content_hash: toBytea(contentHash(change.content ?? content)),
  };
  quoteIds.push(row.id);
  const { data, error } = await admin.from("quotes").insert(row).select().single();
  if (error) throw error;
  return data as Database["public"]["Tables"]["quotes"]["Row"];
}

async function keyFor(user: TestUser, scopes = ["quotes:read"]) {
  const key = generateKey("test");
  const { error } = await admin.from("api_keys").insert({
    user_id: user.id, name: `卡一${randomUUID()}`, key_prefix: key.prefix,
    key_hash: toBytea(key.hash), scopes,
  });
  if (error) throw error;
  return key.secret;
}

function expectMeta(response: Reply<unknown>, pagination?: Pagination) {
  expect(response.meta).toEqual({
    request_id: response.headers.get("x-request-id"),
    ...(pagination ? { pagination } : {}),
  });
  expect(response.meta.request_id).toMatch(/^req_/);
}

function expectQuote(quote: Quote, expected: Partial<Quote> = {}) {
  expect(quote).toEqual({
    id: expect.stringMatching(UUID), content: expect.any(String), length: expect.any(Number),
    category: { key: expect.any(String), name: expect.any(String) }, source_from: expect.any(String),
    submitter: { id: expect.stringMatching(UUID), username: expect.any(String), avatar_url: null, deleted: false, verified: false },
    stats: { like_count: expect.any(Number), favorite_count: expect.any(Number), comment_count: expect.any(Number) },
    status: "published", commit_from: "web", edited_at: null,
    created_at: expect.stringMatching(ISO), ...expected,
  });
  expect(quote.length).toBe(Array.from(quote.content).length);
}

function expectError(response: Reply<unknown>, code: keyof typeof catalog, details?: Record<string, unknown>, cache = "no-store") {
  const entry = catalog[code];
  expect(response.status).toBe(entry.status);
  expect(response.error).toEqual({
    code, status: entry.status, message: entry.message, message_en: entry.message_en,
    docs_url: `https://docs.shuoshuotw.xyz/errors#${code}`,
    request_id: response.headers.get("x-request-id"),
    ...(details === undefined ? {} : { details }),
  });
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe(cache);
}

afterAll(async () => {
  // Only this run's random IDs are removed; append-only audit records remain intact.
  if (quoteIds.length) {
    await admin.from("moderation_cases").delete().in("target_id", quoteIds).throwOnError();
    await admin.from("quotes").delete().in("id", quoteIds).throwOnError();
  }
  if (users.length) {
    await admin.from("profiles").delete().in("id", users.map(({ id }) => id)).throwOnError();
    for (const user of users) {
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) throw error;
    }
  }
});

describe("quotes: public reads and cursor pagination", () => {
  let user: TestUser;
  beforeAll(async () => { user = await newUser(); });

  it("GET returns the full shared Quote and text representations", async () => {
    const row = await fixture(user, { content: `說說😀\n第二行${randomUUID()}` });
    const response = await request(`/v1/quotes/${row.id}`);
    expect(response.status).toBe(200);
    expectMeta(response);
    expectQuote(response.data, { id: row.id, content: row.content, source_from: row.source_from });
    expect(response.headers.get("cache-control")).toBe(CACHE);
    expect(response.headers.has("ratelimit-limit")).toBe(false);
    const authed = await request(`/v1/quotes/${row.id}?ignored=ok`, { token: user.token });
    expect(authed.data).toEqual(response.data);
    const text = await request(`/v1/quotes/${row.id}?format=text`);
    expect(text.status).toBe(200);
    expect(text.raw).toBe(row.content);
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text.headers.get("x-quote-id")).toBe(row.id);
    expect(text.headers.get("cache-control")).toBe(CACHE);
    const seed = await request(`/v1/quotes/${SEED.quote(1, 1)}`);
    expect(seed.status).toBe(200);
    expectQuote(seed.data);
  });

  it("GET distinguishes under_review, removed, deleted, missing and malformed IDs", async () => {
    const review = await fixture(user, { status: "under_review" });
    const visible = await request(`/v1/quotes/${review.id}`);
    expect(visible.status).toBe(200);
    expectQuote(visible.data, { id: review.id, status: "under_review" });
    const removed = await fixture(user, { status: "removed", removed_reason: "spam", removed_at: new Date().toISOString() });
    expectError(await request(`/v1/quotes/${removed.id}?format=text`), "QUOTE_REMOVED", { reason: "spam" }, CACHE);
    const deleted = await fixture(user, { status: "deleted" });
    for (const id of [deleted.id, randomUUID(), "not-a-uuid"]) {
      expectError(await request(`/v1/quotes/${id}?format=text`), "QUOTE_NOT_FOUND", undefined, CACHE);
    }
  });

  it("lists only published quotes without duplicates or omissions across microsecond and ID ties", async () => {
    const base = new Date(Date.UTC(2001, 0, 1) + Math.floor(Math.random() * 300_000_000_000)).toISOString().slice(0, 19);
    const fractions = ["123456", "123456", "123456", "123450", "123100", "122999"];
    const rows = [];
    for (const fraction of fractions) rows.push(await fixture(user, { category_key: "poetry", created_at: `${base}.${fraction}Z` }));
    for (const status of ["under_review", "removed", "deleted"] as const) {
      await fixture(user, { category_key: "poetry", created_at: `${base}.123456Z`, status });
    }
    const expected = rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const own = new Set(expected.map(({ id }) => id));
    const seen: string[] = [];
    let cursor: string | null = encodeCursor({ c: `${base}.124000Z`, i: "ffffffff-ffff-4fff-bfff-ffffffffffff" });
    let finished = false;
    for (let page = 0; page < 100; page += 1) {
      const response: Reply<Quote[]> = await request<Quote[]>(`/v1/quotes?categories=poetry&limit=2&cursor=${cursor}&ignored=ok`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(CACHE);
      expect(response.headers.has("ratelimit-limit")).toBe(false);
      const pagination: Pagination = response.meta.pagination!;
      expect(pagination).toEqual({ limit: 2, next_cursor: pagination.has_more ? expect.any(String) : null, has_more: expect.any(Boolean) });
      for (const quote of response.data) {
        expectQuote(quote);
        expect(quote.category).toEqual({ key: "poetry", name: "詩詞" });
        seen.push(quote.id);
      }
      expectMeta(response, pagination);
      if (!pagination.has_more) {
        expect(pagination.next_cursor).toBeNull();
        finished = true;
        break;
      }
      expect(response.data).toHaveLength(2);
      const last = response.data.at(-1)!;
      const raw = rows.find(({ id }) => id === last.id);
      if (raw) expect(decodeCursor(pagination.next_cursor!)).toEqual({ c: raw.created_at, i: raw.id });
      cursor = pagination.next_cursor;
    }
    expect(finished).toBe(true);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((id) => own.has(id))).toEqual(expected.map(({ id }) => id));
  });

  it("validates list/trending limits, categories, cursors and single-quote format", async () => {
    for (const path of [
      "/v1/quotes?limit=0", "/v1/quotes?limit=101", "/v1/quotes?limit=1.5",
      "/v1/quotes?categories=unknown", "/v1/quotes?categories=",
      "/v1/quotes/trending?limit=0", "/v1/quotes/trending?limit=51",
      "/v1/quotes/trending?categories=poetry,unknown", `/v1/quotes/${SEED.quote(1, 1)}?format=xml`,
    ]) {
      const response = await request(path);
      expectError(response, "VALIDATION_FAILED", { fields: expect.any(Array) });
      expect(response.error!.details!.fields).not.toHaveLength(0);
    }
    for (const cursor of ["bad", "", Buffer.from(JSON.stringify({ c: "x", i: "bad" })).toString("base64url")]) {
      expectError(await request(`/v1/quotes?cursor=${cursor}`), "INVALID_CURSOR");
    }
    for (const limit of [1, 100]) {
      const response = await request<Quote[]>(`/v1/quotes?limit=${limit}`);
      expect(response.status).toBe(200);
      expect(response.meta.pagination!.limit).toBe(limit);
      expect(response.data.length).toBeLessThanOrEqual(limit);
    }
    expect((await request("/v1/quotes")).meta.pagination!.limit).toBe(20);
  });
});

describe("quotes: writes, ownership and editing (ED-01/02/03/07/08/09)", () => {
  let user: TestUser;
  let other: TestUser;
  beforeAll(async () => { other = await newUser(); });
  beforeEach(async () => { user = await newUser(); });

  it("POST normalizes content, returns every Quote field and Location, and records the original and hash", async () => {
    const content = `說😀e\u0301${randomUUID()}`;
    const response = await request("/v1/quotes", {
      method: "POST", token: user.token, body: { content: `  ${content}  `, category: "original", source_from: "  測試來源  " },
    });
    expect(response.status).toBe(201);
    quoteIds.push(response.data.id);
    expectQuote(response.data, {
      content: content.normalize("NFC"), category: { key: "original", name: "原創" }, source_from: "測試來源",
      submitter: { id: user.id, username: expect.any(String), avatar_url: null, deleted: false, verified: false },
      stats: { like_count: 0, favorite_count: 0, comment_count: 0 },
    });
    expectMeta(response);
    expect(response.headers.get("location")).toBe(`/v1/quotes/${response.data.id}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("ratelimit-limit")).toBe("60");
    const { data, error } = await admin.from("quotes").select("original_content, content_hash").eq("id", response.data.id).single();
    if (error) throw error;
    expect(data).toEqual({ original_content: response.data.content, content_hash: toBytea(contentHash(response.data.content)) });
  });

  it("API Keys with quotes:write can create, edit and delete; commit_from stays api", async () => {
    const token = await keyFor(user, ["quotes:read", "quotes:write"]);
    const content = `金鑰提交${randomUUID()}`;
    const created = await request("/v1/quotes", { method: "POST", token, body: { content, category: "ai", source_from: "測試" } });
    expect(created.status).toBe(201);
    quoteIds.push(created.data.id);
    expectQuote(created.data, { content, commit_from: "api", category: { key: "ai", name: "AI" } });
    const edited = await request(`/v1/quotes/${created.data.id}`, { method: "PATCH", token, body: { content: `${content}呀` } });
    expect(edited.status).toBe(200);
    expectMeta(edited);
    expectQuote(edited.data, { ...created.data, content: `${content}呀`, length: content.length + 1, edited_at: expect.stringMatching(ISO) });
    const deleted = await request(`/v1/quotes/${created.data.id}`, { method: "DELETE", token });
    expect(deleted.status).toBe(204);
    expect(deleted.raw).toBe("");
    expect(deleted.headers.get("cache-control")).toBe("no-store");
  });

  it("requires authentication and quotes:write on every write; rejects another user's PATCH and DELETE (ED-02)", async () => {
    const row = await fixture(user);
    const readKey = await keyFor(user);
    for (const [path, method, body] of [
      ["/v1/quotes", "POST", { content: `權限${randomUUID()}`, category: "original", source_from: "來源" }],
      [`/v1/quotes/${row.id}`, "PATCH", { source_from: "來源" }],
      [`/v1/quotes/${row.id}`, "DELETE", undefined],
    ] as const) {
      expectError(await request(path, { method, body }), "AUTHENTICATION_REQUIRED");
      expectError(await request(path, { method, body, token: readKey }), "INSUFFICIENT_SCOPE", { required_scope: "quotes:write" });
    }
    for (const token of [other.token, await keyFor(other, ["quotes:read", "quotes:write"])]) {
      expectError(await request(`/v1/quotes/${row.id}`, { method: "PATCH", token, body: { content: `${row.content}呀` } }), "NOT_RESOURCE_OWNER");
      expectError(await request(`/v1/quotes/${row.id}`, { method: "DELETE", token }), "NOT_RESOURCE_OWNER");
    }
    expect((await request(`/v1/quotes/${row.id}`)).data.content).toBe(row.content);
  });

  it("rejects unknown, empty, null and out-of-bounds bodies rather than silently accepting them", async () => {
    const row = await fixture(user);
    const valid = { content: `驗證${randomUUID()}`, category: "original", source_from: "來源" };
    for (const [path, method, bodies] of [
      ["/v1/quotes", "POST", [{ ...valid, author: "冒名" }, {}, { ...valid, content: "說" }, { ...valid, content: "說".repeat(101) }, { ...valid, source_from: "" }, { ...valid, category: "unknown" }]],
      [`/v1/quotes/${row.id}`, "PATCH", [{}, { author: "冒名" }, { source_from: "合法", author: "冒名" }, { content: null }, { category: null }, { source_from: null }, { content: "說\u0007說" }, { content: "說\u200b說" }]],
    ] as const) {
      for (const body of bodies) expectError(await request(path, { method, token: user.token, body }), "VALIDATION_FAILED", { fields: expect.any(Array) });
    }
  });

  it("enforces Chinese language checks on both POST and PATCH (ED-03)", async () => {
    const row = await fixture(user);
    for (const [content, code, details] of [
      [`hello${randomUUID()}`, "QUOTE_NO_HAN", undefined],
      [`这说这${randomUUID()}`, "QUOTE_NOT_TRADITIONAL", { characters: ["这", "说"] }],
    ] as const) {
      expectError(await request("/v1/quotes", { method: "POST", token: user.token, body: { content, category: "original", source_from: "來源" } }), code, details);
      expectError(await request(`/v1/quotes/${row.id}`, { method: "PATCH", token: user.token, body: { content } }), code, details);
    }
    expect((await request(`/v1/quotes/${row.id}`)).data.content).toBe(row.content);
  });

  it("deduplicates normalized POST and PATCH content, hides removed IDs and releases deleted hashes (ED-03)", async () => {
    const content = `重複內容${randomUUID().replaceAll("-", "")}`;
    const existing = await fixture(user, { content });
    const editable = await fixture(user, { content: `${content}甲` });
    const duplicate = () => request("/v1/quotes", { method: "POST", token: user.token, body: { content: `${content}！`, category: "poetry", source_from: "其他來源" } });
    expectError(await duplicate(), "QUOTE_DUPLICATE", { existing_id: existing.id });
    expectError(await request(`/v1/quotes/${editable.id}`, { method: "PATCH", token: user.token, body: { content } }), "QUOTE_DUPLICATE", { existing_id: existing.id });
    await admin.from("quotes").update({ status: "removed", removed_reason: "spam" }).eq("id", existing.id).throwOnError();
    expectError(await duplicate(), "QUOTE_DUPLICATE", { existing_id: null });
    expectError(await request(`/v1/quotes/${editable.id}`, { method: "PATCH", token: user.token, body: { content } }), "QUOTE_DUPLICATE", { existing_id: null });
    await admin.from("quotes").update({ status: "deleted" }).eq("id", existing.id).throwOnError();
    const allowed = await duplicate();
    expect(allowed.status).toBe(201);
    quoteIds.push(allowed.data.id);
    expect((await request(`/v1/quotes/${editable.id}`)).data.content).toBe(editable.content);
  });

  it("edits content/category/source, retains reactions and comments and writes the before/after audit (ED-01)", async () => {
    const row = await fixture(user);
    await admin.from("quote_likes").insert({ user_id: other.id, quote_id: row.id }).throwOnError();
    await admin.from("quote_favorites").insert({ user_id: other.id, quote_id: row.id }).throwOnError();
    const comment = { quote_id: row.id, user_id: other.id, content: `保留留言${randomUUID()}` };
    await admin.from("comments").insert(comment).throwOnError();
    const body = { content: `${row.content}呀`, category: "literature", source_from: "修改來源" };
    const response = await request(`/v1/quotes/${row.id}`, { method: "PATCH", token: user.token, body });
    expect(response.status).toBe(200);
    expectMeta(response);
    expectQuote(response.data, {
      id: row.id, content: body.content, category: { key: "literature", name: "文學" }, source_from: body.source_from,
      edited_at: expect.stringMatching(ISO), stats: { like_count: 1, favorite_count: 1, comment_count: 1 },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { data: comments, error } = await admin.from("comments").select("content, status").eq("quote_id", row.id);
    if (error) throw error;
    expect(comments).toEqual([{ content: comment.content, status: "visible" }]);
    const { data: logs, error: auditError } = await admin.from("audit_logs").select("actor_id, request_id, metadata").eq("target_id", row.id).eq("action", "quote.edit");
    if (auditError) throw auditError;
    expect(logs).toEqual([{
      actor_id: user.id, request_id: response.meta.request_id,
      metadata: { before: { content: row.content, category: row.category_key, source_from: row.source_from }, after: body },
    }]);
    const { data: stored, error: readError } = await admin.from("quotes").select("original_content, content_hash").eq("id", row.id).single();
    if (readError) throw readError;
    expect(stored).toEqual({ original_content: row.content, content_hash: toBytea(contentHash(body.content)) });
  });

  it("uses the database's 24-hour edit window (ED-07)", async () => {
    const inside = await fixture(user, { created_at: new Date(Date.now() - 23 * 3600_000).toISOString() });
    expect((await request(`/v1/quotes/${inside.id}`, { method: "PATCH", token: user.token, body: { content: `${inside.content}呀` } })).status).toBe(200);
    const expired = await fixture(user, { created_at: new Date(Date.now() - 25 * 3600_000).toISOString() });
    expectError(await request(`/v1/quotes/${expired.id}`, { method: "PATCH", token: user.token, body: { content: `${expired.content}呀` } }), "QUOTE_EDIT_WINDOW_EXPIRED");
    expectError(await request(`/v1/quotes/${expired.id}`, { method: "PATCH", token: user.token, body: { category: "poetry" } }), "QUOTE_EDIT_WINDOW_EXPIRED");
    expect((await request(`/v1/quotes/${expired.id}`)).data.content).toBe(expired.content);
  });

  it("accepts 49%, rejects 50% and 100% without mutation, permits metadata and normalized punctuation edits (ED-08)", async () => {
    const original = randomUUID().replaceAll("-", "") + "天".repeat(68);
    const row = await fixture(user, { content: original });
    const change = (count: number) => original.slice(0, 100 - count) + "地".repeat(count);
    const accepted = await request(`/v1/quotes/${row.id}`, { method: "PATCH", token: user.token, body: { content: change(49) } });
    expect(accepted.status).toBe(200);
    for (const [content, ratio] of [[change(50), 0.5], ["人".repeat(100), 1]] as const) {
      expectError(await request(`/v1/quotes/${row.id}`, { method: "PATCH", token: user.token, body: { content } }), "QUOTE_EDIT_TOO_LARGE", { change_ratio: ratio, limit: 0.5 });
      expect((await request(`/v1/quotes/${row.id}`)).data).toEqual(accepted.data);
    }
    for (const body of [{ category: "poetry" }, { source_from: "單獨修改來源" }]) {
      const response = await request(`/v1/quotes/${row.id}`, { method: "PATCH", token: user.token, body });
      expect(response.status).toBe(200);
      expect(response.data.content).toBe(change(49));
    }
    const ascii = `甲乙${randomUUID().replaceAll("-", "")}`;
    const normalized = await fixture(user, { content: ascii });
    const fullWidth = [...ascii].map((c) => /[a-z0-9]/.test(c) ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c).join("") + "！";
    const response = await request(`/v1/quotes/${normalized.id}`, { method: "PATCH", token: user.token, body: { content: fullWidth } });
    expect(response.status).toBe(200);
    expect(response.data.content).toBe(fullWidth);
  });

  it("measures every edit against immutable original_content rather than the previous edit (ED-09)", async () => {
    const original = randomUUID().replaceAll("-", "") + "天".repeat(68);
    const row = await fixture(user, { content: original });
    for (const count of [10, 20, 30, 40, 50, 10]) {
      const content = original.slice(0, 100 - count) + "地".repeat(count);
      const response = await request(`/v1/quotes/${row.id}`, { method: "PATCH", token: user.token, body: { content } });
      if (count === 50) expectError(response, "QUOTE_EDIT_TOO_LARGE", { change_ratio: 0.5, limit: 0.5 });
      else {
        expect(response.status).toBe(200);
        expect(response.data.content).toBe(content);
      }
      const { data, error } = await admin.from("quotes").select("original_content, content").eq("id", row.id).single();
      if (error) throw error;
      expect(data).toEqual({ original_content: original, content: original.slice(0, 100 - (count === 50 ? 40 : count)) + "地".repeat(count === 50 ? 40 : count) });
    }
  });

  it("maps lifecycle errors for PATCH and DELETE, including open cases on published quotes", async () => {
    const removed = await fixture(user, { status: "removed", removed_reason: "spam" });
    const deleted = await fixture(user, { status: "deleted" });
    for (const method of ["PATCH", "DELETE"]) {
      const options = { method, token: user.token, ...(method === "PATCH" ? { body: { source_from: "來源" } } : {}) };
      expectError(await request(`/v1/quotes/${removed.id}`, options), "QUOTE_REMOVED", { reason: "spam" });
      for (const id of [deleted.id, randomUUID(), "not-a-uuid"]) expectError(await request(`/v1/quotes/${id}`, options), "QUOTE_NOT_FOUND");
    }
    for (const status of ["published", "under_review"] as const) {
      const row = await fixture(user, { status });
      await admin.from("moderation_cases").insert({ target_type: "quote", target_id: row.id }).throwOnError();
      expectError(await request(`/v1/quotes/${row.id}`, { method: "PATCH", token: user.token, body: { content: `${row.content}呀` } }), "QUOTE_HAS_OPEN_CASE");
      expectError(await request(`/v1/quotes/${row.id}`, { method: "DELETE", token: user.token }), "QUOTE_HAS_OPEN_CASE");
      expect((await request(`/v1/quotes/${row.id}`)).data.content).toBe(row.content);
    }
  });

  it("enforces submission suspensions and account bans transactionally; suspension still permits deletion", async () => {
    const row = await fixture(user);
    const until = new Date(Date.now() + 3600_000).toISOString();
    await admin.from("account_standing").update({ suspended_until: until }).eq("user_id", user.id).throwOnError();
    const post = () => request("/v1/quotes", { method: "POST", token: user.token, body: { content: `封禁測試${randomUUID()}`, category: "original", source_from: "來源" } });
    const patch = () => request(`/v1/quotes/${row.id}`, { method: "PATCH", token: user.token, body: { content: `${row.content}呀` } });
    // The account's own API Keys are held back with it
    const key = await keyFor(user, ["quotes:read", "quotes:write"]);
    const postWithKey = () => request("/v1/quotes", { method: "POST", token: key, body: { content: `封禁測試${randomUUID()}`, category: "original", source_from: "來源" } });
    for (const response of [await post(), await patch(), await postWithKey()]) expectError(response, "SUBMISSION_SUSPENDED", { until: expect.any(String) });
    await admin.from("account_standing").update({ status: "banned" }).eq("user_id", user.id).throwOnError();
    for (const response of [await post(), await patch(), await request(`/v1/quotes/${row.id}`, { method: "DELETE", token: user.token })]) expectError(response, "ACCOUNT_BANNED");
    expect((await request(`/v1/quotes/${row.id}`, { token: user.token })).status).toBe(200);
    await admin.from("account_standing").update({ status: "active" }).eq("user_id", user.id).throwOnError();
    const response = await request(`/v1/quotes/${row.id}`, { method: "DELETE", token: user.token });
    expect(response.status).toBe(204);
    expect(response.raw).toBe("");
    expectError(await request(`/v1/quotes/${row.id}`), "QUOTE_NOT_FOUND", undefined, CACHE);
  });
});

describe("trending quotes (TR-01/02/03)", () => {
  it("ranks recent likes plus 48-hour freshness, breaks score ties by date, excludes stale likes and non-published quotes", async () => {
    const user = await newUser();
    const voters = await Promise.all(Array.from({ length: 8 }, () => newUser()));
    const now = Date.now();
    const age = (hours: number) => new Date(now - hours * 3600_000).toISOString();
    const old = await fixture(user, { category_key: "flim", created_at: age(240) });
    const boundary = await fixture(user, { category_key: "flim", created_at: age(48) });
    const fresh = await fixture(user, { category_key: "flim", created_at: age(1) });
    const freshWithoutLikes = await fixture(user, { category_key: "flim", created_at: age(0.1) });
    const expiredWithoutLikes = await fixture(user, { category_key: "flim", created_at: age(49) });
    const stale = await fixture(user, { category_key: "flim", created_at: age(240) });
    // These owned candidates remain testable even when the other cards create fresh quotes.
    for (const [row, count, created_at] of [[old, 8, age(167)], [boundary, 6, age(24)], [fresh, 6, age(24)], [stale, 8, age(192)]] as const) {
      await admin.from("quote_likes").insert(voters.slice(0, count).map(({ id }) => ({ user_id: id, quote_id: row.id, created_at }))).throwOnError();
    }
    const tieOlder = await fixture(user, { category_key: "flim", created_at: age(96) });
    const tieNewer = await fixture(user, { category_key: "flim", created_at: age(80) });
    for (const row of [tieOlder, tieNewer]) await admin.from("quote_likes").insert(voters.slice(0, 6).map(({ id }) => ({ user_id: id, quote_id: row.id }))).throwOnError();
    const hidden = [];
    for (const status of ["under_review", "removed", "deleted"] as const) {
      const row = await fixture(user, { category_key: "flim", created_at: age(1), status });
      hidden.push(row);
      await admin.from("quote_likes").insert(voters.map(({ id }) => ({ user_id: id, quote_id: row.id }))).throwOnError();
    }
    const response = await request<Quote[]>("/v1/quotes/trending?categories=flim&limit=50");
    expect(response.status).toBe(200);
    expectMeta(response);
    expect(response.headers.get("cache-control")).toBe(CACHE);
    expect(response.headers.has("ratelimit-limit")).toBe(false);
    const ids = response.data.map(({ id }) => id);
    const expected = [fresh, old, boundary, tieNewer, tieOlder, freshWithoutLikes].map(({ id }) => id);
    expect(ids.filter((id) => expected.includes(id))).toEqual(expected);
    for (const row of [stale, expiredWithoutLikes, ...hidden]) expect(ids).not.toContain(row.id);
    for (const quote of response.data) {
      expectQuote(quote);
      expect(quote.category).toEqual({ key: "flim", name: "影視" });
    }
    for (const limit of [1, 50]) {
      const limited = await request<Quote[]>(`/v1/quotes/trending?categories=flim&limit=${limit}`);
      expect(limited.status).toBe(200);
      expect(limited.data.length).toBeGreaterThan(0);
      expect(limited.data.length).toBeLessThanOrEqual(limit);
      if (limit === 50) expect(limited.data.map(({ id }) => id).filter((id) => expected.includes(id))).toEqual(expected);
      for (const quote of limited.data) {
        expectQuote(quote);
        expect(quote.category).toEqual({ key: "flim", name: "影視" });
      }
      expectMeta(limited);
    }
    const defaults = await request<Quote[]>("/v1/quotes/trending");
    expect(defaults.status).toBe(200);
    expect(defaults.data.length).toBeLessThanOrEqual(20);
  });
});
