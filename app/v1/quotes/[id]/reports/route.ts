import { createReport } from "@/lib/governance/reports";
import { identified, route, withRoute } from "@/lib/http/with-route";
import { reportBody } from "@/lib/validators/governance";

export const dynamic = "force-dynamic";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  POST: withRoute(
    { auth: "user", rate: "RL-SENSITIVE", cache: "C-NONE", idNotFound: "QUOTE_NOT_FOUND", body: reportBody },
    ({ caller, params, body, requestId }) => createReport({ type: "quote", id: params.id! }, identified(caller).userId, body, requestId),
  ),
});
