import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse } from "yaml";

type Response = { $ref?: string; content?: Record<string, unknown> };
type Operation = { responses: Record<string, Response> };
type Document = { paths: Record<string, Record<string, Operation>>; components: { responses: Record<string, Response> } };

const doc = parse(readFileSync("openapi/openapi.yaml", "utf8")) as Document;
// `doc` is not a schema itself; it is only the document the operations' $refs resolve against
const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats.default(ajv);
ajv.addSchema(doc, "openapi");

const templates = Object.keys(doc.paths).map((template) => ({
  template,
  literal: !template.includes("{"),
  regex: new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`),
}));
const compiled = new Map<string, ValidateFunction>();

const pointer = (...parts: string[]) => parts.map((part) => encodeURIComponent(part.replaceAll("~", "~0").replaceAll("/", "~1"))).join("/");

function validatorFor(segments: string[]) {
  const ref = `openapi#/${pointer(...segments, "content", "application/json", "schema")}`;
  let validate = compiled.get(ref);
  if (!validate) {
    validate = ajv.compile({ $ref: ref });
    compiled.set(ref, validate);
  }
  return validate;
}

/** Throws when a response is not what openapi.yaml promises for that operation and status. Paths outside the contract are ignored. */
export function checkContract(method: string, path: string, status: number, contentType: string | null, raw: string) {
  const pathname = path.split("?")[0] as string;
  const match = templates.find(({ literal, template }) => literal && template === pathname)
    ?? templates.find(({ literal, regex }) => !literal && regex.test(pathname));
  const verb = method.toLowerCase();
  const operation = match && doc.paths[match.template]?.[verb];
  if (!match || !operation) return;

  const label = `${method} ${match.template} -> ${status}`;
  const response = operation.responses[String(status)];
  if (!response) throw new Error(`Undocumented status: ${label}\n${raw}`);

  const named = response.$ref?.split("/").at(-1);
  const content = named ? doc.components.responses[named]?.content : response.content;
  if (!content) {
    if (raw) throw new Error(`Expected no body: ${label}\n${raw}`);
    return;
  }
  if (contentType?.startsWith("text/plain") && "text/plain" in content) return;
  if (!contentType?.startsWith("application/json") || !("application/json" in content)) {
    throw new Error(`Undocumented content type ${contentType}: ${label}`);
  }
  const segments = named ? ["components", "responses", named] : ["paths", match.template, verb, "responses", String(status)];
  const validate = validatorFor(segments);
  if (!validate(JSON.parse(raw))) {
    throw new Error(`Response breaks the contract: ${label}\n${JSON.stringify(validate.errors, null, 2)}\n${raw}`);
  }
}
