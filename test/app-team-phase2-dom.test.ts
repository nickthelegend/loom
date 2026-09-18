/**
 * Loom Teams, Phase 2 ("stop colliding") in the web app, actually executed.
 *
 * The real APP_HTML in jsdom against a real daemon, a real `loom hub` and a
 * second member — bob, an in-process TeamLink with his own clone (the pattern
 * from app-team-dom.test.ts). Origin carries a reviewed `loom.team.json`.
 * Leases, overlap decisions, zone waits and drift come from the real team
 * coordinators admitting tasks on both sides; the page is alice.
 *
 * Alice's project also opens with an orchestra run on disk that waits on her
 * (a run file written before the runtime opens — how a daemon restart finds
 * it), whose pending tasks each carry one kind of team hold.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { OrchestraRun, OrchestraTask } from "../src/core/orchestra.js";
import { readDaemonConfig, writeProjectConfig } from "../src/core/registry.js";
import type { Lease } from "../src/core/team-hub.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { DaemonClient } from "../src/daemon/client.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { TeamCoordinator } from "../src/daemon/team-coordinator.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import { tmpDir, waitUntil } from "./helpers.js";

const SECRET = "s3cret";
const POLICY = {
  hardZones: ["db/migrations/**"],
  permissions: { ceiling: "auto", bypassRequiresPlan: true },
  agents: { allow: ["echo", "claude-code"] },
  delivery: { protected: ["main"] },
  orchestra: { maxParallelPerMember: 6, teamMaxConcurrentAgents: 20 },
};
let hub: Awaited<ReturnType<typeof startHubServer>>;
let daemon: LoomDaemon;
let baseUrl: string;
let adminToken: string;
let projectId: string;
let origin: string;
let teamId: string;
let aliceRt: ProjectRuntime;
let bob: { link: TeamLink; rt: ProjectRuntime; coord: TeamCoordinator } | null = null;

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

function cloneAs(name: string): string {
  const dir = tmpDir(`team2-dom-${name}`);
  git(path.dirname(dir), "clone", "-q", origin, dir);
  git(dir, "remote", "set-url", "origin", "git@github.com:acme/app.git");
  git(dir, "config", "user.email", `${name}@t`);
  git(dir, "config", "user.name", name);
  writeProjectConfig(dir, {
    name: `app-${name}`,
    agents: [{ id: "alpha", kind: "echo", role: "worker" }, { id: "conductor", kind: "echo", role: "orchestrator" }],
    brain: { extractor: "off" },
  });
  return dir;
}

const HELD = "oheld1";
const since = Date.now() - 3 * 60_000;
function task(id: string, title: string, extra: Partial<OrchestraTask>): OrchestraTask {
  return {
    id, title, prompt: "p", agent: "alpha", kind: "echo", dependsOn: [], status: "pending",
    chat: "main", attempts: 0, queued: [], ...extra,
  } as OrchestraTask;
}
/** A run that waits on alice, one pending task per kind of team hold. */
function heldRun(dir: string): OrchestraRun {
  return {
    id: HELD, goal: "Harden the session layer", orchestrator: { agent: "conductor", kind: "echo" }, workers: ["alpha"],
    status: "waiting_human", question: "Which first?", chat: "main", baseBranch: "main", baseCommit: "HEAD",
    branch: `loom/orchestra/${HELD}/main`, dir, round: 1, maxRounds: 10, maxParallel: 4, costUsd: 0,
    createdAt: Date.now() - 600_000, updatedAt: Date.now(),
    notes: ["t1 edited src/sessions.ts outside its declared touches, overlapping bob's goal 'Tweak sessions' (oB1)."],
    tasks: [
      task("t-decide", "Rename the cookie", {
        touches: ["docs/shared.md"],
        hold: { kind: "decide", reason: "t-decide overlaps a teammate's work: bob's goal 'Tweak sessions' (oB1) holds docs/shared.md", since },
      }),
      task("t-wait", "Move sessions to redis", {
        touches: ["src/sessions.ts"], overlap: "wait:oB1",
        hold: { kind: "wait", reason: "waiting for goal oB1's PR to merge — its PR is open", runId: "oB1", since },
      }),
      task("t-zone", "Add the sessions table", {
        touches: ["db/migrations/**"],
        hold: { kind: "zone", reason: "db/migrations/** is a hard zone held by bob's goal (oB1) — starts when it's released", zone: "db/migrations/**", holder: "bob", since },
      }),
      task("t-cap", "Load-test it", {
        touches: ["bench/**"],
        hold: { kind: "capacity", reason: "the team is at its limit of 20 running agents (team policy) — starts when one finishes", since },
      }),
      task("t-go", "Document the store", {
        status: "done", touches: ["docs/**", "README.md", "src/sessions.ts", "src/cookies.ts", "src/store.ts"], overlap: "proceed:one-line change",
      }),
    ],
  } as OrchestraRun;
}

