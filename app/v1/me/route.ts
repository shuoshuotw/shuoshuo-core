import type { Database } from "@/lib/database.types";
import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { updateSubmitter } from "@/lib/quotes/pool";
import { enforceAction } from "@/lib/ratelimit";
import { toStanding } from "@/lib/standing";
import { db, rpc } from "@/lib/supabase";
import { updateMeBody } from "@/lib/validators/me";

export const dynamic = "force-dynamic";

type Profile = Database["public"]["Tables"]["profiles"]["Row"];

const REMOVAL_NOTICE_MS = 30 * 24 * 60 * 60 * 1000;

async function me(userId: string, updatedProfile?: Profile) {
  const [profile, standing, roles, sanctions, removals] = await Promise.all([
    updatedProfile
      ? { data: updatedProfile, error: null }
      : db().from("profiles").select("*").eq("id", userId).is("deleted_at", null).single(),
    db().from("account_standing").select("status, suspended_until, strike_count").eq("user_id", userId).single(),
    db().from("user_roles").select("role").eq("user_id", userId).order("role"),
    db().from("sanctions").select("id, starts_at").eq("user_id", userId).is("lifted_at", null)
      .or(`ends_at.is.null,ends_at.gt.${new Date().toISOString()}`),
    db().from("violations").select("id, created_at, sanctions(id), appeals(decided_at)").eq("user_id", userId).is("overturned_at", null)
      .gte("created_at", new Date(Date.now() - REMOVAL_NOTICE_MS).toISOString()),
  ]);
  for (const result of [profile, standing, roles, sanctions, removals]) {
    if (result.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: result.error });
  }
  if (!profile.data || !standing.data || !roles.data || !sanctions.data || !removals.data) {
    throw new ApiError("SERVICE_UNAVAILABLE");
  }
  // §8.7.1. A sanction speaks for its linked removal, so a removal with one never gets its own notice.
  const pendingNotices = [
    ...sanctions.data.map((row) => ({ type: "sanction", id: row.id, created_at: iso(row.starts_at) })),
    ...removals.data.filter((row) => row.sanctions.length === 0 && row.appeals.every((appeal) => appeal.decided_at === null))
      .map((row) => ({ type: "removal", id: row.id, created_at: iso(row.created_at) })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const p = profile.data;
  return {
    id: p.id,
    username: p.username,
    avatar_url: p.avatar_url,
    likes_public: p.likes_public,
    favorites_public: p.favorites_public,
    roles: roles.data.map((row) => row.role),
    standing: toStanding(standing.data),
    pending_notices: pendingNotices,
    created_at: iso(p.created_at),
  };
}

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "user_or_key", scope: "me:read", rate: "RL-USER", cache: "C-NONE" }, async ({ caller, requestId }) => {
    return json(await me(identified(caller).userId), requestId);
  }),
  PATCH: withRoute({ auth: "user", rate: "RL-SENSITIVE", cache: "C-NONE", body: updateMeBody }, async ({ caller, body, requestId }) => {
    const userId = identified(caller).userId;
    if (body.username !== undefined) await enforceAction(userId, "username_change");
    const profile = await rpc("update_profile", { actor: userId, ...body }, { requestId });
    if (body.username !== undefined) updateSubmitter(userId, { username: profile.username });
    return json(await me(userId, profile), requestId);
  }),
});
