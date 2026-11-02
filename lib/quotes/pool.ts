import { singleton } from "@/lib/runtime/singleton";
import { rpc } from "@/lib/supabase";
import { CATEGORY_KEYS } from "@/lib/validators/common";

// shortcut: the pool assumes one Core process. A second instance needs Redis or Postgres NOTIFY to sync writes (§10.3).

const PER_CATEGORY = 500;
const REFILL_MS = 6 * 60 * 60 * 1000;
const LENGTH_ATTEMPTS = 8;

export type PoolQuote = {
  id: string;
  content: string;
  length: number;
  category: { key: string; name: string };
  source_from: string;
  submitter: { id: string; username: string; deleted: boolean };
  stats: { like_count: number; favorite_count: number; comment_count: number };
  status: string;
  commit_from: string;
  edited_at: string | null;
  created_at: string;
};

type Bucket = { quotes: PoolQuote[]; total: number };
type Pool = { buckets: Map<string, Bucket>; loadedAt: number; loading: Promise<void> | null };

const pool = () => singleton<Pool>("quote-pool", () => ({ buckets: new Map(), loadedAt: 0, loading: null }));

export const SYSTEM_REQUEST_ID = "system_pool";

async function load(state: Pool) {
  const results = await Promise.all(
    CATEGORY_KEYS.map(async (key) => {
      const sampled = (await rpc("sample_quotes", { category: key, n: PER_CATEGORY }, { requestId: SYSTEM_REQUEST_ID })) as unknown as {
        quotes: PoolQuote[];
        category_total: number;
      };
      return [key, { quotes: sampled.quotes, total: sampled.category_total }] as const;
    }),
  );
  state.buckets = new Map(results);
  state.loadedAt = Date.now();
}

// Single flight: concurrent first requests share one load
function startLoad(state: Pool): Promise<void> {
  state.loading ??= load(state).finally(() => {
    state.loading = null;
  });
  return state.loading;
}

export async function ensureLoaded(): Promise<void> {
  const state = pool();
  if (state.loadedAt === 0) return startLoad(state);
  if (Date.now() - state.loadedAt > REFILL_MS) {
    // Refills in the background and keeps serving old data if it fails (§10.3)
    void startLoad(state).catch((error: unknown) => {
      console.error(JSON.stringify({ event: "pool_refill_failed", message: String(error) }));
    });
  }
}

const inLengthRange = (quote: PoolQuote, min?: number, max?: number) =>
  (min === undefined || quote.length >= min) && (max === undefined || quote.length <= max);

function pick<T>(items: T[]): T | undefined {
  return items[Math.floor(Math.random() * items.length)];
}

// Weighted by category total, so a quote's odds do not depend on how full its category is (§10.3)
function pickBucket(buckets: Bucket[]): Bucket | undefined {
  const weight = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
  let point = Math.random() * weight;
  for (const bucket of buckets) {
    point -= bucket.total;
    if (point < 0) return bucket;
  }
  return buckets.at(-1);
}

export function draw(filter: { categories?: readonly string[]; min?: number; max?: number } = {}): PoolQuote | null {
  const { buckets } = pool();
  const keys = filter.categories ?? CATEGORY_KEYS;
  const usable = keys.map((key) => buckets.get(key)).filter((bucket): bucket is Bucket => !!bucket && bucket.quotes.length > 0);
  if (!usable.length) return null;

  for (let attempt = 0; attempt < LENGTH_ATTEMPTS; attempt += 1) {
    const quote = pick(pickBucket(usable)?.quotes ?? []);
    if (quote && inLengthRange(quote, filter.min, filter.max)) return quote;
  }
  const matches = usable.flatMap((bucket) => bucket.quotes.filter((quote) => inLengthRange(quote, filter.min, filter.max)));
  return pick(matches) ?? null;
}

// Every write passes through this process, so these keep the pool current without a removal list (§10.3).
// Route handlers must call them after a successful RPC.

function find(id: string): { bucket: Bucket; index: number } | null {
  for (const bucket of pool().buckets.values()) {
    const index = bucket.quotes.findIndex((quote) => quote.id === id);
    if (index >= 0) return { bucket, index };
  }
  return null;
}

/** New or edited published quote. A full category drops the new quote until the next refill. */
export function upsertQuote(quote: PoolQuote): void {
  const existing = find(quote.id);
  if (existing) {
    if (existing.bucket === pool().buckets.get(quote.category.key)) {
      existing.bucket.quotes[existing.index] = quote;
      return;
    }
    existing.bucket.quotes.splice(existing.index, 1);
    existing.bucket.total -= 1;
  }
  const bucket = pool().buckets.get(quote.category.key);
  if (!bucket) return;
  bucket.total += 1;
  if (bucket.quotes.length < PER_CATEGORY) bucket.quotes.push(quote);
}

/** Deleted, under review or removed. Pass the category when known, so a quote outside the sample still lowers the total. */
export function removeQuote(id: string, categoryKey?: string): void {
  const existing = find(id);
  if (existing) {
    existing.bucket.quotes.splice(existing.index, 1);
    existing.bucket.total -= 1;
    return;
  }
  const bucket = categoryKey ? pool().buckets.get(categoryKey) : undefined;
  if (bucket) bucket.total = Math.max(0, bucket.total - 1);
}

export function updateStats(id: string, stats: Partial<PoolQuote["stats"]>): void {
  const existing = find(id);
  if (existing) {
    const quote = existing.bucket.quotes[existing.index] as PoolQuote;
    quote.stats = { ...quote.stats, ...stats };
  }
}

/** Rename or account deletion. A deleted account keeps its name and only flips `deleted` (D-22). */
export function updateSubmitter(userId: string, change: { username?: string; deleted?: boolean }): void {
  for (const bucket of pool().buckets.values()) {
    for (const quote of bucket.quotes) {
      if (quote.submitter.id === userId) quote.submitter = { ...quote.submitter, ...change };
    }
  }
}

/** Test support: put the pool in a known state */
export function resetPool(buckets: Record<string, Bucket> = {}, loadedAt = 0): void {
  const state = pool();
  state.buckets = new Map(Object.entries(buckets));
  state.loadedAt = loadedAt;
  state.loading = null;
}
