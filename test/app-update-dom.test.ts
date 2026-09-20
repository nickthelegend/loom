/**
 * The Update button, actually clicked.
 *
 * The real page in jsdom against a real daemon, with only the two update
 * endpoints answered by the test — because whether a newer Loom exists depends
 * on GitHub, and a suite that asks GitHub tests the weather. Everything else
 * here is the product: the pill that appears, the section that says what will
 * run, the confirm, and the POST that starts it.
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
let clientToken: string;

const AVAILABLE = {
  version: "0.2.1",
  rev: "abc1234def",
  root: "/src/loom",
  git: null,
  latest: "0.3.0",
  release: { version: "0.3.0", tag: "v0.3.0", url: "https://example.invalid/releases/v0.3.0", publishedAt: "2026-09-20T00:00:00Z" },
  behindRelease: true,
  install: "git",
  canApply: true,
  refusal: null,
  steps: ["git pull --ff-only", "npm install --no-audit --no-fund", "npm run build"],
};

const UP_TO_DATE = { ...AVAILABLE, latest: "0.2.1", behindRelease: false, release: { ...AVAILABLE.release, version: "0.2.1", tag: "v0.2.1" } };

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-update-dom");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  const client = new DaemonClient(readDaemonConfig()!);
  await client.addProject(makeProjectDir({ name: "updates" }));
  const { token } = await client.newPairingToken();
  const claim = await fetch(`${baseUrl}/api/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name: "jsdom" }),
  });
  clientToken = ((await claim.json()) as { clientToken: string }).clientToken;
}, 30_000);

const live: Mounted[] = [];
afterEach(() => {
  while (live.length) live.pop()!.close();
});
afterAll(async () => {
  await daemon.close();
});

interface Mounted {
  window: JSDOM["window"];
  errors: string[];
  /** Every POST the page made to the apply route. */
  applied: number;
  close: () => void;
}

function mount(status: Record<string, unknown>): Mounted {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  const sockets: WebSocket[] = [];
  let closed = false;
  const never = new Promise<never>(() => {});
  const m: Mounted = { window: null as unknown as JSDOM["window"], errors, applied: 0, close: () => {} };

  const dom = new JSDOM(APP_HTML, {
    url: `${baseUrl}/app`,
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
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as Promise<Response>;
        if (url.pathname === "/api/updates") return json(status);
        if (url.pathname === "/api/updates/apply") {
          m.applied++;
          return json({ started: true, steps: status.steps });
        }
        return fetch(url, init).then((r) => (closed ? never : r));
      }) as typeof window.fetch;
      window.WebSocket = class extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      } as unknown as typeof window.WebSocket;
      window.localStorage.setItem("loomClientToken", clientToken);
      window.confirm = () => true;
    },
  });

  m.window = dom.window;
  m.close = () => {
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
  };
  live.push(m);
  return m;
}

const $ = (m: Mounted, sel: string) => m.window.document.querySelector(sel);
const text = (m: Mounted, sel: string) => $(m, sel)?.textContent?.trim() ?? "";
const click = (el: Element | null) => {
  if (!el) throw new Error("clicked an element that isn't there");
  (el as HTMLElement).dispatchEvent(
    new (el.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent("click", { bubbles: true }),
  );
};

async function openUpdates(m: Mounted) {
  await waitUntil(() => !!($(m, "#setupbtn") as HTMLElement & { onclick?: unknown })?.onclick, { timeoutMs: 20_000 });
  click($(m, "#setupbtn"));
  await waitUntil(() => !!$(m, '#setnav [data-sec="updates"]'), { timeoutMs: 20_000 });
  click($(m, '#setnav [data-sec="updates"]'));
  await waitUntil(() => text(m, "#setpane").includes("Updates"), { timeoutMs: 20_000 });
}

describe("web app · updating Loom", () => {
  it("says a newer Loom is out, shows exactly what it will run, and runs it", async () => {
    const m = mount(AVAILABLE);
    // the quiet pill in the status bar is the whole announcement
    await waitUntil(() => !!$(m, "#updready"), { timeoutMs: 20_000 });
    expect(text(m, "#updready")).toContain("0.3.0");

    await openUpdates(m);
    expect(text(m, "#setpane")).toContain("0.3.0 is out");
    // the commands, before anything runs
    const shown = text(m, ".scmd");
    expect(shown).toContain("git pull --ff-only");
    expect(shown).toContain("npm run build");

    const go = $(m, "#updnow") as HTMLButtonElement;
    expect(go, "the Update button is offered").toBeTruthy();
    expect(go.textContent).toContain("0.3.0");
    click(go);
    await waitUntil(() => m.applied === 1, { timeoutMs: 20_000 });
    // and it says what's happening rather than going quiet
    expect(go.disabled).toBe(true);
    await waitUntil(() => text(m, "#updlog").length > 0, { timeoutMs: 20_000 });
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("offers nothing to press when this Loom is current", async () => {
    const m = mount(UP_TO_DATE);
    await openUpdates(m);
    expect($(m, "#updready")).toBeFalsy(); // no pill
    expect($(m, "#updnow")).toBeFalsy(); // no button
    expect(text(m, "#setpane")).toContain("Up to date");
    expect(m.applied).toBe(0);
    expect(m.errors).toEqual([]);
  }, 60_000);

  it("an install it can't update is told where the release is, not offered a button", async () => {
    const m = mount({ ...AVAILABLE, install: "unknown", canApply: false, root: null, refusal: "this copy of Loom wasn't installed from git or npm — download the release instead" });
    await openUpdates(m);
    expect($(m, "#updnow")).toBeFalsy();
    expect(text(m, "#setpane")).toContain("download the release");
    expect(text(m, ".scmd")).toContain("example.invalid");
    expect(m.applied).toBe(0);
    expect(m.errors).toEqual([]);
  }, 60_000);
});
