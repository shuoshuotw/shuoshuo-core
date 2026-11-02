import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, iso, olderThan, pageOf, paginationQuery } from "@/lib/http/pagination";
import { identified, jsonList, route, withRoute } from "@/lib/http/with-route";
import { QUOTE_SELECT, toQuote, type QuoteRow } from "@/lib/quotes/serialize";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "user_or_key", scope: "me:read", rate: "RL-USER", cache: "C-NONE", query: paginationQuery }, async ({ caller, query, requestId }) => {
    const after = decodeCursor(query.cursor);
    let select = db().from("quote_favorites").select(`quote_id, created_at, quote:quotes(${QUOTE_SELECT})`)
      .eq("user_id", identified(caller).userId)
      .order("created_at", { ascending: false }).order("quote_id", { ascending: false }).limit(query.limit + 1);
    if (after) select = select.or(olderThan(after, "created_at", "quote_id"));
    const { data, error } = await select;
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const page = pageOf(data, query.limit, (row) => ({ c: row.created_at, i: row.quote_id }));
    return jsonList(page.items.map((row) => ({
      favorited_at: iso(row.created_at),
      quote: row.quote && (row.quote.status === "published" || row.quote.status === "under_review") ? toQuote(row.quote as QuoteRow) : null,
    })), page.pagination, requestId);
  }),
});
