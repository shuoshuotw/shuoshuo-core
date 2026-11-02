import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { identified, json, noContent, route, withRoute } from "@/lib/http/with-route";
import { db, rpc } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute(
    { auth: "user", rate: "RL-USER", cache: "C-NONE", rejectBanned: true, idNotFound: "API_KEY_NOT_FOUND" },
    async ({ caller, params, requestId }) => {
      const { data, error } = await db().from("api_keys")
        .select("id, name, key_prefix, scopes, last_used_at, regenerated_at, created_at")
        .eq("id", params.id!)
        .eq("user_id", identified(caller).userId)
        .is("revoked_at", null)
        .maybeSingle();
      if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
      if (!data) throw new ApiError("API_KEY_NOT_FOUND");
      return json({
        ...data,
        last_used_at: iso(data.last_used_at),
        regenerated_at: iso(data.regenerated_at),
        created_at: iso(data.created_at),
      }, requestId);
    },
  ),
  DELETE: withRoute(
    { auth: "user", rate: "RL-WRITE", cache: "C-NONE", action: "api_key_write", idNotFound: "API_KEY_NOT_FOUND" },
    async ({ caller, params, requestId }) => {
      await rpc("revoke_api_key", { actor: identified(caller).userId, key_id: params.id! }, { requestId });
      return noContent();
    },
  ),
});
