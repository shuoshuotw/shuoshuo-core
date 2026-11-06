import { z } from "zod";
import { paginationQuery } from "@/lib/http/pagination";
import { reasonText, textField } from "@/lib/validators/common";

const reportReason = z.enum([
  "harassment", "hate", "sexual", "violence", "privacy", "spam", "misinformation", "simplified_chinese", "other",
]);

// §9.8
const auditAction = z.enum([
  "case.resolve", "quote.edit", "quote.review_expired", "comment.remove", "sanction.create", "sanction.lift",
  "account.ban", "account.unban", "api_key.revoke_all", "appeal.resolve", "account.delete", "api_key.create",
  "api_key.regenerate", "api_key.delete", "profile.reset", "report.threshold_reached",
]);

export const reportBody = z
  .strictObject({ reason: reportReason, detail: reasonText.optional() })
  .refine((body) => body.reason !== "other" || body.detail !== undefined, { path: ["detail"], message: "原因為其他時必填" });

export const appealBody = z.strictObject({
  target_type: z.enum(["sanction", "violation"]),
  target_id: z.uuid(),
  statement: textField(20, 1000),
});

export const accountDeletionBody = z.strictObject({ confirm_username: z.string() });

export const casesQuery = paginationQuery.extend({
  status: z.enum(["open", "resolved"]).default("open"),
  target_type: z.enum(["quote", "comment"]).optional(),
});

export const resolveCaseBody = z
  .strictObject({ resolution: z.enum(["dismiss", "uphold"]), final_reason: reportReason.optional(), note: textField(0, 1000).optional() })
  .refine((body) => body.resolution !== "uphold" || body.final_reason !== undefined, { path: ["final_reason"], message: "確認違規時必填" });

export const adminAppealsQuery = paginationQuery.extend({
  status: z.enum(["pending", "accepted", "rejected"]).default("pending"),
});

export const resolveAppealBody = z.strictObject({ decision: z.enum(["accept", "reject"]), note: textField(1, 1000) });

export const sanctionBody = z
  .strictObject({
    kind: z.enum(["submit_suspension", "account_ban"]),
    duration_days: z.number().int().min(1).max(365).optional(),
    reason: reasonText,
  })
  .refine((body) => body.kind !== "submit_suspension" || body.duration_days !== undefined, { path: ["duration_days"], message: "停權時必填" });

export const reasonBody = z.strictObject({ reason: reasonText });

export const auditLogsQuery = paginationQuery.extend({
  actor_id: z.uuid().optional(),
  // Part of the name an actor goes by now
  actor: z.string().trim().min(1).max(30).optional(),
  target_id: z.uuid().optional(),
  action: auditAction.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
