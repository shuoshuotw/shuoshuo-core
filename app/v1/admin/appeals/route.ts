import { appealTarget, SANCTION_SELECT, type SanctionRow, toSanction, toViolation, VIOLATION_SELECT, type ViolationRow } from "@/lib/governance/serialize";
import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, iso, olderThan, pageOf } from "@/lib/http/pagination";
import { jsonList, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";
import { adminAppealsQuery } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

const APPEAL_SELECT = `id, user_id, sanction_id, violation_id, statement, status, created_at, sanction:sanctions(${SANCTION_SELECT}), violation:violations(${VIOLATION_SELECT})`;

type AppealRow = {
  id: string;
  user_id: string;
  sanction_id: string | null;
  violation_id: string | null;
  statement: string;
  status: string;
  created_at: string;
  sanction: SanctionRow | null;
  violation: ViolationRow | null;
};

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "admin", rate: "RL-ADMIN", cache: "C-NONE", query: adminAppealsQuery }, async ({ query, requestId }) => {
    const after = decodeCursor(query.cursor);
    let select = db().from("appeals").select(APPEAL_SELECT).eq("status", query.status)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
    if (after) select = select.or(olderThan(after));
    const { data, error } = await select;
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const page = pageOf(data as unknown as AppealRow[], query.limit, (row) => ({ c: row.created_at, i: row.id }));
    return jsonList(page.items.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      ...appealTarget(row),
      sanction: row.sanction ? toSanction(row.sanction) : null,
      violation: row.violation ? toViolation(row.violation) : null,
      statement: row.statement,
      status: row.status,
      created_at: iso(row.created_at),
    })), page.pagination, requestId);
  }),
});
