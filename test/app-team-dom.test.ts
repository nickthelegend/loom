/**
 * Loom Teams in the web app, actually executed.
 *
 * The real APP_HTML in jsdom against a real daemon (the harness from
 * app-orchestra-dom.test.ts), a real `loom hub` on an ephemeral port, and a
 * second member — bob — as an in-process TeamLink with his own clone of the
 * same GitHub repo (the "two members" setup from team.test.ts). The page is
 * alice: it signs in, creates the team, shares its project and mints an
 * invite; bob joins through that link and runs a goal, and alice's Fleet
 * shows it — the titles decrypted on her side, never sent to the hub in clear.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, writeProjectConfig } from "../src/core/registry.js";
import type { OrchestraTask } from "../src/core/orchestra.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { DaemonClient } from "../src/daemon/client.js";
import { ProjectRuntime } from "../src/daemon/runtime.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { TeamLink } from "../src/daemon/team.js";
import { startHubServer } from "../src/hub/server.js";
import { tmpDir, waitUntil } from "./helpers.js";

const SECRET = "s3cret";
let hub: Awaited<ReturnType<typeof startHubServer>>;
let daemon: LoomDaemon;
let baseUrl: string;
let adminToken: string;
let projectId: string;
let origin: string;
let bob: { link: TeamLink; rt: ProjectRuntime } | null = null;

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

/** A clone of the team's repo, its origin pointed at GitHub the way a real checkout's is. */
function cloneAs(name: string): string {
  const dir = tmpDir(`team-dom-${name}`);
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

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-team-dom");
  process.env.LOOM_NO_NOTIFY = "1";
  hub = await startHubServer({ port: 0, secret: SECRET });

  origin = tmpDir("team-dom-origin");
  git(origin, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(origin, "README.md"), "# app\n");
  fs.writeFileSync(path.join(origin, ".gitignore"), ".loom/\n");
  git(origin, "add", "-A");
  git(origin, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "seed");

  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  const cfg = readDaemonConfig()!;
  // Team actions are admin-only: the page is the local console, which holds
  // the daemon's own token (what /api/bootstrap hands a loopback visitor).
  adminToken = cfg.adminToken;
  projectId = (await new DaemonClient(cfg).addProject(cloneAs("alice"))).project.id;
}, 30_000);

const live: Mounted[] = [];
afterEach(() => {
  while (live.length) live.pop()!.close();
});

afterAll(async () => {
  if (bob) {
    const run = bob.rt.orchestra.active();
    if (run) await bob.rt.orchestra.abort(run.id);
    await bob.link.stop();
    await bob.rt.close();
  }
  await daemon.close();
  await hub.close();
});

interface Mounted {
  window: JSDOM["window"];
  errors: string[];
  close: () => void;
}

