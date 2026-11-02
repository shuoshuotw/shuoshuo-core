import { toViolation, VIOLATION_SELECT, type ViolationRow } from "@/lib/governance/serialize";
import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, olderThan, pageOf, paginationQuery } from "@/lib/http/pagination";
import { identified, jsonList, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "user", rate: "RL-USER", cache: "C-NONE", query: paginationQuery }, async ({ caller, query, requestId }) => {
    const after = decodeCursor(query.cursor);
    let select = db().from("violations").select(VIOLATION_SELECT)
      .eq("user_id", identified(caller).userId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
    if (after) select = select.or(olderThan(after));
    const { data, error } = await select;
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const page = pageOf(data as unknown as ViolationRow[], query.limit, (row) => ({ c: row.created_at, i: row.id }));
    return jsonList(page.items.map(toViolation), page.pagination, requestId);
  }),
});
