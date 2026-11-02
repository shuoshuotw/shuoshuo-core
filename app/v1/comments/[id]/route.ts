import { COMMENT_SELECT, syncCommentCount, toComment } from "@/lib/comments/serialize";
import { ApiError } from "@/lib/http/api-error";
import { identified, json, noContent, route, withRoute } from "@/lib/http/with-route";
import { db, rpc } from "@/lib/supabase";
import { commentBody } from "@/lib/validators/comments";

export const dynamic = "force-dynamic";

function commentError(error: unknown): never {
  if (error instanceof ApiError && error.code === "NOT_RESOURCE_OWNER") {
    throw new ApiError(error.code, { variant: "comment", details: error.details, cause: error });
  }
  throw error;
}

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  PATCH: withRoute(
    { auth: "user_or_key", scope: "comments:write", rate: "RL-WRITE", cache: "C-NONE", idNotFound: "COMMENT_NOT_FOUND", body: commentBody },
    async ({ caller, params, body, requestId }) => {
      const id = await rpc("update_comment", { actor: identified(caller).userId, comment_id: params.id!, content: body.content }, { requestId }).catch(commentError);
      const { data, error } = await db().from("comments").select(COMMENT_SELECT).eq("id", id).single();
      if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
      return json(toComment(data), requestId);
    },
  ),
  DELETE: withRoute(
    { auth: "user_or_key", scope: "comments:write", rate: "RL-WRITE", cache: "C-NONE", idNotFound: "COMMENT_NOT_FOUND" },
    async ({ caller, params, requestId }) => {
      const comment = await db().from("comments").select("quote_id").eq("id", params.id!).maybeSingle();
      if (comment.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: comment.error });
      if (!comment.data) throw new ApiError("COMMENT_NOT_FOUND");
      await rpc("delete_comment", { actor: identified(caller).userId, comment_id: params.id! }, { requestId }).catch(commentError);
      await syncCommentCount(comment.data.quote_id);
      return noContent();
    },
  ),
});
