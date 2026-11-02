import { z } from "zod";
import { ApiError } from "@/lib/http/api-error";
import { json, route, text, withRoute } from "@/lib/http/with-route";
import { randomQuote } from "@/lib/quotes/random";
import { CATEGORY_KEYS, categoryList, lengthParam } from "@/lib/validators/common";

export const dynamic = "force-dynamic";

const query = z.object({
  categories: categoryList.optional(),
  exclude_categories: categoryList.optional(),
  format: z.enum(["json", "text"]).default("json"),
  min_length: lengthParam.optional(),
  max_length: lengthParam.optional(),
});

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = route({
  GET: withRoute({ auth: "public", rate: "RL-PUBLIC", query }, async ({ query: q, requestId }) => {
    if (q.categories && q.exclude_categories) throw new ApiError("CATEGORY_FILTER_CONFLICT");
    if (q.min_length !== undefined && q.max_length !== undefined && q.max_length < q.min_length) {
      throw new ApiError("INVALID_LENGTH_RANGE");
    }
    const excluded = q.exclude_categories;
    const categories = excluded ? CATEGORY_KEYS.filter((key) => !excluded.includes(key)) : q.categories;
    if (categories?.length === 0) throw new ApiError("NO_QUOTE_MATCHED");

    const quote = await randomQuote({ categories, min: q.min_length, max: q.max_length }, requestId);
    return q.format === "text" ? text(quote.content, { "X-Quote-Id": quote.id }) : json(quote, requestId);
  }),
});
