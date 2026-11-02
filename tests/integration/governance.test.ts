import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as resolveAppealRoute } from "@/app/v1/admin/appeals/[id]/resolve/route";
import { POST as resolveCaseRoute } from "@/app/v1/admin/cases/[id]/resolve/route";
import { POST as reportQuote } from "@/app/v1/quotes/[id]/reports/route";
import { generateKey, toBytea } from "@/lib/auth/api-key";
import { draw, resetPool } from "@/lib/quotes/pool";
import { QUOTE_SELECT, type QuoteRow, toQuote } from "@/lib/quotes/serialize";
import { admin, call, type TestUser } from "./helpers";
import { agedUser, checked, cleanupFixtures, expectError, ISO, newAdmin, newComment, newQuote, newUser, openCase, removedFromAuth, report, reportedQuote, resolve, trackCase, uphold } from "./fixtures";

type Row = Record<string, never>;
const CORE_URL = process.env.CORE_URL ?? "http://localhost:3001";
const STATEMENT = "我認為這次處分判斷有誤，請協助重新審視內容。";

afterAll(cleanupFixtures);

describe("GET /v1/health/ready", () => {
  it("reports the database to internal callers", async () => {
    process.loadEnvFile(".env.local");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", process.env.INTERNAL_HMAC_SECRETS!.split(",")[0]!)
      .update(`${timestamp}.GET./v1/health/ready`).digest("hex");
    const response = await fetch(`${CORE_URL}/v1/health/ready`, { headers: { "x-shuoshuo-internal": `v1.${timestamp}.${signature}` } });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ data: { status: "ok", checks: { database: "ok" } }, meta: { request_id: response.headers.get("x-request-id") } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("reports", () => {
  it("creates a report without revealing the count, and rejects duplicates, own content and invalid bodies", async () => {
    const owner = await newUser();
    const reporter = await newUser();
    const quoteId = await newQuote(owner);
    const path = `/v1/quotes/${quoteId}/reports`;
    const created = await report(path.replace(quoteId, quoteId.toUpperCase()), reporter, { reason: "other", detail: "說明原因" });
    expect(created.data).toEqual({ id: expect.any(String), status: "pending", created_at: expect.stringMatching(ISO) });
    await openCase("quote", quoteId);
    expect(await checked(admin.from("reports").select("reason, detail, is_discounted").eq("target_id", quoteId)))
      .toEqual([{ reason: "other", detail: "說明原因", is_discounted: true }]);

    expectError(await call(path, { method: "POST", token: reporter.token, body: { reason: "spam" } }), 409, "REPORT_DUPLICATE");
    expectError(await call(path, { method: "POST", token: owner.token, body: { reason: "spam" } }), 422, "CANNOT_REPORT_OWN");
    const other = await newUser();
    for (const body of [{ reason: "other" }, { reason: "copyright" }, { reason: "spam", extra: 1 }, { reason: "spam", detail: "" }]) {
      expectError(await call(path, { method: "POST", token: other.token, body }), 400, "VALIDATION_FAILED");
    }
    expectError(await call(`/v1/quotes/${randomUUID()}/reports`, { method: "POST", token: other.token, body: { reason: "spam" } }), 404, "QUOTE_NOT_FOUND");
    expectError(await call("/v1/quotes/not-a-uuid/reports", { method: "POST", token: other.token, body: { reason: "spam" } }), 404, "QUOTE_NOT_FOUND");
  });

  it("GOV-18: three new accounts open a case but do not trigger under_review; three aged accounts do", async () => {
    const owner = await newUser();
    const quoteId = await newQuote(owner);
    const path = `/v1/quotes/${quoteId}/reports`;
    for (let i = 0; i < 3; i += 1) await report(path, await newUser());
    await openCase("quote", quoteId);
    expect(await checked(admin.from("quotes").select("status").eq("id", quoteId).single())).toEqual({ status: "published" });

    for (let i = 0; i < 3; i += 1) await report(path, await agedUser());
    expect(await checked(admin.from("quotes").select("status").eq("id", quoteId).single())).toEqual({ status: "under_review" });
    expect(await checked(admin.from("audit_logs").select("action").eq("target_id", quoteId).eq("action", "report.threshold_reached")))
      .toEqual([{ action: "report.threshold_reached" }]);
  });

  it("reports comments, and refuses a missing comment, one's own comment and a banned reporter", async () => {
    const owner = await newUser();
    const author = await newUser();
    const reporter = await newUser();
    const commentId = await newComment(await newQuote(owner), author);
    const path = `/v1/comments/${commentId}/reports`;
    const created = await report(path, reporter);
    expect(created.data).toEqual({ id: expect.any(String), status: "pending", created_at: expect.stringMatching(ISO) });
    await openCase("comment", commentId);
    expectError(await call(path, { method: "POST", token: author.token, body: { reason: "spam" } }), 422, "CANNOT_REPORT_OWN");
    expectError(await call(`/v1/comments/${randomUUID()}/reports`, { method: "POST", token: reporter.token, body: { reason: "spam" } }), 404, "COMMENT_NOT_FOUND");
    const banned = await newUser();
    await checked(admin.from("account_standing").update({ status: "banned" }).eq("user_id", banned.id));
    expectError(await call(path, { method: "POST", token: banned.token, body: { reason: "spam" } }), 403, "ACCOUNT_BANNED");
  });

  it("lists only the caller's reports, newest first, without gaps across pages", async () => {
    const owner = await newUser();
    const reporter = await newUser();
    const first = await newQuote(owner);
    const second = await newQuote(owner);
    const ids = [
      (await report(`/v1/quotes/${first}/reports`, reporter)).data as unknown as { id: string },
      (await report(`/v1/quotes/${second}/reports`, reporter)).data as unknown as { id: string },
    ].map((row) => row.id);
    for (const quoteId of [first, second]) await openCase("quote", quoteId);

    const page = await call("/v1/me/reports?limit=1", { token: reporter.token });
    const meta = page.meta as unknown as { pagination: { next_cursor: string; has_more: boolean } };
    expect(meta.pagination.has_more).toBe(true);
    const next = await call(`/v1/me/reports?limit=1&cursor=${meta.pagination.next_cursor}`, { token: reporter.token });
    const rows = [...(page.data as unknown as { id: string }[]), ...(next.data as unknown as { id: string }[])];
    expect(rows.map((row) => row.id)).toEqual(ids.toReversed());
    expect(rows[1]).toEqual({ id: ids[0], target_type: "quote", target_id: first, reason: "spam", status: "pending", created_at: expect.stringMatching(ISO) });
    expect((await call("/v1/me/reports", { token: owner.token })).data).toEqual([]);
  });
});

describe("case queue", () => {
  let moderator: TestUser;
  beforeAll(async () => {
    moderator = await newAdmin();
  });

  it("orders open cases by effective reporters, then oldest first, across cursors; filters by status and type", async () => {
    const owner = await newUser();
    const insert = async (effective: number, created_at: string, target_type = "quote") => {
      const row = await checked(admin.from("moderation_cases").insert({ target_type, target_id: randomUUID(), effective_reporter_count: effective, created_at }).select("id").single()) as { id: string };
      trackCase(row.id);
      return row.id;
    };
    const expected = [
      await insert(90_000, "2026-01-02T00:00:00Z"),
      await insert(90_000, "2026-01-03T00:00:00.000001Z"),
      await insert(90_000, "2026-01-03T00:00:00.000002Z"),
      await insert(80_000, "2026-01-01T00:00:00Z"),
    ];
    const seen: string[] = [];
    let cursor = "";
    for (;;) {
      const page = await call(`/v1/admin/cases?limit=1${cursor && `&cursor=${cursor}`}`, { token: moderator.token });
      expect(page.status, page.raw).toBe(200);
      const [row] = page.data as unknown as { id: string }[];
      if (row && expected.includes(row.id)) seen.push(row.id);
      const { next_cursor } = (page.meta as unknown as { pagination: { next_cursor: string | null } }).pagination;
      if (!next_cursor || seen.length === expected.length) break;
      cursor = next_cursor;
    }
    expect(seen).toEqual(expected);

    const quoteId = await newQuote(owner, `長內容${"測".repeat(90)}`);
    await report(`/v1/quotes/${quoteId}/reports`, await newUser(), { reason: "hate" });
    const caseId = await openCase("quote", quoteId);
    const all = await call("/v1/admin/cases?limit=100&target_type=quote", { token: moderator.token });
    expect((all.data as unknown as Row[]).find((row) => (row.id as unknown as string) === caseId)).toEqual({
      id: caseId, target_type: "quote", target_id: quoteId, status: "open", reporter_count: 1, effective_reporter_count: 0,
      top_reason: "hate", preview: `長內容${"測".repeat(77)}`, created_at: expect.stringMatching(ISO),
    });
    const comments = await call("/v1/admin/cases?limit=100&target_type=comment", { token: moderator.token });
    expect((comments.data as unknown as { target_type: string }[]).every((row) => row.target_type === "comment")).toBe(true);
    const resolved = await call("/v1/admin/cases?limit=100&status=resolved", { token: moderator.token });
    expect((resolved.data as unknown as { status: string }[]).every((row) => row.status === "resolved")).toBe(true);
    expectError(await call("/v1/admin/cases?status=closed", { token: moderator.token }), 400, "VALIDATION_FAILED");
  });

  it("shows the case detail, including would_ban, and 404s a missing or malformed case", async () => {
    const { owner, reporter, quoteId, caseId } = await reportedQuote();
    await checked(admin.from("account_standing").update({ strike_count: 3 }).eq("user_id", owner.id));
    const profile = await checked(admin.from("profiles").select("username").eq("id", owner.id).single()) as { username: string };
    const detail = await call(`/v1/admin/cases/${caseId}`, { token: moderator.token });
    expect(detail.status, detail.raw).toBe(200);
    expect(detail.data).toMatchObject({
      id: caseId, target_type: "quote", target_id: quoteId, status: "open", reporter_count: 1, top_reason: "spam",
      resolution: null, final_reason: null,
      target: { id: quoteId, status: "published", removed_reason: null, removed_at: null },
      reports: [{ reason: "spam", detail: null, reporter_id: reporter.id, is_discounted: true, created_at: expect.stringMatching(ISO) }],
      subject: { user_id: owner.id, username: profile.username, prior_violations: [], would_ban: true, standing: { strike_count: 3, strike_limit: 4 } },
      audit: [],
    });
    expectError(await call(`/v1/admin/cases/${randomUUID()}`, { token: moderator.token }), 404, "CASE_NOT_FOUND");
    expectError(await call("/v1/admin/cases/not-a-uuid", { token: moderator.token }), 404, "CASE_NOT_FOUND");
  });
});

describe("resolving cases", () => {
  let moderator: TestUser;
  beforeAll(async () => {
    moderator = await newAdmin();
  });

  it("uphold removes the quote, adds a strike and a sanction once, and the user can read them without learning the reporter", async () => {
    const { owner, reporter, quoteId, caseId } = await reportedQuote();
    expectError(await resolve(caseId, moderator.token, { resolution: "uphold" }), 400, "VALIDATION_FAILED");
    const response = await uphold(caseId, moderator.token);
    expect(response.status, response.raw).toBe(200);
    const violationId = ((response.data as unknown as { effects: { violation_id: string } }).effects).violation_id;
    expect(response.data).toEqual({
      case_id: caseId, resolution: "uphold",
      effects: {
        target_status: "removed", violation_id: expect.any(String), strike_count: 1,
        sanction: { kind: "submit_suspension", ends_at: expect.stringMatching(ISO) }, api_keys_revoked: 0,
      },
    });
    expectError(await uphold(caseId, moderator.token), 409, "CASE_ALREADY_RESOLVED");
    expectError(await resolve(randomUUID(), moderator.token, { resolution: "dismiss" }), 404, "CASE_NOT_FOUND");
    const removed = await call(`/v1/quotes/${quoteId}`);
    expectError(removed, 410, "QUOTE_REMOVED");

    const violations = await call("/v1/me/violations", { token: owner.token });
    expect(violations.status, violations.raw).toBe(200);
    const sanction = {
      id: expect.any(String), kind: "submit_suspension", source: "auto", reason: "確認違規（第 1 次）",
      starts_at: expect.stringMatching(ISO), ends_at: expect.stringMatching(ISO), lifted_at: null, appeal_status: null,
    };
    expect(violations.data).toEqual([{
      id: violationId, quote_id: quoteId, reason: "spam", counts_as_strike: true, overturned_at: null,
      created_at: expect.stringMatching(ISO), appeal_status: null, sanction,
    }]);
    expect(violations.raw).not.toContain(reporter.id);
    expect((await call("/v1/me/sanctions", { token: owner.token })).data).toEqual([sanction]);
    expect(await checked(admin.from("reports").select("status").eq("case_id", caseId))).toEqual([{ status: "upheld" }]);
    expect(await checked(admin.from("audit_logs").select("action").eq("target_id", caseId))).toEqual([{ action: "case.resolve" }]);
  });

  it("dismiss restores an under_review quote without any strike", async () => {
    const { owner, quoteId, caseId } = await reportedQuote();
    await checked(admin.from("quotes").update({ status: "under_review", under_review_since: new Date().toISOString() }).eq("id", quoteId));
    const response = await resolve(caseId, moderator.token, { resolution: "dismiss" });
    expect(response.data).toEqual({
      case_id: caseId, resolution: "dismiss",
      effects: { target_status: "published", violation_id: null, strike_count: null, sanction: null, api_keys_revoked: 0 },
    });
    expect((await call(`/v1/quotes/${quoteId}`)).status).toBe(200);
    expect(await checked(admin.from("account_standing").select("strike_count").eq("user_id", owner.id).single())).toEqual({ strike_count: 0 });
    expect(await checked(admin.from("reports").select("status").eq("case_id", caseId))).toEqual([{ status: "dismissed" }]);
  });

  it("GOV-09, GOV-13: a removed comment has no strike, can be appealed, and is restored on accept", async () => {
    const owner = await newUser();
    const author = await newUser();
    const quoteId = await newQuote(owner);
    const commentId = await newComment(quoteId, author);
    await report(`/v1/comments/${commentId}/reports`, await newUser());
    const caseId = await openCase("comment", commentId);
    const resolved = await uphold(caseId, moderator.token);
    const violationId = (resolved.data as unknown as { effects: { violation_id: string; strike_count: number | null; target_status: string } }).effects;
    expect(violationId).toMatchObject({ target_status: "removed", strike_count: null, sanction: null });
    expect(await checked(admin.from("quote_stats").select("comment_count").eq("quote_id", quoteId).single())).toEqual({ comment_count: 0 });

    const appealed = await call("/v1/me/appeals", { method: "POST", token: author.token, body: { target_type: "violation", target_id: violationId.violation_id, statement: STATEMENT } });
    expect(appealed.status, appealed.raw).toBe(201);
    const appealId = (appealed.data as unknown as { id: string }).id;
    expect(appealed.data).toEqual({ id: appealId, target_type: "violation", target_id: violationId.violation_id, status: "pending", created_at: expect.stringMatching(ISO) });
    expectError(await call("/v1/me/appeals", { method: "POST", token: author.token, body: { target_type: "violation", target_id: violationId.violation_id, statement: STATEMENT } }), 409, "APPEAL_ALREADY_EXISTS");

    const listed = await call("/v1/admin/appeals?limit=100", { token: moderator.token });
    expect((listed.data as unknown as { id: string }[]).find((row) => row.id === appealId)).toEqual({
      id: appealId, user_id: author.id, target_type: "violation", target_id: violationId.violation_id, sanction: null,
      violation: expect.objectContaining({ id: violationId.violation_id, quote_id: null, counts_as_strike: false, appeal_status: "pending", sanction: null }),
      statement: STATEMENT, status: "pending", created_at: expect.stringMatching(ISO),
    });

    const accepted = await call(`/v1/admin/appeals/${appealId}/resolve`, { method: "POST", token: moderator.token, body: { decision: "accept", note: "判斷有誤" } });
    expect(accepted.data).toEqual({ appeal_id: appealId, status: "accepted", effects: { strike_count: 0, sanction_lifted: false, target_restored: true } });
    expect(await checked(admin.from("comments").select("status").eq("id", commentId).single())).toEqual({ status: "visible" });
    expect(await checked(admin.from("quote_stats").select("comment_count").eq("quote_id", quoteId).single())).toEqual({ comment_count: 1 });
    expectError(await call(`/v1/admin/appeals/${appealId}/resolve`, { method: "POST", token: moderator.token, body: { decision: "reject", note: "再次" } }), 409, "APPEAL_ALREADY_RESOLVED");
    expect((await call("/v1/me/appeals", { token: author.token })).data).toEqual([{
      id: appealId, target_type: "violation", target_id: violationId.violation_id, statement: STATEMENT, status: "accepted",
      decision_note: "判斷有誤", decided_at: expect.stringMatching(ISO), created_at: expect.stringMatching(ISO),
    }]);
  });

  it("accepting a sanction appeal restores the quote, the strike and the sanction; rejecting changes nothing but the appeal", async () => {
    const first = await reportedQuote();
    await uphold(first.caseId, moderator.token);
    const [sanction] = (await call("/v1/me/sanctions", { token: first.owner.token })).data as unknown as { id: string }[];
    const body = { target_type: "sanction", target_id: sanction!.id, statement: STATEMENT };
    const appealed = await call("/v1/me/appeals", { method: "POST", token: first.owner.token, body });
    const appealId = (appealed.data as unknown as { id: string }).id;
    const accepted = await call(`/v1/admin/appeals/${appealId}/resolve`, { method: "POST", token: moderator.token, body: { decision: "accept", note: "誤判" } });
    expect(accepted.data).toEqual({ appeal_id: appealId, status: "accepted", effects: { strike_count: 0, sanction_lifted: true, target_restored: true } });
    expect((await call(`/v1/quotes/${first.quoteId}`)).status).toBe(200);
    const [after] = (await call("/v1/me/violations", { token: first.owner.token })).data as unknown as Row[];
    expect(after).toMatchObject({ overturned_at: expect.stringMatching(ISO), appeal_status: "accepted", sanction: { lifted_at: expect.stringMatching(ISO), appeal_status: "accepted" } });

    const second = await reportedQuote();
    await uphold(second.caseId, moderator.token);
    const [other] = (await call("/v1/me/sanctions", { token: second.owner.token })).data as unknown as { id: string }[];
    const rejectedAppeal = await call("/v1/me/appeals", { method: "POST", token: second.owner.token, body: { target_type: "sanction", target_id: other!.id, statement: STATEMENT } });
    const rejected = await call(`/v1/admin/appeals/${(rejectedAppeal.data as unknown as { id: string }).id}/resolve`, { method: "POST", token: moderator.token, body: { decision: "reject", note: "維持處分" } });
    expect(rejected.data).toMatchObject({ status: "rejected", effects: { strike_count: 1, sanction_lifted: false, target_restored: false } });
    expectError(await call(`/v1/quotes/${second.quoteId}`), 410, "QUOTE_REMOVED");
    expectError(await call(`/v1/admin/appeals/${randomUUID()}/resolve`, { method: "POST", token: moderator.token, body: { decision: "accept", note: "無" } }), 404, "APPEAL_NOT_FOUND");
    expectError(await call(`/v1/admin/appeals/${appealId}/resolve`, { method: "POST", token: moderator.token, body: { decision: "accept", note: "" } }), 400, "VALIDATION_FAILED");
  });

  it("refuses appeals for someone else's record, a violation that has a sanction, and short statements", async () => {
    const { owner, caseId } = await reportedQuote();
    const resolved = await uphold(caseId, moderator.token);
    const violationId = (resolved.data as unknown as { effects: { violation_id: string } }).effects.violation_id;
    const [sanction] = (await call("/v1/me/sanctions", { token: owner.token })).data as unknown as { id: string }[];
    const stranger = await newUser();
    expectError(await call("/v1/me/appeals", { method: "POST", token: stranger.token, body: { target_type: "sanction", target_id: sanction!.id, statement: STATEMENT } }), 404, "APPEAL_TARGET_NOT_FOUND");
    expectError(await call("/v1/me/appeals", { method: "POST", token: owner.token, body: { target_type: "violation", target_id: violationId, statement: STATEMENT } }), 404, "APPEAL_TARGET_NOT_FOUND");
    expectError(await call("/v1/me/appeals", { method: "POST", token: owner.token, body: { target_type: "sanction", target_id: sanction!.id, statement: "太短" } }), 400, "VALIDATION_FAILED");
    expect((await call("/v1/me/appeals", { token: stranger.token })).data).toEqual([]);
    expect((await call("/v1/me/sanctions", { token: stranger.token })).data).toEqual([]);
  });

  it("lets a banned user read their own governance records (§9.5)", async () => {
    const user = await newUser();
    await checked(admin.from("account_standing").update({ status: "banned" }).eq("user_id", user.id));
    for (const path of ["/v1/me/violations", "/v1/me/sanctions", "/v1/me/appeals", "/v1/me/reports"]) {
      const response = await call(path, { token: user.token });
      expect(response.status, response.raw).toBe(200);
    }
  });
});

describe("random pool (§10.3)", () => {
  // Handlers run in this process because the HTTP server's pool is out of reach
  const invoke = (handler: typeof reportQuote, path: string, id: string, token: string, body: object) => handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  const inPool = () => draw({ categories: ["original"] })?.id;

  async function loadPool(quoteId: string) {
    const row = await checked(admin.from("quotes").select(QUOTE_SELECT).eq("id", quoteId).single());
    resetPool({ original: { quotes: [toQuote(row as unknown as QuoteRow)], total: 1 } }, Date.now());
  }

  it("drops a quote at the report threshold and on uphold, and restores it on dismiss and accepted appeal", async () => {
    process.loadEnvFile(".env.local");
    const moderator = await newAdmin();
    const owner = await newUser();
    const quoteId = await newQuote(owner);
    try {
      await loadPool(quoteId);
      const path = `/v1/quotes/${quoteId}/reports`;
      for (let i = 0; i < 2; i += 1) await report(path, await agedUser());
      const third = await agedUser();
      expect(inPool()).toBe(quoteId);
      expect((await invoke(reportQuote, path, quoteId, third.token, { reason: "spam" })).status).toBe(201);
      expect(inPool()).toBeUndefined();
      const firstCase = await openCase("quote", quoteId);

      const dismissed = await invoke(resolveCaseRoute, `/v1/admin/cases/${firstCase}/resolve`, firstCase, moderator.token, { resolution: "dismiss" });
      expect(dismissed.status, await dismissed.text()).toBe(200);
      expect(inPool()).toBe(quoteId);

      await report(path, await newUser());
      const secondCase = await openCase("quote", quoteId);
      const upheld = await invoke(resolveCaseRoute, `/v1/admin/cases/${secondCase}/resolve`, secondCase, moderator.token, { resolution: "uphold", final_reason: "spam" });
      expect(upheld.status, await upheld.text()).toBe(200);
      expect(inPool()).toBeUndefined();

      const [sanction] = (await call("/v1/me/sanctions", { token: owner.token })).data as unknown as { id: string }[];
      const appeal = await call("/v1/me/appeals", { method: "POST", token: owner.token, body: { target_type: "sanction", target_id: sanction!.id, statement: STATEMENT } });
      const appealId = (appeal.data as unknown as { id: string }).id;
      const accepted = await invoke(resolveAppealRoute, `/v1/admin/appeals/${appealId}/resolve`, appealId, moderator.token, { decision: "accept", note: "誤判" });
      expect(accepted.status, await accepted.text()).toBe(200);
      expect(inPool()).toBe(quoteId);
    } finally {
      resetPool();
    }
  });
});

describe("user administration", () => {
  let moderator: TestUser;
  beforeAll(async () => {
    moderator = await newAdmin();
  });

  it("GOV-14: a manual ban adds no strike, revokes keys and can be lifted; suspensions need a duration", async () => {
    const user = await newUser();
    const key = generateKey("test");
    await checked(admin.from("api_keys").insert({ user_id: user.id, name: "ban", key_prefix: key.prefix, key_hash: toBytea(key.hash), scopes: ["quotes:read"] }));
    const path = `/v1/admin/users/${user.id}/sanctions`;

    expectError(await call(path, { method: "POST", token: moderator.token, body: { kind: "submit_suspension", reason: "理由" } }), 400, "VALIDATION_FAILED");
    const suspended = await call(path, { method: "POST", token: moderator.token, body: { kind: "submit_suspension", duration_days: 7, reason: "暫停" } });
    expect(suspended.status, suspended.raw).toBe(201);
    expect(suspended.data).toEqual({ sanction_id: expect.any(String), kind: "submit_suspension", ends_at: expect.stringMatching(ISO), api_keys_revoked: 0 });

    const banned = await call(path, { method: "POST", token: moderator.token, body: { kind: "account_ban", reason: "封號" } });
    expect(banned.status, banned.raw).toBe(201);
    const sanctionId = (banned.data as unknown as { sanction_id: string }).sanction_id;
    expect(banned.data).toEqual({ sanction_id: sanctionId, kind: "account_ban", ends_at: null, api_keys_revoked: 1 });
    expectError(await call(path, { method: "POST", token: moderator.token, body: { kind: "account_ban", reason: "再次" } }), 409, "ALREADY_BANNED");
    expectError(await call("/v1/categories", { token: key.secret }), 401, "API_KEY_REVOKED");

    const detail = await call(`/v1/admin/users/${user.id}`, { token: moderator.token });
    expect(detail.status, detail.raw).toBe(200);
    expect(detail.data).toMatchObject({ id: user.id, roles: [], api_key_count: 0, quote_count: 0, violations: [], standing: { status: "banned", strike_count: 0 } });
    expect((detail.data as unknown as { sanctions: unknown[] }).sanctions).toHaveLength(2);
    expect(detail.raw).not.toContain(user.email);

    const lifted = await call(`/v1/admin/sanctions/${sanctionId}/lift`, { method: "POST", token: moderator.token, body: { reason: "解除" } });
    expect(lifted.status, lifted.raw).toBe(200);
    expect(lifted.data).toEqual({ sanction_id: sanctionId, lifted_at: expect.stringMatching(ISO), standing: expect.objectContaining({ status: "suspended", strike_count: 0 }) });
    expectError(await call(`/v1/admin/sanctions/${sanctionId}/lift`, { method: "POST", token: moderator.token, body: { reason: "再次" } }), 409, "SANCTION_ALREADY_LIFTED");
    expectError(await call(`/v1/admin/sanctions/${randomUUID()}/lift`, { method: "POST", token: moderator.token, body: { reason: "無" } }), 404, "SANCTION_NOT_FOUND");
    expect(await checked(admin.from("api_keys").select("revoked_at").eq("user_id", user.id).single())).toEqual({ revoked_at: expect.any(String) });
  });

  it("returns USER_NOT_FOUND for unknown users on every user route", async () => {
    const id = randomUUID();
    expectError(await call(`/v1/admin/users/${id}`, { token: moderator.token }), 404, "USER_NOT_FOUND");
    expectError(await call("/v1/admin/users/not-a-uuid", { token: moderator.token }), 404, "USER_NOT_FOUND");
    expectError(await call(`/v1/admin/users/${id}/sanctions`, { method: "POST", token: moderator.token, body: { kind: "account_ban", reason: "無" } }), 404, "USER_NOT_FOUND");
    expectError(await call(`/v1/admin/users/${id}/reset-profile`, { method: "POST", token: moderator.token, body: { reason: "無" } }), 404, "USER_NOT_FOUND");
  });

  it("resets a username and records it", async () => {
    const user = await newUser();
    const before = await checked(admin.from("profiles").select("username").eq("id", user.id).single()) as { username: string };
    const response = await call(`/v1/admin/users/${user.id}/reset-profile`, { method: "POST", token: moderator.token, body: { reason: "不當名稱" } });
    expect(response.status, response.raw).toBe(200);
    const { username } = response.data as unknown as { username: string };
    expect(response.data).toEqual({ id: user.id, username: expect.any(String) });
    expect(username).not.toBe(before.username);
    const logs = await call(`/v1/admin/audit-logs?target_id=${user.id}&action=profile.reset`, { token: moderator.token });
    expect(logs.data).toEqual([{
      id: expect.any(Number), actor_id: moderator.id, actor_type: "admin", action: "profile.reset", target_type: "user", target_id: user.id,
      metadata: { before: before.username, after: username, reason: "不當名稱" }, request_id: expect.anything(), created_at: expect.stringMatching(ISO),
    }]);
  });

  it("filters and pages audit logs, and accepts only §9.8 actions", async () => {
    const user = await newUser();
    for (const reason of ["一", "二"]) {
      await call(`/v1/admin/users/${user.id}/reset-profile`, { method: "POST", token: moderator.token, body: { reason } });
    }
    const path = `/v1/admin/audit-logs?target_id=${user.id}`;
    const first = await call(`${path}&limit=1`, { token: moderator.token });
    const { next_cursor } = (first.meta as unknown as { pagination: { next_cursor: string } }).pagination;
    const second = await call(`${path}&limit=1&cursor=${next_cursor}`, { token: moderator.token });
    const reasons = [...first.data as unknown as { metadata: { reason: string } }[], ...second.data as unknown as { metadata: { reason: string } }[]].map((row) => row.metadata.reason);
    expect(reasons).toEqual(["二", "一"]);
    expect((await call(`${path}&from=2999-01-01T00:00:00Z`, { token: moderator.token })).data).toEqual([]);
    expect((await call(`${path}&to=2000-01-01T00:00:00Z`, { token: moderator.token })).data).toEqual([]);
    expect((await call(`/v1/admin/audit-logs?actor_id=${user.id}`, { token: moderator.token })).data).toEqual([]);
    expectError(await call("/v1/admin/audit-logs?action=made.up", { token: moderator.token }), 400, "VALIDATION_FAILED");
    expectError(await call("/v1/admin/audit-logs?from=yesterday", { token: moderator.token }), 400, "VALIDATION_FAILED");
  });
});

describe("POST /v1/me/account-deletion", () => {
  it("requires the exact name, then removes the account's data while its quotes and name stay (§11.5, D-22)", async () => {
    const moderator = await newAdmin();
    const user = await newUser();
    const other = await newUser();
    const profile = await checked(admin.from("profiles").select("username").eq("id", user.id).single()) as { username: string };
    const quoteId = await newQuote(user);
    const othersQuote = await newQuote(other);
    const commentId = await newComment(othersQuote, user);
    await report(`/v1/comments/${commentId}/reports`, other);
    const caseId = await openCase("comment", commentId);
    await report(`/v1/quotes/${othersQuote}/reports`, user);
    await openCase("quote", othersQuote);
    await call(`/v1/quotes/${othersQuote}/like`, { method: "PUT", token: user.token });
    const key = generateKey("test");
    await checked(admin.from("api_keys").insert({ user_id: user.id, name: "bye", key_prefix: key.prefix, key_hash: toBytea(key.hash), scopes: ["quotes:read"] }));

    const path = "/v1/me/account-deletion";
    expectError(await call(path, { method: "POST", token: user.token, body: { confirm_username: `${profile.username}x` } }), 422, "CONFIRMATION_MISMATCH");
    expectError(await call(path, { method: "POST", token: moderator.token, body: {} }), 400, "VALIDATION_FAILED");
    expect(await checked(admin.from("profiles").select("deleted_at").eq("id", user.id).single())).toEqual({ deleted_at: null });

    const deleted = await call(path, { method: "POST", token: user.token, body: { confirm_username: profile.username } });
    expect(deleted.status, deleted.raw).toBe(202);
    expect(deleted.data).toEqual({ status: "deleted" });
    removedFromAuth.add(user.id);

    expect((await admin.auth.admin.getUserById(user.id)).error).toBeTruthy();
    expect(await checked(admin.from("account_standing").select("user_id").eq("user_id", user.id))).toEqual([]);
    expect(await checked(admin.from("comments").select("id").eq("id", commentId))).toEqual([]);
    expect(await checked(admin.from("quote_likes").select("user_id").eq("user_id", user.id))).toEqual([]);
    expect(await checked(admin.from("reports").select("reporter_id").eq("target_id", othersQuote))).toEqual([{ reporter_id: null }]);
    expect(await checked(admin.from("moderation_cases").select("status, resolution").eq("id", caseId).single())).toEqual({ status: "resolved", resolution: "target_deleted" });
    expect(await checked(admin.from("audit_logs").select("action").eq("target_id", user.id).eq("action", "account.delete"))).toEqual([{ action: "account.delete" }]);

    const quote = await call(`/v1/quotes/${quoteId}`);
    expect(quote.status, quote.raw).toBe(200);
    expect(quote.data).toMatchObject({ submitter: { id: user.id, username: profile.username, deleted: true } });
    expectError(await call(`/v1/users/${encodeURIComponent(profile.username)}`), 404, "USER_NOT_FOUND");

    const governance = await call(`/v1/admin/users/${user.id}`, { token: moderator.token });
    expect(governance.data).toMatchObject({ id: user.id, standing: null, api_key_count: 0 });
    const detail = await call(`/v1/admin/cases/${caseId}`, { token: moderator.token });
    expect(detail.data).toMatchObject({ resolution: "target_deleted", target: null, subject: null, preview: null });
    expectError(await call(path, { method: "POST", token: user.token, body: { confirm_username: profile.username } }), 401, "TOKEN_INVALID");
  });
});
