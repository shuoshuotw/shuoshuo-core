import { COMMENT_SELECT, type CommentRow, syncCommentCount, toComment } from "@/lib/comments/serialize";
import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, olderThan, pageOf, paginationQuery } from "@/lib/http/pagination";
import { identified, json, jsonList, route, withRoute } from "@/lib/http/with-route";
import { db, rpc } from "@/lib/supabase";
import { commentBody } from "@/lib/validators/comments";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute(
    { auth: "public", rate: "RL-PUBLIC", cache: "C-30", idNotFound: "QUOTE_NOT_FOUND", query: paginationQuery },
    async ({ params, query, requestId }) => {
      const after = decodeCursor(query.cursor);
      const quote = await db().from("quotes").select("status, removed_reason").eq("id", params.id!).maybeSingle();
      if (quote.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: quote.error });
      if (!quote.data || quote.data.status === "deleted") throw new ApiError("QUOTE_NOT_FOUND");
      if (quote.data.status === "removed") throw new ApiError("QUOTE_REMOVED", { details: { reason: quote.data.removed_reason } });

      let pinned: CommentRow | null = null;
      if (!after) {
        const result = await db().from("comments").select(COMMENT_SELECT)
          .eq("quote_id", params.id!).eq("status", "visible").not("pinned_at", "is", null).maybeSingle();
        if (result.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: result.error });
        pinned = result.data;
      }
      let read = db().from("comments").select(COMMENT_SELECT)
        .eq("quote_id", params.id!).eq("status", "visible").is("pinned_at", null)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
      if (after) read = read.or(olderThan(after));
      const { data, error } = await read;
      if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
      // The pin is outside the ordinary keyset, including when limit=1.
      const page = pageOf(data, query.limit, (row) => ({ c: row.created_at, i: row.id }));
      return jsonList((pinned ? [pinned, ...page.items] : page.items).map(toComment), page.pagination, requestId);
    },
  ),
  POST: withRoute(
    { auth: "user_or_key", scope: "comments:write", rate: "RL-WRITE", cache: "C-NONE", idNotFound: "QUOTE_NOT_FOUND", body: commentBody },
    async ({ caller, params, body, requestId }) => {
      const id = await rpc("create_comment", { actor: identified(caller).userId, quote_id: params.id!, content: body.content }, { requestId });
      await syncCommentCount(params.id!);
      const { data, error } = await db().from("comments").select(COMMENT_SELECT).eq("id", id).single();
      if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
      return json(toComment(data), requestId, { status: 201 });
    },
  ),
});
