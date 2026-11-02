import { SANCTION_SELECT, type SanctionRow, toSanction, toViolation, VIOLATION_SELECT, type ViolationRow } from "@/lib/governance/serialize";
import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { json, route, withRoute } from "@/lib/http/with-route";
import { toStanding } from "@/lib/standing";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "admin", rate: "RL-ADMIN", cache: "C-NONE", idNotFound: "USER_NOT_FOUND" }, async ({ params, requestId }) => {
    const id = params.id!;
    const [profile, standing, roles, violations, sanctions, keys, quotes] = await Promise.all([
      db().from("profiles").select("id, username, created_at").eq("id", id).maybeSingle(),
      db().from("account_standing").select("status, suspended_until, strike_count").eq("user_id", id).maybeSingle(),
      db().from("user_roles").select("role").eq("user_id", id).order("role"),
      db().from("violations").select(VIOLATION_SELECT).eq("user_id", id)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(50),
      db().from("sanctions").select(SANCTION_SELECT).eq("user_id", id)
        .order("starts_at", { ascending: false }).order("id", { ascending: false }).limit(50),
      db().from("api_keys").select("id", { count: "exact", head: true }).eq("user_id", id).is("revoked_at", null),
      db().from("quotes").select("id", { count: "exact", head: true }).eq("submitter_id", id).neq("status", "deleted"),
    ]);
    for (const result of [profile, standing, roles, violations, sanctions, keys, quotes]) {
      if (result.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: result.error });
    }
    if (!profile.data) throw new ApiError("USER_NOT_FOUND");
    return json({
      id: profile.data.id,
      username: profile.data.username,
      standing: standing.data ? toStanding(standing.data) : null,
      roles: (roles.data ?? []).map((row) => row.role),
      created_at: iso(profile.data.created_at),
      violations: (violations.data as unknown as ViolationRow[]).map(toViolation),
      sanctions: (sanctions.data as unknown as SanctionRow[]).map(toSanction),
      api_key_count: keys.count ?? 0,
      quote_count: quotes.count ?? 0,
    }, requestId);
  }),
});
