import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { rpc } from "@/lib/supabase";
import { reasonBody } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  POST: withRoute(
    { auth: "admin", rate: "RL-ADMIN", cache: "C-NONE", session: "online", idNotFound: "SANCTION_NOT_FOUND", body: reasonBody },
    async ({ caller, params, body, requestId }) => {
      const lifted = await rpc("lift_sanction", { actor: identified(caller).userId, sanction_id: params.id!, reason: body.reason }, { requestId }) as object;
      return json({ sanction_id: params.id, ...lifted }, requestId);
    },
  ),
});
