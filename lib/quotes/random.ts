import { ApiError } from "@/lib/http/api-error";
import { draw, ensureLoaded, type PoolQuote } from "@/lib/quotes/pool";
import { singleton } from "@/lib/runtime/singleton";
import { rpc } from "@/lib/supabase";

const FALLBACK_TIMEOUT_MS = 500;
const FALLBACK_CONCURRENCY = 5;
const NEGATIVE_TTL_MS = 60_000;
const NEGATIVE_MAX = 10_000;

type Filter = { categories?: readonly string[]; min?: number; max?: number };

const state = () => singleton("quote-fallback", () => ({ running: 0, empty: new Map<string, number>() }));

const keyOf = ({ categories, min, max }: Filter) => `${[...(categories ?? [])].sort().join(",")}|${min ?? ""}|${max ?? ""}`;

// §10.3: the pool first, then the database for selective filters. Bad parameters must not hammer the database.
export async function randomQuote(filter: Filter, requestId: string): Promise<PoolQuote> {
  await ensureLoaded();
  const quote = draw(filter);
  if (quote) return quote;

  const fallback = state();
  const key = keyOf(filter);
  if ((fallback.empty.get(key) ?? 0) > Date.now()) throw new ApiError("NO_QUOTE_MATCHED");
  if (fallback.running >= FALLBACK_CONCURRENCY) throw new ApiError("SERVICE_UNAVAILABLE");

  fallback.running += 1;
  try {
    const found = (await rpc(
      "random_quote_fallback",
      { categories: filter.categories ? [...filter.categories] : null, min: filter.min ?? null, max: filter.max ?? null } as never,
      { requestId, timeoutMs: FALLBACK_TIMEOUT_MS },
    )) as unknown as PoolQuote | null;
    if (found) return found;
    if (fallback.empty.size >= NEGATIVE_MAX) fallback.empty.clear();
    fallback.empty.set(key, Date.now() + NEGATIVE_TTL_MS);
    throw new ApiError("NO_QUOTE_MATCHED");
  } finally {
    fallback.running -= 1;
  }
}
