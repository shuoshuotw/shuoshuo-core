import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import * as likes from "@/app/v1/quotes/[id]/like/route";
import * as favorites from "@/app/v1/quotes/[id]/favorite/route";
import { generateKey, toBytea } from "@/lib/auth/api-key";
import type { Database } from "@/lib/database.types";
import { contentHash } from "@/lib/quotes/normalize";
import { draw, resetPool } from "@/lib/quotes/pool";
import { QUOTE_SELECT, toQuote, type QuoteRow } from "@/lib/quotes/serialize";
import { admin, call, createUser, SEED, type TestUser } from "./helpers";

const users: string[] = [];
const quotes: string[] = [];
const cases: string[] = [];
type Functions = Database["private"]["Functions"];
type Reply = Awaited<ReturnType<typeof call>>;

async function checked<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function one<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> {
  const data = await checked(query);
  if (data === null || data === undefined) throw new Error("Expected one fixture row");
  return data as NonNullable<T>;
}

async function fixtureRpc<Name extends keyof Functions>(name: Name, args: Functions[Name]["Args"]) {
  return await checked(admin.schema("private").rpc(name, args)) as Functions[Name]["Returns"];
}

async function newUser() {
  const user = await createUser(`卡二${randomUUID().replaceAll("-", "").slice(0, 24)}`);
  users.push(user.id);
  return user;
}

async function newQuote(owner: TestUser) {
  const content = `卡二測試說說${randomUUID()}`;
  const id = await fixtureRpc("create_quote", {
    actor: owner.id, content, content_hash: toBytea(contentHash(content)),
    category: "original", source_from: "整合測試", commit_from: "api",
  });
  quotes.push(id);
  return id;
}

async function newComment(quoteId: string, author: TestUser) {
  return fixtureRpc("create_comment", { actor: author.id, quote_id: quoteId, content: `卡二留言${randomUUID()}` });
}

async function newKey(user: TestUser, scopes: string[]) {
  const key = generateKey("test");
  await checked(admin.from("api_keys").insert({
    user_id: user.id, name: "card-2", key_prefix: key.prefix, key_hash: toBytea(key.hash), scopes: ["quotes:read", ...scopes],
  }));
  return key.secret;
}

function expectSuccess(response: Reply, data: unknown, limit = 60) {
  expect(response.status, response.raw).toBe(200);
  const requestId = response.headers.get("x-request-id");
  expect(requestId).toMatch(/^req_/);
  expect(JSON.parse(response.raw)).toEqual({ data, meta: { request_id: requestId } });
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("ratelimit-limit")).toBe(String(limit));
  expect(response.headers.get("ratelimit-remaining")).toMatch(/^\d+$/);
  expect(response.headers.get("ratelimit-reset")).toMatch(/^\d+$/);
}

function expectError(response: Reply, status: number, code: string, details?: Record<string, unknown>) {
  expect(response.status, response.raw).toBe(status);
  expect(JSON.parse(response.raw)).toEqual({ error: {
    code, status, message: expect.any(String), message_en: expect.any(String),
    ...(details ? { details } : {}), docs_url: `https://docs.shuoshuotw.xyz/errors#${code}`,
    request_id: response.headers.get("x-request-id"),
  } });
  expect(response.headers.get("cache-control")).toBe("no-store");
}

afterAll(async () => {
  resetPool();
  if (cases.length) {
    await checked(admin.from("reports").delete().in("case_id", cases));
    await checked(admin.from("violations").delete().in("case_id", cases));
    await checked(admin.from("moderation_cases").delete().in("id", cases));
  }
  if (quotes.length) await checked(admin.from("quotes").delete().in("id", quotes));
  if (users.length) {
    await checked(admin.from("profiles").delete().in("id", users));
    for (const id of users) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
    }
  }
});

const reactions = [
  { kind: "like", active: "liked", count: "like_count", table: "quote_likes", handlers: likes },
  { kind: "favorite", active: "favorited", count: "favorite_count", table: "quote_favorites", handlers: favorites },
] as const;

