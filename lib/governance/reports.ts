import type { z } from "zod";
import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { json } from "@/lib/http/with-route";
import { removeQuote } from "@/lib/quotes/pool";
import { db, rpc } from "@/lib/supabase";
import type { reportBody } from "@/lib/validators/governance";

export async function createReport(
  target: { type: "quote" | "comment"; id: string },
  actor: string,
  body: z.infer<typeof reportBody>,
  requestId: string,
) {
  const [created] = await rpc("create_report", { actor, target_type: target.type, target_id: target.id, ...body }, { requestId });
  if (!created) throw new ApiError("INTERNAL_ERROR");
  if (created.became_under_review) removeQuote(target.id);
  const { data, error } = await db().from("reports").select("id, status, created_at").eq("id", created.report_id).single();
  if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
  return json({ ...data, created_at: iso(data.created_at) }, requestId, { status: 201 });
}
