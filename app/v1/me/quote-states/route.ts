import { ApiError } from "@/lib/http/api-error";
import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";
import { quoteStatesQuery } from "@/lib/validators/me";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "user_or_key", scope: "me:read", rate: "RL-USER", cache: "C-NONE", query: quoteStatesQuery }, async ({ caller, query, requestId }) => {
    const userId = identified(caller).userId;
    const [likes, favorites] = await Promise.all([
      db().from("quote_likes").select("quote_id").eq("user_id", userId).in("quote_id", query.ids),
      db().from("quote_favorites").select("quote_id").eq("user_id", userId).in("quote_id", query.ids),
    ]);
    if (likes.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: likes.error });
    if (favorites.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: favorites.error });
    const liked = new Set(likes.data.map((row) => row.quote_id));
    const favorited = new Set(favorites.data.map((row) => row.quote_id));
    return json({ states: Object.fromEntries(query.ids.map((id) => [id, { liked: liked.has(id), favorited: favorited.has(id) }])) }, requestId);
  }),
});
