import { env } from "@/lib/env";

// §17.2: a missing variable fails at startup, not on the first request that needs it
export function register() {
  env();
}
