import { json, route, withRoute } from "@/lib/http/with-route";
import { rpc } from "@/lib/supabase";
import { CATEGORY_KEYS } from "@/lib/validators/common";
import { trendingQuery } from "@/lib/validators/quotes";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute(
    { auth: "public", rate: "RL-PUBLIC", cache: "C-30", query: trendingQuery },
    async ({ query, requestId }) => json(await rpc("trending_quotes", {
      categories: query.categories ?? [...CATEGORY_KEYS],
      n: query.limit,
    }, { requestId }), requestId),
  ),
});
