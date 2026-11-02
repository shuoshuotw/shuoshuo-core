import { afterAll, describe, expect, it } from "vitest";
import { admin, call } from "./helpers";
import { agedUser, checked, cleanupFixtures, expectError, newAdmin, newUser, openCase, report, trackQuote, uphold } from "./fixtures";

const STATEMENT = "我認為這次處分判斷有誤，請協助重新審視內容。";

afterAll(cleanupFixtures);

const standing = (userId: string) => checked(admin.from("account_standing").select("status, strike_count, suspended_until").eq("user_id", userId).single()) as Promise<{ status: string; strike_count: number; suspended_until: string | null }>;
const quoteStatus = async (id: string) => ((await checked(admin.from("quotes").select("status").eq("id", id).single())) as { status: string }).status;
const auditActions = async (targetId: string) => ((await checked(admin.from("audit_logs").select("action").eq("target_id", targetId))) as { action: string }[]).map(({ action }) => action);

// TEST_PLAN §7, one account's whole way down and back, against the real Core and database
describe("GOV-E2E-01: report, review, suspension, automatic ban, key revocation, appeal", () => {
  it("runs the 18 steps in order", async () => {
    const moderator = await newAdmin();
    const bob = await newUser();
    const [carol, dave, erin] = await Promise.all([agedUser(), agedUser(), agedUser()]);

    // 1: three keys and four published quotes, drawable at random
    const keys: string[] = [];
    for (const name of ["一", "二", "三"]) {
      const created = await call("/v1/me/api-keys", { method: "POST", token: bob.token, body: { name, scopes: ["quotes:write"] } });
      expect(created.status, created.raw).toBe(201);
      keys.push((created.data as unknown as { secret: string }).secret);
    }
    const quotes: string[] = [];
    for (const content of ["治理全鏈第一句測試用", "治理全鏈第二句測試用", "治理全鏈第三句測試用", "治理全鏈第四句測試用"]) {
      const created = await call("/v1/quotes", { method: "POST", token: bob.token, body: { content: `${content}${bob.id}`, category: "original", source_from: "治理測試" } });
      expect(created.status, created.raw).toBe(201);
      const { id } = created.data as unknown as { id: string };
      expect((created.data as unknown as { status: string }).status).toBe("published");
      quotes.push(id);
      trackQuote(id);
    }
    const [q1, q2, q3, q4] = quotes as [string, string, string, string];

    // 2: first report opens a case and the quote stays up
    await report(`/v1/quotes/${q1}/reports`, carol);
    const case1 = await openCase("quote", q1);
    expect(await quoteStatus(q1)).toBe("published");

    // 3: the same person cannot report twice
    expectError(await call(`/v1/quotes/${q1}/reports`, { method: "POST", token: carol.token, body: { reason: "spam" } }), 409, "REPORT_DUPLICATE");

    // 4: the third reporter sends it to review, out of the pool, still readable, and Bob has no strike
    await report(`/v1/quotes/${q1}/reports`, dave);
    await report(`/v1/quotes/${q1}/reports`, erin);
    expect(await quoteStatus(q1)).toBe("under_review");
    expect((await call(`/v1/quotes/${q1}`)).status).toBe(200);
    expect((await standing(bob.id)).strike_count).toBe(0);

    // 5: a human upholds it: removed, first strike, seven days, audited
    const first = await uphold(case1, moderator.token);
    expect(first.status, first.raw).toBe(200);
    expect(await quoteStatus(q1)).toBe("removed");
    const afterFirst = await standing(bob.id);
    expect(afterFirst.strike_count).toBe(1);
    const days = (new Date(afterFirst.suspended_until!).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    expect(await auditActions(case1)).toContain("case.resolve");

    // 6: suspended from submitting, with the date
    const barred = await call("/v1/quotes", { method: "POST", token: bob.token, body: { content: `治理全鏈第五句測試用${bob.id}`, category: "original", source_from: "治理測試" } });
    expectError(barred, 403, "SUBMISSION_SUSPENDED");
    expect((barred.error as unknown as { details: { until: string } }).details.until).toBeTruthy();

    // 7, 8: reading with a key and liking still work (D-12)
    expect((await call("/v1/quotes?limit=1", { token: keys[0]! })).status).toBe(200);
    expect((await call(`/v1/quotes/${q2}/like`, { method: "PUT", token: bob.token })).status).toBe(200);

    // 9: once the date has passed Bob can submit again
    await checked(admin.from("sanctions").update({ ends_at: "2020-01-01T00:00:00Z" }).eq("user_id", bob.id).select("id"));
    await checked(admin.from("account_standing").update({ suspended_until: "2020-01-01T00:00:00Z" }).eq("user_id", bob.id).select("user_id"));
    const again = await call("/v1/quotes", { method: "POST", token: bob.token, body: { content: `治理全鏈第五句測試用${bob.id}`, category: "original", source_from: "治理測試" } });
    expect(again.status, again.raw).toBe(201);
    trackQuote((again.data as unknown as { id: string }).id);

    // 10, 11: the ladder goes on
    for (const [quote, strikes, length] of [[q2, 2, 30], [q3, 3, 90]] as const) {
      await report(`/v1/quotes/${quote}/reports`, carol);
      const response = await uphold(await openCase("quote", quote), moderator.token);
      expect(response.status, response.raw).toBe(200);
      const now = await standing(bob.id);
      expect(now.strike_count).toBe(strikes);
      expect(Math.round((new Date(now.suspended_until!).getTime() - Date.now()) / 86_400_000)).toBe(length);
    }

    // 12: the fourth is a ban, automatic, in one transaction: keys revoked, identity blocked
    await report(`/v1/quotes/${q4}/reports`, carol);
    const fourth = await uphold(await openCase("quote", q4), moderator.token);
    expect(fourth.status, fourth.raw).toBe(200);
    expect((fourth.data as unknown as { effects: { api_keys_revoked: number; sanction: { kind: string } } }).effects).toMatchObject({ api_keys_revoked: 3, sanction: { kind: "account_ban" } });
    expect(await standing(bob.id)).toMatchObject({ status: "banned", strike_count: 4 });
    // identity_blocks holds only HMACs and other test files run alongside this one: supabase/tests/04_governance.sql asserts them exactly

    // 13: the key is dead within 15 seconds (§7.5)
    await expect.poll(async () => (await call("/v1/quotes?limit=1", { token: keys[0]! })).error?.code, { timeout: 20_000, interval: 1000 }).toBe("API_KEY_REVOKED");

    // 14: the session may not write
    expectError(await call(`/v1/quotes/${q2}/like`, { method: "DELETE", token: bob.token }), 403, "ACCOUNT_BANNED");

    // 15: but may still sign in and read why
    const me = await call("/v1/me", { token: bob.token });
    expect(me.status, me.raw).toBe(200);
    expect((me.data as unknown as { standing: { status: string } }).standing.status).toBe("banned");

    // 16: one appeal per sanction
    const sanctions = (await call("/v1/me/sanctions?limit=50", { token: bob.token })).data as unknown as { id: string; kind: string }[];
    const ban = sanctions.find(({ kind }) => kind === "account_ban")!;
    const appealed = await call("/v1/me/appeals", { method: "POST", token: bob.token, body: { target_type: "sanction", target_id: ban.id, statement: STATEMENT } });
    expect(appealed.status, appealed.raw).toBe(201);
    expectError(await call("/v1/me/appeals", { method: "POST", token: bob.token, body: { target_type: "sanction", target_id: ban.id, statement: STATEMENT } }), 409, "APPEAL_ALREADY_EXISTS");

    // 17: accepted: overturned, three strikes, unbanned, the quote back
    const accepted = await call(`/v1/admin/appeals/${(appealed.data as unknown as { id: string }).id}/resolve`, { method: "POST", token: moderator.token, body: { decision: "accept", note: "確認判斷有誤" } });
    expect(accepted.status, accepted.raw).toBe(200);
    const restored = await standing(bob.id);
    expect(restored.strike_count).toBe(3);
    expect(restored.status).toBe("active");
    expect(await quoteStatus(q4)).toBe("published");

    // 18: the old keys stay dead (D-17)
    expect((await call("/v1/quotes?limit=1", { token: keys[0]! })).status).toBe(401);
  }, 60_000);
});

describe("§9.2: expired reviews lead the queue", () => {
  it("puts a case whose review expired ahead of busier ones, on the first page only", async () => {
    const moderator = await newAdmin();
    const owner = await newUser();
    const [carol, dave] = await Promise.all([agedUser(), agedUser()]);
    const created = [];
    for (const label of ["甲", "乙"]) {
      const response = await call("/v1/quotes", { method: "POST", token: owner.token, body: { content: `佇列排序測試${label}${owner.id}`, category: "original", source_from: "治理測試" } });
      expect(response.status, response.raw).toBe(201);
      const { id } = response.data as unknown as { id: string };
      trackQuote(id);
      created.push(id);
    }
    const [stale, busy] = created as [string, string];
    await report(`/v1/quotes/${stale}/reports`, carol);
    await report(`/v1/quotes/${busy}/reports`, carol);
    await report(`/v1/quotes/${busy}/reports`, dave);
    const staleCase = await openCase("quote", stale);
    const busyCase = await openCase("quote", busy);

    await checked(admin.from("quotes").update({ status: "under_review", under_review_since: new Date(Date.now() - 8 * 86_400_000).toISOString() }).eq("id", stale).select("id"));
    const { error } = await admin.schema("private").rpc("restore_expired_reviews");
    expect(error).toBeNull();

    const listed = await call("/v1/admin/cases?limit=50", { token: moderator.token });
    expect(listed.status, listed.raw).toBe(200);
    const ids = (listed.data as unknown as { id: string }[]).map(({ id }) => id);
    expect(ids[0]).toBe(staleCase);
    expect(ids).toContain(busyCase);
    expect(ids.filter((id) => id === staleCase)).toHaveLength(1);

    // A case that was resolved leaves the front for good
    await uphold(staleCase, moderator.token);
    const after = await call("/v1/admin/cases?limit=50", { token: moderator.token });
    expect((after.data as unknown as { id: string }[]).map(({ id }) => id)).not.toContain(staleCase);
  });
});