async function team<T = { result: unknown }>(action: string, body: unknown): Promise<T> {
  const r = await fetch(`${baseUrl}/api/team/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

/** Just enough of a run and a task for a coordinator to admit it. */
function fakeRun(id: string, goal: string, dir: string): OrchestraRun {
  return { id, goal, dir, tasks: [], status: "running" } as unknown as OrchestraRun;
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-team2-dom");
  process.env.LOOM_NO_NOTIFY = "1";
  hub = await startHubServer({ port: 0, secret: SECRET });

  origin = tmpDir("team2-dom-origin");
  git(origin, "init", "-q", "-b", "main");
  const put = (f: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(origin, f)), { recursive: true });
    fs.writeFileSync(path.join(origin, f), body);
  };
  put("README.md", "# app\n");
  put(".gitignore", ".loom/\n");
  put("loom.team.json", JSON.stringify(POLICY, null, 2));
  put("docs/shared.md", "shared\n");
  put("src/sessions.ts", "export {};\n");
  put("src/ui/button.tsx", "export {};\n");
  put("db/migrations/001.sql", "-- 1\n");
  git(origin, "add", "-A");
  git(origin, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "seed");

  const aliceDir = cloneAs("alice");
  // on disk before the runtime opens, as a daemon restart would find it
  fs.mkdirSync(path.join(aliceDir, ".loom", "orchestra"), { recursive: true });
  fs.writeFileSync(path.join(aliceDir, ".loom", "orchestra", `${HELD}.json`), JSON.stringify(heldRun(aliceDir)));

  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  const cfg = readDaemonConfig()!;
  adminToken = cfg.adminToken;
  projectId = (await new DaemonClient(cfg).addProject(aliceDir)).project.id;
  aliceRt = await (daemon as unknown as { runtime(id: string): Promise<ProjectRuntime> }).runtime(projectId);

  // alice: signed in, a team, this project shared, and an invite for bob
  await team("signin", { hub: hub.url, github: "alice", secret: SECRET });
  const created = await team<{ result: { id: string } }>("create", { name: "Acme" });
  teamId = created.result.id;
  const share = await fetch(`${baseUrl}/api/projects/${projectId}/team/share`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(share.ok).toBe(true);
  const { result: inv } = await team<{ result: { link: string } }>("invite", { teamId });

  const rt = await ProjectRuntime.open({ id: "p-bob", name: "app-bob", dir: cloneAs("bob") });
  const link = new TeamLink({ runtimes: () => [rt], broadcast: () => {}, statePath: path.join(tmpDir("teamstate2-bob"), "team.json") });
  await link.join(inv.link, { github: "bob", secret: SECRET });
  bob = { link, rt, coord: link.coordinatorFor(rt) };

  // Leases, from the real coordinators. alice: the sessions area, and the migrations hard zone.
  const aliceCoord = daemon.team.coordinatorFor(aliceRt);
  const aliceRun = fakeRun("oA1", "Rework sessions", aliceRt.info.dir);
  expect(await aliceCoord.admit(aliceRun, task("t1", "Split the session store", { touches: ["docs/**", "src/sessions.ts"] }))).toMatchObject({ go: true });
  expect(await aliceCoord.admit(aliceRun, task("t2", "Add a sessions migration", { touches: ["db/migrations/**"] }))).toMatchObject({ go: true });

  // bob: a goal that overlaps alice's and says why it's fine (D29) ...
  const bRun = fakeRun("oB1", "Tweak sessions", rt.info.dir);
  const bT1 = task("t1", "Reword the sessions doc", { touches: ["docs/shared.md"], overlap: "proceed:one-line change" });
  expect(await bob.coord.admit(bRun, bT1)).toMatchObject({ go: true });
  // ... one queued behind alice's hard zone (D31) ...
  const zoned = await bob.coord.admit(bRun, task("m1", "Drop the old table", { touches: ["db/migrations/**"] }));
  expect(zoned).toMatchObject({ go: false, hold: { kind: "zone", holder: "alice" } });
  // ... a goal whose task is done and waits for its PR (landing, D36) ...
  const bRun2 = fakeRun("oB2", "Restyle buttons", rt.info.dir);
  expect(await bob.coord.admit(bRun2, task("t3", "New button styles", { touches: ["src/ui/**"] }))).toMatchObject({ go: true });
  const bobHub = (link as unknown as { hub(): { setRunLeaseState(t: string, r: string, s: string): Promise<number>; releaseLeases(t: string, r: string, why: string): Promise<number> } }).hub();
  await bobHub.setRunLeaseState(teamId, "oB2", "landing");
  // ... one from a laptop that went to sleep (stale, D12) ...
  const bRun3 = fakeRun("oB3", "Readme polish", rt.info.dir);
  expect(await bob.coord.admit(bRun3, task("t4", "Tidy the readme", { touches: ["README.md"] }))).toMatchObject({ go: true });
  const staleId = (bob.coord as unknown as { leaseIds: Map<string, string> }).leaseIds.get("oB3/t4")!;
  const mem = hub.hub as unknown as { leasesByTeam: Map<string, Map<string, Lease>>; emit(t: string, e: unknown): void; withStale(l: Lease): Lease };
  const sl = mem.leasesByTeam.get(teamId)!.get(staleId)!;
  sl.ts -= 11 * 60_000; // the hub's clock says nobody renewed it for 11 minutes
  mem.emit(teamId, { type: "lease", teamId, lease: mem.withStale(sl) });
  // ... and one that landed: its PR merged, its leases released
  expect(await bob.coord.admit(fakeRun("oB9", "Ship icons", rt.info.dir), task("t9", "Icons", { touches: ["assets/**"] }))).toMatchObject({ go: true });
  expect(await bobHub.releaseLeases(teamId, "oB9", "PR #9 merged")).toBe(1);

  // drift: bob's t1 edits a file it never declared, one alice holds (D33)
  bob.coord.onEdit(bRun, bT1, "src/sessions.ts");
  // a merge-tree prediction, posted the way the coordinator posts it (D34)
  await (bob.coord as unknown as { post(t: string, k: string, e: unknown): Promise<void> }).post(teamId, "conflict:test", {
    type: "conflict_predicted",
    repo: "acme/app",
    meta: { runs: ["oB1", "oA1"], members: ["bob", "alice"], files: ["docs/shared.md"] },
  });
  await waitUntil(() => (daemon.team.status().teams[0]?.feed ?? []).some((e) => e.type === "drift"), { timeoutMs: 15_000 });
}, 60_000);

const live: Mounted[] = [];
afterEach(() => {
  while (live.length) live.pop()!.close();
});

afterAll(async () => {
  if (bob) {
    await bob.link.stop();
    await bob.rt.close();
  }
  await daemon.close();
  await hub.close();
});

interface Mounted {
  window: JSDOM["window"];
  errors: string[];
  confirms: string[];
  close: () => void;
}

/** Boot the app in a DOM, against the real daemon, on alice's project (see app-team-dom.test.ts). */
function mount({ desktop = true } = {}): Mounted {
  const errors: string[] = [];
  const confirms: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  virtualConsole.on("error", (msg: string) => errors.push(String(msg)));
  const sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});

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
        matches: /min-width/.test(q) ? desktop : false,
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
        return fetch(new URL(String(input), baseUrl), init).then((r) => (closed ? never : r));
      }) as typeof window.fetch;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", adminToken);
      window.confirm = (msg?: string) => {
        confirms.push(String(msg));
        return true;
      };
    },
  });
  const m: Mounted = {
    window: dom.window,
    errors,
    confirms,
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
  waitUntil(() => !!($(m, sel) as (HTMLElement & { onclick?: unknown }) | null)?.onclick);
const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  (el as HTMLElement).dispatchEvent(new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }));
};
const noLeak = (s: string) => {
  for (const leak of ["{", "}", '"type"', "[object Object]", "undefined", "null", "NaN"]) expect(s, `raw payload leaked: ${leak}`).not.toContain(leak);
};

async function openTab(m: Mounted, tab: string, sel: string) {
  await ready(m, `.tab[data-tab="${tab}"]`);
  click($(m, `.tab[data-tab="${tab}"]`));
  await waitUntil(() => !!$(m, sel), { timeoutMs: 15_000 });
}

describe("web app · Loom Teams, Phase 2", () => {
  it("task cards show the files they declared, the overlap decision, and a banner per hold kind", async () => {
    const m = mount();
    await openTab(m, "orchestra", `#pane-orchestra .otask[data-otask="t-cap"]`);
    const card = (id: string) => $(m, `#pane-orchestra .otask[data-otask="${id}"]`)!;

    // decide: amber, the orchestrator owes an answer
    const decide = card("t-decide").querySelector(".ohold")!;
    expect(decide.getAttribute("data-ohold")).toBe("decide");
    expect(decide.classList.contains("warn")).toBe(true);
    expect(decide.textContent).toContain("Needs the orchestrator: t-decide overlaps a teammate's work");

    // wait: cyan, the teammate's goal by name (from the team's leases), and a way out
    const wait = card("t-wait").querySelector(".ohold")!;
    expect(wait.getAttribute("data-ohold")).toBe("wait");
    expect(wait.classList.contains("live")).toBe(true);
    await waitUntil(() => (card("t-wait").querySelector(".ohold")?.textContent ?? "").includes("Tweak sessions"));
    expect(text(m, '.otask[data-otask="t-wait"] .oht')).toMatch(/^Waiting for bob’s PR for ‘Tweak sessions’…/);
    expect(text(m, '.otask[data-otask="t-wait"] .oht small')).toBe("its PR is open");
    expect(card("t-wait").querySelector("[data-ostopwait]")?.textContent).toBe("Stop waiting");
    expect(text(m, '.otask[data-otask="t-wait"] .ovl')).toBe("waits for Tweak sessions");

    // zone: amber, a lock, whose zone
    const zone = card("t-zone").querySelector(".ohold")!;
    expect(zone.getAttribute("data-ohold")).toBe("zone");
    expect(zone.classList.contains("warn")).toBe(true);
    expect(zone.querySelector(".ohi svg rect")).toBeTruthy(); // the lock
    expect(text(m, '.otask[data-otask="t-zone"] .oht')).toMatch(/^Queued behind bob’s hard zone db\/migrations\/\*\*/);
    expect(text(m, '.otask[data-otask="t-zone"] .oht small')).toBe("starts when it's released");

    // capacity: neutral
    const cap = card("t-cap").querySelector(".ohold")!;
    expect(cap.getAttribute("data-ohold")).toBe("capacity");
    expect(cap.classList.contains("warn") || cap.classList.contains("live")).toBe(false);
    expect(cap.textContent).toContain("the team is at its limit of 20 running agents");

    // a done task: no banner; its touches as chips (4, then +1), its overlap decision
    const done = card("t-go");
    expect(done.querySelector(".ohold")).toBeNull();
    expect([...done.querySelectorAll(".otouch .tglob")].map((g) => g.textContent)).toEqual(["docs/**", "README.md", "src/sessions.ts", "src/cookies.ts", "+1 more"]);
    expect(done.querySelector(".ovl")?.textContent).toBe("proceeds: one-line change");
    // the team's notes for the orchestrator's next review
    expect(text(m, "#pane-orchestra .onotes")).toContain("t1 edited src/sessions.ts outside its declared touches");
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);

  it("Stop waiting asks first, then releases the wait on the daemon", async () => {
    const m = mount();
    await openTab(m, "orchestra", '#pane-orchestra [data-ostopwait="t-wait"]');
    await ready(m, '#pane-orchestra [data-ostopwait="t-wait"]');
    click($(m, '#pane-orchestra [data-ostopwait="t-wait"]'));
    expect(m.confirms.length).toBe(1);
    expect(m.confirms[0]).toContain("t-wait starts now");
    await waitUntil(() => !$(m, '.otask[data-otask="t-wait"] .ohold'), { timeoutMs: 10_000 });
    const t = aliceRt.orchestra.get(HELD)!.tasks.find((x) => x.id === "t-wait")!;
    expect(t.hold).toBeUndefined();
    expect(t.overlap).toMatch(/^proceed:the owner stopped waiting on oB1/);
    expect(text(m, '.otask[data-otask="t-wait"] .ovl')).toMatch(/^proceeds: the owner stopped waiting on oB1/);
    // the thread doesn't open behind the button
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);

  it("renders task_held, synced and delivery_policy in the thread as sentences", async () => {
    const run = aliceRt.orchestra.get(HELD)!;
    const emit = (aliceRt.orchestra as unknown as { emit(r: OrchestraRun, ph: string, x: unknown, chat?: string): void }).emit.bind(aliceRt.orchestra);
    emit(run, "task_held", { taskId: "t-zone", hold: { kind: "zone", zone: "db/migrations/**", holder: "bob", reason: "r", since } });
    emit(run, "task_held", { taskId: "t-wait", hold: { kind: "wait", runId: "oB1", reason: "r", since } });
    emit(run, "task_held", { taskId: "t-decide", hold: { kind: "decide", reason: "t-decide overlaps bob's work", since } });
    emit(run, "synced", { with: "main" });
    emit(run, "delivery_policy", { from: "push", to: "pr", branch: "main" });
    const m = mount();
    await waitUntil(() => text(m, "#feed").includes("protected by team policy"), { timeoutMs: 15_000 });
    const rows = $$(m, "#feed .sys.orch").map((r) => r.textContent?.replace(/\s+/g, " ").trim() ?? "");
    expect(rows).toContain("⏸ t-zone is queued behind bob’s hard zone db/migrations/**");
    expect(rows.some((r) => /^⏸ t-wait waits for (‘Tweak sessions’|goal oB1)’s PR to merge before it starts$/.test(r))).toBe(true);
    expect(rows).toContain("⏸ t-decide needs the orchestrator — t-decide overlaps bob's work");
    expect(rows).toContain("↻ Brought the goal up to date with main before a waiting task started");
    expect(rows).toContain("⚠ main is protected by team policy — delivering as a PR instead of merging and pushing");
    noLeak(rows.join("\n"));
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);

  it("the Team block lists real leases by member, with state pills and the overlap hint in amber", async () => {
    const m = mount();
    await openTab(m, "fleet", '#fteam .tlrow[data-tlstate="stale"]');
    await waitUntil(() => $$(m, "#fteam .tlrow").length === 5, { timeoutMs: 15_000 });
    expect($$(m, "#fteam .tsech").some((h) => /^Leases5$/.test(h.textContent ?? ""))).toBe(true);
    const heads = $$(m, "#fteam .tlgrp").map((g) => g.getAttribute("data-tlmember"));
    expect(heads).toEqual(["bob", "you"]); // teammates first, yours last

    const bobs = $$(m, '#fteam .tlgrp[data-tlmember="bob"] .tlrow');
    expect(bobs.length).toBe(3); // the zone-queued task never got one; oB9's were released
    const shared = bobs.find((r) => r.textContent?.includes("Reword the sessions doc"))!;
    expect(shared.querySelector(".tsub")?.textContent).toBe("Tweak sessions");
    expect(shared.querySelector(".opill")?.textContent).toBe("active");
    // it overlaps alice's docs/** and (after drifting) src/sessions.ts: amber, with where
    expect(shared.classList.contains("clash")).toBe(true);
    expect(shared.querySelector(".tlclash")?.textContent).toContain("overlaps yours");
    expect(shared.querySelector(".tlclash")?.textContent).toContain("docs/shared.md");
    expect(shared.querySelector(".tlfc")?.textContent).toMatch(/^\d+ files?$/);

    const landing = bobs.find((r) => r.textContent?.includes("New button styles"))!;
    expect(landing.querySelector(".opill")?.textContent).toBe("landing");
    expect(landing.classList.contains("clash")).toBe(false);
    expect([...landing.querySelectorAll(".tglob")].map((g) => g.textContent)).toEqual(["src/ui/**"]);
    expect(landing.querySelector(".tlfc")?.textContent).toBe("1 file");

    const stale = bobs.find((r) => r.textContent?.includes("Tidy the readme"))!;
    expect(stale.querySelector(".opill")?.textContent).toBe("stale");
    expect(stale.classList.contains("stale")).toBe(true);
    // a stale lease blocks nobody, so it's never the collision
    expect(stale.classList.contains("clash")).toBe(false);

    // alice's own: listed, never flagged against herself
    const mine = $$(m, '#fteam .tlgrp[data-tlmember="you"] .tlrow');
    expect(mine.length).toBe(2);
    expect(mine.some((r) => r.classList.contains("clash"))).toBe(false);
    expect(mine.map((r) => r.querySelector(".tit")?.textContent).sort()).toEqual(["Add a sessions migration", "Split the session store"]);
    expect(mine.every((r) => r.querySelector(".tsub")?.textContent === "Rework sessions")).toBe(true);
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);

  it("the five Phase 2 feed types read as sentences", async () => {
    const m = mount();
    await openTab(m, "fleet", '#fteam .tfe[data-tfeed="conflict_predicted"]');
    await waitUntil(() => !!$(m, '#fteam .tfe[data-tfeed="drift"]') && !!$(m, '#fteam .tfe[data-tfeed="lease_released"]'), { timeoutMs: 15_000 });
    const line = (type: string) => text(m, `#fteam .tfe[data-tfeed="${type}"] .tft`);
    expect(line("overlap_decided")).toBe("bob’s ‘Tweak sessions’ proceeds alongside yours: one-line change");
    expect($(m, '#fteam .tfe[data-tfeed="overlap_decided"]')?.classList.contains("warn")).toBe(true);
    expect(line("drift")).toBe("bob’s t1 edited src/sessions.ts outside its plan (you hold it)");
    expect(line("zone_waiting")).toBe("bob’s m1 is queued behind your hard zone db/migrations/**");
    expect(line("conflict_predicted")).toBe("merge conflict predicted between bob’s ‘Tweak sessions’ and alice’s ‘Rework sessions’ in docs/shared.md");
    expect($(m, '#fteam .tfe[data-tfeed="conflict_predicted"]')?.classList.contains("err")).toBe(true);
    expect(line("lease_released")).toBe("bob’s oB9 landed — 1 lease released (PR #9 merged)");
    noLeak($$(m, "#fteam .tfe .tft").map((r) => r.textContent ?? "").join("\n"));
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);

  it("project settings show the team policy beside the share toggle, read-only", async () => {
    const m = mount();
    await waitUntil(() => !!$(m, `[data-pset="${projectId}"]`));
    await ready(m, `[data-pset="${projectId}"]`);
    click($(m, `[data-pset="${projectId}"]`));
    await waitUntil(() => !!$(m, '#psteam .tpol[data-tpsrc="origin"]'), { timeoutMs: 15_000 });
    expect($(m, "#psteam [data-tshare]")).toBeTruthy();
    const pol = text(m, "#psteam .tpol");
    expect(pol).toContain("Team policy");
    expect(pol).toContain("from origin");
    expect(text(m, "#psteam .tpolr:nth-of-type(2) .tpolv")).toBe("db/migrations/**");
    expect(text(m, "#psteam .tpol .pbdg")).toBe("auto");
    expect(pol).toContain("bypass only in plan mode");
    expect(pol).toContain("echo");
    expect(pol).toContain("claude-code");
    expect(pol).toContain("main");
    expect(pol).toContain("6 in parallel per member · 20 agents across the team");
    expect(pol).toContain("change it with a PR to loom.team.json");
    // read-only: nothing to type into, nothing to press
    expect($$(m, "#psteam .tpol input, #psteam .tpol button, #psteam .tpol select").length).toBe(0);
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);

  it("Settings → Team lists the policy per shared project; no loom.team.json says so, with a sample", async () => {
    // a second checkout whose origin has no policy file: a plain repo, remote pointed at acme/app
    const bare = tmpDir("team2-dom-nopolicy");
    git(bare, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(bare, "README.md"), "# np\n");
    git(bare, "add", "-A");
    git(bare, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "seed");
    git(bare, "remote", "add", "origin", "git@github.com:acme/app.git");
    writeProjectConfig(bare, { name: "app-nopolicy", agents: [{ id: "alpha", kind: "echo" }], brain: { extractor: "off" } });
    await new DaemonClient(readDaemonConfig()!).addProject(bare);

    const m = mount();
    await ready(m, ".sfoot #setupbtn");
    click($(m, "#setupbtn"));
    await waitUntil(() => !!$(m, '.setnav [data-sec="team"]'));
    click($(m, '.setnav [data-sec="team"]'));
    await waitUntil(() => $$(m, "#setpane .tpol[data-tpsrc]").length === 2, { timeoutMs: 15_000 });
    const withPolicy = $(m, '#setpane .tpol[data-tpsrc="origin"]')!;
    expect(withPolicy.querySelector(".tpolh small")?.textContent).toBe("app-alice · acme/app");
    const none = $(m, '#setpane .tpol[data-tpsrc="none"]')!;
    expect(none.textContent).toContain("no team policy");
    expect(none.querySelector(".tpolsample")?.textContent).toContain('"hardZones"');
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);
});
