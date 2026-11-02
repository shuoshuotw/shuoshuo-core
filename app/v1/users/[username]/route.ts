import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { json, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";
import { findProfile } from "@/lib/users/profile";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "public", rate: "RL-PUBLIC", cache: "C-30" }, async ({ params, requestId }) => {
    const profile = await findProfile(params.username!);
    const quotes = await db().from("quotes").select("id", { count: "exact", head: true })
      .eq("submitter_id", profile.id).eq("status", "published");
    if (quotes.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: quotes.error });
    return json({ ...profile, quote_count: quotes.count ?? 0, created_at: iso(profile.created_at) }, requestId);
  }),
});
