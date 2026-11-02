import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { codePoints } from "@/lib/quotes/normalize";
import { db } from "@/lib/supabase";

export const CASE_SELECT = "id, target_type, target_id, status, effective_reporter_count, created_at, resolution, final_reason, reports(reason)";

export type CaseRow = {
  id: string;
  target_type: "quote" | "comment";
  target_id: string;
  status: string;
  effective_reporter_count: number;
  created_at: string;
  resolution: string | null;
  final_reason: string | null;
  reports: { reason: string }[];
};

function topReason(reports: { reason: string }[]): string | null {
  const counts = new Map<string, number>();
  for (const { reason } of reports) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].sort(([a, m], [b, n]) => n - m || a.localeCompare(b))[0]?.[0] ?? null;
}

export function toCaseSummary(row: CaseRow, preview: string | null) {
  return {
    id: row.id,
    target_type: row.target_type,
    target_id: row.target_id,
    status: row.status,
    reporter_count: row.reports.length,
    effective_reporter_count: row.effective_reporter_count,
    top_reason: topReason(row.reports),
    preview,
    created_at: iso(row.created_at),
  };
}

export const previewOf = (content: string) => codePoints(content).slice(0, 80).join("");

/** Target content by ID. Targets are polymorphic, so there is no FK to embed. */
export async function previews(rows: Pick<CaseRow, "target_type" | "target_id">[]): Promise<Map<string, string>> {
  const ids = (type: CaseRow["target_type"]) => rows.filter((row) => row.target_type === type).map((row) => row.target_id);
  const [quotes, comments] = await Promise.all([
    db().from("quotes").select("id, content").in("id", ids("quote")),
    db().from("comments").select("id, content").in("id", ids("comment")),
  ]);
  if (quotes.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: quotes.error });
  if (comments.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: comments.error });
  return new Map([...quotes.data, ...comments.data].map((row) => [row.id, previewOf(row.content)]));
}
