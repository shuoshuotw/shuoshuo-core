import { z } from "zod";
import { paginationQuery } from "@/lib/http/pagination";
import { codePoints } from "@/lib/quotes/normalize";

const username = z.string().transform((value) => value.normalize("NFC")).pipe(
  z.string()
    .refine((value) => codePoints(value).length >= 2 && codePoints(value).length <= 30, "須為 2 至 30 字")
    .regex(/^[\p{Script=Han}A-Za-z0-9_-]+$/u),
);

export const updateMeBody = z.strictObject({
  username: username.optional(),
  likes_public: z.boolean().optional(),
  favorites_public: z.boolean().optional(),
}).refine((value) => Object.values(value).some((field) => field !== undefined), "至少需要一個欄位");

export const myQuotesQuery = paginationQuery.extend({
  status: z.enum(["published", "under_review", "removed"]).optional(),
});

export const quoteStatesQuery = z.object({
  ids: z.string().transform((value) => value.split(",")).pipe(
    z.array(z.uuid().transform((value) => value.toLowerCase())).min(1).max(50),
  ),
});
