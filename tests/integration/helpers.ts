import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// Needs `supabase start` and a running Core on port 3001 (`pnpm build && pnpm start`). The publishable key is the CLI's local default; the secret key comes from .env.local.
const SUPABASE_URL = "http://127.0.0.1:54321";
process.loadEnvFile(".env.local");
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;
const PUBLISHABLE_KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const CORE_URL = process.env.CORE_URL ?? "http://localhost:3001";

export const admin = createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

export const SEED = {
  adminUser: "00000000-0000-4000-a000-000000000001",
  alice: "00000000-0000-4000-a000-000000000002",
  bob: "00000000-0000-4000-a000-000000000003",
  /** cat * 100 + line; submitter is 2 + line % 4 */
  quote: (category: number, line: number) => `00000000-0000-4000-8000-${String(category * 100 + line).padStart(12, "0")}`,
};

export type TestUser = { id: string; email: string; token: string };

// The Admin API does not trigger the signup Hook (§6.7), so tests can use email users
export async function createUser(fullName = `測試${randomUUID().slice(0, 6)}`): Promise<TestUser> {
  const email = `${randomUUID()}@example.com`;
  const password = randomUUID();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
  if (created.error) throw created.error;
  const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return { id: created.data.user.id, email, token: signedIn.data.session.access_token };
}

type CallOptions = { method?: string; token?: string; body?: unknown; ip?: string };

// A fresh IP per call by default: tests must not trip each other's per-IP limits
export async function call(path: string, { method = "GET", token, body, ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}` }: CallOptions = {}) {
  const response = await fetch(`${CORE_URL}${path}`, {
    method,
    headers: {
      "cf-connecting-ip": ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let json: { data?: never; meta?: never; error?: { code: string; details?: never } } = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    // format=text and 204 responses
  }
  return { status: response.status, headers: response.headers, raw, ...json };
}
