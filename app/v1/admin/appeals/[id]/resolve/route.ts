import { syncCommentCount } from "@/lib/comments/serialize";
import { ApiError } from "@/lib/http/api-error";
import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { upsertQuote } from "@/lib/quotes/pool";
import { QUOTE_SELECT, type QuoteRow, toQuote } from "@/lib/quotes/serialize";
import { db, rpc } from "@/lib/supabase";
import { resolveAppealBody } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

async function syncRestoredTarget(appealId: string) {
  const appeal = await db().from("appeals").select("violation_id, sanction:sanctions(violation_id)").eq("id", appealId).single();
  if (appeal.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: appeal.error });
  const violationId = appeal.data.violation_id ?? appeal.data.sanction?.violation_id;
  if (!violationId) return;

  const violation = await db().from("violations").select("quote_id, case:moderation_cases(target_id)").eq("id", violationId).single();
  if (violation.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: violation.error });
  if (violation.data.quote_id) {
    const quote = await db().from("quotes").select(QUOTE_SELECT).eq("id", violation.data.quote_id).single();
    if (quote.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: quote.error });
    upsertQuote(toQuote(quote.data as QuoteRow));
    return;
  }
  const comment = await db().from("comments").select("quote_id").eq("id", violation.data.case.target_id).single();
  if (comment.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: comment.error });
  await syncCommentCount(comment.data.quote_id);
}

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  POST: withRoute(
    { auth: "admin", rate: "RL-ADMIN", cache: "C-NONE", session: "online", idNotFound: "APPEAL_NOT_FOUND", body: resolveAppealBody },
    async ({ caller, params, body, requestId }) => {
      const effects = await rpc("resolve_appeal", {
        actor: identified(caller).userId,
        appeal_id: params.id!,
        decision: body.decision,
        note: body.note,
      }, { requestId }) as { target_restored: boolean };
      if (effects.target_restored) await syncRestoredTarget(params.id!);
      return json({ appeal_id: params.id, status: body.decision === "accept" ? "accepted" : "rejected", effects }, requestId);
    },
  ),
});
