import { ApiError } from "@/lib/http/api-error";
import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { updateSubmitter } from "@/lib/quotes/pool";
import { db, rpc } from "@/lib/supabase";
import { accountDeletionBody } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

// §11.5
export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  POST: withRoute(
    { auth: "user", rate: "RL-WRITE", cache: "C-NONE", action: "account_delete", session: "recent", body: accountDeletionBody },
    async ({ caller, body, requestId }) => {
      const { userId } = identified(caller);
      // No deleted_at filter: a retry after a failed deleteUser must still get through
      const { data, error } = await db().from("profiles").select("username").eq("id", userId).maybeSingle();
      if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
      if (data?.username !== body.confirm_username) throw new ApiError("CONFIRMATION_MISMATCH");

      await rpc("delete_account_data", { actor: userId }, { requestId, timeoutMs: 10_000 });
      // deleteUser removes any session this misses, so its failure is not worth failing over
      if (caller.type === "user") await db().auth.admin.signOut(caller.token, "global");
      const deleted = await db().auth.admin.deleteUser(userId);
      if (deleted.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: deleted.error });
      updateSubmitter(userId, { deleted: true });
      return json({ status: "deleted" }, requestId, { status: 202 });
    },
  ),
});