describe.each(reactions)("$kind", ({ kind, active, count, table, handlers }) => {
  const path = (id: string) => `/v1/quotes/${id}/${kind}`;
  const state = (id: string, value: boolean, n: number) => ({ quote_id: id, [active]: value, [count]: n });

  it("is idempotent for JWT and scoped keys, counts distinct users and changes only the caller's reaction", async () => {
    const owner = await newUser();
    const other = await newUser();
    const quoteId = await newQuote(owner);
    const key = await newKey(other, ["reactions:write"]);
    for (let i = 0; i < 2; i += 1) {
      expectSuccess(await call(path(quoteId), { method: "DELETE", token: owner.token }), state(quoteId, false, 0));
    }
    expectSuccess(await call(path(quoteId.toUpperCase()), { method: "PUT", token: owner.token }), state(quoteId, true, 1));
    expectSuccess(await call(path(quoteId), { method: "PUT", token: owner.token }), state(quoteId, true, 1));
    for (let i = 0; i < 2; i += 1) {
      expectSuccess(await call(path(quoteId), { method: "PUT", token: key }), state(quoteId, true, 2), 120);
    }
    for (let i = 0; i < 2; i += 1) {
      expectSuccess(await call(path(quoteId), { method: "DELETE", token: owner.token }), state(quoteId, false, 1));
    }
    expect(await checked(admin.from(table).select("user_id").eq("quote_id", quoteId))).toEqual([{ user_id: other.id }]);
    for (let i = 0; i < 2; i += 1) {
      expectSuccess(await call(path(quoteId), { method: "DELETE", token: key }), state(quoteId, false, 0), 120);
    }
    expect(await checked(admin.from("quote_stats").select("like_count, favorite_count, comment_count").eq("quote_id", quoteId).single()))
      .toEqual({ like_count: 0, favorite_count: 0, comment_count: 0 });
  });

  it("allows suspended callers and under-review quotes, but blocks banned callers without changing their existing reaction", async () => {
    const owner = await newUser();
    const quoteId = await newQuote(owner);
    await checked(admin.from("account_standing").update({ suspended_until: new Date(Date.now() + 86_400_000).toISOString() }).eq("user_id", owner.id));
    await checked(admin.from("quotes").update({ status: "under_review", under_review_since: new Date().toISOString() }).eq("id", quoteId));
    expectSuccess(await call(path(quoteId), { method: "PUT", token: owner.token }), state(quoteId, true, 1));
    expectSuccess(await call(path(quoteId), { method: "DELETE", token: owner.token }), state(quoteId, false, 0));
    expectSuccess(await call(path(quoteId), { method: "PUT", token: owner.token }), state(quoteId, true, 1));
    await checked(admin.from("account_standing").update({ status: "banned" }).eq("user_id", owner.id));
    for (const method of ["PUT", "DELETE"]) {
      expectError(await call(path(quoteId), { method, token: owner.token }), 403, "ACCOUNT_BANNED");
    }
    expect(await checked(admin.from(table).select("user_id").eq("quote_id", quoteId))).toEqual([{ user_id: owner.id }]);
    expect((await one(admin.from("quote_stats").select("like_count, favorite_count").eq("quote_id", quoteId).single()))[count]).toBe(1);
  });

  it("returns resource errors for malformed, missing, deleted and removed quotes on both methods", async () => {
    const owner = await newUser();
    const quoteId = await newQuote(owner);
    for (const method of ["PUT", "DELETE"]) {
      for (const id of ["not-a-uuid", randomUUID()]) expectError(await call(path(id), { method, token: owner.token }), 404, "QUOTE_NOT_FOUND");
    }
    await checked(admin.from("quotes").update({ status: "removed", removed_reason: "spam" }).eq("id", quoteId));
    for (const method of ["PUT", "DELETE"]) {
      expectError(await call(path(quoteId), { method, token: owner.token }), 410, "QUOTE_REMOVED", { reason: "spam" });
    }
    await checked(admin.from("quotes").update({ status: "deleted" }).eq("id", quoteId));
    for (const method of ["PUT", "DELETE"]) expectError(await call(path(quoteId), { method, token: owner.token }), 404, "QUOTE_NOT_FOUND");
    expect(await checked(admin.from(table).select("user_id").eq("quote_id", quoteId))).toEqual([]);
  });

  it("rejects missing reactions:write on both methods without writing", async () => {
    const owner = await newUser();
    const quoteId = await newQuote(owner);
    const key = await newKey(owner, ["comments:write"]);
    for (const method of ["PUT", "DELETE"]) {
      expectError(await call(path(quoteId), { method, token: key }), 403, "INSUFFICIENT_SCOPE", { required_scope: "reactions:write" });
    }
    expect(await checked(admin.from(table).select("user_id").eq("quote_id", quoteId))).toEqual([]);
  });

  it("keeps concurrent duplicate reactions at one row and a nonnegative count", async () => {
    const owner = await newUser();
    const quoteId = await newQuote(owner);
    for (const [method, value, n] of [["PUT", true, 1], ["DELETE", false, 0]] as const) {
      const responses = await Promise.all(Array.from({ length: 4 }, () => call(path(quoteId), { method, token: owner.token })));
      for (const response of responses) expectSuccess(response, state(quoteId, value, n));
      expect((await one(admin.from("quote_stats").select("like_count, favorite_count").eq("quote_id", quoteId).single()))[count]).toBe(n);
      expect(await checked(admin.from(table).select("user_id").eq("quote_id", quoteId))).toEqual(value ? [{ user_id: owner.id }] : []);
    }
  });

  it("synchronizes the real RPC result into the local pool", async () => {
    // Exercise the handler's pool in this process; HTTP requests use the separate Core process's singleton.
    if (existsSync(".env.local")) process.loadEnvFile(".env.local");
    const owner = await newUser();
    const quoteId = await newQuote(owner);
    const row = await checked(admin.from("quotes").select(QUOTE_SELECT).eq("id", quoteId).single());
    resetPool({ original: { quotes: [toQuote(row as unknown as QuoteRow)], total: 1 } }, Date.now());
    const invoke = (method: "PUT" | "DELETE") => handlers[method](new Request(`http://localhost${path(quoteId)}`, {
      method, headers: { authorization: `Bearer ${owner.token}`, "cf-connecting-ip": "127.0.0.1" },
    }), { params: Promise.resolve({ id: quoteId }) });
    try {
      for (const [method, n] of [["PUT", 1], ["DELETE", 0]] as const) {
        const response = await invoke(method);
        expect(response.status, await response.text()).toBe(200);
        expect(draw({ categories: ["original"] })?.stats[count]).toBe(n);
      }
    } finally {
      resetPool();
    }
  });
});

