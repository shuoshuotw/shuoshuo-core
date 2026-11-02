import { z } from "zod";
import { codePoints, hasForbiddenCharacters, normalizeText } from "@/lib/quotes/normalize";

export const CATEGORY_KEYS = [
  "anime", "manga", "game", "music", "literature", "original", "flim",
  "poetry", "internet", "philosophy", "anti-motiv", "ai", "other",
] as const;

export const categoryKey = z.enum(CATEGORY_KEYS);

// Comma-separated; an unknown key is a 400, not a silent wrong result (§8.3.1)
export const categoryList = z
  .string()
  .transform((value) => value.split(","))
  .pipe(z.array(categoryKey).min(1));

export const lengthParam = z.coerce.number().int().min(1).max(100);

function textField(min: number, max: number, extra?: (value: string) => boolean) {
  return z
    .string()
    .transform(normalizeText)
    .refine((value) => {
      const length = codePoints(value).length;
      return length >= min && length <= max;
    }, `須為 ${min} 至 ${max} 字`)
    .refine((value) => !hasForbiddenCharacters(value), "含不允許的字元")
    .refine((value) => extra?.(value) ?? true);
}

export const quoteContent = textField(2, 100);
export const commentContent = textField(1, 500);
export const sourceFrom = textField(1, 100);
export const reasonText = textField(1, 500);
