// Cross-checks Spectral cannot do: OpenAPI against errors.yaml, and RPC error codes against both.
import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const errors = parse(readFileSync("openapi/errors.yaml", "utf8"));
const openapi = parse(readFileSync("openapi/openapi.yaml", "utf8"));
const problems = [];
const used = new Set();

for (const [path, item] of Object.entries(openapi.paths)) {
  for (const [method, op] of Object.entries(item)) {
    const label = `${method.toUpperCase()} ${path}`;
    const statuses = new Set();
    for (const code of op["x-errors"]) {
      used.add(code);
      if (!errors[code]) problems.push(`${label}: unknown error code ${code}`);
      else statuses.add(String(errors[code].status));
    }
    const documented = Object.keys(op.responses).filter((s) => /^[45]/.test(s));
    for (const status of statuses) {
      if (!documented.includes(status)) problems.push(`${label}: ${status} has a code in x-errors but no response`);
    }
    for (const status of documented) {
      if (!statuses.has(status)) problems.push(`${label}: response ${status} has no code in x-errors`);
    }
  }
}

// Codes that any route can produce without being declared per operation
for (const code of ["ROUTE_NOT_FOUND", "METHOD_NOT_ALLOWED"]) used.add(code);

const migrations = readdirSync("supabase/migrations").map((f) => readFileSync(`supabase/migrations/${f}`, "utf8")).join("\n");
const raised = new Set();
for (const match of migrations.matchAll(/raise_error\('([A-Z_]+)'/g)) raised.add(match[1]);
for (const match of migrations.matchAll(/assert_can_write_content\(actor, '([A-Z_]+)'\)/g)) raised.add(match[1]);
for (const code of raised) {
  if (!errors[code]) problems.push(`RPC raises ${code}, missing from errors.yaml`);
}

for (const code of Object.keys(errors)) {
  if (!used.has(code)) problems.push(`errors.yaml defines ${code}, no operation uses it`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`contract ok: ${Object.keys(errors).length} codes, ${raised.size} raised by RPC`);
