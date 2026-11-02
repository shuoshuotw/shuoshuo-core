import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DELETE as deleteQuoteRoute, PATCH as patchQuoteRoute } from "@/app/v1/quotes/[id]/route";
import { PATCH as patchMeRoute } from "@/app/v1/me/route";
import { POST as deleteAccountRoute } from "@/app/v1/me/account-deletion/route";
import { POST as createQuoteRoute } from "@/app/v1/quotes/route";
import { draw, resetPool } from "@/lib/quotes/pool";
import { checked, cleanupFixtures, expectError, newUser, removedFromAuth, trackQuote } from "./fixtures";
import { admin, call } from "./helpers";

type Quote = { id: string; content: string; length: number; category: { key: string }; submitter: { username: string; deleted: boolean } };
const data = (response: Awaited<ReturnType<typeof call>>) => response.data as unknown as Quote;

afterAll(cleanupFixtures);

describe("GET /v1/quotes/random", () => {
  it("RD-01: every filter is honoured on every draw", async () => {
    for (let i = 0; i < 10; i += 1) {
      const included = data(await call("/v1/quotes/random?categories=anime,manga"));
      expect(["anime", "manga"]).toContain(included.category.key);
      const excluded = data(await call("/v1/quotes/random?exclude_categories=anime,manga"));
      expect(["anime", "manga"]).not.toContain(excluded.category.key);
      const short = data(await call("/v1/quotes/random?min_length=2&max_length=10"));
      expect(short.length).toBeGreaterThanOrEqual(2);
      expect(short.length).toBeLessThanOrEqual(10);
    }
  });

  it("RD-02: conflicting and unknown filters are 400s rather than a silent wrong answer", async () => {
    expectError(await call("/v1/quotes/random?categories=anime&exclude_categories=manga"), 400, "CATEGORY_FILTER_CONFLICT");
    expectError(await call("/v1/quotes/random?min_length=10&max_length=2"), 400, "INVALID_LENGTH_RANGE");
    expectError(await call("/v1/quotes/random?categories=nope"), 400, "VALIDATION_FAILED");
    expectError(await call("/v1/quotes/random?min_length=0"), 400, "VALIDATION_FAILED");
    expectError(await call("/v1/quotes/random?max_length=101"), 400, "VALIDATION_FAILED");
  });

  it("RD-03: an impossible filter is NO_QUOTE_MATCHED", async () => {
    const rows = await checked(admin.from("quotes").select("length").eq("category_key", "ai").eq("status", "published")) as { length: number }[];
    const taken = new Set(rows.map((row) => row.length));
    const free = Array.from({ length: 100 }, (_, i) => i + 1).find((length) => !taken.has(length));
    expectError(await call(`/v1/quotes/random?categories=ai&min_length=${free}&max_length=${free}`), 404, "NO_QUOTE_MATCHED");
  });

  it("API-07: format=text is the bare content with its ID in a header, while errors stay JSON", async () => {
    const response = await call("/v1/quotes/random?format=text&categories=anime");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const id = response.headers.get("x-quote-id");
    const row = await checked(admin.from("quotes").select("content").eq("id", id).single()) as { content: string };
    expect(response.raw).toBe(row.content);

    const single = await call(`/v1/quotes/${id}?format=text`);
    expect([single.raw, single.headers.get("x-quote-id")]).toEqual([row.content, id]);

    for (const path of ["/v1/quotes/random?format=text&categories=nope", `/v1/quotes/${randomUUID()}?format=text`]) {
      const failed = await call(path);
      expect(failed.headers.get("content-type")).toContain("application/json");
      expect(failed.error).toBeDefined();
    }
  });
});

describe("RD-07: the pool follows every write on the next request", () => {
  // Handlers run in this process because the HTTP server's pool is out of reach
  const invoke = async (handler: typeof createQuoteRoute, method: string, token: string, body?: object, id?: string) => {
    const response = await handler(new Request("http://localhost/v1/x", {
      method,
      headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "127.0.0.1", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), { params: Promise.resolve<Record<string, string>>(id ? { id } : {}) });
    const raw = await response.text();
    expect(response.status, raw).toBeLessThan(300);
    return raw ? (JSON.parse(raw) as { data: { id: string } }).data : undefined;
  };
  const inPool = () => draw({ categories: ["other"] });

  afterEach(() => {
    resetPool();
  });

  it("covers create, edit, rename, account deletion and delete", async () => {
    const owner = await newUser();
    resetPool({ other: { quotes: [], total: 0 } }, Date.now());
    const content = `隨機池測試內容${randomUUID()}`;
    const created = await invoke(createQuoteRoute, "POST", owner.token, { content, category: "other", source_from: "整合測試" });
    trackQuote(created!.id);
    expect(inPool()).toMatchObject({ id: created!.id, content });

    await invoke(patchQuoteRoute, "PATCH", owner.token, { source_from: "改過的來源" }, created!.id);
    expect(inPool()).toMatchObject({ id: created!.id, source_from: "改過的來源" });

    const username = `隨機${randomUUID().slice(0, 8)}`;
    await invoke(patchMeRoute, "PATCH", owner.token, { username });
    expect(inPool()?.submitter).toMatchObject({ username, deleted: false });

    const second = await newUser();
    const secondQuote = await invoke(createQuoteRoute, "POST", second.token, { content: `第二則內容${randomUUID()}`, category: "other", source_from: "整合測試" });
    trackQuote(secondQuote!.id);
    await invoke(deleteQuoteRoute, "DELETE", second.token, undefined, secondQuote!.id);
    expect(inPool()?.id).toBe(created!.id);

    await invoke(deleteAccountRoute, "POST", owner.token, { confirm_username: username });
    removedFromAuth.add(owner.id);
    expect(inPool()?.submitter).toMatchObject({ id: owner.id, deleted: true });

    resetPool({ other: { quotes: [inPool()!], total: 1 } }, Date.now());
    const third = await newUser();
    await checked(admin.from("quotes").update({ submitter_id: third.id }).eq("id", created!.id));
    await invoke(deleteQuoteRoute, "DELETE", third.token, undefined, created!.id);
    expect(inPool()).toBeNull();
  });
});
