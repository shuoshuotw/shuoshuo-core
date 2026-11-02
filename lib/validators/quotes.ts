import { z } from "zod";
import { limitParam, paginationQuery } from "@/lib/http/pagination";
import { categoryKey, categoryList, quoteContent, sourceFrom } from "@/lib/validators/common";

export const quotesQuery = paginationQuery.extend({ categories: categoryList.optional() });

export const trendingQuery = z.object({
  categories: categoryList.optional(),
  limit: limitParam(50),
});

export const quoteQuery = z.object({ format: z.enum(["json", "text"]).default("json") });

export const createQuoteBody = z.strictObject({
  content: quoteContent,
  category: categoryKey,
  source_from: sourceFrom,
});

export const updateQuoteBody = createQuoteBody.partial().refine(
  (body) => Object.keys(body).length > 0,
  "至少提供一個欄位",
);
