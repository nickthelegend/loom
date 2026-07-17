/**
 * Searching a project: its code, and its conversations.
 *
 * The rail could find a file by name and nothing else — the least useful half
 * of search, since you remember a line rather than a filename. And the thread,
 * where a project's reasoning actually lives, wasn't searchable at all.
 *
 * Real repos and real logs here: git grep's output format is the thing under
 * test in half of these, and a mocked git would only prove this file agrees
 * with itself.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { searchChats, searchCode } from "../src/core/search.js";
import type { LoomEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

function repo(files: Record<string, string>, git = true): string {
  const dir = tmpDir("search");
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  if (git) execFileSync("git", ["init", "-q", "."], { cwd: dir, stdio: "ignore" });
  return dir;
}

/** A log with just enough shape for the searcher. */
function log(events: Partial<LoomEvent>[]): { list: () => LoomEvent[] } {
  const full = events.map((e, i) => ({
    id: i + 1,
    ts: 1_700_000_000_000 + i * 1000,
    kind: "message",
    payload: {},
    ...e,
  })) as LoomEvent[];
  return { list: () => full };
}

describe("search · code", () => {
  it("finds a line, not just a filename", async () => {
    const dir = repo({ "src/a.ts": "const answer = 42;\nconst other = 1;\n" });
    const { hits } = await searchCode(dir, "answer");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("src/a.ts");
    expect(hits[0]?.line).toBe(1);
    expect(hits[0]?.text).toContain("const answer = 42;");
  });

  it("is case-insensitive, because a search box is", async () => {
    const dir = repo({ "a.ts": "const Answer = 42;\n" });
    const { hits } = await searchCode(dir, "ANSWER");
    expect(hits).toHaveLength(1);
  });

  /**
   * The box is a search box. Someone typing `foo(bar)` means those characters,
   * and a regex there would make a paren a syntax error and blame them.
   */
  it("treats the query as text, not a regex", async () => {
    const dir = repo({ "a.ts": "call(foo(bar));\nnot a match\n" });
    const { hits } = await searchCode(dir, "foo(bar)");
    expect(hits).toHaveLength(1);
    // and a lone paren doesn't explode
    await expect(searchCode(dir, "(")).resolves.toBeTruthy();
  });

  it("finds a file you just wrote and haven't committed", async () => {
    const dir = repo({ "fresh.ts": "brand new line\n" });
    const { hits } = await searchCode(dir, "brand new");
    expect(hits.map((h) => h.path)).toContain("fresh.ts");
  });

  it("stays out of node_modules", async () => {
    const dir = repo({
      "mine.ts": "needle here\n",
      "node_modules/dep/index.js": "needle here too\n",
    });
    const { hits } = await searchCode(dir, "needle");
    expect(hits.map((h) => h.path)).toEqual(["mine.ts"]);
  });

  /** No repo, no index to lean on — the walk has to carry it. */
  it("works outside a git repo", async () => {
    const dir = repo({ "plain.txt": "findable line\n" }, false);
    const { hits } = await searchCode(dir, "findable");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("plain.txt");
  });

  it("returns nothing for an empty query rather than everything", async () => {
    const dir = repo({ "a.ts": "x\n" });
    expect((await searchCode(dir, "   ")).hits).toEqual([]);
  });

  it("finds nothing when there's nothing, without failing", async () => {
    const dir = repo({ "a.ts": "x\n" });
    const { hits } = await searchCode(dir, "definitely-not-in-here");
    expect(hits).toEqual([]);
  });
});

describe("search · chats", () => {
  const conversation = log([
    { id: 1, kind: "message", payload: { text: "we should use sqlite for the log" } },
    { id: 2, kind: "message", agentId: "codex", payload: { text: "agreed, node:sqlite needs 22.5" } },
    { id: 3, kind: "tool_call", agentId: "codex", payload: { tool: "shell", summary: "shell: npm test" } },
    { id: 4, kind: "error", agentId: "codex", payload: { message: "sqlite failed to open" } },
    { id: 5, kind: "message", chat: "side", payload: { text: "unrelated chatter" } },
  ]);

  it("finds your own message", () => {
    const { hits } = searchChats(conversation, "sqlite for the log");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.eventId).toBe(1);
  });

  /**
   * What you remember about a project is rarely the sentence you typed — it's
   * the answer you got, or the error you hit.
   */
  it("searches replies, tool calls and errors, not just your side", () => {
    const kinds = searchChats(conversation, "sqlite").hits.map((h) => h.kind);
    expect(kinds).toContain("message");
    expect(kinds).toContain("error");
    expect(searchChats(conversation, "npm test").hits[0]?.kind).toBe("tool_call");
  });

  it("returns newest first — you're looking for something you just saw", () => {
    const { hits } = searchChats(conversation, "sqlite");
    expect(hits[0]!.eventId).toBeGreaterThan(hits[hits.length - 1]!.eventId);
  });

  it("says which conversation each hit is in", () => {
    expect(searchChats(conversation, "unrelated").hits[0]?.chat).toBe("side");
    expect(searchChats(conversation, "sqlite for the log").hits[0]?.chat).toBe("main");
  });

  it("can be scoped to one chat", () => {
    expect(searchChats(conversation, "unrelated", { chat: "main" }).hits).toEqual([]);
    expect(searchChats(conversation, "unrelated", { chat: "side" }).hits).toHaveLength(1);
  });

  it("is case-insensitive", () => {
    expect(searchChats(conversation, "SQLITE").hits.length).toBeGreaterThan(0);
  });

  /**
   * A hit that shows the first 80 characters of a 4KB reply is a hit you can't
   * identify. The window goes around the match.
   */
  it("shows the text around the match, not the start of the message", () => {
    const long = log([
      { id: 1, payload: { text: "x".repeat(500) + " THE NEEDLE " + "y".repeat(500) } },
    ]);
    const snip = searchChats(long, "THE NEEDLE").hits[0]!.snippet;
    expect(snip).toContain("THE NEEDLE");
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
    expect(snip.length).toBeLessThan(200);
  });

  it("returns nothing for an empty query rather than the whole log", () => {
    expect(searchChats(conversation, "").hits).toEqual([]);
    expect(searchChats(conversation, "   ").hits).toEqual([]);
  });
});
