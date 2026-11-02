import { ApiError } from "@/lib/http/api-error";
import { json, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "public", rate: "RL-PUBLIC", cache: "C-DAY" }, async ({ requestId }) => {
    const { data, error } = await db().from("categories").select("key, name_zh, name_en").order("sort_order");
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    return json(data.map(({ key, name_zh, name_en }) => ({ key, name: name_zh, name_en })), requestId);
  }),
});
