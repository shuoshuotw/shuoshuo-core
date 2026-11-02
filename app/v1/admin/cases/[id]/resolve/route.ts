import { syncCommentCount } from "@/lib/comments/serialize";
import { ApiError } from "@/lib/http/api-error";
import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { removeQuote, upsertQuote } from "@/lib/quotes/pool";
import { QUOTE_SELECT, type QuoteRow, toQuote } from "@/lib/quotes/serialize";
import { db, rpc } from "@/lib/supabase";
import { resolveCaseBody } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  POST: withRoute(
    { auth: "admin", rate: "RL-ADMIN", cache: "C-NONE", session: "online", idNotFound: "CASE_NOT_FOUND", body: resolveCaseBody },
    async ({ caller, params, body, requestId }) => {
      const found = await db().from("moderation_cases").select("target_type, target_id").eq("id", params.id!).maybeSingle();
      if (found.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: found.error });
      if (!found.data) throw new ApiError("CASE_NOT_FOUND");
      const { target_type: type, target_id: targetId } = found.data;

      // Read before the RPC: after it commits, a failed read could only report failure for a finished resolution
      let quote: QuoteRow | null = null;
      let commentQuoteId: string | undefined;
      if (type === "quote") {
        const read = await db().from("quotes").select(QUOTE_SELECT).eq("id", targetId).single();
        if (read.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: read.error });
        quote = read.data as QuoteRow;
      } else {
        const read = await db().from("comments").select("quote_id").eq("id", targetId).maybeSingle();
        if (read.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: read.error });
        commentQuoteId = read.data?.quote_id;
      }

      const effects = await rpc("resolve_case", {
        actor: identified(caller).userId,
        case_id: params.id!,
        resolution: body.resolution,
        ...(body.final_reason ? { final_reason: body.final_reason } : {}),
        ...(body.note ? { note: body.note } : {}),
      }, { requestId }) as { target_status: string };

      if (quote && effects.target_status === "removed") removeQuote(targetId, quote.category.key);
      if (quote?.status === "under_review" && effects.target_status === "published") {
        upsertQuote(toQuote({ ...quote, status: "published" }));
      }
      if (commentQuoteId && effects.target_status === "removed") await syncCommentCount(commentQuoteId);

      return json({ case_id: params.id, resolution: body.resolution, effects }, requestId);
    },
  ),
});
