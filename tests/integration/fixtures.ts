import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { toBytea } from "@/lib/auth/api-key";
import { contentHash } from "@/lib/quotes/normalize";
import { admin, call, createUser, type TestUser } from "./helpers";

export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const users: string[] = [];
export const removedFromAuth = new Set<string>();
const quotes: string[] = [];
const cases: string[] = [];

export function trackCase(id: string) {
  cases.push(id);
}

export function trackQuote(id: string) {
  quotes.push(id);
}

export function trackUser(id: string) {
  users.push(id);
}

export async function checked<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> {
  const { data, error } = await query;
  if (error) throw error;
  return data as NonNullable<T>;
}

export async function newUser() {
  const user = await createUser();
  users.push(user.id);
  return user;
}

// Accounts under 7 days old do not count toward the threshold (§9.2)
export async function agedUser() {
  const user = await newUser();
  await checked(admin.from("profiles").update({ created_at: "2020-01-01T00:00:00Z" }).eq("id", user.id));
  return user;
}

export async function newAdmin() {
  const user = await newUser();
  await checked(admin.from("user_roles").insert({ user_id: user.id, role: "admin" }));
  return user;
}

export const fixture = (name: string, args: Record<string, unknown>) => checked(admin.schema("private").rpc(name, args)) as Promise<string>;

export async function newQuote(owner: TestUser, content = `治理測試${randomUUID()}`) {
  const id = await fixture("create_quote", {
    actor: owner.id, content, content_hash: toBytea(contentHash(content)), category: "original", source_from: "整合測試", commit_from: "api",
  });
  quotes.push(id);
  return id;
}

export const newComment = (quoteId: string, author: TestUser) => fixture("create_comment", { actor: author.id, quote_id: quoteId, content: `治理留言${randomUUID()}` });

export async function report(path: string, reporter: TestUser, body: object = { reason: "spam" }) {
  const response = await call(path, { method: "POST", token: reporter.token, body });
  expect(response.status, response.raw).toBe(201);
  return response;
}

export async function openCase(type: "quote" | "comment", id: string) {
  const row = await checked(admin.from("moderation_cases").select("id").eq("target_type", type).eq("target_id", id).eq("status", "open").single()) as { id: string };
  cases.push(row.id);
  return row.id;
}

// One reported quote and its open case
export async function reportedQuote() {
  const owner = await newUser();
  const reporter = await newUser();
  const quoteId = await newQuote(owner);
  await report(`/v1/quotes/${quoteId}/reports`, reporter);
  return { owner, reporter, quoteId, caseId: await openCase("quote", quoteId) };
}

export const resolve = (caseId: string, token: string, body: object) => call(`/v1/admin/cases/${caseId}/resolve`, { method: "POST", token, body });
export const uphold = (caseId: string, token: string) => resolve(caseId, token, { resolution: "uphold", final_reason: "spam", note: "內部備註" });

export function expectError(response: { status: number; error?: { code: string } }, status: number, code: string) {
  expect([response.status, response.error?.code]).toEqual([status, code]);
}

export async function cleanupFixtures() {
  if (users.length) {
    await checked(admin.from("appeals").delete().in("user_id", users));
    await checked(admin.from("sanctions").delete().in("user_id", users));
    await checked(admin.from("violations").delete().in("user_id", users));
  }
  if (cases.length) {
    await checked(admin.from("reports").delete().in("case_id", cases));
    await checked(admin.from("moderation_cases").delete().in("id", cases));
  }
  if (quotes.length) await checked(admin.from("quotes").delete().in("id", quotes));
  if (users.length) {
    await checked(admin.from("profiles").delete().in("id", users));
    for (const id of users) {
      if (!removedFromAuth.has(id)) await admin.auth.admin.deleteUser(id);
    }
  }
}
