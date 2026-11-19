import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Brain } from "../src/core/brain.js";
import { watchMergedPrs } from "../src/core/brain-r4/pr-learning.js";
import { EventLog } from "../src/core/eventlog.js";
import * as intake from "../src/core/intake.js";
import { execFile } from "../src/core/process.js";
import { readPrRecords, recordOpenedPr } from "../src/core/pr-feedback.js";
import { PrFeedback, PR_POLL_MS } from "../src/daemon/pr-feedback.js";
import type { ProjectRuntime } from "../src/daemon/runtime.js";
import { tmpDir, waitUntil } from "./helpers.js";

vi.mock("../src/core/process.js", () => ({ execFile: vi.fn() }));
const url = (n: number) => `https://github.com/acme/app/pull/${n}`;
let dir: string, log: EventLog, brain: Brain, feedback: PrFeedback;
let stops: Array<() => void>;
let reads: number[];
let read: (n: number) => void;

beforeEach(async () => {
  vi.mocked(execFile).mockReset();
  dir = tmpDir("r4-pr-feedback");
  log = await EventLog.open(path.join(dir, ".loom"));
  brain = new Brain(log);
  stops = [];
  reads = [];
  read = () => {};
  feedback = new PrFeedback({ info: { id: "test", dir }, log,
    chats: () => [{ id: "main", prFeedback: "off" }],
  } as unknown as ProjectRuntime);
  for (const n of [1, 2, 3]) recordOpenedPr(dir, url(n), { chat: "main", source: "delivery" });
  vi.mocked(execFile).mockImplementation(((_command: string, args: string[], _options: unknown, callback: Function) => {
    const n = Number(args[2]);
    reads.push(n);
    queueMicrotask(() => {
      try {
        read(n);
        callback(null, JSON.stringify({ state: n === 1 ? "MERGED" : "CLOSED", url: url(n), headRefOid: "head", mergeable: "MERGEABLE" }), "");
      } catch (error) { callback(error, "", ""); }
    });
  }) as typeof execFile);
});

afterEach(async () => {
  stops.forEach(stop => stop());
  await feedback.stop();
  brain.close();
  log.close();
  vi.restoreAllMocks();
});

const announcements = () => log.list({ kinds: ["status"] }).filter(e => e.payload.state === "pr_feedback").map(e => e.payload.text);
const expected = ["PR #1 merged", "PR #2 closed without merging", "PR #3 closed without merging"];

it("finishes the whole poll before a merged-PR learner can race subsequent PR reads", async () => {
  let learning = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const knowledge = vi.fn(async () => {
    learning = true;
    await held;
    return { title: "Preserve every terminal announcement" };
  });
  stops.push(watchMergedPrs(brain, log, dir, knowledge));
  // Deterministic equivalent of the exclusive lock in the fake gh binary:
  // once merge handling begins, any remaining poll read loses the race.
  read = () => { if (learning) throw new Error("OVERLAP: merged PR reader owns gh"); };
  try {
    await feedback.pollNow();
    expect(announcements()).toEqual(expected);
    expect(readPrRecords(dir).map(p => p.state)).toEqual(["MERGED", "CLOSED", "CLOSED"]);
    expect(knowledge).toHaveBeenCalledOnce();
    expect(brain.knowledge.hasLearnedPr(url(1))).toBe(false);
    await feedback.pollNow();
    expect(reads).toEqual([1, 2, 3]);
    expect(announcements()).toEqual(expected);
  } finally {
    release();
    await waitUntil(() => brain.knowledge.hasLearnedPr(url(1)));
  }
});

it("continues past one failed PR and retries it after backoff without repeating terminal announcements", async () => {
  read = n => { if (n === 1) throw new Error("gh unavailable"); };
  await feedback.pollNow();
  expect(announcements()).toEqual(expected.slice(1));
  expect(readPrRecords(dir).map(p => p.state)).toEqual(["OPEN", "CLOSED", "CLOSED"]);
  await feedback.pollNow();
  expect(reads).toEqual([1, 2, 3]);
  read = () => {};
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * PR_POLL_MS + 1);
  await feedback.pollNow();
  expect(reads).toEqual([1, 2, 3, 1]);
  expect(announcements()).toEqual([...expected.slice(1), expected[0]]);
});

it("persists all terminal states before notifying throwing and awaiting subscribers", async () => {
  const states: string[][] = [];
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  stops.push(log.onEvent(event => {
    if (event.payload.state === "pr_feedback") {
      states.push(readPrRecords(dir).map(p => p.state));
      throw new Error("broken observer");
    }
  }));
  const observed: string[] = [];
  stops.push(log.onEvent(async event => {
    if (event.payload.state !== "pr_feedback") return;
    observed.push(String(event.payload.text));
    await held;
  }));
  try {
    await feedback.pollNow();
    expect(announcements()).toEqual(expected);
    expect(observed).toEqual(expected);
    expect(states).toEqual(Array.from({ length: 3 }, () => ["MERGED", "CLOSED", "CLOSED"]));
    expect(warning).toHaveBeenCalledTimes(3);
    await feedback.pollNow();
    expect(announcements()).toEqual(expected);
  } finally { release(); }
});

it("cancels the learner's gh read on shutdown and never starts its follow-up comments read", async () => {
  let signal: AbortSignal | undefined;
  let finish!: (error: null, stdout: string) => void;
  vi.mocked(execFile).mockImplementation(((_command: string, _args: string[], options: { signal: AbortSignal }, callback: typeof finish) => {
    signal = options.signal;
    finish = callback;
  }) as typeof execFile);
  const stop = watchMergedPrs(brain, log, dir);
  stops.push(stop);
  log.append({ kind: "status", payload: { state: "pr_feedback", text: "PR #1 merged", url: url(1) } });
  await waitUntil(() => signal !== undefined);
  expect(signal!.aborted).toBe(false);
  stop();
  expect(signal!.aborted).toBe(true);
  // Even a successful read delivered during shutdown must not spawn gh api
  // after the runtime (and, in integration tests, its fake PATH) has changed.
  finish(null, JSON.stringify({ title: "Late result" }));
  await new Promise(resolve => setImmediate(resolve));
  expect(execFile).toHaveBeenCalledOnce();
  expect(brain.knowledge.hasLearnedPr(url(1))).toBe(false);
});

it.each(["flushIntakePrs", "completeLinearIssues"] as const)("announces every terminal PR before %s waits or rejects", async hook => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const integration = vi.spyOn(intake, hook).mockImplementation(async () => {
    await held;
    throw new Error("integration unavailable");
  });
  const polling = feedback.pollNow();
  try {
    await waitUntil(() => integration.mock.calls.length > 0);
    expect(announcements()).toEqual(expected);
  } finally { release(); await polling; }
  expect(announcements()).toEqual(expected);
  expect(readPrRecords(dir).map(p => p.state)).toEqual(["MERGED", "CLOSED", "CLOSED"]);
});
