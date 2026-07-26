/**
 * The install surfaces, over a real daemon: the MCP catalog and its install /
 * uninstall routes, and the skill catalog and its install / remove routes.
 *
 * These test persistence and refusal, which is what the UI actually depends on
 * — that a server it installed is in config.json on the next read, and that the
 * shapes which used to be allowed (a "server" with no url) now come back as a
 * 400 with a sentence rather than a row that can never connect.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearCatalogCache } from "../src/core/mcp-catalog.js";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let baseUrl: string;
let token: string;
let projectId: string;
let projectDir: string;
/** A stand-in registry, so the suite never calls the public one. */
let registry: http.Server;
let registryQueries: string[] = [];

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const get = async (p: string) => (await fetch(`${baseUrl}${p}`, { headers: H() })).json();

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";

  // A local registry rather than the real one. Not just for speed: a unit suite
  // that reaches the public registry is one that fails on a plane, and one whose
  // assertions depend on what somebody else published this week.
  registry = http.createServer((req, res) => {
    registryQueries.push(String(req.url));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        servers: [
          {
            server: {
              name: "app.linear/linear",
              title: "Linear",
              description: "Issues, projects, cycles",
              version: "1.0.0",
              remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }],
            },
            _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
          },
          // Not installable: no remote, no package. Must not reach the caller.
          { server: { name: "app.example/hollow", title: "Hollow", remotes: null, packages: null } },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  const addr = registry.address();
  process.env.LOOM_MCP_REGISTRY = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v0/servers`;
  clearCatalogCache();

  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  const client = new DaemonClient(readDaemonConfig()!);
  projectDir = makeProjectDir({ name: "catalog" });
  projectId = (await client.addProject(projectDir)).project.id;
});
afterAll(async () => {
  await daemon.close();
  await new Promise<void>((resolve) => registry.close(() => resolve()));
  delete process.env.LOOM_MCP_REGISTRY;
  clearCatalogCache();
});

describe("GET /api/mcp/catalog", () => {
  it("serves the registry's installable entries alongside the curated shelf", async () => {
    registryQueries = [];
    const body = (await get("/api/mcp/catalog?q=linear&limit=5")) as {
      servers: Array<{ id: string; title: string; transport: string; url?: string; command?: string }>;
      featured: Array<{ slug: string; url?: string; command?: string; needsUrl?: boolean }>;
      degraded: boolean;
    };
    expect(body.degraded).toBe(false);
    expect(registryQueries[0]).toContain("search=linear");
    // The hollow entry — a name with nothing behind it — never becomes a row.
    expect(body.servers.map((s) => s.id)).toEqual(["app.linear/linear"]);
    for (const s of body.servers) expect(Boolean(s.url) || Boolean(s.command)).toBe(true);

    expect(body.featured.map((f) => f.slug)).toEqual(expect.arrayContaining(["github", "linear", "signoz"]));
    for (const f of body.featured) {
      expect(Boolean(f.url) || Boolean(f.command) || f.needsUrl === true).toBe(true);
    }
  });
});

describe("POST /api/projects/:id/mcps/install", () => {
  it("persists a remote server to config.json and reports a measured connected state", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/mcps/install`, {
      method: "POST",
      headers: H(),
      // 127.0.0.1:1 has nothing listening, which is the point: it saves, and it
      // reports connected:false rather than inferring "connected" from a string.
      body: JSON.stringify({ name: "Probe Me", url: "http://127.0.0.1:1/mcp", transport: "http" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installed: { name: string; connected: boolean } | null };
    expect(body.installed?.name).toBe("Probe Me");
    expect(body.installed?.connected).toBe(false);

    const saved = readProjectConfig(projectDir)!.mcps?.find((m) => m.name === "Probe Me");
    expect(saved?.url).toBe("http://127.0.0.1:1/mcp");
    expect(saved?.enabledForSession).toBe(true);
  });

  it("persists a stdio server with its command and args", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/mcps/install`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ name: "Playwright", command: "npx", args: ["@playwright/mcp@latest"], transport: "stdio", slug: "playwright" }),
    });
    expect(res.status).toBe(200);
    const saved = readProjectConfig(projectDir)!.mcps?.find((m) => m.name === "Playwright");
    expect(saved?.command).toBe("npx");
    expect(saved?.args).toEqual(["@playwright/mcp@latest"]);
    expect(saved?.slug).toBe("playwright");
  });

  it("rejects a server with neither a url nor a command", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/mcps/install`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ name: "Nothing At All", transport: "http" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/neither a url nor a command/);
    expect(readProjectConfig(projectDir)!.mcps?.some((m) => m.name === "Nothing At All")).toBeFalsy();
  });

  it("rejects a nameless server and a url that isn't http(s)", async () => {
    const nameless = await fetch(`${baseUrl}/api/projects/${projectId}/mcps/install`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ url: "https://mcp.example.com/mcp" }),
    });
    expect(nameless.status).toBe(400);

    const scheme = await fetch(`${baseUrl}/api/projects/${projectId}/mcps/install`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ name: "Weird", url: "ftp://mcp.example.com" }),
    });
    expect(scheme.status).toBe(400);
  });
});

