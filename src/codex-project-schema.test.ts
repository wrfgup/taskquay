import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT_REQUEST_FIELDS, verifyProjectSchemas } from "./codex-project-schema.js";

const string = { type: "string" };
const roots = { type: "array", items: { type: "object", properties: { path: string }, required: ["path"] } };
function fixture(): Record<string, any> {
  const docs: Record<string, any> = {};
  for (const [name, keys] of Object.entries(PROJECT_REQUEST_FIELDS)) {
    docs[name] = { type: "object", properties: Object.fromEntries(keys.map(k => [k, string])), required: [...keys] };
  }
  docs["v1/InitializeParams"].properties = {
    clientInfo: { type: "object", properties: { name: string, version: string }, required: ["name", "version"] },
    capabilities: { type: "object", properties: { experimentalApi: { type: "boolean" } } },
  };
  docs["v2/ProjectListParams"].properties = { cursor: { type: ["string", "null"] }, limit: { type: "integer" } };
  docs["v2/ThreadReadParams"].properties.includeTurns = { type: "boolean" };
  docs["v2/ProjectCreateParams"].properties.roots = roots;
  docs["v1/InitializeResponse"] = { properties: { codexHome: { allOf: [{ $ref: "#/definitions/Path" }] } }, definitions: { Path: string } };
  const project = { type: "object", properties: { id: string, name: string, roots, metadata: { type: "object" },
    createdAt: { type: "integer" }, updatedAt: { type: "integer" }, position: { type: "integer" } } };
  for (const name of ["v2/ProjectCreateResponse", "v2/ProjectReadResponse"]) docs[name] = { properties: { project } };
  docs["v2/ProjectListResponse"] = { properties: { data: { type: "array", items: project }, nextCursor: { type: ["string", "null"] } } };
  docs["v2/ThreadReadResponse"] = { properties: { thread: { properties: { id: string, cwd: string, projectId: { type: ["string", "null"] } } } } };
  // Each document is independently serialized in a real generated bundle.
  return JSON.parse(JSON.stringify(docs));
}

test("project schema qualification accepts additive optional fields and path references", () => {
  const docs = fixture();
  docs["v2/ProjectListParams"].properties.sortKey = string;
  docs["v2/ProjectReadResponse"].properties.project.properties.recencyAt = { type: ["integer", "null"] };
  assert.equal(verifyProjectSchemas(docs).checked.length, 12);
});
test("project schema qualification rejects a new mandatory request parameter", () => {
  const docs = fixture(); docs["v2/ProjectCreateParams"].required.push("futureRequired");
  assert.throws(() => verifyProjectSchemas(docs), /ProjectCreateParams.*futureRequired/);
});
test("project schema qualification rejects changed identities and missing methods", () => {
  const docs = fixture(); docs["v2/ThreadReadResponse"].properties.thread.properties.projectId = { type: "integer" };
  assert.throws(() => verifyProjectSchemas(docs), /thread.projectId/);
  const missing = fixture(); delete missing["v2/ProjectReadParams"];
  assert.throws(() => verifyProjectSchemas(missing), /ProjectReadParams/);
});
test("project schema qualification never fetches external schema references", () => {
  const docs = fixture(); docs["v1/InitializeResponse"].properties.codexHome = { $ref: "https://example.invalid/schema" };
  assert.throws(() => verifyProjectSchemas(docs), /External schema/);
});

for (const [name, key] of [
  ["v1/InitializeParams", "clientInfo"], ["v1/InitializeParams", "capabilities"],
  ["v2/ThreadReadParams", "includeTurns"], ["v2/ProjectListParams", "limit"],
  ["v2/ProjectCreateParams", "roots"],
]) {
  test(`project schema qualification rejects ${name}.${key} changed to string`, () => {
    const docs = fixture(); docs[name!].properties[key!] = string;
    assert.throws(() => verifyProjectSchemas(docs), new RegExp(`${name}.*${key}`));
  });
}

test("project list qualification requires both null and non-null cursors", () => {
  for (const type of ["string", "null"]) {
    const docs = fixture(); docs["v2/ProjectListParams"].properties.cursor = { type };
    assert.throws(() => verifyProjectSchemas(docs), /ProjectListParams.*cursor/);
  }
});

test("project schema qualification rejects new nested required fields, even with defaults or no property definition", () => {
  for (const key of ["clientInfo", "capabilities"]) {
    for (const defined of [false, true]) {
      const docs = fixture(), node = docs["v1/InitializeParams"].properties[key];
      node.required = [...(node.required ?? []), "futureRequired"];
      if (defined) node.properties.futureRequired = { type: "string", default: "not-sent" };
      assert.throws(() => verifyProjectSchemas(docs), new RegExp(`InitializeParams.*${key}.*futureRequired`));
    }
  }
  const docs = fixture(); docs["v2/ProjectCreateParams"].properties.roots.items.required.push("futureRequired");
  assert.throws(() => verifyProjectSchemas(docs), /ProjectCreateParams.*roots.*futureRequired/);
});

test("project schema qualification checks array items and every root's path", () => {
  for (const items of [{ type: "string" }, { type: "null" },
    { type: "object", properties: { path: { type: "integer" } }, required: ["path"] }]) {
    const docs = fixture(); docs["v2/ProjectCreateParams"].properties.roots.items = items;
    assert.throws(() => verifyProjectSchemas(docs), /ProjectCreateParams.*roots/);
  }
  const docs = fixture(); docs["v2/ProjectCreateParams"].properties.roots.maxItems = 1;
  assert.throws(() => verifyProjectSchemas(docs), /ProjectCreateParams.*roots/);
});

