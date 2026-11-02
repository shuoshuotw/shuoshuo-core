import { toBytea } from "@/lib/auth/api-key";
import { ApiError } from "@/lib/http/api-error";
import { identified, json, noContent, route, text, withRoute } from "@/lib/http/with-route";
import { assertEditWithinLimit, assertQuoteLanguage, contentHash } from "@/lib/quotes/normalize";
import { removeQuote, upsertQuote } from "@/lib/quotes/pool";
import { QUOTE_SELECT, type QuoteRow, toQuote } from "@/lib/quotes/serialize";
import { db, rpc } from "@/lib/supabase";
import { quoteQuery, updateQuoteBody } from "@/lib/validators/quotes";

export const dynamic = "force-dynamic";

async function readQuote(id: string) {
  const { data, error } = await db().from("quotes").select(QUOTE_SELECT).eq("id", id).maybeSingle();
  if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
  if (!data || data.status === "deleted") throw new ApiError("QUOTE_NOT_FOUND");
  if (data.status === "removed") throw new ApiError("QUOTE_REMOVED", { details: { reason: data.removed_reason } });
  return toQuote(data as QuoteRow);
}

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute(
    { auth: "public", rate: "RL-PUBLIC", cache: "C-30", idNotFound: "QUOTE_NOT_FOUND", query: quoteQuery },
    async ({ params, query, requestId }) => {
      const quote = await readQuote(params.id!);
      return query.format === "text" ? text(quote.content, { "X-Quote-Id": quote.id }) : json(quote, requestId);
    },
  ),
  PATCH: withRoute(
    {
      auth: "user_or_key", scope: "quotes:write", rate: "RL-WRITE", cache: "C-NONE",
      idNotFound: "QUOTE_NOT_FOUND", body: updateQuoteBody,
    },
    async ({ caller, params, body, requestId }) => {
      const actor = identified(caller);
      if (body.content !== undefined) {
        assertQuoteLanguage(body.content);
        // Only compare the owner's published content; the RPC decides ownership and lifecycle errors.
        const { data, error } = await db().from("quotes").select("original_content")
          .eq("id", params.id!).eq("submitter_id", actor.userId).eq("status", "published").maybeSingle();
        if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
        if (data) assertEditWithinLimit(data.original_content, body.content);
      }
      const id = await rpc("update_quote", {
        actor: actor.userId,
        quote_id: params.id!,
        ...body,
        ...(body.content === undefined ? {} : { content_hash: toBytea(contentHash(body.content)) }),
      }, { requestId });
      const quote = await readQuote(id);
      if (quote.status === "published") upsertQuote(quote);
      return json(quote, requestId);
    },
  ),
  DELETE: withRoute(
    { auth: "user_or_key", scope: "quotes:write", rate: "RL-WRITE", cache: "C-NONE", idNotFound: "QUOTE_NOT_FOUND" },
    async ({ caller, params, requestId }) => {
      const { data, error } = await db().from("quotes").select("category_key, status").eq("id", params.id!).maybeSingle();
      if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
      await rpc("delete_quote", { actor: identified(caller).userId, quote_id: params.id! }, { requestId });
      if (data?.status === "published") removeQuote(params.id!, data.category_key);
      return noContent();
    },
  ),
});
