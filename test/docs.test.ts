/**
 * The docs are a contract too. These tests catch the class of bug where a doc
 * confidently tells a reader to type something that cannot work — the kind
 * nothing else notices, because no code imports a README.
 *
 * The SDK guide spent a while telling adapter authors to import from
 * "loom-agents/sdk", a package that has never existed under any name.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const pkg = JSON.parse(read("package.json")) as {
  name: string;
  exports: Record<string, string>;
};

/** Every `from "…"` in a fenced code block across the docs. */
function importedPackages(md: string): string[] {
  const out: string[] = [];
  const re = /from\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const spec = m[1]!;
    if (!spec.startsWith(".") && !spec.startsWith("node:")) out.push(spec);
  }
  return out;
}

const DOCS = ["README.md", "docs/adapters.md"];

describe("docs · import paths resolve", () => {
  it.each(DOCS)("%s only tells readers to import packages that exist", (doc) => {
    const specs = [...new Set(importedPackages(read(doc)))];
    const ours = specs.filter((s) => s === pkg.name || s.startsWith(pkg.name + "/"));
    // the guides are worthless if they don't show our own import at all
    if (doc === "docs/adapters.md") expect(ours.length).toBeGreaterThan(0);
    for (const spec of ours) {
      const sub = spec === pkg.name ? "." : "." + spec.slice(pkg.name.length);
      expect(pkg.exports[sub], `${doc} imports "${spec}", not an export of ${pkg.name}`).toBeTruthy();
    }
    // a package name we don't publish and don't depend on can't resolve
    const foreign = specs.filter((s) => !ours.includes(s));
    const deps = Object.keys({
      ...((pkg as unknown as { dependencies?: object }).dependencies ?? {}),
      ...((pkg as unknown as { devDependencies?: object }).devDependencies ?? {}),
      ...((pkg as unknown as { peerDependencies?: object }).peerDependencies ?? {}),
    });
    for (const spec of foreign) {
      const base = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      expect(deps, `${doc} imports "${spec}", which is neither ours nor a dependency`).toContain(base);
    }
  });

  it("never resurrects the import path that does not exist", () => {
    // Prose may *name* the old broken path — the changelog has to, to explain
    // the fix. What must never come back is an import telling you to use it.
    for (const doc of [...DOCS, "ARCHITECTURE.md", "CHANGELOG.md"]) {
      expect(read(doc), `${doc} imports from a package that has never existed`).not.toMatch(
        /from\s+"loom-agents/,
      );
    }
  });
});

describe("docs · the SDK surface the guide promises", () => {
  it("exports every name docs/adapters.md tells authors to import", async () => {
    const md = read("docs/adapters.md") + read("README.md");
    // names imported from our own sdk entry point, minus `type` imports
    const wanted = new Set<string>();
    const re = /import\s*\{([^}]+)\}\s*from\s+"@loompad\/cli\/sdk"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md))) {
      for (const raw of m[1]!.split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
        if (name && !raw.includes("type ")) wanted.add(name);
      }
    }
    expect(wanted.size).toBeGreaterThan(0);
    const sdk = (await import("../src/sdk.js")) as Record<string, unknown>;
    for (const name of wanted) {
      expect(sdk[name], `docs import { ${name} } from "@loompad/cli/sdk", which doesn't export it`).toBeDefined();
    }
  });
});
