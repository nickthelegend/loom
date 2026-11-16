import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ADES } from "../src/core/ades.js";
import { cloneSource, parseProjectAgent, projectGit, projectSlug } from "../src/core/project-creation.js";
import { ensureDaemonConfig, listProjects, readDaemonConfig, readProjectConfig, writeDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { ProjectCreation } from "../src/daemon/project-creation.js";
import { addProjectAt } from "../src/daemon/routes/projects.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let daemon: LoomDaemon;
let client: DaemonClient;
let base: string;
let token: string;
let projectsRoot: string;
let cloneUrl: string;
let scoped: string;
let guest: string;
let phone: string;
let scopeId: string;
const originalAdes = [...ADES];
const sockets: WebSocket[] = [];

const call = (method: string, route: string, body?: unknown, auth = token) => fetch(base + route, {
  method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

async function pair(body: unknown): Promise<string> {
  const minted = await call("POST", "/api/pair/new", body);
  expect(minted.status).toBe(200);
  const { token: pairing } = await minted.json() as { token: string };
  const claimed = await call("POST", "/api/pair/claim", { token: pairing, name: "test device" });
  expect(claimed.status).toBe(200);
  return (await claimed.json() as { clientToken: string }).clientToken;
}

async function connect(auth: string, project?: string) {
  const frames: Array<Record<string, any>> = [];
  const ws = new WebSocket(base.replace("http", "ws") + "/ws" + (project ? `?project=${project}` : ""), [`loom.bearer.${auth}`]);
  sockets.push(ws);
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { ws, frames };
}

async function finish(jobId: string) {
  await waitUntil(async () => (await client.projectJob(jobId)).status !== "cloning");
  return client.projectJob(jobId);
}

async function cli(args: string[]) {
  return exec(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "src/cli/index.ts"), ...args], {
    cwd: tmpDir("outside-project"), env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-project-creation");
  process.env.LOOM_NO_NOTIFY = "1";
  projectsRoot = path.join(tmpDir("project-creation"), "Projects with spaces");
  writeDaemonConfig({ ...ensureDaemonConfig({ host: "127.0.0.1", port: 0 }), projectsRoot });
  // Exercise real detection against a fixture catalog, never an installed agent CLI.
  ADES.splice(0, ADES.length, { kind: "echo", label: "Echo", tier: "adapter", probe: async () => true });
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  const cfg = readDaemonConfig()!;
  base = `http://${cfg.host}:${cfg.port}`;
  token = cfg.adminToken;
  client = new DaemonClient(cfg);
  const source = makeProjectDir({ name: "source repository", agents: [{ id: "echo", kind: "echo", role: "echo" }] });
  fs.writeFileSync(path.join(source, "README.md"), "a cloned readme\n");
  await projectGit(["init"], source);
  await projectGit(["add", "."], source);
  await projectGit(["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"], source);
  const bare = path.join(tmpDir("clone-source"), "fixture.git");
  await projectGit(["clone", "--bare", source, bare], path.dirname(bare));
  cloneUrl = pathToFileURL(bare).href;
  scopeId = (await client.addProject(makeProjectDir({ name: "new" }))).project.id;
  phone = await pair({});
  scoped = await pair({ projects: [scopeId] });
  guest = await pair({ guest: { project: scopeId, chat: "main", role: "approve", name: "Guest" } });
});

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await daemon?.close();
  ADES.splice(0, ADES.length, ...originalAdes);
});

