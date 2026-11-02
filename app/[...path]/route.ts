import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/http/api-error";
import { errorResponse } from "@/lib/http/with-route";

function notFound(request: Request) {
  return errorResponse(new ApiError("ROUTE_NOT_FOUND"), request, `req_${randomUUID()}`);
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
