/**
 * One-link onboarding in the web app, actually executed.
 *
 * The real APP_HTML in jsdom against a real daemon (the harness from
 * app-team-dom.test.ts) and a real `loom hub`. The page is alice's Loom:
 *   - Invite in a project's header asks her to sign in first, then shows a
 *     one-time https link (and its QR) that carries the repo and her crews;
 *   - a link carol sent opens the join page (`/app#join=…`): what it sets
 *     up, Join, each step as it runs, then Open — and her crew lands here,
 *     filled from alice's agents.
 * GitHub is faked (`gh`), so nothing here talks to it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, writeProjectConfig } from "../src/core/registry.js";
import { inviteFragment } from "../src/core/invite-link.js";
import { APP_HTML } from "../src/daemon/app-page.js";
import { DaemonClient } from "../src/daemon/client.js";
import { inviteTeammate } from "../src/daemon/onboard.js";
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
let client: DaemonClient;
let projectId: string;
let origin: string;
const ghCalls: string[][] = [];
const cleanup: Array<() => Promise<void>> = [];

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });

function cloneAs(name: string): string {
  const dir = tmpDir(`onb-dom-${name}`);
  git(path.dirname(dir), "clone", "-q", origin, dir);
  git(dir, "remote", "set-url", "origin", "git@github.com:acme/app.git");
  writeProjectConfig(dir, { name: `app-${name}`, agents: [{ id: "alpha", kind: "echo" }], brain: { extractor: "off" } });
  return dir;
}

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-onb-dom");
  process.env.LOOM_NO_NOTIFY = "1";
  hub = await startHubServer({ port: 0, secret: SECRET });
  origin = tmpDir("onb-dom-origin");
  git(origin, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(origin, "README.md"), "# app\n");
  fs.writeFileSync(path.join(origin, ".gitignore"), ".loom/\n");
  git(origin, "add", "-A");
  git(origin, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "seed");

  daemon = new LoomDaemon({
    host: "127.0.0.1",
    port: 0,
    gh: async (args) => { ghCalls.push(args); return args[1] === "repos/acme/app" ? "true\n" : "[]"; },
    onboard: { projectsHome: tmpDir("onb-dom-projects"), clone: async () => { throw new Error("alice already has the repo — nothing should clone"); } },
  });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  const cfg = readDaemonConfig()!;
  adminToken = cfg.adminToken;
  client = new DaemonClient(cfg);
  projectId = (await client.addProject(cloneAs("alice"))).project.id;
}, 30_000);

const live: Mounted[] = [];
afterEach(() => { while (live.length) live.pop()!.close(); });
afterAll(async () => {
  for (const c of cleanup.reverse()) await c().catch(() => {});
  await daemon.close();
  await hub.close();
});

interface Mounted { window: JSDOM["window"]; errors: string[]; close: () => void }

function mount(hash: string): Mounted {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  virtualConsole.on("error", (msg: string) => errors.push(String(msg)));
  const sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});
  const dom = new JSDOM(APP_HTML, {
    url: `${baseUrl}/app${hash}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof window.ResizeObserver;
      window.matchMedia = ((q: string) => ({
        matches: /min-width/.test(q), media: q, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
      })) as typeof window.matchMedia;
      window.fetch = ((input: string, init?: RequestInit) => {
        if (closed) return never;
        return fetch(new URL(String(input), baseUrl), init).then((r) => (closed ? never : r));
      }) as typeof window.fetch;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
      } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", adminToken);
      window.localStorage.setItem("loomSetupSeen", "1"); // the first-run dialog would cover the page
      window.open = (() => null) as typeof window.open;
    },
  });
  const m: Mounted = {
    window: dom.window,
    errors,
    close: () => {
      closed = true;
      for (const s of sockets) { try { s.removeAllListeners(); s.on("error", () => {}); s.terminate(); } catch { /* gone */ } }
      dom.window.close();
    },
  };
  live.push(m);
  return m;
}

const $ = (m: Mounted, sel: string) => m.window.document.querySelector(sel);
const $$ = (m: Mounted, sel: string) => [...m.window.document.querySelectorAll(sel)];
const text = (m: Mounted, sel: string) => $(m, sel)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const ready = (m: Mounted, sel: string) => waitUntil(() => !!($(m, sel) as (HTMLElement & { onclick?: unknown }) | null)?.onclick, { timeoutMs: 10_000 });
const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  (el as HTMLElement).dispatchEvent(new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }));
};

