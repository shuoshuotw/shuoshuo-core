import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { generateKey, toBytea } from "@/lib/auth/api-key";
import { admin, call, createUser, type TestUser } from "./helpers";

// SEC-03: the access matrix comes from openapi.yaml, so an endpoint that forgets its check fails here without anyone writing a test for it
type Operation = { "x-auth": string; "x-required-scope"?: string };
type Paths = Record<string, Record<string, Operation>>;

const METHODS = ["get", "post", "put", "patch", "delete"];
const paths = (parse(readFileSync("openapi/openapi.yaml", "utf8")) as { paths: Paths }).paths;
const operations = Object.entries(paths).flatMap(([path, item]) =>
  Object.entries(item).filter(([method]) => METHODS.includes(method)).map(([method, operation]) => ({
    path,
    method: method.toUpperCase(),
    auth: operation["x-auth"],
    scope: operation["x-required-scope"],
  })),
);

const url = (path: string) => path.replace("{id}", randomUUID()).replace("{username}", "查無此人");
const byAuth = (...modes: string[]) => operations.filter((operation) => modes.includes(operation.auth));
// Authorization runs before the body is read, so the shape only matters for reaching the route
const request = (operation: (typeof operations)[number], token?: string) => call(url(operation.path), {
  method: operation.method,
  ...(token ? { token } : {}),
  ...(["GET", "DELETE"].includes(operation.method) ? {} : { body: {} }),
});
const label = "$method $path";

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? routeFiles(path) : entry.name === "route.ts" ? [path] : [];
  });
}

describe("SEC-03: every operation in the contract", () => {
  let user: TestUser;
  let readOnlyKey: string;

  beforeAll(async () => {
    user = await createUser();
    const key = generateKey("test");
    const { error } = await admin.from("api_keys").insert({
      user_id: user.id, name: "contract", key_prefix: key.prefix, key_hash: toBytea(key.hash), scopes: ["quotes:read"],
    });
    if (error) throw error;
    readOnlyKey = key.secret;
  });

  afterAll(async () => {
    await admin.from("profiles").delete().eq("id", user.id);
    await admin.auth.admin.deleteUser(user.id);
  });

  it("matches the route files one to one", () => {
    const files = routeFiles(join("app", "v1")).map((file) =>
      `/${relative("app", file).split(sep).slice(0, -1).join("/")}`.replace(/\[(\w+)\]/g, "{$1}"),
    );
    expect(files.sort()).toEqual(Object.keys(paths).sort());
  });

  it.each(byAuth("public"))(`${label} is open to anonymous callers`, async (operation) => {
    const response = await request(operation);
    expect([401, 403, 405]).not.toContain(response.status);
    expect(response.error?.code).not.toBe("ROUTE_NOT_FOUND");
  });

  it.each(byAuth("internal"))(`${label} hides itself from anyone without the HMAC`, async (operation) => {
    for (const token of [undefined, user.token, readOnlyKey]) {
      const response = await request(operation, token);
      expect([response.status, response.error?.code]).toEqual([404, "ROUTE_NOT_FOUND"]);
    }
  });

  it.each(byAuth("jwt_or_key", "jwt", "admin", "listing"))(`${label} rejects anonymous callers`, async (operation) => {
    const response = await request(operation);
    expect([response.status, response.error?.code]).toEqual([401, "AUTHENTICATION_REQUIRED"]);
  });

  it.each(byAuth("jwt", "admin"))(`${label} rejects API Keys`, async (operation) => {
    const response = await request(operation, readOnlyKey);
    expect([response.status, response.error?.code]).toEqual([403, "API_KEY_NOT_ALLOWED"]);
  });

  it.each(byAuth("jwt_or_key").filter(({ scope }) => scope && scope !== "quotes:read"))(`${label} needs its scope`, async (operation) => {
    const response = await request(operation, readOnlyKey);
    expect([response.status, response.error?.code]).toEqual([403, "INSUFFICIENT_SCOPE"]);
    expect(response.error?.details).toEqual({ required_scope: operation.scope });
  });

  it.each(byAuth("admin"))(`SEC-09: ${label} rejects ordinary users`, async (operation) => {
    const response = await request(operation, user.token);
    expect([response.status, response.error?.code]).toEqual([403, "FORBIDDEN_ROLE"]);
  });
});
