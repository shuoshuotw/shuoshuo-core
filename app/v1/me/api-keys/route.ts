import { generateKey, toBytea } from "@/lib/auth/api-key";
import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { identified, json, route, withRoute } from "@/lib/http/with-route";
import { db, rpc } from "@/lib/supabase";
import { createApiKey } from "@/lib/validators/api-keys";
import type { components } from "@/openapi/types";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute(
    { auth: "user", rate: "RL-USER", cache: "C-NONE", rejectBanned: true },
    async ({ caller, requestId }) => {
      const { data, error } = await db().from("api_keys")
        .select("id, name, key_prefix, scopes, expires_at, last_used_at, regenerated_at, created_at")
        .eq("user_id", identified(caller).userId)
        .is("revoked_at", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
      if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
      return json(data.map((row) => ({
        ...row,
        expires_at: iso(row.expires_at),
        last_used_at: iso(row.last_used_at),
        regenerated_at: iso(row.regenerated_at),
        created_at: iso(row.created_at),
      })), requestId);
    },
  ),
  POST: withRoute(
    { auth: "user", rate: "RL-WRITE", cache: "C-NONE", action: "api_key_write", session: "recent", body: createApiKey },
    async ({ caller, body, requestId }) => {
      const key = generateKey();
      const data = await rpc("create_api_key", {
        actor: identified(caller).userId,
        name: body.name,
        scopes: body.scopes,
        key_prefix: key.prefix,
        key_hash: toBytea(key.hash),
        // Left out, the key has no end date, which the RPC allows only once the account has
        ...(body.expires_in_days !== null && { expires_at: new Date(Date.now() + body.expires_in_days * DAY_MS).toISOString() }),
      }, { requestId }) as components["schemas"]["ApiKey"];
      return json({ ...data, secret: key.secret }, requestId, { status: 201 });
    },
  ),
});
