import { iso } from "@/lib/http/pagination";

type AppealRef = { status: string };

export const SANCTION_SELECT = "id, kind, source, reason, starts_at, ends_at, lifted_at, appeals(status)";

export type SanctionRow = {
  id: string;
  kind: string;
  source: string;
  reason: string;
  starts_at: string;
  ends_at: string | null;
  lifted_at: string | null;
  appeals: AppealRef[];
};

export function toSanction(row: SanctionRow) {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    reason: row.reason,
    starts_at: iso(row.starts_at),
    ends_at: iso(row.ends_at),
    lifted_at: iso(row.lifted_at),
    appeal_status: row.appeals[0]?.status ?? null,
  };
}

export const VIOLATION_SELECT = `id, quote_id, reason, counts_as_strike, overturned_at, created_at, appeals(status), sanctions(${SANCTION_SELECT})`;

export type ViolationRow = {
  id: string;
  quote_id: string | null;
  reason: string;
  counts_as_strike: boolean;
  overturned_at: string | null;
  created_at: string;
  appeals: AppealRef[];
  sanctions: SanctionRow[];
};

export function toViolation(row: ViolationRow) {
  const sanction = row.sanctions[0];
  return {
    id: row.id,
    quote_id: row.quote_id,
    reason: row.reason,
    counts_as_strike: row.counts_as_strike,
    overturned_at: iso(row.overturned_at),
    created_at: iso(row.created_at),
    // A violation with a sanction is appealed through that sanction (§9.6)
    appeal_status: row.appeals[0]?.status ?? sanction?.appeals[0]?.status ?? null,
    sanction: sanction ? toSanction(sanction) : null,
  };
}

/** One's own violations also say what was reported: the case's target and, for a quote, its words (§9.6). */
export const OWN_VIOLATION_SELECT = `${VIOLATION_SELECT}, moderation:moderation_cases(target_type, target_id), quote:quotes(content)`;

export type OwnViolationRow = ViolationRow & {
  moderation: { target_type: "quote" | "comment"; target_id: string } | null;
  quote: { content: string } | null;
};

export const appealTarget =(row: { sanction_id: string | null; violation_id: string | null }) =>
  row.sanction_id
    ? { target_type: "sanction", target_id: row.sanction_id }
    : { target_type: "violation", target_id: row.violation_id };
