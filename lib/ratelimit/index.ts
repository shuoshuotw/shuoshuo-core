import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import type { Caller } from "@/lib/auth/caller";
import { ApiError } from "@/lib/http/api-error";
import { singleton } from "@/lib/runtime/singleton";

export type RateClass = "RL-PUBLIC" | "RL-USER" | "RL-WRITE" | "RL-SENSITIVE" | "RL-ADMIN";
export type ActionQuota = "api_key_write" | "api_key_regenerate" | "username_change" | "account_delete";

type Tier = "anonymous" | "internal" | "user" | "api_key";

// §8.2.3, per minute. A missing tier means that caller type cannot reach the route.
const CLASSES: Record<RateClass, Partial<Record<Tier, number>>> = {
  "RL-PUBLIC": { anonymous: 60, internal: 3000, user: 300, api_key: 1200 },
  "RL-USER": { user: 120, api_key: 300 },
  "RL-WRITE": { user: 60, api_key: 120 },
  "RL-SENSITIVE": { user: 10 },
  "RL-ADMIN": { user: 600 },
};

const API_KEY_ACCOUNT_TOTAL = 3000;

// §10.4, per user per hour
const ACTIONS: Record<ActionQuota, number> = {
  api_key_write: 20,
  api_key_regenerate: 10,
  username_change: 5,
  account_delete: 3,
};

function limiter(name: string, points: number, duration: number) {
  return singleton(`rate:${name}`, () => new RateLimiterMemory({ points, duration, keyPrefix: name }));
}

export type RateHeaders = Record<string, string>;

type Check = { scope: string; subject: string; points: number; duration: number; name: string };

function tierOf(caller: Caller): { tier: Tier; subject: string } {
  if (caller.type === "api_key") return { tier: "api_key", subject: caller.keyId };
  if (caller.type === "user") return { tier: "user", subject: caller.userId };
  if (caller.internal) return { tier: "internal", subject: "shared" };
  return { tier: "anonymous", subject: caller.ip };
}

function checksFor(caller: Caller, rate: RateClass, action?: ActionQuota): Check[] {
  const { tier, subject } = tierOf(caller);
  const points = CLASSES[rate][tier];
  // Route auth rejects these callers first; reaching here unlimited would be a wiring bug
  if (points === undefined) throw new ApiError("INTERNAL_ERROR", { cause: `${tier} on ${rate}` });
  const checks: Check[] = [{ scope: tier, subject, points, duration: 60, name: `${rate}:${tier}` }];

  if (caller.type === "api_key" && rate === "RL-PUBLIC") {
    checks.push({ scope: "api_key_account", subject: caller.userId, points: API_KEY_ACCOUNT_TOTAL, duration: 60, name: "account-total" });
  }
  if (action && caller.type !== "anonymous") {
    checks.push({ scope: action, subject: caller.userId, points: ACTIONS[action], duration: 3600, name: `action:${action}` });
  }
  return checks;
}

// All checks consume; any one over its limit is a 429, and the headers show whichever has least left (§10.4)
export async function enforceRateLimit(caller: Caller, rate: RateClass, action?: ActionQuota): Promise<RateHeaders> {
  let tightest: { limit: number; remaining: number; resetMs: number } | undefined;

  for (const check of checksFor(caller, rate, action)) {
    try {
      const res = await limiter(check.name, check.points, check.duration).consume(check.subject);
      if (!tightest || res.remainingPoints < tightest.remaining) {
        tightest = { limit: check.points, remaining: res.remainingPoints, resetMs: res.msBeforeNext };
      }
    } catch (cause) {
      if (!(cause instanceof RateLimiterRes)) throw new ApiError("INTERNAL_ERROR", { cause });
      throw tooManyRequests(check.scope, check.points, check.duration, cause.msBeforeNext);
    }
  }

  return tightest
    ? {
        "RateLimit-Limit": String(tightest.limit),
        "RateLimit-Remaining": String(tightest.remaining),
        "RateLimit-Reset": String(Math.ceil(tightest.resetMs / 1000)),
      }
    : {};
}

// For a quota that depends on the body, such as a rename on PATCH /v1/me, which `withRoute` cannot know up front
export async function enforceAction(userId: string, action: ActionQuota): Promise<void> {
  const points = ACTIONS[action];
  try {
    await limiter(`action:${action}`, points, 3600).consume(userId);
  } catch (cause) {
    if (!(cause instanceof RateLimiterRes)) throw new ApiError("INTERNAL_ERROR", { cause });
    throw tooManyRequests(action, points, 3600, cause.msBeforeNext);
  }
}

function tooManyRequests(scope: string, limit: number, window: number, msBeforeNext: number) {
  const retryAfter = Math.ceil(msBeforeNext / 1000);
  return new ApiError("RATE_LIMITED", {
    details: { scope, limit, window_seconds: window, retry_after_seconds: retryAfter },
    headers: {
      "Retry-After": String(retryAfter),
      "RateLimit-Limit": String(limit),
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": String(retryAfter),
    },
  });
}

const GUARD_LOOKUPS = 120;
const GUARD_FAILURES = 20;

// AUTH-GUARD (§10.4): runs before any credential lookup, so random keys cannot hammer the database
export async function guardCredentialLookup(ip: string): Promise<void> {
  const failures = await limiter("auth-guard-failures", GUARD_FAILURES, 60).get(ip);
  if (failures && failures.consumedPoints >= GUARD_FAILURES) {
    throw tooManyRequests("auth_guard", GUARD_FAILURES, 60, failures.msBeforeNext);
  }
  try {
    await limiter("auth-guard-lookups", GUARD_LOOKUPS, 60).consume(ip);
  } catch (cause) {
    if (!(cause instanceof RateLimiterRes)) throw new ApiError("INTERNAL_ERROR", { cause });
    throw tooManyRequests("auth_guard", GUARD_LOOKUPS, 60, cause.msBeforeNext);
  }
}

export async function recordCredentialFailure(ip: string): Promise<void> {
  // Over the limit is fine here; the next guard call answers 429
  await limiter("auth-guard-failures", GUARD_FAILURES, 60).consume(ip).catch((cause: unknown) => {
    if (!(cause instanceof RateLimiterRes)) throw cause;
  });
}

// IPv6 clients control a whole /64, so that is the subject (§10.4)
export function clientIp(headers: Headers): string {
  const ip = headers.get("cf-connecting-ip")?.trim();
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.split("::");
  const left = head.split(":").filter(Boolean);
  const right = (tail ?? "").split(":").filter(Boolean);
  const missing = Math.max(0, 8 - left.length - right.length);
  const full = [...left, ...Array<string>(missing).fill("0"), ...right];
  return `${full.slice(0, 4).join(":")}::/64`;
}
