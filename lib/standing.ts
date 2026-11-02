import { iso } from "@/lib/http/pagination";

export type StandingRow = { status: "active" | "banned"; suspended_until: string | null; strike_count: number };

// `suspended` is computed, so an expired suspension needs no scheduled job (§9.5). Keep in step with private.standing_json.
export function toStanding(row: StandingRow, now = Date.now()) {
  const suspended = row.suspended_until !== null && new Date(row.suspended_until).getTime() > now;
  const banned = row.status === "banned";
  return {
    status: banned ? "banned" : suspended ? "suspended" : "active",
    suspended_until: iso(row.suspended_until),
    strike_count: row.strike_count,
    strike_limit: 4,
    can_submit: !banned && !suspended,
    can_comment: !banned && !suspended,
  };
}
