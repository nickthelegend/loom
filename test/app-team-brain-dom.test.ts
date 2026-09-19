/**
 * Loom Teams, Phase 3 ("one brain") in the web app: the Brain tab's Team view.
 *
 * The real APP_HTML in jsdom against a real daemon (the harness from
 * app-orchestra-dom.test.ts). An unshared project reads the real endpoint; for
 * the populated view the page's fetch answers /team/brain with a canned team
 * brain — a hub, a second member and a canon PR are team-phase3.test.ts's job —
 * and records what the page POSTs back.
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
  process.env.LOOM_HOME = tmpDir("home-team-brain-dom");
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

const mem = (id: string, text: string, tier: string, extra: Record<string, unknown> = {}) => ({
  id, text, kind: "decision", tier, author: tier === "own" ? "alice" : "bob", confirmedBy: [], mine: tier === "own", state: "live", ...extra,
});
const BRAIN = {
  status: { shared: true, teamId: "t1", repo: "acme/app", canon: 1, team: 3, confirmed: 1, mine: 1, lastError: "push rejected" },
  memories: [
    mem("c1", "Use pnpm, never npm", "canon", { author: null }),
    mem("f1", "Sessions live in redis", "confirmed", { confirmedBy: ["bob", "carol"] }),
    mem("o1", "Cookies are SameSite=Lax", "own"),
    mem("p1", "Retry the webhook twice", "proposed"),
  ],
  inbox: [
    { id: "promote:f1", type: "promote", detail: "confirmed by 2 teammates — make it canon?", a: mem("f1", "Sessions live in redis", "confirmed", { confirmedBy: ["bob", "carol"] }) },
    { id: "duplicate:o1|p1", type: "duplicate", detail: "nearly the same memory, worded differently", a: mem("o1", "Cookies are SameSite=Lax", "own"), b: mem("p1", "Cookies use SameSite Lax", "proposed") },
  ],
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

/** Boot the app on the project; `brain` answers /team/brain (and its actions) instead of the daemon. */
function mount(brain?: typeof BRAIN): Mounted {
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
        if (brain && url.pathname.startsWith(`/api/projects/${projectId}/team/brain`)) {
          if (init?.method === "POST") {
            const body = JSON.parse(String(init.body ?? "{}"));
            posts.push({ path: url.pathname, body });
            const result = url.pathname.endsWith("/promote") ? { branch: "loom/canon", prUrl: "https://github.com/acme/app/pull/7", added: 1 } : { ok: true };
            return json({ result, ...brain });
          }
          return json(brain);
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

/** Open the Brain tab, then flip it to Team. */
async function openTeamBrain(m: Mounted) {
  await ready(m, '.tab[data-tab="brain"]');
  click($(m, '.tab[data-tab="brain"]'));
  await ready(m, '#pane-brain [data-bview="team"]');
  click($(m, '#pane-brain [data-bview="team"]'));
}

describe("web app · the Brain tab's Team view (Phase 3)", () => {
  it("an unshared project says so, and Mine is still the solo brain", async () => {
    const m = mount();
    await openTeamBrain(m);
    await waitUntil(() => text(m, "#pane-brain .tbrain").includes("isn’t shared with a team"), { timeoutMs: 15_000 });
    expect($(m, '#pane-brain [data-bview="team"]')?.classList.contains("on")).toBe(true);
    click($(m, '#pane-brain [data-bview="mine"]'));
    await waitUntil(() => !!$(m, "#pane-brain #decform"), { timeoutMs: 15_000 });
    expect($(m, "#pane-brain .tbrain")).toBeNull();
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);

  it("renders the inbox and the memories by tier, and proposes canon with the right ids", async () => {
    const m = mount(BRAIN);
    await openTeamBrain(m);
    await waitUntil(() => !!$(m, "#pane-brain .tbcard"), { timeoutMs: 15_000 });

    expect(text(m, "#pane-brain .tbtop")).toContain("acme/app");
    expect(text(m, "#pane-brain .tbtop")).toContain("1 canon · 3 team · 1 confirmed · 1 yours");
    expect(text(m, "#pane-brain .tberr")).toBe("push rejected");

    // inbox first, one card per item, the type as a chip
    const cards = $$(m, "#pane-brain .tbcard");
    expect(cards.map((c) => c.getAttribute("data-tbin"))).toEqual(["promote:f1", "duplicate:o1|p1"]);
    expect(cards[1]!.textContent).toContain("Cookies use SameSite Lax");
    expect(cards[1]!.querySelector('[data-tbact="merge"]')).toBeTruthy();

    // memories grouped Canon, Confirmed, Yours, Proposed
    const secs = $$(m, "#pane-brain .bsec").map((s) => s.firstChild?.textContent?.trim());
    expect(secs).toEqual(["Inbox", "Canon", "Confirmed", "Yours", "Proposed"]);
    const row = (id: string) => $(m, `#pane-brain .tbmem[data-tbid="${id}"]`)!;
    expect(row("f1").textContent).toContain("by bob · confirmed by 2");
    expect(row("c1").querySelector("[data-tbact]")).toBeNull(); // canon: nothing to do here
    expect(row("o1").querySelector('[data-tbact="private"]')).toBeTruthy();
    expect(row("o1").querySelector('[data-tbact="correct"]')).toBeNull(); // yours: not a correction
    expect(row("p1").querySelector('[data-tbact="correct"]')).toBeTruthy();

    click(cards[0]!.querySelector('[data-tbact="promote"]'));
    await waitUntil(() => !!$(m, "#pane-brain .tbpr a"), { timeoutMs: 15_000 });
    expect(m.posts).toEqual([{ path: `/api/projects/${projectId}/team/brain/promote`, body: { ids: ["f1"] } }]);
    expect($(m, "#pane-brain .tbpr a")?.getAttribute("href")).toBe("https://github.com/acme/app/pull/7");
    expect(m.errors.join("\n")).toBe("");
  }, 30_000);
});
