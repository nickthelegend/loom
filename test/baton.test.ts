import { describe, expect, it } from "vitest";
import { BatonManager, NotHolderError } from "../src/core/baton.js";
import { EventLog } from "../src/core/eventlog.js";
import { projectLoomDir } from "../src/core/registry.js";
import { makeProjectDir } from "./helpers.js";

async function setup() {
  const dir = makeProjectDir();
  const log = await EventLog.open(projectLoomDir(dir));
  return { dir, log, baton: new BatonManager(dir, log) };
}

describe("baton manager", () => {
  it("starts unheld, acquires, and logs the handoff", async () => {
    const { baton, log } = await setup();
    expect(baton.holder()).toBeNull();
    baton.acquire("plannerbot");
    expect(baton.holder()).toBe("plannerbot");
    const handoffs = log.list({ kinds: ["handoff"] });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.payload).toMatchObject({ from: null, to: "plannerbot" });
  });

  it("acquire is idempotent for the holder but exclusive across agents", async () => {
    const { baton } = await setup();
    baton.acquire("plannerbot");
    baton.acquire("plannerbot"); // no-op
    expect(() => baton.acquire("execbot")).toThrow(NotHolderError);
  });

  it("handoff moves the baton and persists across manager instances", async () => {
    const { baton, dir, log } = await setup();
    baton.acquire("plannerbot");
    const { from } = baton.handoff("execbot");
    expect(from).toBe("plannerbot");
    expect(baton.holder()).toBe("execbot");
    // A fresh manager over the same project sees the same holder (disk state).
    const again = new BatonManager(dir, log);
    expect(again.holder()).toBe("execbot");
  });

  it("release clears the holder; assertHolder guards writes", async () => {
    const { baton } = await setup();
    baton.acquire("plannerbot");
    baton.release("plannerbot");
    expect(baton.holder()).toBeNull();
    expect(() => baton.assertHolder("plannerbot")).toThrow(NotHolderError);
  });
});
