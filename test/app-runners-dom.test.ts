/**
 * Loom Teams, Phase 5 ("runners") in the web app: Fleet's Runners and Deploys,
 * "Continue on runner" and a moved run on the orchestra card, the feed's new
 * sentences, and Settings → Team's "This machine as a runner" panel.
 *
 * The real APP_HTML in jsdom against a real daemon (the harness from
 * app-landing-dom.test.ts). The page's fetch answers /api/team, /orchestra,
 * /team/runners, /team/deploys, /team/release-notes and /api/runner with
 * canned answers — the hub's job table and the runner itself are
 * team-phase5.test.ts's job — and records what the page asks for.
 */

import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let baseUrl: string;
let adminToken: string;
let projectId: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-runners-dom");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  const cfg = readDaemonConfig()!;
  adminToken = cfg.adminToken;
  projectId = (await new DaemonClient(cfg).addProject(makeProjectDir({ name: "app" }))).project.id;
}, 30_000);

afterAll(async () => {
  await daemon.close();
});

const now = Date.now();
const TEAM = {
  signedIn: true,
  hub: "https://hub.example.com",
  github: "alice",
  device: "d-laptop",
  teams: [
    {
      id: "t1",
      name: "Acme",
      role: "owner",
      keyVersion: 1,
      members: [{ id: "u1", github: "alice", name: "Alice", role: "owner", devices: 2 }],
      repos: ["acme/app"],
      presence: [],
      leases: [],
      costs: null,
      feed: [
        { type: "goal_moved", github: "alice", meta: { runId: "r-run1", to: "alice's runner" }, content: { goal: "Add OAuth login" }, ts: now - 5000 },
        { type: "deploy_failed", github: "bob", meta: { environment: "production", sha: "abcdef1234", url: "https://github.com/acme/app/actions/runs/1", creator: "bob" }, ts: now - 4000 },
      ],
    },
  ],
};
const RUNNERS = [
  { deviceId: "d-box", userId: "u1", github: "alice", label: "alice-vps", kinds: ["claude-code", "codex"], shared: true, capacity: 2, lastSeen: now, mine: true, online: true },
  { deviceId: "d-bob", userId: "u2", github: "bob", label: "bob-home", kinds: ["codex"], shared: true, capacity: 1, lastSeen: now - 3_600_000, mine: false, online: false },
];
const JOBS = [
  {
    id: "j1", kind: "start", state: "claimed", github: "alice", runnerGithub: "alice", runnerId: "d-box", goal: "Speed up the build", runId: "r-moved",
    progress: { runId: "r-moved", goal: "Speed up the build", status: "running", tasks: [{ id: "t1", status: "done" }, { id: "t2", status: "running" }], costUsd: 0.42, landing: null, at: now },
    mine: true, createdAt: now - 60_000, updatedAt: now - 1000,
  },
  { id: "j2", kind: "fix", state: "failed", github: "alice", runnerId: "d-box", error: "clone failed: repository not found", goal: "Fix CI", runId: "r-x", progress: null, mine: true, createdAt: now - 90_000, updatedAt: now - 80_000 },
];
const run = (id: string, goal: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, goal, status,
  orchestrator: { agent: "claude-code", kind: "claude-code" },
  workers: [], tasks: [], round: 1, maxRounds: 4, maxParallel: 2,
  branch: `loom/orchestra/${id}/x`, baseBranch: "main", costUsd: 0.5,
  createdAt: now - 60_000, updatedAt: now, ...extra,
});
const RUNS = [
  run("r-run1", "Add OAuth login", "running"),
  run("r-moved", "Speed up the build", "moved", { movedTo: { where: "alice's runner", at: now - 30_000 } }),
];
const DEPLOYS = [
  { id: 7, environment: "production", sha: "abcdef1234567", ref: "main", creator: "bob", state: "failure", url: "https://github.com/acme/app/actions/runs/1", at: now - 4000 },
  { id: 6, environment: "staging", sha: "1234567abcdef", ref: "main", creator: "alice", state: "success", url: null, at: now - 90_000 },
];
const RUNNER_STATUS = {
  running: true, registered: true, token: true, lastError: null,
  config: { enabled: true, shared: false, capacity: 2, isolation: "docker", kinds: ["claude-code"] },
  active: [{ jobId: "j5", kind: "continue", repo: "acme/app", owner: "alice", runId: "r-5", project: "p5" }],
};
const PAIR_LINK = "loom-runner:eyJ2IjoxLCJodWIiOiJodHRwczovL2h1YiJ9";

