import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agedUser, checked, cleanupFixtures, expectError, ISO, newAdmin, newComment, newQuote, newUser, openCase, removedFromAuth, report, reportedQuote, resolve, trackCase, trackUser, uphold } from "./fixtures";
import { admin, call, createUser, type TestUser } from "./helpers";

afterAll(cleanupFixtures);

const standing = (id: string) => checked(admin.from("account_standing").select("status, strike_count").eq("user_id", id).single());

describe("concurrency", () => {
  let moderator: TestUser;
  beforeAll(async () => {
    moderator = await newAdmin();
  });

  it("GOV-02: two admins resolving one case: one wins, the other gets 409, and the strike counts once", async () => {
    const { owner, caseId } = await reportedQuote();
    const responses = await Promise.all([uphold(caseId, moderator.token), uphold(caseId, moderator.token)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await standing(owner.id)).toEqual({ status: "active", strike_count: 1 });
    expect(await checked(admin.from("violations").select("id").eq("user_id", owner.id))).toHaveLength(1);
  });

  it("GOV-03: four cases against one user resolved at once add up and ban them", async () => {
    const owner = await newUser();
    const caseIds = [];
    for (let i = 0; i < 4; i += 1) {
      const quoteId = await newQuote(owner);
      await report(`/v1/quotes/${quoteId}/reports`, await newUser());
      caseIds.push(await openCase("quote", quoteId));
    }
    const responses = await Promise.all(caseIds.map((id) => uphold(id, moderator.token)));
    for (const response of responses) expect(response.status, response.raw).toBe(200);
    expect(await standing(owner.id)).toEqual({ status: "banned", strike_count: 4 });
    const kinds = await checked(admin.from("sanctions").select("kind").eq("user_id", owner.id)) as { kind: string }[];
    expect(kinds.filter(({ kind }) => kind === "account_ban")).toHaveLength(1);
  });

  it("GOV-15: dismissing while the third report arrives never leaves under_review without an open case", async () => {
    for (let round = 0; round < 3; round += 1) {
      const owner = await newUser();
      const quoteId = await newQuote(owner);
      const path = `/v1/quotes/${quoteId}/reports`;
      for (let i = 0; i < 2; i += 1) await report(path, await agedUser());
      const caseId = await openCase("quote", quoteId);
      const third = await agedUser();
      const [dismissed, reported] = await Promise.all([
        resolve(caseId, moderator.token, { resolution: "dismiss" }),
        call(path, { method: "POST", token: third.token, body: { reason: "spam" } }),
      ]);
      expect(dismissed.status, dismissed.raw).toBe(200);
      expect(reported.status, reported.raw).toBe(201);
      const { status } = await checked(admin.from("quotes").select("status").eq("id", quoteId).single()) as { status: string };
      const open = await checked(admin.from("moderation_cases").select("id").eq("target_id", quoteId).eq("status", "open")) as { id: string }[];
      open.forEach(({ id }) => trackCase(id));
      if (status === "under_review") expect(open).toHaveLength(1);
    }
  });

  it("SEC-08a: no key created during a ban survives it", async () => {
    const user = await newUser();
    const responses = await Promise.all([
      ...Array.from({ length: 5 }, (_, i) => call("/v1/me/api-keys", { method: "POST", token: user.token, body: { name: `併發${i}` } })),
      call(`/v1/admin/users/${user.id}/sanctions`, { method: "POST", token: moderator.token, body: { kind: "account_ban", reason: "併發封號" } }),
      ...Array.from({ length: 5 }, (_, i) => call("/v1/me/api-keys", { method: "POST", token: user.token, body: { name: `併發後${i}` } })),
    ]);
    for (const response of responses) expect([201, 403], response.raw).toContain(response.status);
    expect(await checked(admin.from("api_keys").select("id").eq("user_id", user.id).is("revoked_at", null))).toEqual([]);
  });
});

describe("governance rules", () => {
  let moderator: TestUser;
  beforeAll(async () => {
    moderator = await newAdmin();
  });

  it("GOV-04: a failure inside resolve_case rolls everything back", async () => {
    const { owner, quoteId, caseId } = await reportedQuote();
    // violations.reason is not null, so uphold fails after the case and report updates have run
    const { error } = await admin.schema("private").rpc("resolve_case", { actor: moderator.id, case_id: caseId, resolution: "uphold" });
    expect(error).toBeTruthy();
    expect(await checked(admin.from("moderation_cases").select("status").eq("id", caseId).single())).toEqual({ status: "open" });
    expect(await checked(admin.from("reports").select("status").eq("case_id", caseId))).toEqual([{ status: "pending" }]);
    expect(await checked(admin.from("quotes").select("status").eq("id", quoteId).single())).toEqual({ status: "published" });
    expect(await standing(owner.id)).toEqual({ status: "active", strike_count: 0 });
  });

  it("GOV-07: a reporter with 5 recently dismissed reports stops counting toward the threshold", async () => {
    const reporter = await agedUser();
    const owner = await newUser();
    for (let i = 0; i < 5; i += 1) {
      const row = await checked(admin.from("moderation_cases").insert({ target_type: "quote", target_id: randomUUID(), status: "resolved", resolution: "dismiss", resolved_at: new Date().toISOString() }).select("id, target_id").single()) as { id: string; target_id: string };
      trackCase(row.id);
      await checked(admin.from("reports").insert({ case_id: row.id, target_type: "quote", target_id: row.target_id, reporter_id: reporter.id, reason: "spam", status: "dismissed" }));
    }
    const quoteId = await newQuote(owner);
    await report(`/v1/quotes/${quoteId}/reports`, reporter);
    await openCase("quote", quoteId);
    expect(await checked(admin.from("reports").select("is_discounted").eq("target_id", quoteId))).toEqual([{ is_discounted: true }]);
    expect(await checked(admin.from("moderation_cases").select("effective_reporter_count").eq("target_id", quoteId))).toEqual([{ effective_reporter_count: 0 }]);
  });

  it("GOV-08: there is no copyright reason and no remove_no_strike resolution", async () => {
    const { caseId } = await reportedQuote();
    expectError(await resolve(caseId, moderator.token, { resolution: "remove_no_strike" }), 400, "VALIDATION_FAILED");
    expectError(await resolve(caseId, moderator.token, { resolution: "uphold", final_reason: "copyright" }), 400, "VALIDATION_FAILED");
  });

  it("GOV-17: an expired review returns to published, keeps its case open and is audited", async () => {
    const { quoteId, caseId } = await reportedQuote();
    await checked(admin.from("quotes").update({ status: "under_review", under_review_since: new Date(Date.now() - 8 * 86_400_000).toISOString() }).eq("id", quoteId));
    const { error } = await admin.schema("private").rpc("restore_expired_reviews");
    expect(error).toBeNull();
    expect(await checked(admin.from("quotes").select("status, under_review_since").eq("id", quoteId).single())).toEqual({ status: "published", under_review_since: null });
    expect(await checked(admin.from("moderation_cases").select("status").eq("id", caseId).single())).toEqual({ status: "open" });
    expect(await checked(admin.from("audit_logs").select("action").eq("target_id", quoteId).eq("action", "quote.review_expired"))).toEqual([{ action: "quote.review_expired" }]);
  });

  it("GOV-24: upholding a quote whose submitter already left removes it and adds no violation", async () => {
    const { owner, quoteId, caseId } = await reportedQuote();
    const profile = await checked(admin.from("profiles").select("username").eq("id", owner.id).single()) as { username: string };
    const deleted = await call("/v1/me/account-deletion", { method: "POST", token: owner.token, body: { confirm_username: profile.username } });
    expect(deleted.status, deleted.raw).toBe(202);
    removedFromAuth.add(owner.id);

    const response = await uphold(caseId, moderator.token);
    expect(response.status, response.raw).toBe(200);
    expect(response.data).toMatchObject({ effects: { target_status: "removed", violation_id: null, strike_count: null, sanction: null } });
    expect(await checked(admin.from("quotes").select("status").eq("id", quoteId).single())).toEqual({ status: "removed" });
  });

  it("reports refuse a removed quote, a banned reporter and a second report of one comment", async () => {
    const { reporter, quoteId, caseId } = await reportedQuote();
    await uphold(caseId, moderator.token);
    expectError(await call(`/v1/quotes/${quoteId}/reports`, { method: "POST", token: reporter.token, body: { reason: "spam" } }), 410, "QUOTE_REMOVED");

    const owner = await newUser();
    const live = await newQuote(owner);
    const banned = await newUser();
    await checked(admin.from("account_standing").update({ status: "banned" }).eq("user_id", banned.id));
    expectError(await call(`/v1/quotes/${live}/reports`, { method: "POST", token: banned.token, body: { reason: "spam" } }), 403, "ACCOUNT_BANNED");

    const commentId = await newComment(live, owner);
    const once = await newUser();
    await report(`/v1/comments/${commentId}/reports`, once);
    await openCase("comment", commentId);
    expectError(await call(`/v1/comments/${commentId}/reports`, { method: "POST", token: once.token, body: { reason: "spam" } }), 409, "REPORT_DUPLICATE");
  });
});

describe("identity", () => {
  it("SEC-02: user_metadata cannot grant the admin role", async () => {
    const user = await createUser("自封管理員", { role: "admin", roles: ["admin"], is_admin: true });
    trackUser(user.id);
    expectError(await call("/v1/admin/cases", { token: user.token }), 403, "FORBIDDEN_ROLE");
    expect((await call("/v1/me", { token: user.token })).data).toMatchObject({ roles: [] });
  });

  it("SEC-10: a signed-out JWT passes signature checks but not the online check on risky routes", async () => {
    const user = await newUser();
    const moderator = await newAdmin();
    for (const token of [user.token, moderator.token]) {
      const { error } = await admin.auth.admin.signOut(token, "global");
      expect(error).toBeNull();
    }
    expectError(await call("/v1/me/api-keys", { method: "POST", token: user.token, body: { name: "登出後" } }), 401, "TOKEN_INVALID");
    expectError(await call(`/v1/admin/users/${user.id}/sanctions`, { method: "POST", token: moderator.token, body: { kind: "account_ban", reason: "登出後" } }), 401, "TOKEN_INVALID");
    // Reads stay signature-only until the 15-minute expiry (R-14)
    expect((await call("/v1/me", { token: user.token })).status).toBe(200);
  });

  it("PV-06: a reused name does not make old quotes look like the new owner's", async () => {
    const first = await newUser();
    const username = `重用名${randomUUID().slice(0, 8)}`;
    await checked(admin.from("profiles").update({ username }).eq("id", first.id));
    const quoteId = await newQuote(first);
    const deleted = await call("/v1/me/account-deletion", { method: "POST", token: first.token, body: { confirm_username: username } });
    expect(deleted.status, deleted.raw).toBe(202);
    removedFromAuth.add(first.id);

    const second = await newUser();
    const renamed = await call("/v1/me", { method: "PATCH", token: second.token, body: { username } });
    expect(renamed.status, renamed.raw).toBe(200);

    expect((await call(`/v1/quotes/${quoteId}`)).data).toMatchObject({ submitter: { id: first.id, username, deleted: true } });
    expect((await call(`/v1/users/${encodeURIComponent(username)}`)).data).toMatchObject({ id: second.id, username, created_at: expect.stringMatching(ISO) });
  });

  it("RL-06: only a rename spends the rename quota", async () => {
    const user = await newUser();
    for (let i = 0; i < 7; i += 1) {
      const response = await call("/v1/me", { method: "PATCH", token: user.token, body: { likes_public: i % 2 === 0 } });
      expect(response.status, response.raw).toBe(200);
    }
    for (let i = 0; i < 2; i += 1) {
      const response = await call("/v1/me", { method: "PATCH", token: user.token, body: { username: `配額${randomUUID().slice(0, 8)}` } });
      expect(response.status, response.raw).toBe(200);
    }
  });
});
