import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { env } from "@/lib/env";
import { ApiError, isErrorCode } from "@/lib/http/api-error";
import { singleton } from "@/lib/runtime/singleton";

// The only module that holds the Secret Key (§4.3)
export function db() {
  return singleton("supabase", () => {
    const { SUPABASE_URL, SUPABASE_SECRET_KEY } = env();
    return createClient<Database>(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });
}

type PrivateFunctions = Database["private"]["Functions"];

// RPC raises the error code as the message and its details as JSON in DETAIL (§6.6)
export function toApiError(error: { code?: string; message: string; details?: string | null }): ApiError {
  if (error.code === "P0001" && isErrorCode(error.message)) {
    return new ApiError(error.message, error.details ? { details: JSON.parse(error.details) } : {});
  }
  if (error.message.includes("AbortError") || error.message.includes("TimeoutError")) {
    return new ApiError("SERVICE_UNAVAILABLE");
  }
  return new ApiError("INTERNAL_ERROR", { cause: error });
}

export async function rpc<Name extends keyof PrivateFunctions & string>(
  name: Name,
  args: PrivateFunctions[Name]["Args"],
  options: { requestId: string; timeoutMs?: number },
): Promise<PrivateFunctions[Name]["Returns"]> {
  // §10.6: a function-level statement_timeout does not apply to the running statement, so the limit lives here
  const { data, error } = await (db().schema("private") as unknown as RpcClient)
    .rpc(name, args)
    .setHeader("x-request-id", options.requestId)
    .abortSignal(AbortSignal.timeout(options.timeoutMs ?? 3000));
  if (error) throw toApiError(error);
  return data as PrivateFunctions[Name]["Returns"];
}

// supabase-js cannot express a generic function name across the Functions union
type RpcClient = {
  rpc(
    name: string,
    args: unknown,
  ): {
    setHeader(name: string, value: string): {
      abortSignal(signal: AbortSignal): PromiseLike<{
        data: unknown;
        error: { code?: string; message: string; details?: string | null } | null;
      }>;
    };
  };
};
