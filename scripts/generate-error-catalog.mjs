// errors.yaml cannot be read at runtime from a standalone build, so routes import this generated JSON.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const catalog = parse(readFileSync("openapi/errors.yaml", "utf8"));
for (const entry of Object.values(catalog)) delete entry.condition;
writeFileSync("lib/http/error-catalog.json", `${JSON.stringify(catalog, null, 2)}\n`);