describe("DELETE /api/projects/:id/mcps/:name", () => {
  it("removes an installed server from config.json, and 404s for one that isn't there", async () => {
    await fetch(`${baseUrl}/api/projects/${projectId}/mcps/install`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ name: "Temporary", url: "http://127.0.0.1:1/mcp" }),
    });
    expect(readProjectConfig(projectDir)!.mcps?.some((m) => m.name === "Temporary")).toBe(true);

    const del = await fetch(`${baseUrl}/api/projects/${projectId}/mcps/Temporary`, { method: "DELETE", headers: H() });
    expect(del.status).toBe(200);
    expect(readProjectConfig(projectDir)!.mcps?.some((m) => m.name === "Temporary")).toBe(false);

    const again = await fetch(`${baseUrl}/api/projects/${projectId}/mcps/Temporary`, { method: "DELETE", headers: H() });
    expect(again.status).toBe(404);
  });
});

describe("skills catalog + install", () => {
  it("lists discoverable skills with an origin, and marks the project's own as installed", async () => {
    // Bring our own skill rather than asserting against whatever happens to be
    // in the machine's ~/.claude. This used to pass only on a developer who had
    // skills installed, and said nothing at all on a clean checkout or in CI.
    const src = path.join(tmpDir("catskill"), "catalogued");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: catalogued\ndescription: listed here\n---\n\nbody\n");
    await fetch(`${baseUrl}/api/projects/${projectId}/skills/install`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ dir: src }),
    });

    const body = (await get(`/api/projects/${projectId}/skills/catalog`)) as {
      skills: Array<{ id: string; origin: string; installed: boolean; source: string }>;
    };
    const mine = body.skills.find((s) => s.id === "catalogued");
    expect(mine, "the skill we just installed should be in the catalog").toBeDefined();
    expect(mine!.installed).toBe(true); // this project put it there, so it's ours
    expect(mine!.origin).toBe("project");
    // Every row says where it came from — the catalog is a list of real files.
    expect(body.skills.every((s) => typeof s.source === "string" && s.source.length > 0)).toBe(true);

    await fetch(`${baseUrl}/api/projects/${projectId}/skills/catalogued`, { method: "DELETE", headers: H() });
  });

  it("installs a skill from a directory, then removes it", async () => {
    const src = path.join(tmpDir("srcskill"), "installed-here");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: installed-here\ndescription: from a dir\n---\n\nbody\n");

    const res = await fetch(`${baseUrl}/api/projects/${projectId}/skills/install`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ dir: src }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skill: { id: string; from: string };
      skills: Array<{ id: string; installed: boolean; origin: string }>;
    };
    expect(body.skill.id).toBe("installed-here");
    expect(body.skill.from).toBe("dir");
    const row = body.skills.find((s) => s.id === "installed-here")!;
    expect(row.installed).toBe(true);
    expect(row.origin).toBe("project");
    expect(fs.existsSync(path.join(projectDir, "skills", "installed-here", "SKILL.md"))).toBe(true);

    const del = await fetch(`${baseUrl}/api/projects/${projectId}/skills/installed-here`, { method: "DELETE", headers: H() });
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(projectDir, "skills", "installed-here"))).toBe(false);
  });

  it("400s on a git URL that isn't one, on empty input, and on both at once", async () => {
    const post = (body: unknown) =>
      fetch(`${baseUrl}/api/projects/${projectId}/skills/install`, { method: "POST", headers: H(), body: JSON.stringify(body) });

    const notGit = await post({ gitUrl: "ext::sh -c 'touch /tmp/loom-pwned'" });
    expect(notGit.status).toBe(400);
    expect(((await notGit.json()) as { error: string }).error).toMatch(/not a git URL/);
    expect(fs.existsSync("/tmp/loom-pwned")).toBe(false);

    expect((await post({})).status).toBe(400);
    expect((await post({ gitUrl: "https://example.com/x.git", dir: "/tmp" })).status).toBe(400);
  });

  it("refuses to delete a skill that lives outside the project", async () => {
    // A skill in a shared root belongs to the user, not to this project — a
    // project-scoped Remove that reached out and deleted it would be data loss
    // dressed as a feature. Stage one in a root of our own rather than reaching
    // for whatever is in the developer's ~/.claude, so the refusal is tested
    // against a file we control and the test says the same thing on any machine.
    const home = tmpDir("claudehome");
    const outside = path.join(home, "skills", "not-yours");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "SKILL.md"), "---\nname: not-yours\ndescription: the user's own\n---\n\nbody\n");
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      const body = (await get(`/api/projects/${projectId}/skills/catalog`)) as {
        skills: Array<{ id: string; installed: boolean }>;
      };
      const foreign = body.skills.find((s) => s.id === "not-yours");
      expect(foreign, "the skill outside the project should still be discoverable").toBeDefined();
      expect(foreign!.installed).toBe(false); // discoverable, but not ours to delete

      const del = await fetch(`${baseUrl}/api/projects/${projectId}/skills/not-yours`, { method: "DELETE", headers: H() });
      expect(del.status).toBe(400);
      expect(((await del.json()) as { error: string }).error).toMatch(/outside this project/);
      // and it is still on disk, which is the whole point of the refusal
      expect(fs.existsSync(path.join(outside, "SKILL.md"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it("404-shaped 400s for a skill id that does not exist at all", async () => {
    const del = await fetch(`${baseUrl}/api/projects/${projectId}/skills/no-such-skill`, { method: "DELETE", headers: H() });
    expect(del.status).toBe(400);
    expect(((await del.json()) as { error: string }).error).toMatch(/no skill/);
  });
});
