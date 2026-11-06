import { AUDIT_SELECT, toAuditLogs } from "@/lib/governance/audit";
import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, olderThan, pageOf } from "@/lib/http/pagination";
import { jsonList, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";
import { auditLogsQuery } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

// Matches no one: `in` with an empty list is not something to hand PostgREST
const NOBODY = "00000000-0000-0000-0000-000000000000";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "admin", rate: "RL-ADMIN", cache: "C-NONE", query: auditLogsQuery }, async ({ query, requestId }) => {
    const after = decodeCursor(query.cursor);
    let select = db().from("audit_logs").select(AUDIT_SELECT);
    if (query.actor_id) select = select.eq("actor_id", query.actor_id);
    if (query.actor) {
      const named = await db().from("profiles").select("id").ilike("username", `%${query.actor.replace(/[\\%_]/g, "\\$&")}%`).limit(100);
      if (named.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: named.error });
      select = select.in("actor_id", named.data.length > 0 ? named.data.map(({ id }) => id) : [NOBODY]);
    }
    if (query.target_id) select = select.eq("target_id", query.target_id);
    if (query.action) select = select.eq("action", query.action);
    if (query.from) select = select.gte("created_at", query.from);
    if (query.to) select = select.lte("created_at", query.to);
    if (after) select = select.or(olderThan(after));
    const { data, error } = await select
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const page = pageOf(data, query.limit, (row) => ({ c: row.created_at, i: String(row.id) }));
    return jsonList(await toAuditLogs(page.items), page.pagination, requestId);
  }),
});
