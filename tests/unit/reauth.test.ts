import { describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ amr: [] as { method: string; timestamp: number }[] }));

vi.mock("@/lib/env", () => ({ env: () => ({ API_KEY_ENV: "test", CORS_ALLOWED_ORIGINS: "https://shuoshuotw.xyz", INTERNAL_HMAC_SECRETS: "s" }) }));
vi.mock("@/lib/supabase", () => ({ db: () => ({ auth: { getUser: async () => ({ error: null }) } }), rpc: vi.fn() }));
vi.mock("@/lib/auth/resolve-caller", () => ({
  resolveCaller: async () => ({ type: "user", internal: false, ip: "1.1.1.1", userId: "00000000-0000-4000-a000-000000000002", aal: "aal1", sessionId: "s", amr: session.amr, token: "t" }),
}));
vi.spyOn(console, "log").mockImplementation(() => {});

import { POST as regenerateKey } from "@/app/v1/me/api-keys/[id]/regenerate/route";
import { POST as createKey } from "@/app/v1/me/api-keys/route";
import { POST as deleteAccount } from "@/app/v1/me/account-deletion/route";

const id = "00000000-0000-4000-8000-000000000001";
const routes = [
  ["POST /v1/me/api-keys", createKey],
  ["POST /v1/me/api-keys/{id}/regenerate", regenerateKey],
  ["POST /v1/me/account-deletion", deleteAccount],
] as const;
const now = () => Math.floor(Date.now() / 1000);

async function codeFrom(handler: (typeof routes)[number][1]) {
  const response = await handler(new Request("https://api.test/v1/x", { method: "POST" }), { params: Promise.resolve({ id }) });
  return { status: response.status, code: (await response.json() as { error?: { code: string } }).error?.code };
}

describe("SEC-09b: routes that need recent authentication", () => {
  it.each(routes)("%s rejects authentication older than 10 minutes", async (_name, handler) => {
    session.amr = [{ method: "oauth", timestamp: now() - 601 }];
    expect(await codeFrom(handler)).toEqual({ status: 403, code: "REAUTH_REQUIRED" });
  });

  it.each(routes)("%s does not count a token refresh as authentication", async (_name, handler) => {
    session.amr = [{ method: "token_refresh", timestamp: now() }, { method: "oauth", timestamp: now() - 601 }];
    expect(await codeFrom(handler)).toEqual({ status: 403, code: "REAUTH_REQUIRED" });
  });

  it.each(routes)("%s lets recent authentication through to body validation", async (_name, handler) => {
    session.amr = [{ method: "passkey", timestamp: now() - 60 }];
    expect((await codeFrom(handler)).code).not.toBe("REAUTH_REQUIRED");
  });
});