describe("new projects", () => {
  it("creates files, a real first commit, a numbered roster, and a registry entry", async () => {
    const result = await client.newProject({ name: " My FIRST / Project! ", agents: [
      { kind: "echo", model: "first-model", count: 2 }, { kind: "echo", model: "second-model" },
    ] });
    const dir = path.join(projectsRoot, "my-first-project");
    expect(result.project).toMatchObject({ name: "My FIRST / Project!", dir });
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# My FIRST / Project!\n");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(".loom/\n");
    expect(await projectGit(["rev-list", "--count", "HEAD"], dir)).toBe("1");
    expect(await projectGit(["status", "--porcelain"], dir)).toBe("");
    expect(await projectGit(["ls-files"], dir)).toBe(".gitignore\nREADME.md");
    expect(await projectGit(["log", "-1", "--format=%an <%ae>"], dir)).toBe("Loom Test <test@loom.local>");
    expect(result.config.agents).toEqual([
      { id: "echo", kind: "echo", role: "echo", options: { model: "first-model" } },
      { id: "echo-2", kind: "echo", role: "echo", options: { model: "first-model" } },
      { id: "echo-3", kind: "echo", role: "echo", options: { model: "second-model" } },
    ]);
    expect(readProjectConfig(dir)).toEqual(result.config);
    expect(listProjects()).toContainEqual(result.project);
  });

  it("commits with a fallback identity without changing Git configuration", async () => {
    const emptyConfig = path.join(tmpDir("git-identity"), "config");
    fs.writeFileSync(emptyConfig, "");
    vi.stubEnv("GIT_CONFIG_GLOBAL", emptyConfig);
    const { project } = await client.newProject({ name: "Fallback identity", agents: [{ kind: "echo" }] });
    expect(await projectGit(["log", "-1", "--format=%an <%ae>"], project.dir)).toBe("Loom <loom@localhost>");
    await expect(projectGit(["config", "--get", "user.name"], project.dir)).rejects.toThrow();
    expect(fs.readFileSync(emptyConfig, "utf8")).toBe("");
  });

  it("detects the roster when omitted and permits an explicitly empty roster", async () => {
    const detected = await client.newProject({ name: "Detected", git: false });
    expect(detected.config.agents).toEqual([{ id: "echo", kind: "echo", role: "echo" }]);
    const empty = await client.newProject({ name: "Empty", agents: [], git: false });
    expect(empty.config.agents).toEqual([]);
    expect(fs.existsSync(path.join(empty.project.dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(empty.project.dir, "README.md"))).toBe(true);
  });

  it.each([
    {}, { name: "!!!" }, { name: 1 }, { name: "invalid", git: "true" },
    { name: "invalid", agents: {} }, { name: "invalid", agents: [null] },
    { name: "invalid", agents: [{ kind: "unknown" }] },
    ...[0, 9, 1.5, "2", null].map((count) => ({ name: "invalid", agents: [{ kind: "echo", count }] })),
    { name: "invalid", agents: [{ kind: "echo", model: 123 }] },
  ])("refuses malformed input before creating a folder: %j", async (body) => {
    const before = fs.readdirSync(projectsRoot);
    expect((await call("POST", "/api/projects/new", body)).status).toBe(400);
    expect(fs.readdirSync(projectsRoot)).toEqual(before);
  });

  it("refuses occupied names, files, symlinks, and simultaneous requests without overwriting", async () => {
    const dir = path.join(projectsRoot, "occupied");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "keep"), "untouched");
    expect((await call("POST", "/api/projects/new", { name: "Occupied", agents: [] })).status).toBe(409);
    expect(fs.readFileSync(path.join(dir, "keep"), "utf8")).toBe("untouched");
    fs.writeFileSync(path.join(projectsRoot, "a-file"), "keep");
    expect((await call("POST", "/api/projects/new", { name: "A file" })).status).toBe(409);
    fs.symlinkSync(dir, path.join(projectsRoot, "a-link"), "junction");
    expect((await call("POST", "/api/projects/new", { name: "A link" })).status).toBe(409);
    const replies = await Promise.all([1, 2].map(() => call("POST", "/api/projects/new", { name: "Racing", agents: [{ kind: "echo" }] })));
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(listProjects().filter((p) => p.name === "Racing")).toHaveLength(1);
  });

  it("cleans up a failed initialization and allows retrying the name", async () => {
    const before = listProjects();
    vi.stubEnv("PATH", tmpDir("no-git"));
    const failed = await call("POST", "/api/projects/new", { name: "Retry init", agents: [{ kind: "echo" }] });
    expect(failed.status).toBe(500);
    expect(fs.existsSync(path.join(projectsRoot, "retry-init"))).toBe(false);
    expect(listProjects()).toEqual(before);
    vi.unstubAllEnvs();
    expect((await client.newProject({ name: "Retry init", agents: [{ kind: "echo" }] })).project.id).toBeTruthy();
  });
});

