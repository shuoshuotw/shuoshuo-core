import { z } from "zod";
import { paginationQuery } from "@/lib/http/pagination";
import { codePoints } from "@/lib/quotes/normalize";

const username = z.string().transform((value) => value.normalize("NFC")).pipe(
  z.string()
    .refine((value) => codePoints(value).length >= 2 && codePoints(value).length <= 30, "須為 2 至 30 字")
    .regex(/^[\p{Script=Han}A-Za-z0-9_-]+$/u)
    // A deleted account's name is shown with （已刪除） after it (D-22); a living one may not look like it
    .refine((value) => !value.includes("已刪除"), "名稱不可包含「已刪除」")
    // The site's own account goes by it; only SQL on the environment gives it (§6.7)
    .refine((value) => !value.includes("說說官方"), "名稱不可包含「說說官方」"),
);

export const updateMeBody = z.strictObject({
  username: username.optional(),
  likes_public: z.boolean().optional(),
  favorites_public: z.boolean().optional(),
  allow_permanent_api_keys: z.boolean().optional(),
  reduce_motion: z.boolean().optional(),
  // §8.7.1: the picture of one of the account's own sign-in providers, or null for none
  avatar_provider: z.enum(["google", "github", "discord"]).nullable().optional(),
}).refine((value) => Object.values(value).some((field) => field !== undefined), "至少需要一個欄位");

export const myQuotesQuery = paginationQuery.extend({
  status: z.enum(["published", "under_review", "removed"]).optional(),
});

export const quoteStatesQuery = z.object({
  ids: z.string().transform((value) => value.split(",")).pipe(
    z.array(z.uuid().transform((value) => value.toLowerCase())).min(1).max(50),
  ),
});
