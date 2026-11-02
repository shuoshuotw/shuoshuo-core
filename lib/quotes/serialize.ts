import { iso } from "@/lib/http/pagination";

// Pass to .select() on `quotes`. Keep in step with private.quote_json (§8.2.2).
export const QUOTE_SELECT = `
  id, content, length, source_from, status, commit_from, edited_at, created_at, removed_reason, removed_at,
  category:categories!inner(key, name_zh),
  submitter:profiles!quotes_submitter_id_fkey!inner(id, username, deleted_at),
  stats:quote_stats(like_count, favorite_count, comment_count)
` as const;

export type QuoteRow = {
  id: string;
  content: string;
  length: number;
  source_from: string;
  status: string;
  commit_from: string;
  edited_at: string | null;
  created_at: string;
  removed_reason: string | null;
  removed_at: string | null;
  category: { key: string; name_zh: string };
  submitter: { id: string; username: string; deleted_at: string | null };
  stats: { like_count: number; favorite_count: number; comment_count: number } | null;
};

export function toQuote(row: QuoteRow) {
  return {
    id: row.id,
    content: row.content,
    length: row.length,
    category: { key: row.category.key, name: row.category.name_zh },
    source_from: row.source_from,
    submitter: { id: row.submitter.id, username: row.submitter.username, deleted: row.submitter.deleted_at !== null },
    stats: {
      like_count: row.stats?.like_count ?? 0,
      favorite_count: row.stats?.favorite_count ?? 0,
      comment_count: row.stats?.comment_count ?? 0,
    },
    status: row.status,
    commit_from: row.commit_from,
    edited_at: iso(row.edited_at),
    created_at: iso(row.created_at),
  };
}

export function toOwnQuote(row: QuoteRow) {
  return { ...toQuote(row), removed_reason: row.removed_reason, removed_at: iso(row.removed_at) };
}