describe("comment pins", () => {
  const path = (id: string) => `/v1/comments/${id}/pin`;

  it("PN-01: the quote owner can pin and unpin idempotently with JWT and scoped key", async () => {
    const owner = await newUser();
    const author = await newUser();
    const quoteId = await newQuote(owner);
    const commentId = await newComment(quoteId, author);
    const key = await newKey(owner, ["comments:write"]);
    const first = await call(path(commentId.toUpperCase()), { method: "PUT", token: owner.token });
    const { pinned_at } = JSON.parse(first.raw).data;
    expect(pinned_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expectSuccess(first, { comment_id: commentId, pinned_at });
    expectSuccess(await call(path(commentId), { method: "PUT", token: key }), { comment_id: commentId, pinned_at }, 120);
    const stored = await one(admin.from("comments").select("pinned_at").eq("id", commentId).single());
    expect(new Date(stored.pinned_at).toISOString()).toBe(pinned_at);
    for (const [token, limit] of [[owner.token, 60], [key, 120]] as const) {
      expectSuccess(await call(path(commentId), { method: "DELETE", token }), { comment_id: commentId, pinned_at: null }, limit);
    }
    expect(await checked(admin.from("comments").select("pinned_at").eq("id", commentId).single())).toEqual({ pinned_at: null });
  });

  it("PN-01: rejects the comment author, outsider and admin on both methods, including at the RPC boundary", async () => {
    const owner = await newUser();
    const author = await newUser();
    const outsider = await newUser();
    const moderator = await newUser();
    await checked(admin.from("user_roles").insert({ user_id: moderator.id, role: "admin" }));
    const quoteId = await newQuote(owner);
    const commentId = await newComment(quoteId, author);
    const pinned = await call(path(commentId), { method: "PUT", token: owner.token });
    expect(pinned.status, pinned.raw).toBe(200);
    const before = await checked(admin.from("comments").select("pinned_at").eq("id", commentId).single());
    for (const user of [author, outsider, moderator]) {
      for (const method of ["PUT", "DELETE"]) {
        const response = await call(path(commentId), { method, token: user.token });
        expectError(response, 403, "NOT_RESOURCE_OWNER");
        expect(JSON.parse(response.raw).error).toMatchObject({
          message: "只有說說提交者可置頂", message_en: "Only the quote submitter can pin comments",
        });
        const { error } = await admin.schema("private").rpc("set_comment_pin", { actor: user.id, comment_id: commentId, pinned: method === "PUT" });
        expect(error).toMatchObject({ code: "P0001", message: "NOT_RESOURCE_OWNER" });
      }
    }
    expect(await checked(admin.from("comments").select("pinned_at").eq("id", commentId).single())).toEqual(before);
  });

  it("PN-02: replaces the previous pin and serializes concurrent pins without disturbing other quotes", async () => {
    const owner = await newUser();
    const quoteId = await newQuote(owner);
    const otherQuote = await newQuote(owner);
    const first = await newComment(quoteId, owner);
    const second = await newComment(quoteId, owner);
    const unrelated = await newComment(otherQuote, owner);
    for (const id of [unrelated, first, second]) {
      const response = await call(path(id), { method: "PUT", token: owner.token });
      expectSuccess(response, { comment_id: id, pinned_at: expect.stringMatching(/\.\d{3}Z$/) });
    }
    expect(await checked(admin.from("comments").select("id").eq("quote_id", quoteId).not("pinned_at", "is", null))).toEqual([{ id: second }]);
    expectSuccess(await call(path(first), { method: "DELETE", token: owner.token }), { comment_id: first, pinned_at: null });
    expect(await checked(admin.from("comments").select("id").eq("quote_id", quoteId).not("pinned_at", "is", null))).toEqual([{ id: second }]);
    const responses = await Promise.all([first, second].map((id) => call(path(id), { method: "PUT", token: owner.token })));
    responses.forEach((response, i) => expectSuccess(response, { comment_id: [first, second][i], pinned_at: expect.stringMatching(/\.\d{3}Z$/) }));
    const pinned = await one(admin.from("comments").select("id").eq("quote_id", quoteId).not("pinned_at", "is", null));
    expect(pinned).toHaveLength(1);
    expect([first, second]).toContain(pinned[0]!.id);
    expect(await checked(admin.from("comments").select("id").eq("quote_id", otherQuote).not("pinned_at", "is", null))).toEqual([{ id: unrelated }]);
  });

  it("PN-04: deleting or moderating a pinned comment clears its pin and both methods then return 404", async () => {
    const owner = await newUser();
    const author = await newUser();
    const moderator = await newUser();
    await checked(admin.from("user_roles").insert({ user_id: moderator.id, role: "admin" }));
    const quoteId = await newQuote(owner);
    for (const status of ["deleted", "removed"] as const) {
      const commentId = await newComment(quoteId, author);
      const response = await call(path(commentId), { method: "PUT", token: owner.token });
      expectSuccess(response, { comment_id: commentId, pinned_at: expect.any(String) });
      // These sibling HTTP endpoints belong to other cards; use their existing transaction functions.
      if (status === "deleted") {
        await fixtureRpc("delete_comment", { actor: author.id, comment_id: commentId });
      } else {
        const row = await one(admin.from("moderation_cases").insert({ target_type: "comment", target_id: commentId }).select("id").single());
        cases.push(row.id);
        await fixtureRpc("resolve_case", { actor: moderator.id, case_id: row.id, resolution: "uphold", final_reason: "spam" });
      }
      expect(await checked(admin.from("comments").select("status, pinned_at").eq("id", commentId).single())).toEqual({ status, pinned_at: null });
      for (const method of ["PUT", "DELETE"]) expectError(await call(path(commentId), { method, token: owner.token }), 404, "COMMENT_NOT_FOUND");
    }
  });

  it("enforces comments:write, resource IDs and the suspended/banned capability matrix", async () => {
    const owner = await newUser();
    const quoteId = await newQuote(owner);
    const commentId = await newComment(quoteId, owner);
    const key = await newKey(owner, ["reactions:write"]);
    for (const method of ["PUT", "DELETE"]) {
      expectError(await call(path(commentId), { method, token: key }), 403, "INSUFFICIENT_SCOPE", { required_scope: "comments:write" });
      for (const id of ["not-a-uuid", randomUUID()]) expectError(await call(path(id), { method, token: owner.token }), 404, "COMMENT_NOT_FOUND");
    }
    await checked(admin.from("account_standing").update({ suspended_until: new Date(Date.now() + 86_400_000).toISOString() }).eq("user_id", owner.id));
    expectSuccess(await call(path(commentId), { method: "PUT", token: owner.token }), { comment_id: commentId, pinned_at: expect.any(String) });
    expectSuccess(await call(path(commentId), { method: "DELETE", token: owner.token }), { comment_id: commentId, pinned_at: null });
    expectSuccess(await call(path(commentId), { method: "PUT", token: owner.token }), { comment_id: commentId, pinned_at: expect.any(String) });
    const before = await checked(admin.from("comments").select("pinned_at").eq("id", commentId).single());
    await checked(admin.from("account_standing").update({ status: "banned" }).eq("user_id", owner.id));
    for (const method of ["PUT", "DELETE"]) expectError(await call(path(commentId), { method, token: owner.token }), 403, "ACCOUNT_BANNED");
    expect(await checked(admin.from("comments").select("pinned_at").eq("id", commentId).single())).toEqual(before);
  });
});

describe("authentication on every card-2 operation", () => {
  it.each(["PUT", "DELETE"])("rejects anonymous %s before touching data", async (method) => {
    for (const path of [`/v1/quotes/${SEED.quote(1, 1)}/like`, `/v1/quotes/${SEED.quote(1, 1)}/favorite`, `/v1/comments/${randomUUID()}/pin`]) {
      expectError(await call(path, { method }), 401, "AUTHENTICATION_REQUIRED");
    }
  });
});