test("request qualification handles local pointers, nullable anyOf and multiple allOf branches without mutation", () => {
  const docs = fixture(), init = docs["v1/InitializeParams"];
  init.definitions = { "Client/Info": init.properties.clientInfo, Capabilities: init.properties.capabilities };
  init.properties.clientInfo = { allOf: [{ $ref: "#/definitions/Client~1Info" }, { required: ["name"] }] };
  init.properties.capabilities = { anyOf: [{ $ref: "#/definitions/Capabilities" }, { type: "null" }] };
  docs["v2/ProjectListParams"].properties.cursor = { anyOf: [string, { type: "null" }] };
  const create = docs["v2/ProjectCreateParams"];
  create.$defs = { Root: create.properties.roots.items };
  create.properties.roots.items = { $ref: "#/$defs/Root" };
  const read = docs["v2/ProjectReadParams"];
  docs["v2/ProjectReadParams"] = { allOf: [read, { required: ["projectId"] }] };
  const original = structuredClone(docs);
  assert.equal(verifyProjectSchemas(docs).checked.length, 12);
  assert.deepEqual(docs, original);
});

test("request qualification rejects incompatible anyOf and allOf branches through local refs", () => {
  for (const keyword of ["anyOf", "allOf"]) {
    const docs = fixture(), init = docs["v1/InitializeParams"];
    init.definitions = { Client: { ...init.properties.clientInfo, required: ["name", "version", "futureRequired"] } };
    init.properties.clientInfo = { [keyword]: [{ $ref: "#/definitions/Client" }, { type: "null" }] };
    assert.throws(() => verifyProjectSchemas(docs), /InitializeParams.*clientInfo/);
  }
  const docs = fixture(), init = docs["v1/InitializeParams"];
  init.properties.capabilities = { allOf: [init.properties.capabilities, { properties: { experimentalApi: string } }] };
  assert.throws(() => verifyProjectSchemas(docs), /InitializeParams.*experimentalApi/);
});

test("allOf applies required-only constraints alongside a compatible object branch", () => {
  const docs = fixture(), init = docs["v1/InitializeParams"];
  init.properties.clientInfo = { allOf: [init.properties.clientInfo, { required: ["futureRequired"] }] };
  assert.throws(() => verifyProjectSchemas(docs), /InitializeParams.*clientInfo.*futureRequired/);
});

test("referenced root items reject new required fields and changed item types", () => {
  for (const root of [
    { type: "object", properties: { path: string }, required: ["path", "futureRequired"] },
    { type: "string" },
  ]) {
    const docs = fixture(), create = docs["v2/ProjectCreateParams"];
    create.definitions = { Root: root };
    create.properties.roots.items = { allOf: [{ $ref: "#/definitions/Root" }] };
    assert.throws(() => verifyProjectSchemas(docs), /ProjectCreateParams.*roots/);
  }
});

test("request qualification respects additionalProperties, enum and boolean schemas", () => {
  const docs = fixture(); docs["v1/InitializeParams"].properties.capabilities.additionalProperties = false;
  assert.equal(verifyProjectSchemas(docs).checked.length, 12);
  docs["v1/InitializeParams"].properties.capabilities.properties.experimentalApi = false;
  assert.throws(() => verifyProjectSchemas(docs), /InitializeParams.*experimentalApi/);
  const extra = fixture(); extra["v1/InitializeParams"].properties.capabilities = { type: "object", additionalProperties: false };
  assert.throws(() => verifyProjectSchemas(extra), /InitializeParams.*additional properties/);
  const enumeration = fixture(); enumeration["v2/ThreadReadParams"].properties.includeTurns = { type: "boolean", enum: [true] };
  assert.throws(() => verifyProjectSchemas(enumeration), /ThreadReadParams.*includeTurns/);
});

test("request qualification normalizes uint32 and rejects unsupported keywords, formats and drafts", () => {
  const docs = fixture(); docs["v2/ProjectListParams"].properties.limit.format = "uint32";
  assert.equal(verifyProjectSchemas(docs).checked.length, 12);
  for (const constraint of [{ maximum: 99 }, { minimum: 101 }, { type: "string" }]) {
    const changed = fixture(); changed["v2/ProjectListParams"].properties.limit = { format: "uint32", ...constraint };
    assert.throws(() => verifyProjectSchemas(changed), /ProjectListParams.*limit/);
  }
  for (const schema of [{ futureValidationKeyword: true }, { format: "unknown-format" },
    { $schema: "https://json-schema.org/draft/2020-12/schema" }]) {
    const changed = fixture(); Object.assign(changed["v2/ProjectListParams"], schema);
    assert.throws(() => verifyProjectSchemas(changed), /unsupported|only draft-07/);
  }
});

test("request qualification rejects external and missing refs even in an unused anyOf branch", () => {
  for (const ref of ["https://example.invalid/schema", "#/definitions/Missing"]) {
    const docs = fixture(), init = docs["v1/InitializeParams"];
    init.properties.capabilities = { anyOf: [init.properties.capabilities, { $ref: ref }] };
    assert.throws(() => verifyProjectSchemas(docs), /External schema|Missing local schema/);
  }
});

test("request qualification rejects a missing sent field behind top-level composition", () => {
  const docs = fixture(); delete docs["v2/ThreadReadParams"].properties.includeTurns;
  docs["v2/ThreadReadParams"] = { allOf: [docs["v2/ThreadReadParams"], { type: "object" }] };
  assert.throws(() => verifyProjectSchemas(docs), /ThreadReadParams.*missing project field includeTurns/);
});
