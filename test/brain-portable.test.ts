/**
 * The brain as a file that travels.
 *
 * A project's memory was trapped in one machine's sqlite. Export is the live
 * memories, not the event log — history stays where it happened; what moves is
 * what the project knows. The property worth guarding hardest is idempotence:
 * importing the same file twice, or into a project that already learned half of
 * it, must report "known" rather than mint duplicates, because the file will be
 * committed to repos and applied by scripts that don't check first.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let fromId: string;
let toId: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

const teach = (projectId: string, kind: string, text: string) =>
  fetch(`${baseUrl}/api/projects/${projectId}/brain`, {
    method: "POST",
    headers: H(),
    body: JSON.stringify({ kind, text }),
  });

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  fromId = (await client.addProject(makeProjectDir({ name: "origin" }))).project.id;
  toId = (await client.addProject(makeProjectDir({ name: "clone" }))).project.id;

  await teach(fromId, "decision", "sqlite over postgres — nothing to install");
  await teach(fromId, "constraint", "the daemon binds loopback only by default");
  await teach(fromId, "convention", "tests live beside the file they cover");
});

afterAll(async () => {
  await daemon.close();
});

describe("export", () => {
  it("is a self-describing document, not a bare array", async () => {
    const doc = await client.exportBrain(fromId);
    expect(doc.format).toBe("loom-brain");
    expect(doc.version).toBe(1);
    expect(doc.project).toBe("origin");
    expect((doc.memories as unknown[]).length).toBe(3);
  });

  it("carries what a memory is, not where it sat", async () => {
    const doc = await client.exportBrain(fromId);
    const rows = doc.memories as Array<Record<string, unknown>>;
    for (const m of rows) {
      expect(m.kind).toBeTruthy();
      expect(m.text).toBeTruthy();
      // ids and event offsets are machine-local facts; a file that carried
      // them would collide or lie on arrival.
      expect(m.id).toBeUndefined();
      expect(m.provenance).toBeUndefined();
    }
  });
});

describe("import", () => {
  it("teaches a fresh project everything", async () => {
    const doc = await client.exportBrain(fromId);
    const { added, known } = await client.importBrain(toId, doc);
    expect(added).toBe(3);
    expect(known).toBe(0);

    const r = await fetch(`${baseUrl}/api/projects/${toId}/brain`, { headers: H() });
    const { memories } = (await r.json()) as { memories: Array<{ text: string }> };
    expect(memories.some((m) => m.text.includes("sqlite over postgres"))).toBe(true);
  });

  it("is idempotent — the second import learns nothing and says so", async () => {
    const doc = await client.exportBrain(fromId);
    const { added, known } = await client.importBrain(toId, doc);
    expect(added).toBe(0);
    expect(known).toBe(3);
  });

  it("dedupes against what the target already learned on its own", async () => {
    await teach(toId, "fact", "the clone knows this one itself");
    const doc = await client.exportBrain(toId);
    // Re-import the clone's own export into itself: everything known.
    const { added, known } = await client.importBrain(toId, doc);
    expect(added).toBe(0);
    expect(known).toBe(4);
  });

  it("refuses a file that isn't a brain export", async () => {
    await expect(client.importBrain(toId, { some: "json" })).rejects.toThrow(
      /not a loom brain export/,
    );
  });

  it("skips junk rows instead of failing the whole file", async () => {
    const { added } = await client.importBrain(toId, {
      format: "loom-brain",
      version: 1,
      project: "x",
      exportedAt: Date.now(),
      memories: [
        { kind: "nonsense-kind", text: "dropped" },
        { kind: "fact", text: "   " },
        { kind: "fact", text: "the one good row in a messy file" },
      ],
    });
    expect(added).toBe(1);
  });
});
