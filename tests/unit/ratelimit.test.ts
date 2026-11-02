import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Caller } from "@/lib/auth/caller";
import { enforceRateLimit, type RateClass } from "@/lib/ratelimit";

const anonymous = (): Caller => ({ type: "anonymous", internal: false, ip: randomUUID() });
const internal = (): Caller => ({ type: "anonymous", internal: true, ip: randomUUID() });
const user = (): Caller => ({ type: "user", internal: false, ip: "1.1.1.1", userId: randomUUID(), aal: "aal1", sessionId: "s", amr: [], token: "t" });
const apiKey = (userId = randomUUID()): Caller => ({ type: "api_key", internal: false, ip: "1.1.1.1", userId, keyId: randomUUID(), scopes: ["quotes:read"] });

async function spend(caller: Caller, rate: RateClass, times: number) {
  for (let i = 0; i < times; i += 1) await enforceRateLimit(caller, rate);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("rate classes (§8.2.3)", () => {
  // Internal callers share one bucket across the file, so that row only reads its limit
  it.each<[string, () => Caller, RateClass, number]>([
    ["anonymous", anonymous, "RL-PUBLIC", 60],
    ["user", user, "RL-PUBLIC", 300],
    ["API Key", apiKey, "RL-PUBLIC", 1200],
    ["user", user, "RL-USER", 120],
    ["API Key", apiKey, "RL-USER", 300],
    ["user", user, "RL-WRITE", 60],
    ["API Key", apiKey, "RL-WRITE", 120],
    ["user", user, "RL-SENSITIVE", 10],
    ["user", user, "RL-ADMIN", 600],
  ])("RL-01, RL-02: %s on %s allows exactly its limit", async (_name, caller, rate, limit) => {
    const subject = caller();
    await spend(subject, rate, limit - 1);
    const last = await enforceRateLimit(subject, rate);
    expect(last).toMatchObject({ "RateLimit-Limit": String(limit), "RateLimit-Remaining": "0" });
    const over = await enforceRateLimit(subject, rate).catch((error: unknown) => error);
    expect(over).toMatchObject({
      code: "RATE_LIMITED",
      details: { limit, window_seconds: 60 },
      headers: { "RateLimit-Remaining": "0", "RateLimit-Limit": String(limit), "Retry-After": expect.stringMatching(/^\d+$/) },
    });
  });

  it("RL-02: internal callers get the internal quota", async () => {
    expect(await enforceRateLimit(internal(), "RL-PUBLIC")).toMatchObject({ "RateLimit-Limit": "3000" });
  });

  it("RL-02: a caller type a class does not list is a wiring bug, not unlimited", async () => {
    await expect(enforceRateLimit(apiKey(), "RL-SENSITIVE")).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("RL-04: several keys share the account's total on public routes", async () => {
    const owner = randomUUID();
    for (let i = 0; i < 3; i += 1) await spend(apiKey(owner), "RL-PUBLIC", 1000);
    await expect(enforceRateLimit(apiKey(owner), "RL-PUBLIC")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { scope: "api_key_account", limit: 3000 },
    });
    // Another account is untouched
    await expect(enforceRateLimit(apiKey(), "RL-PUBLIC")).resolves.toBeDefined();
  });

  it.each<[string, () => Caller, RateClass, number]>([
    ["RL-05: writes", user, "RL-WRITE", 60],
    ["RL-05: sensitive writes", user, "RL-SENSITIVE", 10],
    ["RL-07: API Keys", apiKey, "RL-PUBLIC", 1200],
  ])("%s only limit per minute: a full minute every minute never hits a longer window", async (_name, caller, rate, limit) => {
    vi.useFakeTimers();
    const subject = caller();
    // shortcut: three windows rather than a simulated day, since CLASSES holds one 60-second duration per class
    for (let window = 0; window < 3; window += 1) {
      await spend(subject, rate, limit);
      await expect(enforceRateLimit(subject, rate)).rejects.toMatchObject({ code: "RATE_LIMITED" });
      vi.advanceTimersByTime(61_000);
    }
    await expect(enforceRateLimit(subject, rate)).resolves.toBeDefined();
  });
});
