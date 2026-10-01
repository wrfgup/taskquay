/** Offline qualification of the project RPC surface; not permission to run an unknown binary. */
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

type Schema = Record<string, any>;

// Mirror codex-projects.ts and the thread naming control call. These are probes,
// not a proof that every possible path/name/id satisfies arbitrary constraints.
const PROJECT_REQUEST_PROBES: Record<string, readonly Record<string, unknown>[]> = {
  "v1/InitializeParams": [{ clientInfo: { name: "devspace-projects", version: "1.0.8" }, capabilities: { experimentalApi: true } }],
  "v2/ProjectListParams": [{ cursor: null, limit: 100 }, { cursor: "next-page", limit: 100 }],
  "v2/ProjectCreateParams": [
    { idempotencyKey: `devspace-roots-v1-${"a".repeat(64)}`, name: "project", roots: [{ path: "D:\\project\\example" }] },
    { idempotencyKey: `devspace-roots-v1-${"b".repeat(64)}`, name: "example", roots: [{ path: "/project/example" }, { path: "/project/other" }] },
  ],
  "v2/ProjectReadParams": [{ projectId: "project-id" }],
  "v2/ThreadReadParams": [{ threadId: "thread-id", includeTurns: false }, { threadId: "thread-id", includeTurns: true }],
  "v2/ThreadMetadataUpdateParams": [{ threadId: "thread-id", projectId: "project-id" }],
  "v2/ThreadSetNameParams": [{ threadId: "thread-id", name: "[DevSpace verification] empty project-bound thread, no inference" }],
};
export const PROJECT_REQUEST_FIELDS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(PROJECT_REQUEST_PROBES).map(([name, probes]) => [name, Object.keys(probes[0]!)]),
);

// The SDK's AJV provider uses strict:false. Explicitly restrict the qualification
// dialect so unrecognized validation keywords cannot silently become a pass.
const REQUEST_SCHEMA_KEYS = new Set([
  "$schema", "$ref", "definitions", "$defs", "title", "description", "$comment", "default", "examples",
  "type", "enum", "const", "properties", "required", "additionalProperties", "items",
  "anyOf", "allOf", "oneOf", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "format",
]);

function localReference(document: Schema, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error("External schema references and non-pointer references are not supported");
  let node: unknown = document;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) throw new Error(`Missing local schema reference: ${ref}`);
    node = (node as Schema)[key];
  }
  return node;
}

function qualifyRequestSchema(document: Schema, node: unknown, label: string, depth = 0): void {
  if (depth > 64) throw new Error(`${label}: schema nesting exceeds qualification limit`);
  if (typeof node === "boolean") return;
  const schema = object(node, label);
  for (const key of Object.keys(schema)) {
    if (!REQUEST_SCHEMA_KEYS.has(key)) throw new Error(`${label}: unsupported request schema keyword ${key}`);
  }
  if (schema.$schema !== undefined && schema.$schema !== "http://json-schema.org/draft-07/schema#") {
    throw new Error(`${label}: only draft-07 request schemas are qualified`);
  }
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string") throw new Error(`${label}: invalid schema reference`);
    localReference(document, schema.$ref); // Synchronous local lookup; never fetch a schema.
  }
  if (schema.format !== undefined) {
    if (schema.format !== "uint32") throw new Error(`${label}: unsupported request schema format ${schema.format}`);
    // Codex's uint32 annotation is not an ajv-formats format. Preserve its
    // constraints explicitly instead of accepting AJV's unknown-format warning.
    delete schema.format;
    schema.allOf = [...(schema.allOf ?? []), { type: ["integer", "null"], minimum: 0, maximum: 4294967295 }];
  }
  for (const key of ["properties", "definitions", "$defs"]) {
    if (schema[key] !== undefined) for (const [name, value] of Object.entries(object(schema[key], `${label}.${key}`))) {
      qualifyRequestSchema(document, value, `${label}.${key}.${name}`, depth + 1);
    }
  }
  for (const key of ["items", "additionalProperties"]) {
    if (schema[key] !== undefined) qualifyRequestSchema(document, schema[key], `${label}.${key}`, depth + 1);
  }
  for (const key of ["anyOf", "allOf", "oneOf"]) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key]) || !schema[key].length) throw new Error(`${label}: invalid ${key}`);
    schema[key].forEach((value: unknown, index: number) => qualifyRequestSchema(document, value, `${label}.${key}[${index}]`, depth + 1));
  }
}