describe("clone jobs", () => {
  it("detects agents and writes config when the repository has no Loom config", async () => {
    const { project } = await client.newProject({ name: "Plain source", agents: [{ kind: "echo" }] });
    const bare = path.join(tmpDir("plain-bare"), "plain.git");
    await projectGit(["clone", "--bare", project.dir, bare], path.dirname(bare));
    const { jobId } = await client.cloneProject({ url: pathToFileURL(bare).href });
    const job = await finish(jobId);
    expect(job.status).toBe("done");
    expect(readProjectConfig(job.project!.dir)).toEqual({ name: "plain", agents: [{ id: "echo", kind: "echo", role: "echo" }] });
  });

  it("returns 202, streams progress only to owner devices, and registers a local bare clone", async () => {
    const ownerSocket = await connect(token);
    const phoneSocket = await connect(phone);
    const scopedSocket = await connect(scoped, scopeId);
    const guestSocket = await connect(guest, scopeId);
    const response = await call("POST", "/api/projects/clone", { url: cloneUrl });
    expect(response.status).toBe(202);
    const { jobId, dir } = await response.json() as { jobId: string; dir: string };
    expect(dir).toBe(path.join(projectsRoot, "fixture"));
    const job = await finish(jobId);
    // the repo's own .loom/config.json is someone else's agent commands: set aside, not run
    expect(job).toMatchObject({ status: "done", project: { dir, name: "fixture" } });
    expect(job.progress).toContain("config.cloned.json");
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".loom", "config.cloned.json"), "utf8")).name).toBe("source repository");
    expect(readProjectConfig(dir)!.name).toBe("fixture"); // a config Loom wrote, not the repo's
    expect(job.error).toBeUndefined();
    expect(listProjects()).toContainEqual(job.project);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("a cloned readme\n");
    expect(await projectGit(["rev-list", "--count", "HEAD"], dir)).toBe("1");
    for (const { frames } of [ownerSocket, phoneSocket]) {
      await waitUntil(() => frames.some((f) => f.type === "project-job" && f.jobId === jobId && f.status === "done"));
      expect(frames.some((f) => f.type === "project-job" && f.status === "cloning")).toBe(true);
      expect(frames.some((f) => f.type === "projects" && f.project.id === job.project!.id)).toBe(true);
    }
    for (const { frames } of [scopedSocket, guestSocket]) {
      expect(frames.some((f) => f.type === "project-job" || f.type === "projects")).toBe(false);
    }
    for (const { ws } of [ownerSocket, phoneSocket, scopedSocket, guestSocket]) ws.close();
  });

  it("lets an unscoped paired phone create, clone with a name, and poll", async () => {
    const added = await call("POST", "/api/projects/new", { name: "From phone", agents: [{ kind: "echo" }], git: false }, phone);
    expect(added.status).toBe(200);
    const response = await call("POST", "/api/projects/clone", { url: cloneUrl, name: "Phone clone" }, phone);
    expect(response.status).toBe(202);
    const { jobId } = await response.json() as { jobId: string };
    expect(await finish(jobId)).toMatchObject({ status: "done", project: { name: "Phone clone", dir: path.join(projectsRoot, "phone-clone") } });
    expect((await call("GET", `/api/projects/jobs/${jobId}`, undefined, phone)).status).toBe(200);
  });

  it("reserves clone destinations before starting Git", async () => {
    const replies = await Promise.all([1, 2].map(() => call("POST", "/api/projects/clone", { url: cloneUrl, name: "Clone race" })));
    expect(replies.map((r) => r.status).sort()).toEqual([202, 409]);
    const accepted = await replies.find((r) => r.status === 202)!.json() as { jobId: string };
    expect((await finish(accepted.jobId)).status).toBe("done");
  });

  it("reports failures, removes only its own partial folder, and can retry", async () => {
    const missing = pathToFileURL(path.join(tmpDir("missing-repo"), "missing.git")).href;
    const { jobId, dir } = await client.cloneProject({ url: missing, name: "Failed clone" });
    const job = await finish(jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toBeTruthy();
    expect(job.project).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
    expect(listProjects().some((p) => p.dir === dir)).toBe(false);
    expect((await finish((await client.cloneProject({ url: cloneUrl, name: "Failed clone" })).jobId)).status).toBe("done");
    expect((await call("GET", "/api/projects/jobs/missing")).status).toBe(404);
  });

  it.each(["", "--upload-pack=bad", "/tmp/local", "http://example.com/repo", "git://example.com/repo", "ext::bad", "https://", "git@host:", "ssh://host/repo\nother"])("rejects unsafe or invalid URLs: %s", async (url) => {
    expect((await call("POST", "/api/projects/clone", { url })).status).toBe(400);
  });

  it("allows file URLs only in the test environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await call("POST", "/api/projects/clone", { url: cloneUrl, name: "No local clone" })).status).toBe(400);
    expect(fs.existsSync(path.join(projectsRoot, "no-local-clone"))).toBe(false);
  });

  it("cancels its Git child and removes the partial clone on shutdown", async () => {
    const frames: Record<string, unknown>[] = [];
    const creation = new ProjectCreation(addProjectAt, (frame) => frames.push(frame));
    const { jobId, dir } = creation.clone({ url: cloneUrl, name: "Cancelled clone" });
    await creation.close();
    expect(creation.job(jobId)).toMatchObject({ status: "failed", error: expect.stringContaining("shutting down") });
    expect(frames.at(-1)).toMatchObject({ type: "project-job", status: "failed" });
    expect(fs.existsSync(dir)).toBe(false);
    expect(listProjects().some((p) => p.dir === dir)).toBe(false);
    expect(() => creation.clone({ url: cloneUrl })).toThrow("shutting down");
  });
});

