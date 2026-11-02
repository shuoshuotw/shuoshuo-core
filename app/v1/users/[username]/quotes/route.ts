import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, olderThan, pageOf, paginationQuery } from "@/lib/http/pagination";
import { jsonList, route, withRoute } from "@/lib/http/with-route";
import { QUOTE_SELECT, type QuoteRow, toQuote } from "@/lib/quotes/serialize";
import { db } from "@/lib/supabase";
import { findProfile } from "@/lib/users/profile";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute(
    { auth: "public", rate: "RL-PUBLIC", cache: "C-30", query: paginationQuery },
    async ({ params, query, requestId }) => {
      const after = decodeCursor(query.cursor);
      const profile = await findProfile(params.username!);
      let read = db().from("quotes").select(QUOTE_SELECT).eq("submitter_id", profile.id).eq("status", "published")
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
      if (after) read = read.or(olderThan(after));
      const { data, error } = await read;
      if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
      const page = pageOf(data, query.limit, (row) => ({ c: row.created_at, i: row.id }));
      return jsonList(page.items.map((row) => toQuote(row as QuoteRow)), page.pagination, requestId);
    },
  ),
});
