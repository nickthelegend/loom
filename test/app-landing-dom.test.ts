/**
 * Loom Teams, Phase 4 ("land safely") in the web app: a goal PR's landing
 * state on its orchestra run card, Land, and Settings → Team's landing doctor.
 *
 * The real APP_HTML in jsdom against a real daemon (the harness from
 * app-team-brain-dom.test.ts). The page's fetch answers GET /orchestra with a
 * finished run carrying a canned LandingState, and /team/landing/:action and
 * /team/doctor with canned answers — the landing loop itself (gh, git, the
 * review) is team-landing.test.ts's job — and records what the page POSTs.
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
  process.env.LOOM_HOME = tmpDir("home-landing-dom");
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

const LANDING = {
  pr: 42,
  url: "https://github.com/acme/app/pull/42",
  state: "failing",
  headSha: "abc123",
  fixAttempts: 1,
  reruns: [],
  flaky: ["lint"],
  checks: { failing: ["test (ubuntu)"], pending: [], passing: 3 },
  reviews: 1,
  review: { state: "failure", reviewer: "codex", high: 2, findings: 3, at: Date.now() },
  updatedAt: Date.now(),
};
const RUN = {
  id: "r-land1",
  goal: "Add OAuth login",
  status: "completed",
  orchestrator: { agent: "claude-code", kind: "claude-code" },
  workers: [],
  tasks: [],
  round: 1,
  maxRounds: 4,
  maxParallel: 2,
  branch: "loom/orchestra/r-land1/add-oauth",
  baseBranch: "main",
  costUsd: 1.25,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now(),
  delivered: { mode: "pr", prUrl: "https://github.com/acme/app/pull/42", at: Date.now() },
  landing: LANDING,
};
const DOCTOR = {
  repo: "acme/app",
  branch: "main",
  findings: [
    { level: "ok", what: "main requires status checks" },
    { level: "warn", what: "no merge queue on main", fix: "Turn on the merge queue in the branch ruleset" },
    { level: "error", what: ".github/workflows/ci.yml doesn't run on merge_group", fix: "Add merge_group: to its triggers" },
  ],
  fixable: [".github/workflows/ci.yml"],
};

interface Mounted {
  window: JSDOM["window"];
  errors: string[];
  posts: Array<{ path: string; body: unknown }>;
  close: () => void;
}

const live: Mounted[] = [];
afterEach(() => {
  while (live.length) live.pop()!.close();
});

/** Boot the app on the project; the orchestra run, landing actions and doctor are canned. */
function mount(): Mounted {
  const errors: string[] = [];
  const posts: Mounted["posts"] = [];
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
        if (url.pathname === `${base}/orchestra` && (!init?.method || init.method === "GET")) return json({ runs: [RUN], active: null });
        if (url.pathname.startsWith(`${base}/team/landing/`) && init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}"));
          posts.push({ path: url.pathname, body });
          const landing = { ...LANDING, state: "landing", landRequested: true };
          return json({ result: landing, goals: [{ runId: RUN.id, goal: RUN.goal, status: RUN.status, costUsd: 0, landing }] });
        }
        if (url.pathname === `${base}/team/doctor`) return json(DOCTOR);
        if (url.pathname === `${base}/team/doctor/fix` && init?.method === "POST") {
          posts.push({ path: url.pathname, body: JSON.parse(String(init.body ?? "{}")) });
          return json({ prUrl: "https://github.com/acme/app/pull/9", files: [".github/workflows/ci.yml"] });
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


describe("web app · landing safely (Phase 4)", () => {
  it("a run's card shows its PR's landing state, and Land posts the run id", async () => {
    const m = mount();
    m.window.confirm = () => true; // failing, so Land asks first
    await ready(m, '.tab[data-tab="orchestra"]');
    click($(m, '.tab[data-tab="orchestra"]'));
    await waitUntil(() => !!$(m, '#pane-orchestra .oland [data-oland-act="land"]'), { timeoutMs: 15_000 });

    const card = text(m, "#pane-orchestra .oland");
    expect($(m, '#pane-orchestra .oland [data-lstate="failing"]')?.textContent).toBe("failing");
    expect($(m, "#pane-orchestra .oland a")?.getAttribute("href")).toBe(LANDING.url);
    expect(card).toContain("PR #42");
    expect(card).toContain("test (ubuntu)");
    expect(card).toContain("Flaky (passed on rerun): lint");
    expect(card).toContain("loom/review: 2 high findings of 3");
    expect(card).toContain("1 fix attempt");
    expect($(m, '#pane-orchestra .oland [data-oland-act="review"]')).toBeTruthy();
    expect($(m, '#pane-orchestra .oland [data-oland-act="override"]')).toBeTruthy();
    // the runs list carries the chip too
    expect($(m, '#pane-orchestra .orun [data-lstate="failing"]')).toBeTruthy();

    click($(m, '#pane-orchestra .oland [data-oland-act="land"]'));
    await waitUntil(() => !!$(m, '#pane-orchestra .oland [data-lstate="landing"]'), { timeoutMs: 15_000 });
    expect(m.posts).toEqual([{ path: `/api/projects/${projectId}/team/landing/land`, body: { runId: RUN.id } }]);
    expect($(m, '#pane-orchestra .oland [data-oland-act="land"]'), "no second Land while landing").toBeNull();
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);

  it("Settings → Team runs the landing doctor, lists findings, and opens the fix PR", async () => {
    const m = mount();
    await ready(m, ".sfoot #setupbtn");
    click($(m, "#setupbtn"));
    await ready(m, '.setnav [data-sec="team"]');
    click($(m, '.setnav [data-sec="team"]'));
    await ready(m, "#setpane [data-tdocrun]");
    expect($(m, "#setpane [data-tdocfix]")).toBeNull();
    click($(m, "#setpane [data-tdocrun]"));
    await waitUntil(() => $$(m, "#setpane .tdocf").length === 3, { timeoutMs: 15_000 });

    expect($$(m, "#setpane .tdocf").map((f) => f.getAttribute("data-tdocf"))).toEqual(["ok", "warn", "error"]);
    expect(text(m, '#setpane .tdocf[data-tdocf="warn"]')).toContain("Turn on the merge queue");
    expect(text(m, "#setpane .tdoc .tpolh")).toContain("acme/app · main");

    await ready(m, "#setpane [data-tdocfix]");
    click($(m, "#setpane [data-tdocfix]"));
    await waitUntil(() => !!$(m, "#setpane .tdocpr a"), { timeoutMs: 15_000 });
    expect($(m, "#setpane .tdocpr a")?.getAttribute("href")).toBe("https://github.com/acme/app/pull/9");
    expect(m.posts).toEqual([{ path: `/api/projects/${projectId}/team/doctor/fix`, body: {} }]);
    expect($(m, "#setpane [data-tdocfix]"), "the fix is open; no second PR").toBeNull();
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);
});
