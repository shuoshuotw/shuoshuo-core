import { json, route, withRoute } from "@/lib/http/with-route";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "public", rate: null, cache: "C-5" }, ({ requestId }) =>
    json({ status: "ok", version: "1.0.0" }, requestId),
  ),
});
