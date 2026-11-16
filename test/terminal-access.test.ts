/**
 * The terminal is this machine, not a project (#380): the owner and their own unscoped devices may
 * open one; a token limited to some projects, or a Share-live guest, may not.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon, base: string, admin: string, projectId: string;

async function device(body: Record<string, unknown>): Promise<string> {
  const pair = await (await fetch(`${base}/api/pair/new`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json() as { token: string };
  const claim = await (await fetch(`${base}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair.token, name: "dev" }) })).json() as { clientToken: string };
  return claim.clientToken;
}
const open = (token: string, term: string) => fetch(`${base}/api/projects/${projectId}/term/open`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ term, cols: 40, rows: 10 }),
});

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home-term-access");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const l = await daemon.listen();
  base = `http://${l.host}:${l.port}`;
  admin = readDaemonConfig()!.adminToken;
  projectId = (await new DaemonClient(readDaemonConfig()!).addProject(makeProjectDir({ name: "term" }))).project.id;
});
afterAll(async () => { await daemon.close(); });

describe("terminal access (#380)", () => {
  it("lets the owner's own phone open a shell, and refuses a project-scoped token and a guest", async () => {
    const phone = await device({});
    const scoped = await device({ projects: [projectId] });
    const guest = await device({ guest: { project: projectId, chat: "main", role: "approve", name: "Guest" } });
    const mine = await open(phone, "phone");
    expect(mine.status).toBe(200);
    expect((await mine.json() as { term: string }).term).toBe("phone");
    expect((await open(scoped, "scoped")).status).toBe(403);
    expect([401, 403]).toContain((await open(guest, "guest")).status);
    await fetch(`${base}/api/projects/${projectId}/term/close`, { method: "POST", headers: { authorization: `Bearer ${phone}`, "content-type": "application/json" }, body: JSON.stringify({ term: "phone" }) });
  });
});