describe("authorization", () => {
  it("refuses guests and scoped tokens on all three endpoints", async () => {
    const before = fs.readdirSync(projectsRoot);
    for (const auth of [scoped, guest]) {
      expect((await call("POST", "/api/projects/new", { name: "forbidden", agents: [{ kind: "echo" }] }, auth)).status).toBe(403);
      expect((await call("POST", "/api/projects/clone", { url: cloneUrl, name: "forbidden" }, auth)).status).toBe(403);
      expect((await call("GET", "/api/projects/jobs/missing", undefined, auth)).status).toBe(403);
    }
    expect(fs.readdirSync(projectsRoot)).toEqual(before);
    expect((await call("POST", "/api/projects/new", { name: "forbidden" }, "invalid-token")).status).toBe(401);
  });
});

describe("CLI", () => {
  it("creates from outside a project with repeated agent flags, models and counts", async () => {
    const { stdout } = await cli(["new", "CLI project", "--agent", "echo@firstx2", "echo", "--agent", "echo@second×2", "--no-git"]);
    const project = listProjects().find((p) => p.id === stdout.trim())!;
    expect(project.dir).toBe(path.join(projectsRoot, "cli-project"));
    expect(fs.existsSync(path.join(project.dir, ".git"))).toBe(false);
    expect(readProjectConfig(project.dir)!.agents.map((a) => [a.id, a.options?.model])).toEqual([
      ["echo", "first"], ["echo-2", "first"], ["echo-3", undefined], ["echo-4", "second"], ["echo-5", "second"],
    ]);
  });

  it("waits for a clone and prints its registered id", async () => {
    const { stdout } = await cli(["clone", cloneUrl, "--name", "CLI clone"]);
    expect(listProjects().find((p) => p.id === stdout.trim())).toMatchObject({ name: "CLI clone", dir: path.join(projectsRoot, "cli-clone") });
  });

  it("exits unsuccessfully for an invalid agent, duplicate destination, or clone failure", async () => {
    await expect(cli(["new", "bad cli", "--agent", "echox9"])).rejects.toThrow(/count must be/);
    await expect(cli(["new", "CLI project", "--agent", "echo"])).rejects.toThrow(/already exists/);
    const missing = pathToFileURL(path.join(tmpDir("cli-missing"), "missing.git")).href;
    await expect(cli(["clone", missing, "--name", "CLI failed"])).rejects.toThrow();
    expect(listProjects().some((p) => p.name === "CLI failed" || p.name === "bad cli")).toBe(false);
  });
});

describe("input normalization", () => {
  it("keeps paths under the root and bounds slugs", () => {
    expect(projectSlug("../../Hello---world_ A")).toBe("hello-world-a");
    expect(projectSlug("A".repeat(59) + "---B")).toBe("a".repeat(59));
    expect(projectSlug("A".repeat(100))).toHaveLength(60);
    expect(() => projectSlug("../ 💡")).toThrow();
  });

  it.each(["https://example.com/team/repo.git", "git@example.com:team/repo.git", "ssh://git@example.com/team/repo.git"])("accepts %s without starting a network clone", (url) => {
    expect(cloneSource(url)).toEqual({ url, name: "repo" });
  });

  it("parses a plain kind, a model, and either count separator", () => {
    expect(parseProjectAgent("echo")).toEqual({ kind: "echo" });
    expect(parseProjectAgent("echo@model")).toEqual({ kind: "echo", model: "model" });
    expect(parseProjectAgent("echox8")).toEqual({ kind: "echo", count: 8 });
    expect(parseProjectAgent("echo@model×2")).toEqual({ kind: "echo", model: "model", count: 2 });
    expect(() => parseProjectAgent("echo@")).toThrow();
  });
});
