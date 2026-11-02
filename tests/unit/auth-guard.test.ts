import { describe, expect, it, vi } from "vitest";

const lookups = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/lib/env", () => ({ env: () => ({ API_KEY_ENV: "test", INTERNAL_HMAC_SECRETS: "s" }) }));
vi.mock("@/lib/supabase", () => ({ db: () => ({}) }));
vi.mock("@/lib/auth/api-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/api-key")>()),
  lookupKey: async () => {
    lookups.count += 1;
    return "invalid";
  },
}));

import { generateKey } from "@/lib/auth/api-key";
import { resolveCaller } from "@/lib/auth/resolve-caller";

const attempt = (ip: string) => resolveCaller(new Request("https://api.test/v1/quotes", {
  headers: { authorization: `Bearer ${generateKey("test").secret}`, "cf-connecting-ip": ip },
})).catch((error: { code: string; details?: { scope?: string } }) => error);

describe("AUTH-GUARD (§10.4)", () => {
  it("RL-08: a flood of random keys stops reaching the database once it trips", async () => {
    for (let i = 0; i < 20; i += 1) expect(await attempt("203.0.113.8")).toMatchObject({ code: "API_KEY_INVALID" });
    const before = lookups.count;
    expect(before).toBe(20);
    for (let i = 0; i < 5; i += 1) {
      expect(await attempt("203.0.113.8")).toMatchObject({ code: "RATE_LIMITED", details: { scope: "auth_guard" } });
    }
    expect(lookups.count).toBe(before);
    // Another address is untouched
    expect(await attempt("203.0.113.9")).toMatchObject({ code: "API_KEY_INVALID" });
  });
});
