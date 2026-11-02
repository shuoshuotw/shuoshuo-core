import { ApiError } from "@/lib/http/api-error";
import { json, route, withRoute } from "@/lib/http/with-route";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "internal", rate: null, cache: "C-NONE" }, async ({ requestId }) => {
    const { error } = await db().from("categories").select("key", { head: true }).abortSignal(AbortSignal.timeout(2000));
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { details: { checks: { database: "failed" } }, cause: error });
    return json({ status: "ok", checks: { database: "ok" } }, requestId);
  }),
});
