import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, olderThan, pageOf } from "@/lib/http/pagination";
import { identified, jsonList, route, withRoute } from "@/lib/http/with-route";
import { QUOTE_SELECT, toOwnQuote, type QuoteRow } from "@/lib/quotes/serialize";
import { db } from "@/lib/supabase";
import { myQuotesQuery } from "@/lib/validators/me";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "user_or_key", scope: "me:read", rate: "RL-USER", cache: "C-NONE", query: myQuotesQuery }, async ({ caller, query, requestId }) => {
    const after = decodeCursor(query.cursor);
    let select = db().from("quotes").select(QUOTE_SELECT)
      .eq("submitter_id", identified(caller).userId).neq("status", "deleted")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
    if (query.status) select = select.eq("status", query.status);
    if (after) select = select.or(olderThan(after));
    const { data, error } = await select;
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const page = pageOf(data, query.limit, (row) => ({ c: row.created_at, i: row.id }));
    return jsonList(page.items.map((row) => toOwnQuote(row as QuoteRow)), page.pagination, requestId);
  }),
});
