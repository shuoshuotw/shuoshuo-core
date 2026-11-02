import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, iso, olderThan, pageOf } from "@/lib/http/pagination";
import { jsonList, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";
import { auditLogsQuery } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "admin", rate: "RL-ADMIN", cache: "C-NONE", query: auditLogsQuery }, async ({ query, requestId }) => {
    const after = decodeCursor(query.cursor);
    let select = db().from("audit_logs").select("id, actor_id, actor_type, action, target_type, target_id, metadata, request_id, created_at");
    if (query.actor_id) select = select.eq("actor_id", query.actor_id);
    if (query.target_id) select = select.eq("target_id", query.target_id);
    if (query.action) select = select.eq("action", query.action);
    if (query.from) select = select.gte("created_at", query.from);
    if (query.to) select = select.lte("created_at", query.to);
    if (after) select = select.or(olderThan(after));
    const { data, error } = await select
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const page = pageOf(data, query.limit, (row) => ({ c: row.created_at, i: String(row.id) }));
    return jsonList(page.items.map((row) => ({ ...row, created_at: iso(row.created_at) })), page.pagination, requestId);
  }),
});
