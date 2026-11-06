import { createHash, randomBytes } from "node:crypto";
import type { ApiKeyScope } from "@/lib/auth/caller";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/http/api-error";
import { singleton } from "@/lib/runtime/singleton";
import { db } from "@/lib/supabase";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY_FORMAT = /^shuoshuo_(live|test)_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}$/;

const CACHE_TTL_MS = 15_000;
const CACHE_MAX = 10_000;
const LAST_USED_INTERVAL_MS = 5 * 60_000;

export type ResolvedKey = { keyId: string; userId: string; scopes: ApiKeyScope[] };

type Lookup = ResolvedKey | "invalid" | "revoked" | "expired";

// Rejection sampling keeps every character uniform; a plain modulo would bias the low digits
function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

export function hashKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

export function generateKey(environment = env().API_KEY_ENV) {
  const prefix = `shuoshuo_${environment}_${randomBase62(8)}`;
  const secret = `${prefix}_${randomBase62(43)}`;
  return { prefix, secret, hash: hashKey(secret) };
}

// PostgREST takes bytea as a \x hex string
export const toBytea = (value: Buffer): string => `\\x${value.toString("hex")}`;

export function isValidKeyFormat(key: string, environment = env().API_KEY_ENV): boolean {
  return KEY_FORMAT.exec(key)?.[1] === environment;
}

const cache = () => singleton("api-key-cache", () => new Map<string, { value: Lookup; expires: number }>());
const lastUsed = () => singleton("api-key-last-used", () => new Map<string, number>());

// §7.5: the revocation delay is exactly this cache's lifetime, at most 15 seconds.
export function cachedKey(hash: Buffer, now = Date.now()): Lookup | undefined {
  const entries = cache();
  const id = hash.toString("hex");
  const entry = entries.get(id);
  if (!entry) return undefined;
  if (entry.expires <= now) {
    entries.delete(id);
    return undefined;
  }
  return entry.value;
}

function remember(hash: Buffer, value: Lookup) {
  const entries = cache();
  // Map keeps insertion order, so the first key is the oldest
  if (entries.size >= CACHE_MAX) entries.delete(entries.keys().next().value as string);
  entries.set(hash.toString("hex"), { value, expires: Date.now() + CACHE_TTL_MS });
}

export async function lookupKey(hash: Buffer): Promise<Lookup> {
  const { data, error } = await db()
    .from("api_keys")
    .select("id, user_id, scopes, revoked_at, expires_at")
    .eq("key_hash", toBytea(hash))
    .maybeSingle();
  // A database error is not cached: it says nothing about the key (§7.5)
  if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
  const value: Lookup = !data
    ? "invalid"
    : data.revoked_at
      ? "revoked"
      : data.expires_at && Date.parse(data.expires_at) <= Date.now()
        ? "expired"
        : { keyId: data.id, userId: data.user_id, scopes: data.scopes as ApiKeyScope[] };
  remember(hash, value);
  return value;
}

// Best effort and throttled, to avoid a write per request (§7.5)
export function touchLastUsed(keyId: string, now = Date.now()) {
  const seen = lastUsed();
  if (now - (seen.get(keyId) ?? 0) < LAST_USED_INTERVAL_MS) return;
  seen.set(keyId, now);
  void db()
    .from("api_keys")
    .update({ last_used_at: new Date(now).toISOString() })
    .eq("id", keyId)
    .then(({ error }) => {
      if (error) console.error(JSON.stringify({ event: "last_used_failed", key_id: keyId, message: error.message }));
    });
}