function declaresField(document: Schema, node: unknown, name: string, depth = 0): boolean {
  if (depth > 12) throw new Error("Unsupported recursive project schema");
  if (typeof node === "boolean") return false;
  const schema = object(node, "schema node");
  if (schema.properties && Object.hasOwn(schema.properties, name)) return true;
  if (schema.$ref && declaresField(document, localReference(document, schema.$ref), name, depth + 1)) return true;
  return ["anyOf", "allOf", "oneOf"].some(key => schema[key]?.some((value: unknown) => declaresField(document, value, name, depth + 1)));
}

function object(value: unknown, label: string): Schema {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected schema object`);
  return value as Schema;
}

function resolve(document: Schema, node: unknown, depth = 0): Schema {
  if (depth > 12) throw new Error("Unsupported recursive project schema");
  const value = object(node, "schema node");
  if (typeof value.$ref === "string") {
    return resolve(document, localReference(document, value.$ref), depth + 1);
  }
  if (Array.isArray(value.allOf) && value.allOf.length === 1) return resolve(document, value.allOf[0], depth + 1);
  return value;
}

function field(document: Schema, node: Schema, name: string): Schema {
  if (!node.properties || !(name in node.properties)) throw new Error(`Missing project field: ${name}`);
  return resolve(document, node.properties[name]);
}

function typeIs(node: Schema, type: string, label: string, nullable = false) {
  const actual = Array.isArray(node.type) ? node.type : [node.type];
  if (!actual.includes(type) || actual.some((t: unknown) => t !== type && !(nullable && t === "null"))) {
    throw new Error(`Incompatible type for ${label}: expected ${type}${nullable ? " or null" : ""}`);
  }
}

export function verifyProjectSchemas(documents: Record<string, unknown>): { checked: string[] } {
  const get = (name: string) => object(documents[name], name);
  for (const [name, probes] of Object.entries(PROJECT_REQUEST_PROBES)) {
    const doc = structuredClone(get(name));
    qualifyRequestSchema(doc, doc, name);
    for (const key of PROJECT_REQUEST_FIELDS[name]!) {
      if (!declaresField(doc, doc, key)) throw new Error(`${name}: missing project field ${key}`);
    }
    // Compile documents independently; never share definitions between bundles.
    const validate = new AjvJsonSchemaValidator().getValidator(doc);
    for (const probe of probes) {
      const result = validate(probe);
      if (!result.valid) throw new Error(`${name}: adapter request is incompatible: ${result.errorMessage}`);
    }
  }

  const init = get("v1/InitializeResponse");
  typeIs(field(init, init, "codexHome"), "string", "initialize.codexHome");

  for (const name of ["v2/ProjectCreateResponse", "v2/ProjectReadResponse", "v2/ProjectListResponse"]) {
    const doc = get(name);
    let project: Schema;
    if (name.endsWith("ProjectListResponse")) {
      const data = field(doc, doc, "data");
      typeIs(data, "array", `${name}.data`);
      typeIs(field(doc, doc, "nextCursor"), "string", `${name}.nextCursor`, true);
      project = resolve(doc, data.items);
    } else project = field(doc, doc, "project");
    typeIs(project, "object", "project");
    for (const key of ["id", "name"]) typeIs(field(doc, project, key), "string", `project.${key}`);
    for (const key of ["createdAt", "updatedAt", "position"]) typeIs(field(doc, project, key), "integer", `project.${key}`);
    typeIs(field(doc, project, "metadata"), "object", "project.metadata");
    const savedRoots = field(doc, project, "roots");
    typeIs(savedRoots, "array", "project.roots");
    typeIs(field(doc, resolve(doc, savedRoots.items), "path"), "string", "project.root.path");
  }
  const threadDoc = get("v2/ThreadReadResponse");
  const thread = field(threadDoc, threadDoc, "thread");
  for (const key of ["id", "cwd"]) typeIs(field(threadDoc, thread, key), "string", `thread.${key}`);
  typeIs(field(threadDoc, thread, "projectId"), "string", "thread.projectId", true);
  return { checked: Object.keys(documents).sort() };
}