/** Boot the app in a DOM, against the real daemon (see app-orchestra-dom.test.ts), on alice's project. */
function mount({ desktop = true } = {}): Mounted {
  const errors: string[] = [];
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
      // Remove asks first; jsdom has no dialogs, and a test always means yes
      window.confirm = () => true;
    },
  });
  const m: Mounted = {
    window: dom.window,
    errors,
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
const type = (m: Mounted, sel: string, value: string) => {
  const el = $(m, sel) as HTMLInputElement | null;
  if (!el) throw new Error(`no field ${sel}`);
  el.value = value;
};

/** Open the Fleet tab and wait for its Team block to have drawn. */
async function openFleet(m: Mounted) {
  await ready(m, '.tab[data-tab="fleet"]');
  click($(m, '.tab[data-tab="fleet"]'));
  await waitUntil(() => !!$(m, "#pane-fleet #fteam .tmh"));
}

describe("web app · Loom Teams", () => {
  it("signs in and creates a team from Fleet, shares the project, and shows an invite like a password", async () => {
    const m = mount();
    await openFleet(m);
    // not on a team: join or create, side by side
    expect(text(m, "#fteam .tjoin")).toContain("Join your team");
    expect(text(m, "#fteam .tjoin")).toContain("Create a team");
    expect($(m, '#fteam [data-tf="link"]')).toBeTruthy();

    type(m, '#fteam [data-tf="hub"]', hub.url);
    type(m, '#fteam [data-tf="cgh"]', "alice");
    type(m, '#fteam [data-tf="csec"]', SECRET);
    type(m, '#fteam [data-tf="name"]', "Acme");
    // a Fleet poll mid-typing must not wipe the form
    await new Promise((r) => setTimeout(r, 2300));
    expect(($(m, '#fteam [data-tf="name"]') as HTMLInputElement).value).toBe("Acme");
    await ready(m, "#fteam [data-tcreate]");
    click($(m, "#fteam [data-tcreate]"));

    await waitUntil(() => !!$(m, "#fteam .tcard[data-tteam]"), { timeoutMs: 15_000 });
    expect(text(m, "#fteam .tchd .tcn")).toBe("Acme");
    expect(text(m, "#fteam .tchd .trole")).toBe("owner");
    const me = $(m, '#fteam .tmem[data-tmem="alice"]')!;
    expect(me.textContent).toContain("owner");
    expect(me.textContent).toContain("you");
    expect(text(m, "#fteam .tsec")).toContain("Nobody else on Acme has an agent running");

    // this project: Auto until chosen — and its remote isn't a team repo yet
    await waitUntil(() => text(m, "#fteam .tshare small").includes("acme/app"));
    expect($(m, "#fteam [data-tshare]")?.getAttribute("data-tsmode")).toBe("auto");
    expect(text(m, "#fteam [data-tslabel]")).toBe("Auto");
    expect(text(m, "#fteam .tshare small")).toContain("not a team repo");
    // Shared publishes it
    await ready(m, '#fteam [data-tsv="shared"]');
    click($(m, '#fteam [data-tsv="shared"]'));
    await waitUntil(() => text(m, "#fteam [data-tslabel]") === "Shared with Acme");
    expect(text(m, "#fteam .tshare small")).toContain("acme/app");
    await waitUntil(() => text(m, "#fteam .tcard .tcrow").length > 0 && $$(m, "#fteam .trepo").some((r) => r.textContent === "acme/app"));

    // Invite: the link, masked, with the password warning and a copy button
    await ready(m, "#fteam [data-tinvite]");
    click($(m, "#fteam [data-tinvite]"));
    await waitUntil(() => !!$(m, "#fteam .tinv .tinvlink"));
    const link = ($(m, "#fteam .tinvlink") as HTMLInputElement).value;
    expect(link).toMatch(/^loom:\/\/team\/join#/);
    expect(text(m, "#fteam .tinvw")).toContain("Treat this link like a password");
    expect(text(m, "#fteam .tinvw")).toContain("team key");
    expect($(m, "#fteam .tinv [data-tcopy]")).toBeTruthy();
    expect($(m, "#fteam .tinvlink")?.classList.contains("shown")).toBe(false);
    click($(m, "#fteam .tinv [data-tshow]"));
    expect($(m, "#fteam .tinvlink")?.classList.contains("shown")).toBe(true);
    // and it survives the next poll's redraw
    await new Promise((r) => setTimeout(r, 2300));
    expect(($(m, "#fteam .tinvlink") as HTMLInputElement | null)?.value).toBe(link);
    expect(m.errors.join("\n")).toBe("");

    // bob: his own daemon's Team Link, his own clone of acme/app. He joins
    // through the link the page just showed and never clicks Share (D8).
    const rt = await ProjectRuntime.open({ id: "p-bob", name: "app-bob", dir: cloneAs("bob") });
    const link2 = new TeamLink({
      runtimes: () => [rt],
      broadcast: () => {},
      statePath: path.join(tmpDir("teamstate-bob"), "team.json"),
    });
    bob = { link: link2, rt };
    await link2.join(link, { github: "bob", secret: SECRET });
    await waitUntil(() => !!$(m, '#fteam .tmem[data-tmem="bob"]'), { timeoutMs: 15_000 });

    // bob runs a goal. echo never plans, so seed the task a plan would have
    // written — a title and the globs it declared it will touch.
    const run = await rt.orchestra.start({ goal: "Add OAuth login", orchestrator: "conductor", workers: ["alpha"] });
    const full = rt.orchestra.get(run.id)!;
    full.tasks.push({
      id: "t1", title: "Wire the GitHub callback", prompt: "never leaves bob's machine", agent: "alpha", kind: "echo",
      dependsOn: [], touches: ["src/auth/**", "src/server.ts", "test/auth.test.ts", "docs/auth.md"],
      status: "running", chat: "t1", branch: "loom/orchestra/o1/t1", attempts: 1, queued: [], startedAt: Date.now() - 65_000,
    } as OrchestraTask);
    await link2.beat();

    // alice's Fleet: bob's group, the repo, the orchestrator and the task
    await waitUntil(() => !!$(m, '#fteam .tgrp[data-tmember="bob"] .tses[data-tagent="alpha#t1"]'), { timeoutMs: 15_000 });
    const task = $(m, '#fteam .tses[data-tagent="alpha#t1"]')!;
    expect(task.querySelector(".tit")?.textContent).toBe("Wire the GitHub callback");
    expect(task.querySelector(".tsub")?.textContent).toBe("Add OAuth login");
    expect(task.querySelector(".tsn small")?.textContent).toBe("task t1");
    expect(task.querySelector(".opill")?.textContent).toBe("running");
    expect(task.querySelector(".tst .ft")?.textContent).toMatch(/^1m \d+s$/);
    // three globs, then "+1 more"
    expect([...task.querySelectorAll(".tglob")].map((g) => g.textContent)).toEqual(["src/auth/**", "src/server.ts", "test/auth.test.ts", "+1 more"]);
    expect(task.querySelector(".tbr")?.textContent).toBe("loom/orchestra/o1/t1");
    const orch = $(m, '#fteam .tses[data-tagent="conductor#orch"]')!;
    expect(orch.querySelector(".tit")?.textContent).toBe("Add OAuth login");
    expect(orch.querySelector(".tsn small")?.textContent).toBe("orchestrator");
    expect(text(m, '#fteam .tgrp[data-tmember="bob"] .trepoh')).toBe("acme/app");
    // the prompt stayed on bob's machine
    expect(text(m, "#fteam")).not.toContain("never leaves");

    // the lease map: which areas bob's task has taken
    const lease = $(m, '#fteam .tlease[data-tlease="src/auth/**"]')!;
    expect(lease.textContent).toContain("bob");
    expect(lease.textContent).toContain("task t1");
    expect($$(m, "#fteam .tlease").length).toBe(4);

    // the feed: sentences, not payloads
    await waitUntil(() => !!$(m, '#fteam .tfe[data-tfeed="goal_started"]'), { timeoutMs: 15_000 });
    expect(text(m, '#fteam .tfe[data-tfeed="goal_started"] .tft')).toBe("bob started ‘Add OAuth login’ (conductor → alpha)");
    expect(text(m, '#fteam .tfe[data-tfeed="member_joined"] .tft')).toMatch(/^(alice|bob) joined$/);
    expect(text(m, '#fteam .tfe[data-tfeed="repo_shared"] .tft')).toBe("alice shared acme/app");
    const feed = $$(m, "#fteam .tfe .tft").map((r) => r.textContent ?? "").join("\n");
    for (const leak of ["{", "}", '"type"', "[object Object]", "undefined", "null", "goal_started"]) {
      expect(feed, `raw payload leaked: ${leak}`).not.toContain(leak);
    }
    expect(m.errors.join("\n")).toBe("");
  }, 90_000);

  it("the Team settings section lists members with roles, and an owner can remove one", async () => {
    const m = mount();
    await ready(m, ".sfoot #setupbtn");
    click($(m, "#setupbtn"));
    await waitUntil(() => !!$(m, '.setnav [data-sec="team"]'));
    // beside Loom Cloud
    const secs = $$(m, ".setnav [data-sec]").map((b) => b.getAttribute("data-sec"));
    expect(secs.indexOf("team")).toBe(secs.indexOf("cloud") + 1);
    click($(m, '.setnav [data-sec="team"]'));
    await waitUntil(() => !!$(m, '#setpane [data-tsmem="bob"]'));
    expect(text(m, "#teamst")).toContain("Signed in");
    expect(text(m, "#teamst")).toContain("alice");
    expect(text(m, '#setpane [data-tsmem="alice"]')).toContain("owner");
    expect(text(m, '#setpane [data-tsmem="alice"]')).toContain("you");
    expect(text(m, '#setpane [data-tsmem="bob"] .trole')).toBe("member");
    expect($(m, '#setpane [data-tsmem="alice"] [data-tremove]'), "no removing yourself").toBeFalsy();
    expect(text(m, "#setpane")).toContain("key v1");
    expect($(m, "#setpane [data-trotate]")).toBeTruthy();
    expect($(m, "#setpane [data-tleave]")).toBeTruthy();

    // Invite from here too: same warning, same link shape
    click($(m, "#setpane [data-tinvite]"));
    await waitUntil(() => !!$(m, "#setpane .tinvlink"));
    expect(($(m, "#setpane .tinvlink") as HTMLInputElement).value).toMatch(/^loom:\/\/team\/join#/);
    expect(text(m, "#setpane .tinvw")).toContain("like a password");

    // Remove bob: the key rotates forward
    await ready(m, '#setpane [data-tsmem="bob"] [data-tremove]');
    click($(m, '#setpane [data-tsmem="bob"] [data-tremove]'));
    await waitUntil(() => !$(m, '#setpane [data-tsmem="bob"]') && text(m, "#setpane").includes("key v2"), { timeoutMs: 15_000 });
    expect(text(m, "#toast")).toContain("key rotated to v2");
    expect(m.errors.join("\n")).toBe("");
  }, 60_000);

  it("project settings carry the share control: Auto by remote, Shared, and Private opts out", async () => {
    // a second checkout of acme/app nobody shared: the remote match is enough (D8)
    const other = (await new DaemonClient(readDaemonConfig()!).addProject(cloneAs("alice-2"))).project.id;
    const m = mount();
    await waitUntil(() => !!$(m, `[data-pset="${other}"]`));
    await ready(m, `[data-pset="${other}"]`);
    click($(m, `[data-pset="${other}"]`));
    await waitUntil(() => text(m, "#psteam [data-tslabel]").startsWith("Auto ("));
    expect(text(m, "#psteam [data-tslabel]")).toBe("Auto (remote matches acme/app)");
    expect(text(m, "#psteam .tshare small")).toContain("Published to Acme");
    click($(m, "#psx"));
    await waitUntil(() => !$(m, ".scrim"));

    await waitUntil(() => !!$(m, `[data-pset="${projectId}"]`));
    await ready(m, `[data-pset="${projectId}"]`);
    click($(m, `[data-pset="${projectId}"]`));
    await waitUntil(() => !!$(m, "#psteam [data-tshare]"));
    expect(text(m, "#psteam [data-tslabel]")).toBe("Shared with Acme");
    click($(m, '#psteam [data-tsv="private"]'));
    await waitUntil(() => text(m, "#psteam [data-tslabel]") === "Private");
    expect($(m, '#psteam [data-tsv="private"]')?.classList.contains("on")).toBe(true);
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);

  it("the phone shows the Team block in the Fleet sheet", async () => {
    const m = mount({ desktop: false });
    await ready(m, "#fleetbtn");
    click($(m, "#fleetbtn"));
    await waitUntil(() => !!$(m, "#fleetsheet #fteam .tcard[data-tteam]"));
    expect(text(m, "#fleetsheet #fteam .tchd .tcn")).toBe("Acme");
    expect($(m, "#fleetsheet #fteam .tfe")).toBeTruthy();
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);
});
