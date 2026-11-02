import { z } from "zod";

const schema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_JWKS_URL: z.url(),
  SUPABASE_JWT_ISSUER: z.url(),
  // Comma-separated; the first signs, all verify, so secrets can rotate without downtime
  INTERNAL_HMAC_SECRETS: z.string().min(1),
  CORS_ALLOWED_ORIGINS: z.string().min(1),
  API_KEY_ENV: z.enum(["live", "test"]),
  SENTRY_DSN: z.url().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
