import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { rpc } from "@/lib/supabase";
import { sanctionBody } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  POST: withRoute(
    { auth: "admin", rate: "RL-ADMIN", cache: "C-NONE", session: "online", idNotFound: "USER_NOT_FOUND", body: sanctionBody },
    async ({ caller, params, body, requestId }) => {
      const [created] = await rpc("create_sanction", {
        actor: identified(caller).userId,
        user_id: params.id!,
        kind: body.kind,
        reason: body.reason,
        ...(body.kind === "submit_suspension" ? { duration_days: body.duration_days } : {}),
      }, { requestId });
      if (!created) throw new ApiError("INTERNAL_ERROR");
      return json({
        sanction_id: created.sanction_id,
        kind: body.kind,
        ends_at: iso(created.ends_at),
        api_keys_revoked: created.api_keys_revoked,
      }, requestId, { status: 201 });
    },
  ),
});
