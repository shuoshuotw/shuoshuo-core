import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { rpc } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function setPin(pinned: boolean) {
  return withRoute(
    { auth: "user_or_key", scope: "comments:write", rate: "RL-WRITE", cache: "C-NONE", idNotFound: "COMMENT_NOT_FOUND" },
    async ({ caller, params, requestId }) => {
      const commentId = params.id!.toLowerCase();
      let pinnedAt: string | null;
      try {
        pinnedAt = await rpc("set_comment_pin", { actor: identified(caller).userId, comment_id: commentId, pinned }, { requestId });
      } catch (error) {
        if (error instanceof ApiError && error.code === "NOT_RESOURCE_OWNER") {
          throw new ApiError(error.code, { variant: "pin", details: error.details, cause: error });
        }
        throw error;
      }
      return json({ comment_id: commentId, pinned_at: iso(pinnedAt) }, requestId);
    },
  );
}

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({ PUT: setPin(true), DELETE: setPin(false) });
