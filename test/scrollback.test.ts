/**
 * Scrollback across a daemon restart (#14).
 *
 * The PROCESS dies with the daemon — a pty can't outlive it — but the text
 * doesn't have to. What these check: history is seeded into the next session
 * with the same identity under a divider that says the shell is new, and a
 * DELIBERATE close forgets the file, because replaying a closed terminal's
 * history into a future one would be a haunting, not a restore.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { TerminalManager, type TermEvents } from "../src/daemon/terminals.js";
import { tmpDir, waitUntil } from "./helpers.js";

const quietEvents = (): TermEvents => ({
  onData: () => {},
  onCommandEnd: () => {},
  onExit: () => {},
  onTitle: () => {},
});

let persistDir: string;
let managers: TerminalManager[] = [];

const manager = (): TerminalManager => {
  const m = new TerminalManager(quietEvents(), 12, persistDir);
  managers.push(m);
  return m;
};

beforeAll(() => {
  persistDir = tmpDir("scrollback");
});

afterEach(() => {
  for (const m of managers) m.closeAll();
  managers = [];
});

describe("scrollback survives the daemon", () => {
  it("seeds a restarted session with the previous session's text", async () => {
    const work = tmpDir("term-work");
    const m1 = manager();
    const s1 = m1.open("proj", "t1", work);
    s1.write("echo scrollback-probe-42\n");
    await waitUntil(() => s1.scrollback().includes("scrollback-probe-42"));
    m1.closeAll(); // the daemon dying — saves on the way down

    const file = fs
      .readdirSync(persistDir)
      .find((f) => f.startsWith("proj-t1"));
    expect(file, "no scrollback file was written").toBeTruthy();

    const m2 = manager();
    const s2 = m2.open("proj", "t1", work);
    expect(s2.scrollback()).toContain("scrollback-probe-42");
    expect(s2.scrollback()).toContain("restored scrollback");
    expect(s2.scrollback()).toContain("new shell");
  });

  it("a deliberate close forgets — no haunting", async () => {
    const work = tmpDir("term-work2");
    const m1 = manager();
    const s1 = m1.open("proj", "t2", work);
    s1.write("echo ghost-line\n");
    await waitUntil(() => s1.scrollback().includes("ghost-line"));
    // Force the save the debounce would have done, then close deliberately.
    m1.closeAll();
    const m2 = manager();
    m2.open("proj", "t2", work);
    m2.close("proj", "t2"); // the person shut this terminal

    const m3 = manager();
    const s3 = m3.open("proj", "t2", work);
    expect(s3.scrollback()).not.toContain("ghost-line");
  });

  it("a manager with no persistDir behaves exactly as before", async () => {
    const m = new TerminalManager(quietEvents(), 12, null);
    managers.push(m);
    const s = m.open("proj", "t3", tmpDir("term-work3"));
    s.write("echo unpersisted\n");
    await waitUntil(() => s.scrollback().includes("unpersisted"));
    m.closeAll();
    const files = fs.readdirSync(persistDir).filter((f) => f.includes("t3"));
    expect(files).toHaveLength(0);
  });
});
