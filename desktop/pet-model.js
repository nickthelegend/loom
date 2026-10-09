// What the Loom pet is doing, decided from what the agents are doing.
//
// Pure: the desktop shell polls the daemon (projects, and each lively
// project's latest events) and hands them here; the pet window only draws the
// mood and the bubble this returns. Kept out of main.js so it can be tested
// without Electron (test/pet-model.test.ts).

const DONE_FOR_MS = 8_000; // a finished turn cheers this long
const SLEEP_AFTER_MS = 90_000; // then, nothing happening, it dozes off

/** "loom-testbed" → "loom-testbed"; long names keep their start. */
const clip = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** One tool call, said the way you'd say it. */
export function describeTool(p) {
  const tool = String(p?.tool ?? "").toLowerCase();
  const what = clip(p?.summary ?? p?.command ?? "", 46);
  const failed = p?.ok === false || !!p?.error || (typeof p?.exitCode === "number" && p.exitCode !== 0);
  let s;
  if (/(todo|plan)/.test(tool)) s = "Updated the plan";
  else if (/(question|ask)/.test(tool)) s = "Asked you something";
  else if (/^(bash|shell|command|exec|run|terminal)/.test(tool) || p?.command) s = what ? `Ran ${what}` : "Ran a command";
  else if (/^(read|view|cat|open)/.test(tool)) s = what ? `Read ${what}` : "Read a file";
  else if (/(write|edit|patch|create|replace|multiedit)/.test(tool)) s = what ? `Edited ${what}` : "Edited a file";
  else if (/(grep|glob|search|find|list|ls)/.test(tool)) s = p?.server === "web" || /web/.test(tool) ? "Searched the web" : what ? `Searched ${what}` : "Searched the code";
  else if (/(fetch|browse|web)/.test(tool)) s = what ? `Opened ${what}` : "Browsed the web";
  else s = what || clip(tool, 30) || "Used a tool";
  return failed ? `${s} — failed` : s;
}

/** The latest thing worth saying about one agent's turn, from newest events backwards. */
function activity(events, agentId) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (agentId && e.agentId && e.agentId !== agentId) continue;
    const p = e.payload ?? {};
    if (e.kind === "tool_call") return describeTool(p);
    if (e.kind === "message" && e.agentId) return `Writing: ${clip(p.text, 52)}`;
    if (e.kind === "status" && p.state === "plan_updated" && Array.isArray(p.plan)) {
      const done = p.plan.filter((x) => x.status === "completed").length;
      return `Working the plan ${done}/${p.plan.length}`;
    }
    if (e.kind === "file_edit") return `Edited ${clip(p.path ?? p.file ?? "a file", 46)}`;
    if (e.kind === "message" && !e.agentId) return "Reading your message";
  }
  return "Thinking…";
}

const label = (id) => {
  const k = String(id ?? "agent");
  return { "claude-code": "Claude", codex: "Codex", opencode: "OpenCode", "grok-code": "Grok", echo: "echo" }[k] ?? k;
};

function dur(ms) {
  const s = Math.round(Number(ms || 0) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * @param projects  GET /api/projects → projects
 * @param events    project id → its latest events (oldest first)
 * @param now       clock
 * @param lastBusyAt  when anything last happened, for dozing off
 * @returns {{ mood: "idle"|"sleep"|"work"|"alert"|"happy"|"sad", title: string, sub: string, project?: string, chat?: string|null }}
 */
export function petState(projects, events, now = Date.now(), lastBusyAt = now) {
  const list = Array.isArray(projects) ? projects : [];
  // Someone is waiting on you: that beats everything.
  for (const p of list) {
    if (!p.needsInput) continue;
    const ev = events[p.id] ?? [];
    const q = [...ev].reverse().find((e) => e.kind === "needs_input");
    const who = q?.agentId ?? p.holder;
    const text = q?.payload?.question ?? (Array.isArray(q?.payload?.questions) ? q.payload.questions[0]?.question : "");
    return { mood: "alert", title: `${label(who)} needs you`, sub: clip(text || p.name, 64), project: p.id, chat: q?.chat ?? null };
  }
  // Someone is working: say what, on the liveliest project.
  const busy = list.filter((p) => (p.agents ?? []).some((a) => a.busy));
  if (busy.length) {
    const latest = (p) => {
      const ev = events[p.id] ?? [];
      return ev.length ? ev[ev.length - 1].ts : 0;
    };
    const p = busy.sort((a, b) => latest(b) - latest(a))[0];
    const agents = (p.agents ?? []).filter((a) => a.busy);
    const ev = events[p.id] ?? [];
    const lastOf = [...ev].reverse().find((e) => e.agentId && agents.some((a) => a.id === e.agentId));
    const who = lastOf?.agentId ?? agents[0].id;
    const more = agents.length > 1 ? ` +${agents.length - 1}` : busy.length > 1 ? ` · ${busy.length} projects` : "";
    return { mood: "work", title: `${clip(p.name, 22)} · ${label(who)}${more}`, sub: activity(ev, who), project: p.id, chat: lastOf?.chat ?? null };
  }
  // Nobody is working. Did something just finish, or fail?
  let recent = null;
  for (const p of list) {
    for (const e of events[p.id] ?? []) {
      if ((e.kind === "run_complete" || (e.kind === "error" && e.agentId)) && now - e.ts < DONE_FOR_MS && (!recent || e.ts > recent.e.ts)) recent = { p, e };
    }
  }
  if (recent?.e.kind === "run_complete") {
    return { mood: "happy", title: `${label(recent.e.agentId)} is done`, sub: `${clip(recent.p.name, 24)} · ${dur(recent.e.payload?.durationMs)}`, project: recent.p.id, chat: recent.e.chat ?? null };
  }
  if (recent?.e.kind === "error") {
    return { mood: "sad", title: `${label(recent.e.agentId)} hit an error`, sub: clip(recent.e.payload?.message, 64), project: recent.p.id, chat: recent.e.chat ?? null };
  }
  return { mood: now - lastBusyAt > SLEEP_AFTER_MS ? "sleep" : "idle", title: "", sub: "" };
}
