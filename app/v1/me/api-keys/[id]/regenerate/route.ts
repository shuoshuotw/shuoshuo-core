import { generateKey, toBytea } from "@/lib/auth/api-key";
import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { rpc } from "@/lib/supabase";
import type { components } from "@/openapi/types";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  POST: withRoute(
    {
      auth: "user", rate: "RL-WRITE", cache: "C-NONE", action: "api_key_regenerate",
      session: "recent", idNotFound: "API_KEY_NOT_FOUND",
    },
    async ({ caller, params, requestId }) => {
      const key = generateKey();
      const data = await rpc("regenerate_api_key", {
        actor: identified(caller).userId,
        key_id: params.id!,
        key_prefix: key.prefix,
        key_hash: toBytea(key.hash),
      }, { requestId }) as components["schemas"]["ApiKey"];
      return json({ ...data, secret: key.secret }, requestId);
    },
  ),
});
