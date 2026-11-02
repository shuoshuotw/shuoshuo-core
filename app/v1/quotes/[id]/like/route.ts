import { ApiError } from "@/lib/http/api-error";
import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { updateStats } from "@/lib/quotes/pool";
import { rpc } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function setLike(value: boolean) {
  return withRoute(
    { auth: "user_or_key", scope: "reactions:write", rate: "RL-WRITE", cache: "C-NONE", idNotFound: "QUOTE_NOT_FOUND" },
    async ({ caller, params, requestId }) => {
      const quoteId = params.id!;
      const [result] = await rpc("set_reaction", { actor: identified(caller).userId, quote_id: quoteId, kind: "like", value }, { requestId });
      if (!result) throw new ApiError("INTERNAL_ERROR");
      // A no-op for anything not in the pool, which holds only published quotes
      updateStats(quoteId, { like_count: result.count });
      return json({ quote_id: quoteId, liked: result.active, like_count: result.count }, requestId);
    },
  );
}

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({ PUT: setLike(true), DELETE: setLike(false) });
