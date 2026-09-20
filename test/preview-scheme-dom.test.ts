/**
 * Dark mode in the preview, inside the page that's being previewed.
 *
 * A parent document has no API for setting another page's
 * prefers-color-scheme. Loom isn't a parent, though — the proxy served this
 * page and its stylesheets — so the bridge re-points the page's own media
 * rules. What these hold it to: the forced scheme really reaches the CSS and
 * matchMedia, and "Auto" puts the page back exactly as it shipped.
 */

import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";

import { bridgeScript } from "../src/core/preview-proxy.js";

/** A previewed page that themes itself the two usual ways. */
function page() {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e: Error) => errors.push(e.message));
  const dom = new JSDOM(
    `<!doctype html><html><head><style>
       body { background: white; }
       @media (prefers-color-scheme: dark) { body { background: black; } }
       @media (prefers-color-scheme: light) { body { color: black; } }
       @media (min-width: 600px) { body { margin: 0; } }
     </style></head><body><p>hello</p>${bridgeScript()}</body></html>`,
    {
      runScripts: "dangerously",
      url: "http://127.0.0.1:4321/",
      virtualConsole,
      // jsdom has no matchMedia at all; a browser does, and the bridge wraps
      // whatever is there. This is the smallest thing that behaves like one.
      beforeParse(window) {
        // matches lives on the PROTOTYPE, as it does in a browser — that's
        // what lets the bridge shadow it and then delete the shadow to undo.
        const proto = Object.create(window.EventTarget.prototype);
        Object.defineProperty(proto, "matches", { configurable: true, get: () => false });
        window.matchMedia = ((q: string) => {
          const mql = new window.EventTarget();
          Object.setPrototypeOf(mql, proto);
          Object.defineProperty(mql, "media", { value: q });
          return mql;
        }) as unknown as typeof window.matchMedia;
      },
    },
  );
  const rules = () =>
    Array.from(dom.window.document.styleSheets[0]!.cssRules).map(
      (r) => (r as CSSMediaRule).media?.mediaText ?? "",
    );
  const ask = (value: string | null) => {
    dom.window.postMessage({ source: "loom-app", kind: "scheme", value }, "*");
    return new Promise((r) => dom.window.setTimeout(r, 30));
  };
  return { dom, rules, ask, errors };
}

describe("forcing a colour scheme on the previewed page", () => {
  it("turns the page's dark rules on and its light rules off", async () => {
    const p = page();
    const before = p.rules();
    expect(before.some((m) => /prefers-color-scheme: dark/.test(m))).toBe(true);

    await p.ask("dark");
    const dark = p.rules();
    expect(dark.filter(Boolean)).toContain("all"); // the dark block now applies
    expect(dark.filter(Boolean)).toContain("not all"); // the light block doesn't
    // A media query that has nothing to do with the scheme is left alone.
    expect(dark.some((m) => /min-width/.test(m))).toBe(true);
    expect(p.dom.window.document.documentElement.style.colorScheme).toBe("dark");
  });

  it("Auto puts every rule back exactly as it shipped", async () => {
    const p = page();
    const before = p.rules();
    await p.ask("dark");
    await p.ask("light");
    await p.ask(null);
    expect(p.rules()).toEqual(before);
    expect(p.dom.window.document.documentElement.style.colorScheme).toBe("");
  });

  it("a script asking matchMedia gets the forced answer, and is told it changed", async () => {
    const p = page();
    const win = p.dom.window as unknown as Window;
    const mql = win.matchMedia("(prefers-color-scheme: dark)");
    let changes = 0;
    mql.addEventListener("change", () => changes++);
    expect(mql.matches).toBe(false);

    await p.ask("dark");
    expect(mql.matches).toBe(true);
    expect(changes).toBeGreaterThan(0); // a themed app re-renders on this

    await p.ask(null);
    expect(mql.matches).toBe(false); // back to whatever the OS says
  });

  it("says what it managed to reach, so the app never claims more than it did", async () => {
    const p = page();
    const heard: Array<Record<string, unknown>> = [];
    p.dom.window.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as { source?: string; kind?: string; payload?: Record<string, unknown> };
      if (d?.source === "loom-preview" && d.kind === "scheme") heard.push(d.payload ?? {});
    });
    await p.ask("dark");
    expect(heard).toHaveLength(1);
    expect(heard[0]!.scheme).toBe("dark");
    expect(Number(heard[0]!.sheets)).toBeGreaterThan(0);
    expect(p.errors).toEqual([]);
  });
});
