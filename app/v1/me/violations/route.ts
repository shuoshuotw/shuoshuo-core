import { OWN_VIOLATION_SELECT, type OwnViolationRow, toViolation } from "@/lib/governance/serialize";
import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, olderThan, pageOf, paginationQuery } from "@/lib/http/pagination";
import { identified, jsonList, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "user", rate: "RL-USER", cache: "C-NONE", query: paginationQuery }, async ({ caller, query, requestId }) => {
    const after = decodeCursor(query.cursor);
    let select = db().from("violations").select(OWN_VIOLATION_SELECT)
      .eq("user_id", identified(caller).userId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
    if (after) select = select.or(olderThan(after));
    const { data, error } = await select;
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const page = pageOf(data as unknown as OwnViolationRow[], query.limit, (row) => ({ c: row.created_at, i: row.id }));

    // A case points at its comment by id only, so the comments' words are read in one more query
    const commentIds = page.items.flatMap(({ moderation }) => (moderation?.target_type === "comment" ? [moderation.target_id] : []));
    const comments = new Map<string, string>();
    if (commentIds.length > 0) {
      const found = await db().from("comments").select("id, content").in("id", commentIds);
      if (found.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: found.error });
      for (const comment of found.data) comments.set(comment.id, comment.content);
    }

    const items = page.items.map((row) => {
      const type = row.moderation?.target_type ?? "quote";
      const content = type === "comment" ? (comments.get(row.moderation!.target_id) ?? null) : (row.quote?.content ?? null);
      return { ...toViolation(row), target: { type, content } };
    });
    return jsonList(items, page.pagination, requestId);
  }),
});
