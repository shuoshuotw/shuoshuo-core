import { appealTarget } from "@/lib/governance/serialize";
import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, iso, olderThan, pageOf, paginationQuery } from "@/lib/http/pagination";
import { identified, json, jsonList, route, withRoute } from "@/lib/http/with-route";
import { db, rpc } from "@/lib/supabase";
import { appealBody } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "user", rate: "RL-USER", cache: "C-NONE", query: paginationQuery }, async ({ caller, query, requestId }) => {
    const after = decodeCursor(query.cursor);
    let select = db().from("appeals").select("id, sanction_id, violation_id, statement, status, decision_note, decided_at, created_at")
      .eq("user_id", identified(caller).userId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
    if (after) select = select.or(olderThan(after));
    const { data, error } = await select;
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const page = pageOf(data, query.limit, (row) => ({ c: row.created_at, i: row.id }));
    return jsonList(page.items.map(({ sanction_id, violation_id, ...row }) => ({
      ...row,
      ...appealTarget({ sanction_id, violation_id }),
      decided_at: iso(row.decided_at),
      created_at: iso(row.created_at),
    })), page.pagination, requestId);
  }),
  POST: withRoute({ auth: "user", rate: "RL-SENSITIVE", cache: "C-NONE", body: appealBody }, async ({ caller, body, requestId }) => {
    const id = await rpc("create_appeal", { actor: identified(caller).userId, ...body }, { requestId });
    const { data, error } = await db().from("appeals").select("id, sanction_id, violation_id, status, created_at").eq("id", id).single();
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    return json({
      id: data.id,
      ...appealTarget(data),
      status: data.status,
      created_at: iso(data.created_at),
    }, requestId, { status: 201 });
  }),
});
