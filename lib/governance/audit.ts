import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { db } from "@/lib/supabase";

export const AUDIT_SELECT = "id, actor_id, actor_type, action, target_type, target_id, metadata, request_id, created_at";

type AuditRow = { actor_id: string | null; created_at: string };
type Actor = { id: string; username: string; avatar_url: string | null; deleted_at: string | null; created_at: string };

/**
 * Log rows as AuditLog, each with who did it by the name they go by now: audit_logs keeps only the id, and a profile
 * outlives its account (D-22). One lookup for the whole page.
 */
export async function toAuditLogs<T extends AuditRow>(rows: T[]) {
  const ids = [...new Set(rows.map((row) => row.actor_id).filter((id): id is string => Boolean(id)))];
  const actors = new Map<string, Actor>();
  if (ids.length > 0) {
    const { data, error } = await db().from("profiles").select("id, username, avatar_url, deleted_at, created_at").in("id", ids);
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    for (const actor of data as Actor[]) actors.set(actor.id, actor);
  }
  return rows.map((row) => {
    const actor = row.actor_id ? actors.get(row.actor_id) : undefined;
    return {
      ...row,
      actor: actor
        ? { id: actor.id, username: actor.username, avatar_url: actor.avatar_url, deleted: actor.deleted_at !== null, created_at: iso(actor.created_at) }
        : null,
      created_at: iso(row.created_at),
    };
  });
}
