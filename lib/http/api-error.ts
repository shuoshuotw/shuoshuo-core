import catalog from "@/lib/http/error-catalog.json";

type Message = { message: string; message_en: string };
type Entry = Message & { status: number; variants?: Record<string, Message> };

export type ErrorCode = keyof typeof catalog;

const entries = catalog as Record<string, Entry>;

export function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(entries, code);
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly messageZh: string;
  readonly messageEn: string;
  readonly details?: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    options: {
      details?: Record<string, unknown>;
      variant?: string;
      headers?: Record<string, string>;
      cause?: unknown;
    } = {},
  ) {
    super(code, { cause: options.cause });
    const entry = entries[code] as Entry;
    const wording = (options.variant && entry.variants?.[options.variant]) || entry;
    this.code = code;
    this.status = entry.status;
    this.messageZh = wording.message;
    this.messageEn = wording.message_en;
    this.details = options.details;
    this.headers = options.headers;
  }

  body(requestId: string) {
    return {
      error: {
        code: this.code,
        status: this.status,
        message: this.messageZh,
        message_en: this.messageEn,
        ...(this.details ? { details: this.details } : {}),
        docs_url: `https://docs.shuoshuotw.xyz/errors#${this.code}`,
        request_id: requestId,
      },
    };
  }
}
