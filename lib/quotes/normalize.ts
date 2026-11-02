import { createHash } from "node:crypto";
import { ApiError } from "@/lib/http/api-error";
import { SIMPLIFIED_ONLY } from "@/lib/quotes/simplified-only";

export const EDIT_CHANGE_LIMIT = 0.5;

const HAN = /\p{Script=Han}/u;
// Newline stays allowed. Control and zero-width characters can hide text from review (§8.3.4).
const CONTROL = /[\p{Cc}]/u;
const ZERO_WIDTH = /[​-‍⁠﻿]/u;
// A ZWJ is only legitimate joining two emoji
const EMOJI_ZWJ = /(?<=\p{Extended_Pictographic}️?)‍(?=\p{Extended_Pictographic})/gu;

export const codePoints = (value: string) => Array.from(value);

export function normalizeText(raw: string): string {
  return raw.trim().normalize("NFC");
}

export function hasForbiddenCharacters(content: string): boolean {
  const withoutNewlines = content.replace(/\r?\n/g, "");
  return CONTROL.test(withoutNewlines) || ZERO_WIDTH.test(withoutNewlines.replace(EMOJI_ZWJ, ""));
}

// §8.3.4 checks that answer 422 rather than a field-level 400
export function assertQuoteLanguage(content: string): void {
  if (!HAN.test(content)) throw new ApiError("QUOTE_NO_HAN");
  const simplified = [...new Set(codePoints(content).filter((character) => SIMPLIFIED_ONLY.has(character)))];
  if (simplified.length) throw new ApiError("QUOTE_NOT_TRADITIONAL", { details: { characters: simplified } });
}

function comparable(content: string): string {
  return content.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");
}

// §8.3.4: full-width, half-width and punctuation differences count as the same quote
export function contentHash(content: string): Buffer {
  return createHash("sha256").update(comparable(content)).digest();
}

function levenshtein(a: string[], b: string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
    }
    previous = current;
  }
  return previous[b.length] as number;
}

// D-32: always measured against the original, so a series of small edits cannot add up past the limit
export function changeRatio(original: string, edited: string): number {
  const a = codePoints(comparable(original));
  const b = codePoints(comparable(edited));
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 0 : levenshtein(a, b) / longest;
}

export function assertEditWithinLimit(original: string, edited: string): void {
  const ratio = changeRatio(original, edited);
  if (ratio >= EDIT_CHANGE_LIMIT) {
    throw new ApiError("QUOTE_EDIT_TOO_LARGE", { details: { change_ratio: ratio, limit: EDIT_CHANGE_LIMIT } });
  }
}
