import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { json, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";
import { findProfile } from "@/lib/users/profile";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "public", rate: "RL-PUBLIC", cache: "C-30" }, async ({ params, requestId }) => {
    const profile = await findProfile(params.username!);
    const [quotes, standing] = await Promise.all([
      db().from("quotes").select("id", { count: "exact", head: true }).eq("submitter_id", profile.id).eq("status", "published"),
      db().from("account_standing").select("status, suspended_until").eq("user_id", profile.id).maybeSingle(),
    ]);
    if (quotes.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: quotes.error });
    if (standing.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: standing.error });
    // The page says when an account is banned or suspended; only the state is public, not why or until when
    const until = standing.data?.suspended_until;
    const state = standing.data?.status === "banned" ? "banned" : until && Date.parse(until) > Date.now() ? "suspended" : "active";
    return json({ ...profile, quote_count: quotes.count ?? 0, standing: state, created_at: iso(profile.created_at) }, requestId);
  }),
});