describe("web app · one link", () => {
  it("Invite asks for GitHub first, then shows a one-time https link with a QR, the repo and push access", async () => {
    let m = mount(`#p/${projectId}`);
    await ready(m, "#invitebtn");
    click($(m, "#invitebtn"));
    // not on a hub yet: sign in with GitHub, right there
    await waitUntil(() => !!$(m, ".invmodal #ivsign"), { timeoutMs: 10_000 });
    expect(text(m, ".invmodal .ivstate")).toContain("GitHub");
    m.close();

    await client.teamAction("signin", { hub: hub.url, github: "alice", secret: SECRET });
    m = mount(`#p/${projectId}`);
    await ready(m, "#invitebtn");
    click($(m, "#invitebtn"));
    await waitUntil(() => !!$(m, ".invmodal #ivlink"), { timeoutMs: 15_000 });
    const link = ($(m, "#ivlink") as HTMLInputElement).value;
    expect(link).toMatch(/^https:\/\/nickthelegend\.github\.io\/loom\/join\/#/);
    // Loom made the team (named after the project) and shared the repo on the way
    expect(text(m, ".ivwho")).toContain("app-alice");
    expect(text(m, ".ivwho")).toContain("acme/app");
    expect(text(m, ".ivsub")).toContain("push access");
    expect($(m, ".ivqr svg")).toBeTruthy();
    expect(text(m, ".ivwarnrow")).toContain("Treat it like a password");
    expect(text(m, "#ivexp")).toMatch(/works once/);
    // the admin check went through gh, and nothing was granted yet — that waits for someone to join
    expect(ghCalls.some((a) => a[1] === "repos/acme/app")).toBe(true);
    expect(ghCalls.some((a) => a.includes("PUT"))).toBe(false);
    expect(m.errors).toEqual([]);
  });

  it("a link carol sent opens the join page: what it does, Join, each step, then the project", async () => {
    // carol: her own clone, a crew, signed in — she invites from her project
    const carolDir = cloneAs("carol");
    const carolRt = await ProjectRuntime.open({ id: "onb-dom-carol", name: "app-carol", dir: carolDir });
    cleanup.push(() => carolRt.close());
    carolRt.crews.create({ name: "Fixers", template: "fix" });
    const carol = new TeamLink({ runtimes: () => [carolRt], broadcast: () => {}, statePath: path.join(tmpDir("onb-dom-carol-state"), "team.json"), gh: async () => "false" });
    cleanup.push(() => carol.stop());
    await carol.signIn(hub.url, { github: "carol", secret: SECRET });
    const invite = await inviteTeammate(carol, carolRt, { gh: async () => "false" });
    expect(invite.grant).toBe(false); // carol can't admin acme/app here — said, not hidden
    expect(invite.grantNote).toMatch(/add them on GitHub/);

    const m = mount(`#join=${inviteFragment(invite.link)}`);
    await waitUntil(() => text(m, ".joincard .jtitle").includes("invited you"), { timeoutMs: 10_000 });
    expect(text(m, ".joincard .jtitle")).toBe("@carol invited you to app-carol");
    expect(text(m, ".joincard .jrepo")).toBe("acme/app");
    // the key left the address bar as soon as the page read it
    expect(m.window.location.hash).toBe("#join");
    const plan = $$(m, ".jsteps li").map((li) => li.querySelector(".jl")!.childNodes[0]!.textContent);
    expect(plan).toEqual(["Sign in with GitHub", "Join the team", "Get the repo", "Open it with your agents", "Show the team what you work on", "Set up the crews"]);
    expect(text(m, ".jsteps li:first-child small")).toContain("signed in as @alice");
    expect(text(m, ".jsteps li:nth-child(3) small")).toMatch(/you have it/);

    await ready(m, "#jgo");
    click($(m, "#jgo"));
    await waitUntil(() => !!$(m, ".jok") || !!$(m, ".jerr"), { timeoutMs: 20_000 });
    expect(text(m, ".jerr")).toBe("");
    expect(text(m, ".jok")).toContain("You’re in");
    expect($$(m, ".jsteps li").map((li) => li.className)).toEqual(["js-skipped", "js-done", "js-done", "js-done", "js-done", "js-done"]);
    expect(text(m, ".jsteps li:nth-child(6) small")).toBe("Fixers");

    // the crew is real, on alice's project, with alice's agent in every seat
    const crews = (await client.crews(projectId)).crews;
    expect(crews.map((c) => c.name)).toContain("Fixers");
    expect(crews.find((c) => c.name === "Fixers")!.teammates.every((t: { agent: string }) => t.agent === "alpha")).toBe(true);

    await ready(m, "#jopen");
    click($(m, "#jopen"));
    await waitUntil(() => m.window.location.hash === `#p/${projectId}` && !$(m, ".joincard"), { timeoutMs: 10_000 });
    expect(m.errors).toEqual([]);
  });

  it("a broken link says so, instead of a blank page", async () => {
    const m = mount("#join=notaninvite");
    await waitUntil(() => !!$(m, ".joincard .jerr"), { timeoutMs: 10_000 });
    expect(text(m, ".joincard .jerr")).toMatch(/isn't a Loom invite link/);
  });
});
