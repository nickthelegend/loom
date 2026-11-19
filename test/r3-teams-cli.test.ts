import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { startHubServer } from "../src/hub/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";
const exec = promisify(execFile), root = process.cwd();
let daemon: LoomDaemon, hub: Awaited<ReturnType<typeof startHubServer>>, dir: string, team: string;
const cli = async (...args: string[]) => (await exec(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "src/cli/index.ts"), ...args], { cwd: dir, env: process.env })).stdout;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r3-cli"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen();
  dir = makeProjectDir({ name: "cli sharing" }); await new DaemonClient(readDaemonConfig()!).addProject(dir);
  hub = await startHubServer({ host: "127.0.0.1", port: 0, secret: "r3" });
  await daemon.team.signIn(hub.url, { github: "alice", secret: "r3" }); team = (await daemon.team.createTeam("CLI")).id;
});
afterAll(async () => { await daemon?.close(); await hub?.close(); });
it("CLI creates and revokes expiring links, edits roles, and exports CSV", async () => {
  const link = JSON.parse(await cli("share", "main", "--expiry", "1h", "--json"));
  expect(link.expiresAt - Date.now()).toBeLessThanOrEqual(3600000); expect((await fetch(link.url)).status).toBe(200);
  await cli("share", "--revoke", link.id); expect((await fetch(link.url)).status).toBe(404);
  expect(JSON.parse(await cli("approval-roles", "--mode", "selected")).mode).toBe("selected");
  expect(await cli("audit", "--csv")).toContain('"at","project","projectName","chat","what","who","detail"');
});
it("CLI shares and imports fleets and invalidates team invites", async () => {
  await cli("fleets:save", "cli", "echox2"); await cli("fleets:share", team, "cli"); await cli("fleets:rm", "cli");
  expect(JSON.parse(await cli("fleets:team", team, "--import", "cli")).fleets[0].spec).toBe("echox2");
  expect(JSON.parse(await cli("fleets", "--json")).fleets[0].name).toBe("cli");
  await daemon.team.invite(team);
  const invites = JSON.parse(await cli("team:invites", team)).invites;
  expect(JSON.parse(await cli("team:invites", team, "--revoke", invites[0].id)).revoked).toBe(true);
});
