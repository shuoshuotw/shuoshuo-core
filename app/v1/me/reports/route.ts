import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, iso, olderThan, pageOf, paginationQuery } from "@/lib/http/pagination";
import { identified, jsonList, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "user", rate: "RL-USER", cache: "C-NONE", query: paginationQuery }, async ({ caller, query, requestId }) => {
    const after = decodeCursor(query.cursor);
    let select = db().from("reports").select("id, target_type, target_id, reason, status, created_at")
      .eq("reporter_id", identified(caller).userId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
    if (after) select = select.or(olderThan(after));
    const { data, error } = await select;
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const page = pageOf(data, query.limit, (row) => ({ c: row.created_at, i: row.id }));
    return jsonList(page.items.map((row) => ({ ...row, created_at: iso(row.created_at) })), page.pagination, requestId);
  }),
});
