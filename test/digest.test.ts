/**
 * What happened while you were away.
 *
 * A digest is only worth reading if every line is true, so the rule here is
 * that nothing is written without an event behind it. These tests feed it a
 * night's worth of events and check it says what happened — and nothing else.
 */

import { describe, expect, it } from "vitest";

import { digest, MAX_LINES } from "../src/core/digest.js";
import type { LoomEvent } from "../src/types.js";

let id = 0;
const ev = (kind: string, payload: Record<string, unknown>, opts: { ts?: number; agentId?: string; chat?: string } = {}): LoomEvent =>
  ({
    id: ++id,
    ts: opts.ts ?? Date.now(),
    kind: kind as LoomEvent["kind"],
    payload,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.chat ? { chat: opts.chat } : {}),
  }) as LoomEvent;

describe("reading a night back", () => {
  it("says what happened, newest first, each line pointing at its event", () => {
    const t = Date.now();
    const events = [
      ev("orchestra", { phase: "started", goal: "rework billing", runId: "o1" }, { ts: t - 5000 }),
      ev("run_complete", { costUsd: 0.4 }, { ts: t - 4000, agentId: "codex" }),
      ev("needs_input", { question: "Which database should I migrate first?" }, { ts: t - 3000, agentId: "claude-code", chat: "main" }),
      ev("orchestra", { phase: "completed", summary: "billing reworked", runId: "o1" }, { ts: t - 2000 }),
    ];
    const d = digest(events, t - 10_000, (a) => (a === "claude-code" ? "planner" : a));

    const kinds = d.lines.map((l) => l.kind);
    expect(kinds[0]).toBe("cost"); // the totals sit at the top
    expect(d.turns).toBe(1);
    expect(d.costUsd).toBeCloseTo(0.4);

    const rest = d.lines.slice(1);
    expect(rest.map((l) => l.at)).toEqual([...rest.map((l) => l.at)].sort((a, b) => b - a)); // newest first
    expect(rest.find((l) => l.kind === "question")!.text).toContain("Which database");
    expect(rest.find((l) => l.kind === "question")!.text).toContain("planner"); // labelled as the UI labels it
    expect(rest.find((l) => l.kind === "question")!.chat).toBe("main"); // clickable
    expect(rest.every((l) => l.eventId > 0)).toBe(true);
    expect(d.waiting).toEqual(["planner"]);
  });

  it("ignores what happened before you left", () => {
    const t = Date.now();
    const d = digest(
      [
        ev("needs_input", { question: "old news" }, { ts: t - 90_000, agentId: "a" }),
        ev("needs_input", { question: "new news" }, { ts: t - 1000, agentId: "a" }),
      ],
      t - 10_000,
    );
    const texts = d.lines.map((l) => l.text).join(" ");
    expect(texts).toContain("new news");
    expect(texts).not.toContain("old news");
  });

  it("reports a landing, a failure and a dead server in their own words", () => {
    const t = Date.now();
    const d = digest(
      [
        ev("orchestra", { phase: "landing", landing: { state: "merged" }, runId: "o1" }, { ts: t - 4000 }),
        ev("orchestra", { phase: "failed", error: "the branch conflicted", runId: "o2" }, { ts: t - 3000 }),
        ev("status", { state: "server_crashed", server: "web", exitCode: 1 }, { ts: t - 2000 }),
        ev("error", { message: "codex refused the turn" }, { ts: t - 1000, agentId: "codex" }),
      ],
      t - 10_000,
    );
    const by = (k: string) => d.lines.find((l) => l.kind === k)?.text ?? "";
    expect(by("landed")).toMatch(/landed/);
    expect(by("server")).toContain("web");
    expect(by("server")).toContain("code 1");
    expect(by("failed")).toBeTruthy();
    expect(d.lines.some((l) => l.text.includes("codex refused the turn"))).toBe(true);
  });

  it("says nothing at all about a quiet night", () => {
    const d = digest([ev("tool_call", { name: "read" }, { ts: Date.now() })], Date.now() - 10_000);
    expect(d.lines).toEqual([]); // no turns, no cost, nothing worth a line
    expect(d.waiting).toEqual([]);
  });

  it("stays a digest when the night was busy", () => {
    const t = Date.now();
    const many = Array.from({ length: 200 }, (_, i) =>
      ev("needs_input", { question: `q${i}` }, { ts: t - 200_000 + i * 100, agentId: "a" }),
    );
    const d = digest(many, t - 300_000);
    expect(d.lines.length).toBeLessThanOrEqual(MAX_LINES);
    expect(d.lines[0]!.text).toContain("q199"); // and keeps the newest
  });
});
