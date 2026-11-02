import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKey, toBytea } from "@/lib/auth/api-key";
import { contentHash } from "@/lib/quotes/normalize";
import type { components } from "@/openapi/types";
import { admin, call, createUser, SEED, type TestUser } from "./helpers";

type Comment = components["schemas"]["Comment"];
type ListMeta = components["schemas"]["ListMeta"];
const CACHE = "public, s-maxage=30, stale-while-revalidate=60";
const users: TestUser[] = [];
const quoteIds: string[] = [];
const commentIds: string[] = [];

async function fixtureQuote(user: TestUser, status = "published") {
  const content = `留言測試${randomUUID()}`;
  const { data, error } = await admin.from("quotes").insert({
    content, original_content: content, content_hash: toBytea(contentHash(content)),
    category_key: "other", source_from: "card-3", submitter_id: user.id, commit_from: "api", status,
    ...(status === "removed" ? { removed_reason: "spam" } : {}),
  }).select("id").single();
  if (error) throw error;
  quoteIds.push(data.id);
  return data.id as string;
}

async function fixtureComment(user: TestUser, quoteId: string, fields: Record<string, unknown> = {}) {
  const { data, error } = await admin.from("comments").insert({
    quote_id: quoteId, user_id: user.id, content: `留言${randomUUID()}`, ...fields,
  }).select("id").single();
  if (error) throw error;
  commentIds.push(data.id);
  return data.id as string;
}

async function keyFor(user: TestUser, scopes: string[]) {
  const key = generateKey("test");
  const { error } = await admin.from("api_keys").insert({
    user_id: user.id, name: "card-3", key_prefix: key.prefix, key_hash: toBytea(key.hash), scopes,
  });
  if (error) throw error;
  return key.secret;
}

async function patchComment(id: string, user: TestUser, content = `編輯${randomUUID()}`) {
  return call(`/v1/comments/${id}`, { method: "PATCH", token: user.token, body: { content } });
}

function expectError(response: Awaited<ReturnType<typeof call>>, status: number, code: string) {
  expect([response.status, response.error?.code]).toEqual([status, code]);
}

