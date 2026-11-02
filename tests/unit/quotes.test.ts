import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertEditWithinLimit,
  assertQuoteLanguage,
  changeRatio,
  contentHash,
  hasForbiddenCharacters,
  normalizeText,
} from "@/lib/quotes/normalize";
import { draw, ensureLoaded, type PoolQuote, removeQuote, resetPool, updateStats, updateSubmitter, upsertQuote } from "@/lib/quotes/pool";
import { randomQuote } from "@/lib/quotes/random";
import { rpc } from "@/lib/supabase";
import { categoryList, quoteContent } from "@/lib/validators/common";

vi.mock("@/lib/supabase", () => ({ rpc: vi.fn() }));

const quote = (id: string, category = "anime", length = 10, submitter = "u1"): PoolQuote => ({
  id,
  content: `內容${id}`,
  length,
  category: { key: category, name: category },
  source_from: "來源",
  submitter: { id: submitter, username: "小明", deleted: false },
  stats: { like_count: 0, favorite_count: 0, comment_count: 0 },
  status: "published",
  commit_from: "web",
  edited_at: null,
  created_at: "2026-11-01T00:00:00.000Z",
});

describe("content rules (§8.3.4)", () => {
  it("trims and applies NFC", () => {
    expect(normalizeText("  é  ")).toBe("é");
  });

  it("counts code points, so an emoji is one", () => {
    expect(quoteContent.safeParse("說😀").success).toBe(true);
    expect(quoteContent.safeParse("說").success).toBe(false);
    expect(quoteContent.safeParse("說".repeat(100)).success).toBe(true);
    expect(quoteContent.safeParse("說".repeat(101)).success).toBe(false);
  });

  it("allows newlines and emoji ZWJ, rejects other control and zero-width characters", () => {
    expect(hasForbiddenCharacters("第一行\n第二行")).toBe(false);
    expect(hasForbiddenCharacters("👨‍👩‍👧")).toBe(false);
    expect(hasForbiddenCharacters("說‍說")).toBe(true);
    expect(hasForbiddenCharacters("說​說")).toBe(true);
    expect(hasForbiddenCharacters("說\u0007說")).toBe(true);
  });

  it("requires a Han character", () => {
    expect(() => assertQuoteLanguage("hello")).toThrowError(expect.objectContaining({ code: "QUOTE_NO_HAN" }));
    expect(() => assertQuoteLanguage("你好 hello")).not.toThrow();
  });

  it("rejects simplified-only characters and names them once each", () => {
    expect(() => assertQuoteLanguage("这里这样说吧")).toThrowError(
      expect.objectContaining({ code: "QUOTE_NOT_TRADITIONAL", details: { characters: ["这", "样", "说"] } }),
    );
  });

  it("allows characters shared with traditional text", () => {
    expect(() => assertQuoteLanguage("後來的后土，里長與天干地支")).not.toThrow();
  });

  it("hashes full-width, half-width and punctuation variants alike", () => {
    expect(contentHash("你好，世界！ABC").equals(contentHash("你好世界 abc"))).toBe(true);
    expect(contentHash("你好，世界").equals(contentHash("你好，世間"))).toBe(false);
  });
});

describe("edit limit (D-32, ED-08)", () => {
  it("accepts 49% and rejects 50%", () => {
    const original = "一二三四五六七八九十".repeat(10);
    const edit = (changed: number) => "改".repeat(changed) + original.slice(changed);
    expect(changeRatio(original, edit(49))).toBeCloseTo(0.49);
    expect(() => assertEditWithinLimit(original, edit(49))).not.toThrow();
    expect(() => assertEditWithinLimit(original, edit(50))).toThrowError(
      expect.objectContaining({ code: "QUOTE_EDIT_TOO_LARGE", details: { change_ratio: 0.5, limit: 0.5 } }),
    );
  });

  it("ignores punctuation and width", () => {
    expect(changeRatio("你好，世界！", "你好 世界")).toBe(0);
  });

  it("makes a 2-character quote uneditable at one change, as D-32 accepts", () => {
    expect(() => assertEditWithinLimit("說說", "說話")).toThrow();
  });
});

describe("categoryList", () => {
  it("rejects an unknown key", () => {
    expect(categoryList.safeParse("anime,nope").success).toBe(false);
    expect(categoryList.parse("anime,anti-motiv")).toEqual(["anime", "anti-motiv"]);
  });
});

