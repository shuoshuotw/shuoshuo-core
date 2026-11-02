import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, iso, olderThan, pageOf, paginationQuery } from "@/lib/http/pagination";
import { jsonList, route, withRoute } from "@/lib/http/with-route";
import { QUOTE_SELECT, type QuoteRow, toQuote } from "@/lib/quotes/serialize";
import { db } from "@/lib/supabase";
import { findProfile } from "@/lib/users/profile";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute(
    { auth: "listing", rate: "RL-PUBLIC", cache: "C-NONE", query: paginationQuery },
    async ({ caller, params, query, requestId }) => {
      const profile = await findProfile(params.username!);
      const owner = caller.type !== "anonymous" && caller.userId === profile.id
        && (caller.type === "user" || caller.scopes.includes("me:read"));
      if (!profile.likes_public && !owner) throw new ApiError("USER_LIKES_PRIVATE");

      const after = decodeCursor(query.cursor);
      let read = db().from("quote_likes").select(`quote_id, created_at, quote:quotes(${QUOTE_SELECT})`)
        .eq("user_id", profile.id).order("created_at", { ascending: false }).order("quote_id", { ascending: false }).limit(query.limit + 1);
      if (after) read = read.or(olderThan(after, "created_at", "quote_id"));
      const { data, error } = await read;
      if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
      const page = pageOf(data, query.limit, (row) => ({ c: row.created_at, i: row.quote_id }));
      return jsonList(page.items.map((row) => {
        const quote = row.quote as QuoteRow | null;
        return { liked_at: iso(row.created_at), quote: quote && ["published", "under_review"].includes(quote.status) ? toQuote(quote) : null };
      }), page.pagination, requestId);
    },
  ),
});