interface Mounted {
  window: JSDOM["window"];
  errors: string[];
  posts: Array<{ path: string; body: unknown }>;
  gets: string[];
  close: () => void;
}

const live: Mounted[] = [];
afterEach(() => {
  while (live.length) live.pop()!.close();
});

/** Boot the app on the project; the team, runs, runners, deploys and this runner are canned. */
function mount(): Mounted {
  const errors: string[] = [];
  const posts: Mounted["posts"] = [];
  const gets: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  virtualConsole.on("error", (msg: string) => errors.push(String(msg)));
  const sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));

  const dom = new JSDOM(APP_HTML, {
    url: `${baseUrl}/app#p/${projectId}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof window.ResizeObserver;
      window.matchMedia = ((q: string) => ({
        matches: /min-width/.test(q),
        media: q,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia;
      window.fetch = ((input: string, init?: RequestInit) => {
        if (closed) return never;
        const url = new URL(String(input), baseUrl);
        const base = `/api/projects/${projectId}`;
        const get = !init?.method || init.method === "GET";
        const record = () => posts.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) });
        if (url.pathname === "/api/team" && get) return json(TEAM);
        if (url.pathname === `${base}/orchestra` && get) return json({ runs: RUNS, active: "r-run1" });
        if (url.pathname === `${base}/team/runners` && get) return json({ runners: RUNNERS, jobs: JOBS });
        if (url.pathname.startsWith(`${base}/team/runners/`) && init?.method === "POST") {
          record();
          return json({ result: { jobId: "j9" }, runners: RUNNERS, jobs: JOBS });
        }
        if (url.pathname === `${base}/team/deploys`) {
          gets.push(url.pathname + url.search);
          return json({ deployments: DEPLOYS });
        }
        if (url.pathname === `${base}/team/release-notes`) {
          gets.push(url.pathname + url.search);
          return json({ markdown: "## Since v1.2.0\n\n- Add OAuth login (#42)" });
        }
        if (url.pathname === "/api/runner" && get) return json(RUNNER_STATUS);
        if (url.pathname.startsWith("/api/runner/") && init?.method === "POST") {
          record();
          return json({ result: url.pathname.endsWith("/pair") ? { link: PAIR_LINK } : { ok: true } });
        }
        return fetch(url, init).then((r) => (closed ? never : r));
      }) as typeof window.fetch;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", adminToken);
    },
  });
  const m: Mounted = {
    window: dom.window,
    errors,
    posts,
    gets,
    close: () => {
      closed = true;
      for (const s of sockets) {
        try {
          s.removeAllListeners();
          s.on("error", () => {});
          s.terminate();
        } catch {
          /* already gone */
        }
      }
      dom.window.close();
    },
  };
  live.push(m);
  return m;
}

const $ = (m: Mounted, sel: string) => m.window.document.querySelector(sel);
const $$ = (m: Mounted, sel: string) => [...m.window.document.querySelectorAll(sel)];
const text = (m: Mounted, sel: string) => $(m, sel)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const ready = (m: Mounted, sel: string) =>
  waitUntil(() => !!($(m, sel) as (HTMLElement & { onclick?: unknown }) | null)?.onclick, { timeoutMs: 15_000 });
const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  (el as HTMLElement).dispatchEvent(new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }));
};
const type = (m: Mounted, sel: string, value: string) => {
  const el = $(m, sel) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new m.window.Event("input", { bubbles: true }));
};

describe("web app · runners (Phase 5)", () => {
  it("Fleet's Team block lists runners, jobs and the feed's new sentences; deploys and release notes on request", async () => {
    const m = mount();
    await ready(m, '.tab[data-tab="fleet"]');
    click($(m, '.tab[data-tab="fleet"]'));
    await waitUntil(() => $$(m, "#fteam .trunners [data-trunner]").length === 2, { timeoutMs: 15_000 });

    expect(text(m, "#fteam .trunners .tsech")).toContain("1/2 online");
    const vps = text(m, '#fteam [data-trunner="d-box"]');
    expect(vps).toContain("alice-vps");
    expect(vps).toContain("shared");
    expect(vps).toContain("yours · claude-code, codex · 2 at a time");
    expect($(m, '#fteam [data-trunner="d-box"] .odot.ok')).toBeTruthy();
    expect(text(m, '#fteam [data-trunner="d-bob"]')).toContain("bob’s · codex");
    expect($(m, '#fteam [data-trunner="d-bob"] .odot.off')).toBeTruthy();
    // jobs, newest first: state chip, goal, where, progress, error
    expect($$(m, "#fteam [data-tjob]").map((j) => j.getAttribute("data-tjob"))).toEqual(["j2", "j1"]);
    const j1 = text(m, '#fteam [data-tjob="j1"]');
    expect(j1).toContain("Start ‘Speed up the build’");
    expect(j1).toContain("on alice-vps");
    expect(j1).toContain("running · 1/2 tasks · $0.42");
    expect($(m, '#fteam [data-tjob="j1"] [data-jstate="claimed"]')).toBeTruthy();
    expect(text(m, '#fteam [data-tjob="j2"] small.err')).toBe("clone failed: repository not found");
    expect(text(m, '#fteam [data-tjob="j2"]')).toContain("CI fix");

    // the feed says it in sentences
    expect(text(m, '#fteam [data-tfeed="goal_moved"]')).toContain("alice moved ‘Add OAuth login’ to alice's runner");
    expect(text(m, '#fteam [data-tfeed="deploy_failed"]')).toContain("deploy of abcdef1 to production failed by bob");

    // deploys: nothing asked of GitHub until you ask
    expect(m.gets).toEqual([]);
    await ready(m, "#fteam [data-tdepload]");
    click($(m, "#fteam [data-tdepload]"));
    await waitUntil(() => $$(m, "#fteam [data-tdeploy]").length === 2, { timeoutMs: 15_000 });
    expect(text(m, '#fteam [data-tdeploy="7"]')).toContain("production abcdef1");
    expect($(m, '#fteam [data-tdeploy="7"] [data-dstate="failure"]')?.textContent).toBe("failed");
    expect($(m, '#fteam [data-tdeploy="7"] a')?.getAttribute("href")).toBe(DEPLOYS[0]!.url);
    expect($(m, '#fteam [data-tdeploy="6"] [data-dstate="success"]')?.textContent).toBe("deployed");

    // release notes since a tag
    type(m, "#fteam [data-trsince]", "v1.2.0");
    await ready(m, "#fteam [data-trnotes]");
    click($(m, "#fteam [data-trnotes]"));
    await waitUntil(() => !!$(m, "#fteam [data-trmd]"), { timeoutMs: 15_000 });
    expect(m.gets).toEqual([`/api/projects/${projectId}/team/deploys`, `/api/projects/${projectId}/team/release-notes?since=v1.2.0`]);
    expect($(m, "#fteam [data-trmd]")?.textContent).toContain("- Add OAuth login (#42)");
    expect(($(m, "#fteam [data-trsince]") as HTMLInputElement).value).toBe("v1.2.0");
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);

  it("a running goal continues on my runner; a moved one is read-only with Bring back and Land", async () => {
    const m = mount();
    let asked = "";
    m.window.confirm = (q?: string) => {
      asked = String(q);
      return true;
    };
    await ready(m, '.tab[data-tab="orchestra"]');
    click($(m, '.tab[data-tab="orchestra"]'));
    await ready(m, "#pane-orchestra #orunner");
    click($(m, "#pane-orchestra #orunner"));
    await waitUntil(() => m.posts.length === 1, { timeoutMs: 15_000 });
    expect(asked).toContain("Move this goal to alice-vps?");
    expect(m.posts[0]).toEqual({ path: `/api/projects/${projectId}/team/runners/continue`, body: { runId: "r-run1", runner: "d-box" } });

    // the moved run: a chip, the runner's progress, no Apply / Abort
    await ready(m, '#pane-orchestra .orun[data-run="r-moved"]');
    click($(m, '#pane-orchestra .orun[data-run="r-moved"]'));
    await ready(m, '#pane-orchestra [data-omove="land"]');
    expect(text(m, "#pane-orchestra [data-moved]")).toBe("moved to alice's runner");
    expect(text(m, "#pane-orchestra .omoved")).toContain("There: running · 1/2 tasks · $0.42");
    expect($(m, "#pane-orchestra #oapply")).toBeNull();
    expect($(m, "#pane-orchestra #oabort")).toBeNull();
    expect($(m, "#pane-orchestra #orunner")).toBeNull();
    click($(m, '#pane-orchestra [data-omove="land"]'));
    await waitUntil(() => m.posts.length === 2, { timeoutMs: 15_000 });
    expect(m.posts[1]).toEqual({ path: `/api/projects/${projectId}/team/runners/land`, body: { runId: "r-moved" } });
    await ready(m, '#pane-orchestra [data-omove="bring-back"]');
    click($(m, '#pane-orchestra [data-omove="bring-back"]'));
    await waitUntil(() => m.posts.length === 3, { timeoutMs: 15_000 });
    expect(m.posts[2]).toEqual({ path: `/api/projects/${projectId}/team/runners/bring-back`, body: { runId: "r-moved" } });
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);

  it("Settings → Team: this machine's runner status, and Pair a runner shows the link like a password", async () => {
    const m = mount();
    await ready(m, ".sfoot #setupbtn");
    click($(m, "#setupbtn"));
    await ready(m, '.setnav [data-sec="team"]');
    click($(m, '.setnav [data-sec="team"]'));
    await ready(m, "#setpane [data-trpair]");
    await waitUntil(() => text(m, "#setpane [data-trunpanel] .tpolh").includes("Running"), { timeoutMs: 15_000 });
    expect(text(m, "#setpane [data-trunpanel] .tpolh")).toContain("personal · 2 at a time · docker · claude-code");
    expect(text(m, '#setpane [data-tractive="j5"]')).toContain("Continue · acme/app for alice");
    expect($(m, "#setpane [data-trstop]")).toBeTruthy();
    expect(text(m, "#setpane .trsw")).toContain("runners.shared");
    // my runners, revocable; a teammate's isn't listed
    await waitUntil(() => !!$(m, '#setpane [data-trrevoke="d-box"]'), { timeoutMs: 15_000 });
    expect($(m, '#setpane [data-trmine="d-bob"]')).toBeNull();

    click($(m, "#setpane [data-trpair]"));
    await waitUntil(() => !!$(m, "#setpane [data-trpairbox] .tinvlink"), { timeoutMs: 15_000 });
    expect(($(m, "#setpane [data-trpairbox] .tinvlink") as HTMLInputElement).value).toBe(PAIR_LINK);
    expect(text(m, "#setpane [data-trpairbox]")).toContain("send it like a password");
    expect(text(m, "#setpane [data-trpairbox]")).toContain("loom runner join");
    expect(m.posts).toEqual([{ path: "/api/runner/pair", body: {} }]);
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);
});
