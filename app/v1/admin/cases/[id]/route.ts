import { COMMENT_SELECT, type CommentRow, toComment } from "@/lib/comments/serialize";
import { AUDIT_SELECT, toAuditLogs } from "@/lib/governance/audit";
import { CASE_SELECT, type CaseRow, previewOf, toCaseSummary } from "@/lib/governance/cases";
import { toViolation, VIOLATION_SELECT, type ViolationRow } from "@/lib/governance/serialize";
import { ApiError } from "@/lib/http/api-error";
import { iso } from "@/lib/http/pagination";
import { json, route, withRoute } from "@/lib/http/with-route";
import { QUOTE_SELECT, type QuoteRow, toOwnQuote } from "@/lib/quotes/serialize";
import { toStanding } from "@/lib/standing";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

async function loadTarget(row: CaseRow) {
  if (row.target_type === "quote") {
    const { data, error } = await db().from("quotes").select(QUOTE_SELECT).eq("id", row.target_id).maybeSingle();
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    const quote = data as QuoteRow | null;
    return quote && { body: toOwnQuote(quote), content: quote.content, subjectId: quote.submitter.id };
  }
  const { data, error } = await db().from("comments").select(COMMENT_SELECT).eq("id", row.target_id).maybeSingle();
  if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
  const comment = data as CommentRow | null;
  return comment && { body: toComment(comment), content: comment.content, subjectId: comment.user.id };
}

async function loadSubject(userId: string, row: CaseRow) {
  const [profile, standing, violations] = await Promise.all([
    db().from("profiles").select("username").eq("id", userId).is("deleted_at", null).maybeSingle(),
    db().from("account_standing").select("status, suspended_until, strike_count").eq("user_id", userId).maybeSingle(),
    db().from("violations").select(VIOLATION_SELECT).eq("user_id", userId).neq("case_id", row.id)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(50),
  ]);
  for (const result of [profile, standing, violations]) {
    if (result.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: result.error });
  }
  if (!profile.data || !standing.data) return null;
  return {
    user_id: userId,
    username: profile.data.username,
    standing: toStanding(standing.data),
    prior_violations: (violations.data as unknown as ViolationRow[]).map(toViolation),
    // Comments never count toward strikes (D-14), and a banned account has no ban left to trigger
    would_ban: row.target_type === "quote" && standing.data.status !== "banned" && standing.data.strike_count + 1 >= 4,
  };
}

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "admin", rate: "RL-ADMIN", cache: "C-NONE", idNotFound: "CASE_NOT_FOUND" }, async ({ params, requestId }) => {
    const { data, error } = await db().from("moderation_cases").select(CASE_SELECT).eq("id", params.id!).maybeSingle();
    if (error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: error });
    if (!data) throw new ApiError("CASE_NOT_FOUND");
    const row = data as unknown as CaseRow;

    const target = await loadTarget(row);
    const [reports, audit, subject] = await Promise.all([
      db().from("reports").select("reason, detail, reporter_id, is_discounted, created_at").eq("case_id", row.id).order("created_at"),
      db().from("audit_logs").select(AUDIT_SELECT)
        .in("target_id", [row.id, row.target_id]).order("created_at", { ascending: false }).limit(50),
      target ? loadSubject(target.subjectId, row) : null,
    ]);
    if (reports.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: reports.error });
    if (audit.error) throw new ApiError("SERVICE_UNAVAILABLE", { cause: audit.error });

    return json({
      ...toCaseSummary(row, target ? previewOf(target.content) : null),
      resolution: row.resolution,
      final_reason: row.final_reason,
      target: target?.body ?? null,
      reports: reports.data.map((report) => ({ ...report, created_at: iso(report.created_at) })),
      subject,
      audit: await toAuditLogs(audit.data),
    }, requestId);
  }),
});
