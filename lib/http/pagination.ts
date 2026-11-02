import { z } from "zod";
import { ApiError } from "@/lib/http/api-error";

export const limitParam = (max = 100) => z.coerce.number().int().min(1).max(max).default(20);

export const paginationQuery = z.object({
  limit: limitParam(),
  cursor: z.string().optional(),
});

// c is spliced into a PostgREST `or` filter, so a loose string would let a client add conditions to it
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

const keyset = z.object({
  c: z.string().regex(TIMESTAMP).refine((value) => Number.isFinite(Date.parse(value))),
  i: z.uuid(),
});

export type Keyset = z.infer<typeof keyset>;

export function encodeCursor(value: Keyset): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): Keyset | null {
  if (cursor === undefined) return null;
  try {
    return keyset.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch (cause) {
    throw new ApiError("INVALID_CURSOR", { cause });
  }
}

// PostgREST filter for "older than the cursor". c must be the raw column value: the API's ISO form
// keeps milliseconds only, and rows inside the same millisecond would be skipped or repeated.
export function olderThan(after: Keyset, column = "created_at", idColumn = "id"): string {
  return `${column}.lt.${after.c},and(${column}.eq.${after.c},${idColumn}.lt.${after.i})`;
}

// Query limit + 1 rows, then pass them here
export function pageOf<Row>(rows: Row[], limit: number, keyOf: (row: Row) => Keyset) {
  const has_more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    pagination: { limit, next_cursor: has_more && last ? encodeCursor(keyOf(last)) : null, has_more },
  };
}

export function iso(value: string): string;
export function iso(value: string | null): string | null;
export function iso(value: string | null) {
  return value === null ? null : new Date(value).toISOString();
}