describe("pool (§10.3)", () => {
  beforeEach(() => {
    vi.mocked(rpc).mockReset();
    resetPool({
      anime: { quotes: [quote("a1", "anime", 10), quote("a2", "anime", 50)], total: 2 },
      game: { quotes: [quote("g1", "game", 10)], total: 1 },
    }, Date.now());
  });

  it("filters by category", () => {
    for (let i = 0; i < 20; i += 1) expect(draw({ categories: ["game"] })?.id).toBe("g1");
  });

  it("filters by length, even when rejection sampling keeps missing", () => {
    for (let i = 0; i < 50; i += 1) expect(draw({ min: 40 })?.id).toBe("a2");
  });

  it("returns null when nothing matches", () => {
    expect(draw({ min: 99 })).toBeNull();
    expect(draw({ categories: ["music"] })).toBeNull();
  });

  it("weights categories by their total", () => {
    resetPool({
      anime: { quotes: [quote("a")], total: 90 },
      game: { quotes: [quote("g", "game")], total: 10 },
    }, Date.now());
    let anime = 0;
    for (let i = 0; i < 4000; i += 1) if (draw()?.id === "a") anime += 1;
    expect(anime / 4000).toBeGreaterThan(0.85);
    expect(anime / 4000).toBeLessThan(0.95);
  });

  it("removes a quote immediately", () => {
    removeQuote("g1");
    expect(draw({ categories: ["game"] })).toBeNull();
  });

  it("adds new quotes and applies edits in place", () => {
    upsertQuote(quote("g2", "game"));
    upsertQuote({ ...quote("g1", "game"), content: "改過了" });
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(draw({ categories: ["game"] })?.content ?? "");
    expect(seen).toEqual(new Set(["改過了", "內容g2"]));
  });

  it("moves a quote whose category changed", () => {
    upsertQuote(quote("g1", "anime"));
    expect(draw({ categories: ["game"] })).toBeNull();
  });

  it("updates stats and submitters", () => {
    updateStats("g1", { like_count: 5 });
    updateSubmitter("u1", { username: "新名字", deleted: true });
    expect(draw({ categories: ["game"] })).toMatchObject({
      stats: { like_count: 5 },
      submitter: { username: "新名字", deleted: true },
    });
  });

  it("loads once for concurrent first requests", async () => {
    resetPool();
    vi.mocked(rpc).mockResolvedValue({ quotes: [], category_total: 0 } as never);
    await Promise.all([ensureLoaded(), ensureLoaded(), ensureLoaded()]);
    expect(rpc).toHaveBeenCalledTimes(13);
  });

  it("keeps serving old data when a refill fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    resetPool({ game: { quotes: [quote("g1", "game")], total: 1 } }, Date.now() - 7 * 60 * 60 * 1000);
    vi.mocked(rpc).mockRejectedValue(new Error("down"));
    await ensureLoaded();
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalled());
    errorLog.mockRestore();
    expect(draw({ categories: ["game"] })?.id).toBe("g1");
  });
});

describe("randomQuote fallback (§10.3)", () => {
  beforeEach(() => {
    vi.mocked(rpc).mockReset();
    resetPool({ game: { quotes: [quote("g1", "game", 10)], total: 1 } }, Date.now());
  });

  it("does not touch the database on a pool hit", async () => {
    await expect(randomQuote({ categories: ["game"] }, "r")).resolves.toMatchObject({ id: "g1" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("falls back to the database with a 500 ms limit", async () => {
    vi.mocked(rpc).mockResolvedValue(quote("db") as never);
    await expect(randomQuote({ categories: ["game"], min: 77 }, "r")).resolves.toMatchObject({ id: "db" });
    expect(rpc).toHaveBeenCalledWith("random_quote_fallback", { categories: ["game"], min: 77, max: null }, { requestId: "r", timeoutMs: 500 });
  });

  it("caches an empty result, so the same filter skips the database", async () => {
    vi.mocked(rpc).mockResolvedValue(null as never);
    const filter = { categories: ["game"], min: 88 };
    await expect(randomQuote(filter, "r")).rejects.toMatchObject({ code: "NO_QUOTE_MATCHED" });
    await expect(randomQuote(filter, "r")).rejects.toMatchObject({ code: "NO_QUOTE_MATCHED" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("answers 503 past 5 concurrent fallbacks", async () => {
    vi.mocked(rpc).mockImplementation(() => new Promise(() => {}) as never);
    for (let i = 0; i < 5; i += 1) void randomQuote({ min: 90 + i }, "r").catch(() => {});
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(5));
    await expect(randomQuote({ min: 96 }, "r")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
