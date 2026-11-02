import { createHmac, timingSafeEqual } from "node:crypto";

const WINDOW_SECONDS = 60;

function sign(secret: string, timestamp: string, method: string, pathAndQuery: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${method}.${pathAndQuery}`).digest("hex");
}

// §7.7: v1.<unix_ts>.<hex(HMAC-SHA256(secret, "<unix_ts>.<METHOD>.<path + query>"))>
export function verifyInternalHeader(
  header: string,
  method: string,
  pathAndQuery: string,
  secrets: string[],
  now = Date.now(),
): boolean {
  const [version, timestamp, signature, ...rest] = header.split(".");
  if (version !== "v1" || !timestamp || !signature || rest.length > 0 || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > WINDOW_SECONDS) return false;

  const given = Buffer.from(signature);
  return secrets.some((secret) => {
    const expected = Buffer.from(sign(secret, timestamp, method, pathAndQuery));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}
