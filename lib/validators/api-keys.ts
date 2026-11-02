import { z } from "zod";
import { codePoints } from "@/lib/quotes/normalize";

export const createApiKey = z.strictObject({
  name: z.string().refine((value) => {
    const length = codePoints(value).length;
    return length >= 1 && length <= 50;
  }, "須為 1 至 50 字"),
  scopes: z.array(z.enum(["quotes:read", "quotes:write", "reactions:write", "comments:write", "me:read"]))
    .default(["quotes:read"])
    .transform((scopes) => [...new Set(["quotes:read", ...scopes])]),
});
