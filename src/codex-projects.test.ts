import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareProjectRoots, projectPathKey, registerProject, type ProjectControl, type ProjectMethod } from "./codex-projects.js";

function fixture() {
  const home = "C:\\Users\\fixture\\.codex", root = "D:\\projects\\voice-memory";
  const calls: { method: ProjectMethod; params: any }[] = [];
  let projects: any[] = [];
  const threads = new Map(["original", "early"].map((id) => [id, { id, cwd: root, projectId: null as string | null, unknown: "preserve" }]));
  const client: ProjectControl = { home, command: "desktop/codex.exe", close: async () => {}, request: async (method, params: any) => {
    calls.push({ method, params });
    if (method === "project/list") return structuredClone({ data: projects, nextCursor: null });
    if (method === "project/create") {
      const existing = projects.find((p) => p.key === params.idempotencyKey);
      if (existing) return { project: structuredClone(existing) };
      const project = { id: "saved", name: params.name, roots: params.roots, key: params.idempotencyKey,
        createdAt: 1, updatedAt: 1, position: 0, metadata: { future: "preserve" }, unknown: "preserve" };
      projects.push(project); return { project: structuredClone(project) };
    }
    if (method === "project/read") return { project: structuredClone(projects.find((p) => p.id === params.projectId)) };
    if (method === "thread/read") return { thread: structuredClone(threads.get(params.threadId)) };
    if (method === "thread/metadata/update") { threads.get(params.threadId)!.projectId = params.projectId; return {}; }
    throw new Error("Unexpected RPC");
  } };
  return { home, root, client, calls, threads, projects };
}

test("new saved root and both original threads register once and preserve unknown fields", async () => {
  const f = fixture();
  const input = { roots: [f.root], expectedHome: f.home, threadIds: ["original", "early"] };
  const first = await registerProject(f.client, input);
  assert.equal(first.status, "persisted_registration");
  assert.equal(first.before?.projectId, null);
  assert.equal(first.after?.threads.length, 2);
  assert.equal(first.uiStatus, "unverified");
  assert.equal(first.provider?.homeMatched, true);
  const replay = await registerProject(f.client, { ...input, roots: ["d:/projects/voice-memory/"] });
  assert.equal(replay.status, "persisted_registration");
  assert.equal(replay.reused, true);
  assert.equal(f.calls.filter((c) => c.method === "project/create").length, 1);
  assert.equal(f.calls.filter((c) => c.method === "thread/metadata/update").length, 2);
  assert.equal(f.projects[0].metadata.future, "preserve");
  assert.equal(f.threads.get("original")!.unknown, "preserve");
  assert(f.calls.every((c) => !["thread/start", "thread/resume", "turn/start"].includes(c.method)));
});

test("an existing multi-root project is reused without dropping other roots", async () => {
  const f = fixture();
  await registerProject(f.client, { roots: [f.root, "D:\\notes"], expectedHome: f.home });
  const receipt = await registerProject(f.client, { roots: [f.root], expectedHome: f.home });
  assert.equal(receipt.reused, true);
  assert.deepEqual(receipt.after?.roots, [f.root, "D:\\notes"]);
});

test("lost successful create response is recovered without another project or model", async () => {
  const f = fixture(); let loseResponse = true;
  const disconnected = { ...f.client, request: async (method: ProjectMethod, params: any) => {
    const result = await f.client.request(method, params);
    if (method === "project/create" && loseResponse) { loseResponse = false; throw new Error("Connection lost; outcome unknown"); }
    return result;
  } };
  const input = { roots: [f.root], expectedHome: f.home, threadIds: ["original"] };
  assert.equal((await registerProject(disconnected, input)).status, "partial");
  assert.equal((await registerProject(disconnected, input)).status, "persisted_registration");
  assert.equal(f.projects.length, 1);
  assert.equal(f.calls.filter((c) => c.method === "project/create").length, 1);
});

