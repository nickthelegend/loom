/**
 * Several sessions of one agent kind in one project, over a real daemon.
 *
 * The roster has always been keyed by instance id with kind alongside it, so two
 * Claude Code sessions on one repo were representable. Adding one still threw:
 * the id defaulted to the kind, the kind was taken, and the UI hid anything
 * already present so there was no way to ask for a second from either surface.
 *
 * The point of the feature is not the second session, it's that both sessions
 * read and write ONE brain. So these check identity (two distinct sessions, two
 * distinct contexts) and sharing (one memory store, one board, one baton) at the
 * same time — either half alone would be the wrong feature.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import type { ProjectStatus } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let projectId: string;
let projectDir: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

const status = async (): Promise<ProjectStatus> => {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}`, { headers: H() });
  return ((await r.json()) as { project: ProjectStatus }).project;
};

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  projectDir = makeProjectDir({ name: "instances" }); // plannerbot + execbot (echo)
  projectId = (await client.addProject(projectDir)).project.id;
});

afterAll(async () => {
  await daemon.close();
});

describe("several sessions of one kind", () => {
  it("gives the first instance the bare kind as its id", async () => {
    // Existing configs and route specs name `echo`. The first instance has to
    // keep that id or every one of them starts pointing at nothing.
    const added = await client.addAgent(projectId, "echo");
    expect(added.kind).toBe("echo");
    expect(added.id).toBe("echo");
  });

  it("adds a second session instead of refusing", async () => {
    const added = await client.addAgent(projectId, "echo");
    expect(added.id).toBe("echo-2");
    expect(added.kind).toBe("echo");

    const ids = (await status()).agents.map((a) => a.id);
    expect(ids).toContain("echo");
    expect(ids).toContain("echo-2");
  });

  it("keeps counting up rather than reusing a suffix", async () => {
    expect((await client.addAgent(projectId, "echo")).id).toBe("echo-3");
  });

  it("takes a name when you give it one", async () => {
    const added = await client.addAgent(projectId, "echo", { as: "reviewer", role: "reviewer" });
    expect(added.id).toBe("reviewer");
    expect(added.role).toBe("reviewer");
  });

  it("still refuses a name that is already taken", async () => {
    // Auto-numbering is for the caller who didn't care. A caller who named the
    // instance means that name, and silently renaming it would be worse.
    await expect(client.addAgent(projectId, "echo", { as: "reviewer" })).rejects.toThrow(
      /already in this project/,
    );
  });

  it("writes every session to config, so a restart keeps them", () => {
    const cfg = readProjectConfig(projectDir)!;
    const echoes = cfg.agents.filter((a) => a.kind === "echo").map((a) => a.id);
    expect(echoes).toEqual(expect.arrayContaining(["echo", "echo-2", "echo-3", "reviewer"]));
  });

  it("spawns each one for real — a config entry with no agent behind it 500s", async () => {
    // addAgent builds before it saves for exactly this reason; if it didn't,
    // every poll of this project would throw on the instance that isn't there.
    const agents = (await status()).agents;
    for (const id of ["echo", "echo-2", "echo-3", "reviewer"]) {
      const a = agents.find((x) => x.id === id);
      expect(a, `${id} missing from status`).toBeTruthy();
      expect(a!.available).toBe(true);
    }
  });

  it("reports a session count per kind, not just a yes/no", async () => {
    // `echo` is a test kind and never appears in ADES, so this asserts the
    // contract the rail depends on rather than echo's own count: every offered
    // kind carries a number, and it agrees with inProject.
    const { ades } = await client.availableAgents(projectId);
    expect(ades.length).toBeGreaterThan(0);
    for (const a of ades) {
      expect(typeof a.instances).toBe("number");
      expect(a.instances).toBeGreaterThanOrEqual(0);
      expect(a.inProject).toBe(a.instances > 0);
    }
  });

  it("keeps adapters addable and stops offering bridges twice", async () => {
    // A bridge is read-mostly and never holds the baton, so a second one buys
    // nothing; an adapter is a real session and a second one is the feature.
    const { ades } = await client.availableAgents(projectId);
    for (const a of ades) {
      expect(a.canAddAnother).toBe(a.tier === "adapter");
    }
  });
});

describe("one brain behind all of them", () => {
  it("serves every session one memory store", async () => {
    // The whole point. The store is keyed by project, not by agent, so a unit
    // is visible to every session in the roster — if each instance had its own
    // brain this would be a fleet of strangers rather than one mind with several
    // hands.
    const write = await fetch(`${baseUrl}/api/projects/${projectId}/brain`, {
      method: "POST",
      headers: H(),
      body: JSON.stringify({ kind: "decision", text: "instance-shared-brain-probe" }),
    });
    expect(write.ok).toBe(true);

    const r = await fetch(`${baseUrl}/api/projects/${projectId}/brain`, { headers: H() });
    const { memories } = (await r.json()) as { memories: Array<{ text: string }> };
    expect(
      memories.some((m) => m.text.includes("instance-shared-brain-probe")),
      "the unit is not in the project brain",
    ).toBe(true);
  });

  it("retrieves that unit for any session that asks, not just its author", async () => {
    // Being in the store is not the same as reaching a model. Units reach a turn
    // through the retrieval brief compiled on handoff, so the property that
    // matters is that a search scoped to one session finds a unit no matter which
    // session was in the room when it was written. Two different sessions, same
    // answer, is what "one brain" has to mean.
    const ask = async (agent: string) => {
      const r = await fetch(
        `${baseUrl}/api/projects/${projectId}/brain/search?q=${encodeURIComponent("instance-shared-brain-probe")}&agent=${agent}`,
        { headers: H() },
      );
      expect(r.ok).toBe(true);
      return (await r.json()) as { hits: Array<{ memory?: { text?: string }; text?: string }> };
    };

    for (const session of ["echo-2", "echo-3", "reviewer"]) {
      const { hits } = await ask(session);
      const texts = JSON.stringify(hits);
      expect(texts, `${session} cannot see the shared unit`).toContain(
        "instance-shared-brain-probe",
      );
    }
  });

  it("keeps one baton across all of them", async () => {
    // Two sessions of a kind must not mean two batons; the lock is per project.
    const p = await status();
    const holders = p.agents.filter((a) => a.holdsBaton);
    expect(holders.length).toBeLessThanOrEqual(1);
  });
});
