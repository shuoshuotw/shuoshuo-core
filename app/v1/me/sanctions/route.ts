import { SANCTION_SELECT, type SanctionRow, toSanction } from "@/lib/governance/serialize";
import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, olderThan, pageOf, paginationQuery } from "@/lib/http/pagination";
import { identified, jsonList, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "user", rate: "RL-USER", cache: "C-NONE", query: paginationQuery }, async ({ caller, query, requestId }) => {
    const after = decodeCursor(query.cursor);
    let select = db().from("sanctions").select(SANCTION_SELECT)
      .eq("user_id", identified(caller).userId)
      .order("starts_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
    if (after) select = select.or(olderThan(after, "starts_at"));
    const { data, error } = await select;
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const page = pageOf(data as unknown as SanctionRow[], query.limit, (row) => ({ c: row.starts_at, i: row.id }));
    return jsonList(page.items.map(toSanction), page.pagination, requestId);
  }),
});
