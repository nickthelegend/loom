/**
 * Chats from your agents' own history (Claude Code, Codex, OpenCode), found
 * for a project's folder and read into a Loom thread. Against fixtures in each
 * tool's real on-disk shape.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { findChats, readChat, type ImportRoots } from "../src/core/chat-import.js";
import { tmpDir } from "./helpers.js";

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function fixtures(project: string): ImportRoots {
  const root = tmpDir("chat-import-roots");
  const slug = path.resolve(project).replace(/[^A-Za-z0-9]/g, "-");

  // Claude Code: one session here, one in a sibling folder whose name starts the same
  const claude = path.join(root, "claude");
  fs.mkdirSync(path.join(claude, slug), { recursive: true });
  fs.mkdirSync(path.join(claude, `${slug}-other`), { recursive: true });
  fs.writeFileSync(path.join(claude, slug, "c1.jsonl"), jsonl([
    { type: "queue-operation", operation: "enqueue" },
    { type: "user", cwd: project, entrypoint: "claude-desktop", timestamp: "2026-10-01T10:00:00Z", message: { role: "user", content: "<system-reminder>noise</system-reminder>Fix the login bug" } },
    { type: "assistant", cwd: project, timestamp: "2026-10-01T10:00:05Z", message: { model: "claude-x", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking at auth.ts." }, { type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } }] } },
    { type: "user", cwd: project, timestamp: "2026-10-01T10:00:06Z", message: { role: "user", content: [{ type: "tool_result", content: "file text" }] } },
    { type: "assistant", cwd: project, isSidechain: true, timestamp: "2026-10-01T10:00:07Z", message: { content: [{ type: "text", text: "subagent chatter" }] } },
    { type: "assistant", cwd: project, timestamp: "2026-10-01T10:00:09Z", message: { content: [{ type: "text", text: "Fixed: the token was compared as a string." }] } },
  ]));
  fs.writeFileSync(path.join(claude, `${slug}-other`, "c2.jsonl"), jsonl([
    { type: "user", cwd: `${project}-other`, timestamp: "2026-10-01T10:00:00Z", message: { content: "not this project" } },
  ]));

  // Codex: one here, one Loom started, one elsewhere
  const codex = path.join(root, "codex", "2026", "10", "02");
  fs.mkdirSync(codex, { recursive: true });
  const rollout = (id: string, cwd: string, originator: string, said: string) => jsonl([
    { timestamp: "2026-10-02T09:00:00Z", type: "session_meta", payload: { id, cwd, originator } },
    { timestamp: "2026-10-02T09:00:01Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }] } },
    { timestamp: "2026-10-02T09:00:02Z", type: "turn_context", payload: { model: "gpt-x" } },
    { timestamp: "2026-10-02T09:00:03Z", type: "event_msg", payload: { type: "user_message", message: said } },
    { timestamp: "2026-10-02T09:00:04Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["npm", "test"] }) } },
    { timestamp: "2026-10-02T09:00:05Z", type: "event_msg", payload: { type: "agent_message", message: "Tests pass." } },
  ]);
  fs.writeFileSync(path.join(codex, "rollout-a.jsonl"), rollout("cx-1", path.join(project, "sub"), "codex_cli_rs", "Run the tests"));
  fs.writeFileSync(path.join(codex, "rollout-b.jsonl"), rollout("cx-loom", project, "loom", "loom's own turn"));
  fs.writeFileSync(path.join(codex, "rollout-c.jsonl"), rollout("cx-else", "/elsewhere", "codex_cli_rs", "elsewhere"));

  // OpenCode: one session in each storage layout, one untitled
  const db = path.join(root, "opencode.db");
  const d = new DatabaseSync(db);
  d.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT, seq INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
  d.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("oc-new", null, project, "New session - 2026-10-03T00:00:00Z", 1791000000000);
  d.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("oc-old", null, project, "Refactor the store", 1790000000000);
  d.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("oc-child", "oc-old", project, "subtask", 1790000000001);
  d.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)").run("m1", "oc-new", "user", 1791000000000, JSON.stringify({ text: "===== LOOM SESSION MEMORY — x =====\nbrief\n===== end session memory — the user's message follows =====\nAdd dark mode" }), 1);
  d.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)").run("m2", "oc-new", "assistant", 1791000000001, JSON.stringify({ model: { id: "big-pickle", providerID: "opencode" }, content: [{ type: "tool", name: "edit", state: { input: { filePath: "app.css" } } }, { type: "text", text: "Done." }] }), 2);
  d.prepare("INSERT INTO message VALUES (?,?,?,?)").run("om1", "oc-old", 1790000000000, JSON.stringify({ role: "user" }));
  d.prepare("INSERT INTO message VALUES (?,?,?,?)").run("om2", "oc-old", 1790000000001, JSON.stringify({ role: "assistant" }));
  d.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run("p1", "om1", "oc-old", 1790000000000, JSON.stringify({ type: "text", text: "Refactor it" }));
  d.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run("p2", "om2", "oc-old", 1790000000001, JSON.stringify({ type: "tool", tool: "write", state: { input: { filePath: "store.js" } } }));
  d.prepare("INSERT INTO part VALUES (?,?,?,?,?)").run("p3", "om2", "oc-old", 1790000000002, JSON.stringify({ type: "text", text: "Refactored." }));
  d.close();

  return { claude, codex: path.join(root, "codex"), opencodeDb: db };
}

describe("chat import", () => {
  it("finds this folder's chats in all three tools, newest first, and flags the ones Loom ran", async () => {
    const project = tmpDir("chat-import-proj");
    const roots = fixtures(project);
    const found = await findChats(project, { roots, loomIds: new Set(["oc-old"]) });
    expect(found.map((c) => [c.source, c.id]).sort()).toEqual([
      ["claude-code", "c1"], ["codex", "cx-1"], ["codex", "cx-loom"], ["opencode", "oc-new"], ["opencode", "oc-old"],
    ]);
    const by = Object.fromEntries(found.map((c) => [c.id, c]));
    expect(by["c1"]!.title).toBe("Fix the login bug");
    expect(by["cx-1"]!.title).toBe("Run the tests");
    expect(by["cx-loom"]!.fromLoom).toBe(true); // Codex's originator says so
    expect(by["oc-old"]!.fromLoom).toBe(true); // Loom's own session id
    expect(by["oc-new"]).toMatchObject({ title: "Add dark mode", automated: true }); // opencode never titled it
  });

  it("reads a Claude chat: your words, the replies and a line per tool, without reminders, thinking or subagents", async () => {
    const project = tmpDir("chat-import-proj");
    const r = await readChat(project, "claude-code", "c1", { roots: fixtures(project) });
    expect(r.items.map((i) => [i.kind, "text" in i ? i.text : `${i.tool} ${i.summary}`])).toEqual([
      ["user", "Fix the login bug"],
      ["assistant", "Looking at auth.ts."],
      ["tool", "Read src/auth.ts"],
      ["assistant", "Fixed: the token was compared as a string."],
    ]);
  });

  it("reads Codex and both OpenCode layouts, and won't read a chat from another folder", async () => {
    const project = tmpDir("chat-import-proj");
    const roots = fixtures(project);
    const cx = await readChat(project, "codex", "cx-1", { roots });
    expect(cx.items.map((i) => ("text" in i ? i.text : `${i.tool} ${i.summary}`))).toEqual(["Run the tests", "shell npm test", "Tests pass."]);
    const ocNew = await readChat(project, "opencode", "oc-new", { roots });
    expect(ocNew.title).toBe("Add dark mode");
    expect(ocNew.items.map((i) => ("text" in i ? i.text : `${i.tool} ${i.summary}`))).toEqual(["Add dark mode", "edit app.css", "Done."]);
    const ocOld = await readChat(project, "opencode", "oc-old", { roots });
    expect(ocOld.items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    await expect(readChat(project, "codex", "cx-else", { roots })).rejects.toThrow(/no codex chat/);
  });
});
