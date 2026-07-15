/**
 * Unified memory ("multiple memory in one"): each ADE's native memory is
 * imported into the shared brain, merged with decisions, deduped, and carried
 * into handoff projections.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildUnifiedMemory, nativeMemoryFiles, readNativeMemory } from "../src/core/memory.js";
import { readDaemonConfig } from "../src/core/registry.js";
import type { LoomEvent, ProjectConfig } from "../src/types.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

describe("memory unit", () => {
  it("maps ADE kinds to their native memory files, honoring overrides", () => {
    expect(nativeMemoryFiles({ id: "cc", kind: "claude-code", role: "planner" })).toContain(
      "CLAUDE.md",
    );
    expect(nativeMemoryFiles({ id: "oc", kind: "opencode", role: "executor" })).toContain(
      "AGENTS.md",
    );
    expect(
      nativeMemoryFiles({ id: "x", kind: "claude-code", role: "planner", memoryFiles: ["NOTES.md"] }),
    ).toEqual(["NOTES.md"]);
  });

  it("reads native memory from disk and dedupes shared files", () => {
    const dir = tmpDir("mem");
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "claude brain\n");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "shared agents brain\n");
    const config: ProjectConfig = {
      name: "m",
      agents: [
        { id: "cc", kind: "claude-code", role: "planner" }, // CLAUDE.md + AGENTS.md
        { id: "oc", kind: "opencode", role: "executor" }, // AGENTS.md (already claimed by cc)
      ],
    };
    const blocks = readNativeMemory(dir, config);
    const files = blocks.map((b) => b.file);
    expect(files).toContain("CLAUDE.md");
    expect(files.filter((f) => f === "AGENTS.md")).toHaveLength(1); // deduped
    expect(blocks.find((b) => b.file === "CLAUDE.md")!.content).toContain("claude brain");
  });

  it("builds a unified document merging decisions and imported ADE memory", () => {
    const events: LoomEvent[] = [
      { id: 1, ts: 1, kind: "decision", payload: { text: "use sqlite" } },
      { id: 2, ts: 2, kind: "decision", payload: { text: "ship as threadloom" } },
    ];
    const doc = buildUnifiedMemory("proj", events, [
      { agentId: "cc", kind: "claude-code", file: "CLAUDE.md", content: "prefer TS strict" },
    ]);
    expect(doc.document).toContain("# Loom unified memory — proj");
    expect(doc.document).toContain("use sqlite");
    expect(doc.document).toContain("Imported from connected ADEs");
    expect(doc.document).toContain("prefer TS strict");
    expect(doc.decisions).toHaveLength(2);
    expect(doc.sources).toHaveLength(1);
  });
});

describe("memory end-to-end", () => {
  let daemon: LoomDaemon;
  let client: DaemonClient;
  let dir: string;
  let id: string;

  beforeAll(async () => {
    process.env.LOOM_HOME = tmpDir("home");
    process.env.LOOM_NO_NOTIFY = "1";
    daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
    await daemon.listen();
    client = new DaemonClient(readDaemonConfig()!);
    dir = makeProjectDir({
      name: "brain",
      agents: [
        { id: "claude-code", kind: "claude-code", role: "planner" },
        { id: "opencode", kind: "opencode", role: "executor" },
      ],
    } as Partial<ProjectConfig>);
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "Claude knows: the parser is recursive descent.\n");
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "Everyone knows: run npm test before pushing.\n");
    id = (await client.addProject(dir)).project.id;
  });

  afterAll(async () => {
    await daemon.close();
  });

  it("auto-imports each ADE's native memory into the shared brain on open", async () => {
    await waitUntil(async () => {
      const { events } = await client.events(id, undefined, 100);
      return events.filter((e) => e.kind === "memory_import").length >= 2;
    });
    const { memory } = await client.memory(id);
    expect(memory.document).toContain("recursive descent"); // from CLAUDE.md
    expect(memory.document).toContain("run npm test"); // from AGENTS.md
    expect(memory.sources.map((s) => s.file).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("import is idempotent until a source changes", async () => {
    const first = await client.importMemory(id);
    expect(first.imported).toBe(0); // already current from open
    fs.appendFileSync(path.join(dir, "CLAUDE.md"), "Also: prefer small PRs.\n");
    const second = await client.importMemory(id);
    expect(second.imported).toBe(1);
    expect(second.sources).toContain("CLAUDE.md");
    const { memory } = await client.memory(id);
    expect(memory.document).toContain("prefer small PRs");
  });

  it("carries the unified brain into a handoff projection", async () => {
    await client.send(id, "kick off");
    await waitUntil(async () => {
      const { events } = await client.events(id, undefined, 50);
      return events.some((e) => e.kind === "run_complete");
    });
    await client.decision(id, "cross-ADE decision: use pino for logs");
    await client.handoff(id, "opencode");
    const memoryFile = path.join(dir, ".loom", "memory", "opencode.md");
    const projected = fs.readFileSync(memoryFile, "utf8");
    // opencode's projected memory now includes claude-code's native knowledge.
    expect(projected).toContain("recursive descent");
    expect(projected).toContain("use pino for logs");
  });
});
