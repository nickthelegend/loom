import { Command } from "commander";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerPhoneCommands } from "../src/cli/r4-phone.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { DaemonClient } from "../src/daemon/client.js";
import { readDaemonConfig } from "../src/core/registry.js";
import { defaultQuiet } from "../src/core/phone-r4/preferences.js";
import { makeProjectDir, tmpDir } from "./helpers.js";
let daemon: LoomDaemon, id: string, device: string;
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("r4-phone-cli"); process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 }); await daemon.listen(); const client = new DaemonClient(readDaemonConfig()!);
  id = (await client.addProject(makeProjectDir())).project.id;
  const { token } = await client.newPairingToken(); const response = await fetch(client.baseUrl + "/api/pair/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, name: "phone" }) }); device = (await response.json() as any).clientId;
}, 30000);
afterAll(async () => { await daemon.close(); });
it("CLI reads Now and brief and changes the selected device's push preferences", async () => {
  const output: string[] = [], original = console.log; console.log = (...args) => { output.push(args.join(" ")); };
  const program = new Command(); registerPhoneCommands(program);
  try {
    await program.parseAsync(["phone", "now"], { from: "user" }); expect(JSON.parse(output.pop()!).rows).toEqual([]);
    await program.parseAsync(["phone", "quiet", "--device", device, "--set", JSON.stringify({ ...defaultQuiet, start: "23:00" })], { from: "user" }); expect(JSON.parse(output.pop()!).quiet.start).toBe("23:00");
    await program.parseAsync(["phone", "notify", id, "main", "needs-you", "--device", device], { from: "user" }); expect(JSON.parse(output.pop()!).level).toBe("needs-you");
    await program.parseAsync(["phone", "brief", id], { from: "user" }); expect(JSON.parse(output.pop()!).finishedTurns).toBe(0);
  } finally { console.log = original; }
});
