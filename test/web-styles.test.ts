/**
 * Stylesheet rules that have bitten: a global class reused as a state.
 *
 * `.busy` was both the spinner (an empty <span class="busy"></span>) and a
 * state class on rows, buttons and graph nodes. A bare `.busy{…}` spinner rule
 * turned every busy thing into a 10px spinning circle — a working agent's
 * Fleet row spun over the row below it.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.join("src", "web", "styles");
const css = fs.readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => ({ f, s: fs.readFileSync(path.join(dir, f), "utf8") }));
const selectors = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("}").flatMap((block) => (block.includes("{") ? block.slice(0, block.indexOf("{")).split(",") : [])).map((x) => x.trim()).filter(Boolean);

describe("the busy spinner", () => {
  it("only an empty span spins: no rule styles a bare .busy", () => {
    for (const { f, s } of css) {
      for (const sel of selectors(s)) expect(sel, `${f}: "${sel}" styles every element with the busy state class`).not.toMatch(/(^|[\s>+~])\.busy(?![\w-])(?![.:[#])/);
    }
    expect(css.some(({ s }) => s.includes("span.busy:empty{"))).toBe(true);
  });

  it("busy stays a state on rows, buttons and nodes", () => {
    const fleet = fs.readFileSync(path.join("src", "web", "project", "fleet.js"), "utf8");
    expect(fleet).toContain('(a.busy ? " busy" : "")');
  });
});
