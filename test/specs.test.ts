/**
 * The Browser tab's spec machinery, over a real daemon.
 *
 * Discovery is filename-shaped on purpose (*.spec.*, *.e2e.*) — parsing imports
 * to be cleverer would drag a TS parser in to answer a question the filename
 * already answers. The runner is exercised through LOOM_SPEC_CMD, which swaps
 * `npx playwright test` for a shell one-liner: the whole path — refusal of
 * unknown files, one-run-per-project, streaming, exit codes, the Console
 * record — is identical either way, and the fixture project doesn't need a
 * browser toolchain installed to prove it.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { findSpecs } from "../src/daemon/specs.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let projectId: string;
let projectDir: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

const specs = async () => {
  const r = await fetch(`${baseUrl}/api/projects/${projectId}/specs`, { headers: H() });
  return (await r.json()) as {
    specs: Array<{ path: string }>;
    running: { id: string; file: string } | null;
  };
};

const runSpec = (file: string) =>
  fetch(`${baseUrl}/api/projects/${projectId}/specs/run`, {
    method: "POST",
    headers: H(),
    body: JSON.stringify({ file }),
  });

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
  projectDir = makeProjectDir({ name: "specs" });

  // A realistic little tree: two specs, one e2e, decoys that must not appear.
  fs.mkdirSync(path.join(projectDir, "tests"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "node_modules", "junk"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "tests", "login.spec.ts"), "// spec");
  fs.writeFileSync(path.join(projectDir, "tests", "cart.e2e.ts"), "// e2e");
  fs.writeFileSync(path.join(projectDir, "checkout.spec.js"), "// spec");
  fs.writeFileSync(path.join(projectDir, "app.ts"), "// not a spec");
  fs.writeFileSync(path.join(projectDir, "node_modules", "junk", "x.spec.ts"), "// decoy");

  projectId = (await client.addProject(projectDir)).project.id;
});

afterAll(async () => {
  delete process.env.LOOM_SPEC_CMD;
  await daemon.close();
});

afterEach(() => {
  delete process.env.LOOM_SPEC_CMD;
});

describe("finding specs", () => {
  it("finds them by name, wherever they sit", () => {
    const found = findSpecs(projectDir).map((s) => s.path);
    expect(found).toEqual(["checkout.spec.js", "tests/cart.e2e.ts", "tests/login.spec.ts"]);
  });

  it("never looks inside node_modules", () => {
    const found = findSpecs(projectDir).map((s) => s.path);
    expect(found.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("serves the same list over the API, with no run in progress", async () => {
    const body = await specs();
    expect(body.specs.map((s) => s.path)).toContain("tests/login.spec.ts");
    expect(body.running).toBeNull();
  });
});

describe("running one", () => {
  it("streams the reporter and records the pass in the Console", async () => {
    process.env.LOOM_SPEC_CMD = "echo running {file}; echo 1 passed";
    const r = await runSpec("tests/login.spec.ts");
    expect(r.status).toBe(200);
    const { run } = (await r.json()) as { run: { id: string; file: string } };
    expect(run.file).toBe("tests/login.spec.ts");

    // The run ends and the Console keeps the record — the stream is for
    // watching live, the logbook is for arriving late.
    await waitUntil(async () => {
      const logs = await fetch(`${baseUrl}/api/logs`, { headers: H() });
      const { logs: rows } = (await logs.json()) as {
        logs: Array<{ scope: string; message: string }>;
      };
      return rows.some((l) => l.scope === "specs" && l.message.includes("passed"));
    });
  });

  it("records a failure with the tail of the output", async () => {
    process.env.LOOM_SPEC_CMD = "echo boom; exit 3";
    await runSpec("tests/cart.e2e.ts");
    await waitUntil(async () => {
      const logs = await fetch(`${baseUrl}/api/logs`, { headers: H() });
      const { logs: rows } = (await logs.json()) as {
        logs: Array<{ scope: string; message: string; detail?: string }>;
      };
      return rows.some(
        (l) =>
          l.scope === "specs" &&
          l.message.includes("failed (exit 3)") &&
          (l.detail ?? "").includes("boom"),
      );
    });
  });

  it("refuses a file discovery would not offer", async () => {
    // Accepting any path would let a caller run arbitrary files through npx
    // with the daemon's hands. Same rule as the agent rail: known ≠ offered.
    process.env.LOOM_SPEC_CMD = "echo never";
    const r = await runSpec("app.ts");
    expect(r.status).toBe(409);
    const { error } = (await r.json()) as { error: string };
    expect(error).toContain("not a spec");
  });

  it("refuses a second run while one is live", async () => {
    process.env.LOOM_SPEC_CMD = "sleep 2; echo done";
    const first = await runSpec("tests/login.spec.ts");
    expect(first.status).toBe(200);

    const second = await runSpec("checkout.spec.js");
    expect(second.status).toBe(409);
    const { error } = (await second.json()) as { error: string };
    expect(error).toContain("already in progress");

    // And the list endpoint says so, so the UI can disable Run.
    expect((await specs()).running?.file).toBe("tests/login.spec.ts");

    // Stop it rather than leaving a sleeping child behind the next test.
    const stop = await fetch(`${baseUrl}/api/projects/${projectId}/specs/stop`, {
      method: "POST",
      headers: H(),
    });
    expect(stop.status).toBe(200);
    await waitUntil(async () => (await specs()).running === null);
  });
});
