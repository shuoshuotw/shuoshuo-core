import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { updateStats } from "@/lib/quotes/pool";
import { db } from "@/lib/supabase";

export const COMMENT_SELECT = "id, quote_id, content, pinned_at, edited_at, created_at, user:profiles!inner(id, username, avatar_url, verified)";

export type CommentRow = {
  id: string;
  quote_id: string;
  content: string;
  pinned_at: string | null;
  edited_at: string | null;
  created_at: string;
  user: { id: string; username: string; avatar_url: string | null; verified: boolean };
};

export function toComment(row: CommentRow) {
  return { ...row, pinned_at: iso(row.pinned_at), edited_at: iso(row.edited_at), created_at: iso(row.created_at) };
}

export async function syncCommentCount(quoteId: string) {
  const { data, error } = await db().from("quote_stats").select("comment_count").eq("quote_id", quoteId).single();
  if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
  // A no-op for anything not in the pool, which holds only published quotes
  updateStats(quoteId, { comment_count: data.comment_count });
}
