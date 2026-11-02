import { iso } from "@/lib/http/pagination";

export const COMMENT_SELECT = "id, quote_id, content, pinned_at, edited_at, created_at, user:profiles!inner(id, username, avatar_url)";

export type CommentRow = {
  id: string;
  quote_id: string;
  content: string;
  pinned_at: string | null;
  edited_at: string | null;
  created_at: string;
  user: { id: string; username: string; avatar_url: string | null };
};

export function toComment(row: CommentRow) {
  return { ...row, pinned_at: iso(row.pinned_at), edited_at: iso(row.edited_at), created_at: iso(row.created_at) };
}
