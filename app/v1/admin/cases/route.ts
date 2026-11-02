import { CASE_SELECT, type CaseRow, previews, toCaseSummary } from "@/lib/governance/cases";
import { ApiError } from "@/lib/http/api-error";
import { decodeCursor, olderThan, pageOf } from "@/lib/http/pagination";
import { jsonList, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";
import { casesQuery } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "admin", rate: "RL-ADMIN", cache: "C-NONE", query: casesQuery }, async ({ query, requestId }) => {
    const after = decodeCursor(query.cursor);
    const open = query.status === "open";
    let select = db().from("moderation_cases").select(CASE_SELECT).eq("status", query.status);
    if (query.target_type) select = select.eq("target_type", query.target_type);
    if (open) {
      select = select.order("effective_reporter_count", { ascending: false }).order("created_at").order("id");
      if (after) {
        if (after.n === undefined) throw new ApiError("INVALID_CURSOR");
        const count = `effective_reporter_count.eq.${after.n}`;
        select = select.or(`effective_reporter_count.lt.${after.n},and(${count},created_at.gt.${after.c}),and(${count},created_at.eq.${after.c},id.gt.${after.i})`);
      }
    } else {
      select = select.order("created_at", { ascending: false }).order("id", { ascending: false });
      if (after) select = select.or(olderThan(after));
    }
    const { data, error } = await select.limit(query.limit + 1);
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const page = pageOf(data as unknown as CaseRow[], query.limit, (row) => ({ c: row.created_at, i: row.id, n: row.effective_reporter_count }));
    const content = await previews(page.items);
    return jsonList(page.items.map((row) => toCaseSummary(row, content.get(row.target_id) ?? null)), page.pagination, requestId);
  }),
});
