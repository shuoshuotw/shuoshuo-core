import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { updateSubmitter } from "@/lib/quotes/pool";
import { rpc } from "@/lib/supabase";
import { reasonBody } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  POST: withRoute(
    { auth: "admin", rate: "RL-ADMIN", cache: "C-NONE", session: "online", idNotFound: "USER_NOT_FOUND", body: reasonBody },
    async ({ caller, params, body, requestId }) => {
      const profile = await rpc("reset_profile", { actor: identified(caller).userId, user_id: params.id!, reason: body.reason }, { requestId });
      updateSubmitter(profile.id, { username: profile.username });
      return json({ id: profile.id, username: profile.username }, requestId);
    },
  ),
});