test("provider home mismatch, unknown schema and another thread owner refuse mutation", async () => {
  const f = fixture();
  assert.equal((await registerProject(f.client, { roots: [f.root], expectedHome: "C:\\other" })).status, "partial");
  assert.equal(f.calls.length, 0);
  const unknown = { ...f.client, request: async () => ({ data: [{ id: "future-format" }], nextCursor: null }) };
  assert.equal((await registerProject(unknown, { roots: [f.root], expectedHome: f.home })).code, "DESKTOP_SCHEMA_UNSUPPORTED");
  f.threads.get("original")!.projectId = "someone-elses-project";
  assert.equal((await registerProject(f.client, { roots: [f.root], expectedHome: f.home, threadIds: ["original"] })).status, "partial");
  assert(!f.calls.some((c) => c.method === "project/create" || c.method === "thread/metadata/update"));
});

test("external project and thread changes stop at actionable partial receipts", async () => {
  const f = fixture(); let lists = 0;
  const concurrent = { ...f.client, request: async (method: ProjectMethod, params: any) => {
    if (method === "project/list" && ++lists === 2) return { data: [{ id: "external", name: "external", roots: [{ path: f.root }], createdAt: 1, updatedAt: 1, position: 0, metadata: {} }], nextCursor: null };
    return f.client.request(method, params);
  } };
  assert.equal((await registerProject(concurrent, { roots: [f.root], expectedHome: f.home })).status, "partial");
  assert(!f.calls.some((c) => c.method === "project/create"));
  let reads = 0;
  const race = { ...f.client, request: async (method: ProjectMethod, params: any) => {
    if (method === "thread/read" && ++reads === 2) f.threads.get("original")!.projectId = "external";
    return f.client.request(method, params);
  } };
  const result = await registerProject(race, { roots: [f.root], expectedHome: f.home, threadIds: ["original"] });
  assert.equal(result.status, "partial");
  assert.equal(result.projectId, "saved", "Completed project creation remains in partial evidence");
  assert(!f.calls.some((c) => c.method === "thread/metadata/update"));
});

test("directory creation is explicit, repeatable, contained and validates all roots first", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-project-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const newRoot = join(root, "new", "project");
  await assert.rejects(prepareProjectRoots([newRoot], [root]), /create_directory/);
  await assert.rejects(prepareProjectRoots([newRoot, join(root, "..", "escape")], [root], true), /outside allowed/);
  await assert.rejects(stat(newRoot), { code: "ENOENT" });
  const first = await prepareProjectRoots([newRoot], [root], true);
  assert.equal(first.createdDirectories.length, 1);
  assert.deepEqual((await prepareProjectRoots([newRoot], [root], true)).createdDirectories, []);
  if (process.platform === "win32") {
    assert.equal((await prepareProjectRoots([`\\\\?\\${newRoot}`], [root])).roots[0], first.roots[0]);
    await assert.rejects(prepareProjectRoots(["/home/ambiguous"], [root]), /absolute local paths/);
  }
  const outside = await mkdtemp(join(tmpdir(), "devspace-project-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const link = join(root, "link");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareProjectRoots([join(link, "escape")], [root], true), /outside allowed/);
  // An unrelated unavailable allowed root must not make a local project unusable.
  assert.equal((await prepareProjectRoots([newRoot], [root, join(root, "absent")])).roots.length, 1);
});

test("Windows extended paths, UNC and WSL aliases retain Linux path case", () => {
  if (process.platform !== "win32") assert.notEqual(projectPathKey("/home/User"), projectPathKey("/home/user"));
  assert.equal(projectPathKey("\\\\?\\D:\\Projects\\voice-memory\\"), projectPathKey("d:/projects/voice-memory"));
  assert.equal(projectPathKey("\\\\?\\UNC\\Server\\Share\\a"), projectPathKey("\\\\server\\share\\a"));
  assert.equal(projectPathKey("\\\\wsl$\\Ubuntu\\home\\User\\project"), projectPathKey("\\\\wsl.localhost\\ubuntu\\home\\User\\project"));
  assert.notEqual(projectPathKey("\\\\wsl$\\Ubuntu\\home\\User"), projectPathKey("\\\\wsl$\\Ubuntu\\home\\user"));
});