afterAll(async () => {
  if (commentIds.length) {
    const { error } = await admin.from("moderation_cases").delete().in("target_id", commentIds);
    if (error) throw error;
  }
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

describe("comments", () => {
  let owner: TestUser;
  let other: TestUser;
  let quoteId: string;

  beforeAll(async () => {
    owner = await createUser(); users.push(owner);
    other = await createUser(); users.push(other);
    quoteId = await fixtureQuote(owner);
  });

  it("POST/PATCH/GET/DELETE return the complete contract, normalize text and maintain visible counts", async () => {
    const raw = `  简体 e\u0301\n${randomUUID()}  `;
    const created = await call(`/v1/quotes/${quoteId}/comments`, { method: "POST", token: owner.token, body: { content: raw } });
    expect(created.status).toBe(201);
    const comment = created.data as unknown as Comment;
    commentIds.push(comment.id);
    const profile = await admin.from("profiles").select("username").eq("id", owner.id).single();
    if (profile.error) throw profile.error;
    expect(comment).toEqual({
      id: expect.any(String), quote_id: quoteId, content: raw.trim().normalize("NFC"),
      user: { id: owner.id, username: profile.data.username, avatar_url: null },
      pinned_at: null, edited_at: null, created_at: expect.any(String),
    });
    expect(comment.created_at).toBe(new Date(comment.created_at).toISOString());
    expect(created.meta).toEqual({ request_id: created.headers.get("x-request-id") });
    expect(created.headers.get("cache-control")).toBe("no-store");

    const edited = await patchComment(comment.id, owner, "  edited e\u0301\n简体  ");
    expect(edited.status).toBe(200);
    const changed = edited.data as unknown as Comment;
    expect(changed).toEqual({ ...comment, content: "edited é\n简体", edited_at: expect.any(String) });
    expect(changed.edited_at).toBe(new Date(changed.edited_at!).toISOString());
    const list = await call(`/v1/quotes/${quoteId}/comments?ignored=yes`);
    expect(list.status).toBe(200);
    expect(list.data).toEqual([changed]);
    expect(list.meta).toEqual({ request_id: list.headers.get("x-request-id"), pagination: { limit: 20, next_cursor: null, has_more: false } });
    expect(list.headers.get("cache-control")).toBe(CACHE);
    expect(list.headers.has("ratelimit-limit")).toBe(false);
    expect((await admin.from("quote_stats").select("comment_count").eq("quote_id", quoteId).single()).data).toEqual({ comment_count: 1 });

    const deleted = await call(`/v1/comments/${comment.id}`, { method: "DELETE", token: owner.token });
    expect([deleted.status, deleted.raw]).toEqual([204, ""]);
    expect((await call(`/v1/quotes/${quoteId}/comments`)).data).toEqual([]);
    expect((await admin.from("quote_stats").select("comment_count").eq("quote_id", quoteId).single()).data).toEqual({ comment_count: 0 });
    expectError(await patchComment(comment.id, owner), 404, "COMMENT_NOT_FOUND");
    expectError(await call(`/v1/comments/${comment.id}`, { method: "DELETE", token: owner.token }), 404, "COMMENT_NOT_FOUND");
  });

  it("PN-03: pin appears only on the first page; tied and sub-millisecond timestamps never repeat or disappear", async () => {
    const id = await fixtureQuote(owner);
    const pin = await fixtureComment(owner, id, { created_at: "2026-01-01T00:00:00Z", pinned_at: "2026-01-02T00:00:00Z" });
    const ordinary = [];
    for (const created_at of ["2026-01-03T00:00:00.123456Z", "2026-01-03T00:00:00.123455Z", "2026-01-03T00:00:00.123455Z"]) {
      ordinary.push(await fixtureComment(owner, id, { created_at }));
    }
    await fixtureComment(owner, id, { status: "removed" });
    await fixtureComment(owner, id, { status: "deleted" });
    const expected = await admin.from("comments").select("id, created_at").eq("quote_id", id).eq("status", "visible").is("pinned_at", null)
      .order("created_at", { ascending: false }).order("id", { ascending: false });
    if (expected.error) throw expected.error;
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let page = 0; page < ordinary.length; page += 1) {
      const response = await call(`/v1/quotes/${id}/comments?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(response.status).toBe(200);
      const rows = response.data as unknown as Comment[];
      const { pagination } = response.meta as unknown as ListMeta;
      expect(rows.map((row) => row.id)).toEqual(page === 0 ? [pin, expected.data[page]!.id] : [expected.data[page]!.id]);
      expect(pagination).toEqual({ limit: 1, has_more: page < ordinary.length - 1, next_cursor: page < ordinary.length - 1 ? expect.any(String) : null });
      if (pagination.next_cursor) {
        expect(JSON.parse(Buffer.from(pagination.next_cursor, "base64url").toString())).toEqual({ c: expected.data[page]!.created_at, i: expected.data[page]!.id });
      }
      seen.push(...rows.map((row) => row.id));
      cursor = pagination.next_cursor;
    }
    expect(new Set(seen).size).toBe(ordinary.length + 1);
    expect(seen).toEqual([pin, ...expected.data.map((row) => row.id)]);
    const pinOnly = await fixtureQuote(owner);
    const lone = await fixtureComment(owner, pinOnly, { pinned_at: new Date().toISOString() });
    const response = await call(`/v1/quotes/${pinOnly}/comments?limit=1`);
    expect((response.data as unknown as Comment[]).map((row) => row.id)).toEqual([lone]);
    expect((response.meta as unknown as ListMeta).pagination).toEqual({ limit: 1, next_cursor: null, has_more: false });
  });

  it("rejects missing/removed/deleted quote IDs on GET and POST, preserving the removal reason", async () => {
    const removed = await fixtureQuote(owner, "removed");
    const deleted = await fixtureQuote(owner, "deleted");
    for (const method of ["GET", "POST"]) {
      for (const id of ["not-a-uuid", randomUUID(), deleted]) {
        const response = await call(`/v1/quotes/${id}/comments`, { method, token: owner.token, ...(method === "POST" ? { body: { content: "valid" } } : {}) });
        expectError(response, 404, "QUOTE_NOT_FOUND");
      }
      const response = await call(`/v1/quotes/${removed}/comments`, { method, token: owner.token, ...(method === "POST" ? { body: { content: "valid" } } : {}) });
      expectError(response, 410, "QUOTE_REMOVED");
      expect(response.error?.details).toEqual({ reason: "spam" });
    }
    const review = await fixtureQuote(owner, "under_review");
    expect((await call(`/v1/quotes/${review}/comments`, { method: "POST", token: owner.token, body: { content: `review ${randomUUID()}` } })).status).toBe(201);
    expect((await call(`/v1/quotes/${SEED.quote(1, 1)}/comments`)).status).toBe(200);
  });

  it("BOLA: even the quote submitter cannot change another user's comment; wording uses the comment variant", async () => {
    const id = await fixtureComment(other, quoteId);
    for (const method of ["PATCH", "DELETE"]) {
      const response = await call(`/v1/comments/${id}`, { method, token: owner.token, ...(method === "PATCH" ? { body: { content: "forbidden" } } : {}) });
      expectError(response, 403, "NOT_RESOURCE_OWNER");
      expect(JSON.parse(response.raw).error.message).toBe("只能變更自己的留言");
    }
    for (const id of [randomUUID(), "invalid"]) {
      expectError(await patchComment(id, owner), 404, "COMMENT_NOT_FOUND");
      expectError(await call(`/v1/comments/${id}`, { method: "DELETE", token: owner.token }), 404, "COMMENT_NOT_FOUND");
    }
  });

  it("requires comments:write for all three mutations and accepts a scoped key", async () => {
    const id = await fixtureComment(owner, quoteId);
    const read = await keyFor(owner, ["quotes:read"]);
    const write = await keyFor(owner, ["quotes:read", "comments:write"]);
    for (const [method, path] of [["POST", `/v1/quotes/${quoteId}/comments`], ["PATCH", `/v1/comments/${id}`], ["DELETE", `/v1/comments/${id}`]]) {
      const options = { method, ...(method === "DELETE" ? {} : { body: { content: "key comment" } }) };
      expectError(await call(path!, options), 401, "AUTHENTICATION_REQUIRED");
      const denied = await call(path!, { ...options, token: read });
      expectError(denied, 403, "INSUFFICIENT_SCOPE");
      expect(denied.error?.details).toEqual({ required_scope: "comments:write" });
      expect((await call(path!, { ...options, token: write })).status).toBe(method === "POST" ? 201 : method === "PATCH" ? 200 : 204);
    }
  });

  it("ED-06: edits within 20 minutes succeed; expired edits fail without changing the row", async () => {
    const recent = await fixtureComment(owner, quoteId, { created_at: new Date(Date.now() - 19 * 60_000).toISOString() });
    expect((await patchComment(recent, owner)).status).toBe(200);
    const old = await fixtureComment(owner, quoteId, { content: "unchanged", created_at: new Date(Date.now() - 21 * 60_000).toISOString() });
    expectError(await patchComment(old, owner), 409, "COMMENT_EDIT_WINDOW_EXPIRED");
    expect((await admin.from("comments").select("content, edited_at").eq("id", old).single()).data).toEqual({ content: "unchanged", edited_at: null });
  });

  it("open cases block PATCH and DELETE; hidden comments are not found", async () => {
    const id = await fixtureComment(owner, quoteId);
    const { error } = await admin.from("moderation_cases").insert({ target_type: "comment", target_id: id });
    if (error) throw error;
    expectError(await patchComment(id, owner), 409, "COMMENT_HAS_OPEN_CASE");
    expectError(await call(`/v1/comments/${id}`, { method: "DELETE", token: owner.token }), 409, "COMMENT_HAS_OPEN_CASE");
    const hidden = await fixtureComment(owner, quoteId, { status: "removed" });
    expectError(await patchComment(hidden, owner), 404, "COMMENT_NOT_FOUND");
    expectError(await call(`/v1/comments/${hidden}`, { method: "DELETE", token: owner.token }), 404, "COMMENT_NOT_FOUND");
  });

  it("ED-05: suspended users cannot create/edit but can delete; banned users cannot mutate", async () => {
    const user = await createUser(); users.push(user);
    const id = await fixtureComment(user, quoteId);
    const until = new Date(Date.now() + 3600_000).toISOString();
    const suspended = await admin.from("account_standing").update({ suspended_until: until }).eq("user_id", user.id);
    if (suspended.error) throw suspended.error;
    for (const response of [
      await patchComment(id, user),
      await call(`/v1/quotes/${quoteId}/comments`, { method: "POST", token: user.token, body: { content: "suspended" } }),
    ]) {
      expectError(response, 403, "COMMENTING_SUSPENDED");
      expect(response.error?.details).toEqual({ until });
    }
    expect((await call(`/v1/comments/${id}`, { method: "DELETE", token: user.token })).status).toBe(204);
    const bannedId = await fixtureComment(user, quoteId);
    const banned = await admin.from("account_standing").update({ status: "banned" }).eq("user_id", user.id);
    if (banned.error) throw banned.error;
    expectError(await patchComment(bannedId, user), 403, "ACCOUNT_BANNED");
    expectError(await call(`/v1/comments/${bannedId}`, { method: "DELETE", token: user.token }), 403, "ACCOUNT_BANNED");
    expectError(await call(`/v1/quotes/${quoteId}/comments`, { method: "POST", token: user.token, body: { content: "banned" } }), 403, "ACCOUNT_BANNED");
  });

  it("validates both bodies strictly with Unicode code-point boundaries and validates list queries", async () => {
    const id = await fixtureComment(owner, quoteId);
    for (const [method, path] of [["POST", `/v1/quotes/${quoteId}/comments`], ["PATCH", `/v1/comments/${id}`]]) {
      for (const body of [{}, { content: " " }, { content: 1 }, { content: "x", author: owner.id }, { content: "x\u0000y" }, { content: "😀".repeat(501) }]) {
        expectError(await call(path!, { method, token: owner.token, body }), 400, "VALIDATION_FAILED");
      }
      expect((await call(path!, { method, token: owner.token, body: { content: "😀".repeat(500) } })).status).toBe(method === "POST" ? 201 : 200);
    }
    expectError(await call(`/v1/quotes/${quoteId}/comments?cursor=invalid`), 400, "INVALID_CURSOR");
    const badTime = Buffer.from(JSON.stringify({ c: "not-a-timestamp", i: randomUUID() })).toString("base64url");
    expectError(await call(`/v1/quotes/${quoteId}/comments?cursor=${badTime}`), 400, "INVALID_CURSOR");
    for (const limit of ["0", "101", "1.5"]) expectError(await call(`/v1/quotes/${quoteId}/comments?limit=${limit}`), 400, "VALIDATION_FAILED");
  });
});
