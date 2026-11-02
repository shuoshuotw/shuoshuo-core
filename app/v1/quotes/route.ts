import { toBytea } from "@/lib/auth/api-key";
import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, olderThan, pageOf } from "@/lib/http/pagination";
import { identified, json, jsonList, route, withRoute } from "@/lib/http/with-route";
import { assertQuoteLanguage, contentHash } from "@/lib/quotes/normalize";
import { upsertQuote } from "@/lib/quotes/pool";
import { QUOTE_SELECT, type QuoteRow, toQuote } from "@/lib/quotes/serialize";
import { db, rpc } from "@/lib/supabase";
import { createQuoteBody, quotesQuery } from "@/lib/validators/quotes";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute(
    { auth: "public", rate: "RL-PUBLIC", cache: "C-30", query: quotesQuery },
    async ({ query, requestId }) => {
      const after = decodeCursor(query.cursor);
      let rows = db().from("quotes").select(QUOTE_SELECT).eq("status", "published")
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
      if (query.categories) rows = rows.in("category_key", query.categories);
      if (after) rows = rows.or(olderThan(after));
      const { data, error } = await rows;
      if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
      const { items, pagination } = pageOf(data as QuoteRow[], query.limit, (row) => ({ c: row.created_at, i: row.id }));
      return jsonList(items.map(toQuote), pagination, requestId);
    },
  ),
  POST: withRoute(
    { auth: "user_or_key", scope: "quotes:write", rate: "RL-WRITE", cache: "C-NONE", body: createQuoteBody },
    async ({ caller, body, requestId }) => {
      const actor = identified(caller);
      assertQuoteLanguage(body.content);
      const id = await rpc("create_quote", {
        actor: actor.userId,
        ...body,
        content_hash: toBytea(contentHash(body.content)),
        commit_from: actor.type === "api_key" ? "api" : "web",
      }, { requestId });
      const { data, error } = await db().from("quotes").select(QUOTE_SELECT).eq("id", id).single();
      if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
      const quote = toQuote(data as QuoteRow);
      if (quote.status === "published") upsertQuote(quote);
      return json(quote, requestId, { status: 201, headers: { Location: `/v1/quotes/${id}` } });
    },
  ),
});
