/**
 * The MCP catalog: what a registry response becomes, and what happens when
 * there isn't one.
 *
 * The registry is stubbed rather than called. Not for speed — for the two
 * claims that matter here, which a live call cannot make either way: that an
 * entry with no remote and no package is DROPPED, and that a registry which
 * does not answer degrades to the curated shelf instead of an empty list or a
 * thrown error. Both are about our behaviour, not the registry's contents.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURATED_MCPS, clearCatalogCache, normalizeRegistry, searchCatalog } from "../src/core/mcp-catalog.js";

/** One registry envelope entry, in the shape the service actually returns. */
function entry(server: Record<string, unknown>, isLatest = true): Record<string, unknown> {
  return {
    server,
    _meta: { "io.modelcontextprotocol.registry/official": { isLatest } },
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  clearCatalogCache();
});
beforeEach(() => clearCatalogCache());

describe("normalizeRegistry", () => {
  it("prefers a remote URL over a published package", () => {
    const [only] = normalizeRegistry({
      servers: [
        entry({
          name: "app.example/both",
          title: "Both",
          description: "has a remote and a package",
          version: "1.2.3",
          remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
          packages: [{ registryType: "npm", identifier: "example-mcp", version: "1.2.3" }],
        }),
      ],
    });
    expect(only).toBeDefined();
    expect(only!.transport).toBe("http");
    expect(only!.url).toBe("https://mcp.example.com/mcp");
    expect(only!.command).toBeUndefined();
    expect(only!.args).toBeUndefined();
  });

  it("derives an npx command from an npm package when there is no remote", () => {
    const [npm] = normalizeRegistry({
      servers: [
        entry({
          name: "io.github.acme/acme-mcp",
          description: "package only",
          version: "0.4.1",
          remotes: null,
          packages: [{ registryType: "npm", identifier: "acme-mcp", version: "0.4.1", runtimeHint: "npx" }],
        }),
      ],
    });
    expect(npm!.transport).toBe("stdio");
    expect(npm!.command).toBe("npx");
    expect(npm!.args).toEqual(["-y", "acme-mcp@0.4.1"]);
    expect(npm!.url).toBeUndefined();
  });

  it("derives a uvx command from a pypi package", () => {
    const [py] = normalizeRegistry({
      servers: [
        entry({
          name: "io.github.acme/py-mcp",
          description: "pypi only",
          packages: [{ registryType: "pypi", identifier: "py-mcp", version: "2.0.0" }],
        }),
      ],
    });
    expect(py!.command).toBe("uvx");
    expect(py!.args).toEqual(["py-mcp@2.0.0"]);
  });

  it("drops an entry that is installable by neither a remote nor a package", () => {
    const out = normalizeRegistry({
      servers: [
        entry({ name: "app.example/nothing", description: "a name in a directory", remotes: null, packages: null }),
        entry({ name: "app.example/oci-only", description: "container only", packages: [{ registryType: "oci", identifier: "example/mcp", version: "1" }] }),
        entry({ name: "app.example/real", description: "installable", remotes: [{ type: "sse", url: "https://x.example.com/sse" }] }),
      ],
    });
    expect(out.map((s) => s.id)).toEqual(["app.example/real"]);
    expect(out[0]!.transport).toBe("sse");
  });

  it("collapses the repeated versions of one server, keeping the one marked latest", () => {
    const out = normalizeRegistry({
      servers: [
        entry({ name: "ac.example/dup", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://old.example.com/mcp" }] }, false),
        entry({ name: "ac.example/dup", version: "2.0.0", remotes: [{ type: "streamable-http", url: "https://new.example.com/mcp" }] }, true),
        entry({ name: "ac.example/dup", version: "2.0.1-rc", remotes: [{ type: "streamable-http", url: "https://rc.example.com/mcp" }] }, false),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe("https://new.example.com/mcp");
    expect(out[0]!.version).toBe("2.0.0");
  });

  it("falls back to a humanised name when an entry has no title", () => {
    const [x] = normalizeRegistry({
      servers: [entry({ name: "ai.smithery/smithery-ai-github", remotes: [{ type: "streamable-http", url: "https://s.example.com/mcp" }] })],
    });
    expect(x!.title).toBe("Smithery Ai Github");
    expect(x!.name).toBe("ai.smithery/smithery-ai-github");
  });
});

describe("searchCatalog", () => {
  it("passes the query to the registry and normalises what comes back", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          servers: [entry({ name: "app.linear/linear", title: "Linear", remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }] })],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const out = await searchCatalog("linear", 5);
    expect(out.degraded).toBe(false);
    expect(out.servers.map((s) => s.title)).toEqual(["Linear"]);
    expect(seen[0]).toContain("search=linear");
    expect(seen[0]).toContain("limit=5");
  });

  it("serves a repeated search from the cache instead of hitting the registry again", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ servers: [entry({ name: "a/b", remotes: [{ type: "streamable-http", url: "https://b.example.com/mcp" }] })] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await searchCatalog("github", 10);
    await searchCatalog("github", 10);
    await searchCatalog("github", 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("degrades to the curated list when the registry is unreachable — and invents nothing", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.modelcontextprotocol.io");
    }) as unknown as typeof fetch;

    const out = await searchCatalog("anything");
    expect(out.degraded).toBe(true);
    expect(out.servers).toEqual([]); // no registry answer means no registry rows
    expect(out.featured).toBe(CURATED_MCPS);
    expect(out.featured.length).toBeGreaterThan(0);
  });

  it("degrades on an HTTP error status too", async () => {
    globalThis.fetch = vi.fn(async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const out = await searchCatalog("busy");
    expect(out.degraded).toBe(true);
    expect(out.servers).toEqual([]);
  });
});

describe("the curated shelf", () => {
  it("gives every provider a stable slug and something the UI can act on", () => {
    const slugs = CURATED_MCPS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length); // slugs pick logos — collisions would mis-brand a row
    for (const p of CURATED_MCPS) {
      expect(p.slug).toMatch(/^[a-z0-9-]+$/);
      expect(p.homepage).toMatch(/^https:\/\//);
      // Every entry is either connectable as written, or honestly marked as
      // needing the user's own endpoint. Nothing is half-specified.
      const actionable = Boolean(p.url) || Boolean(p.command) || p.needsUrl === true;
      expect(actionable, `${p.slug} is neither installable nor marked needsUrl`).toBe(true);
    }
  });

  it("never ships a placeholder URL: needsUrl entries have no url, the rest are absolute", () => {
    for (const p of CURATED_MCPS) {
      if (p.needsUrl) {
        expect(p.url, `${p.slug} is needsUrl but ships a url anyway`).toBeUndefined();
        expect(p.urlTemplate).toBeTruthy(); // a shape to prefill, not a value to use
      } else if (p.transport !== "stdio") {
        expect(p.url).toMatch(/^https:\/\//);
      }
    }
  });

  it("does not ship the deprecated, archived postgres reference server", () => {
    // It is npm-deprecated, unmaintained since 2024, and carries a published
    // SQL-injection flaw. Featuring it would be shipping a known vulnerability.
    const packages = CURATED_MCPS.flatMap((p) => p.args ?? []);
    expect(packages.some((a) => a.includes("@modelcontextprotocol/server-postgres"))).toBe(false);
  });
});
