/**
 * The bridge to the Loom daemon.
 *
 * The pad is just another Loom surface: an agent key is a *handoff* (it locks
 * the baton to that agent — which shows up in the thread, the "process monitor"),
 * and a held-to-talk turn is a *message* sent to that agent. The agent's spoken
 * reply is polled back off the event stream.
 *
 * When the backend runs on the same machine as the daemon it bootstraps the
 * admin token over loopback, so there's nothing to configure. Every call throws
 * on failure so the caller can fall back to the standalone LLM.
 */

import { config } from "./config.mjs";

const cache = { token: null, projectId: null, agents: [] };

async function loomFetch(method, path, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(config.loom.url + path, {
      method,
      headers: {
        ...(cache.token ? { Authorization: `Bearer ${cache.token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw new Error(`loom ${method} ${path} → ${res.status}: ${text.slice(0, 160)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

/** Get an admin token + pick the project. Idempotent; safe to call often. */
export async function loomInit() {
  if (!cache.token) {
    if (config.loom.token) {
      cache.token = config.loom.token;
    } else {
      // Loopback bootstrap (same-machine only) — no auth header needed.
      const boot = await loomFetch("GET", "/api/bootstrap", null, 4000);
      if (!boot.token) throw new Error("loom bootstrap returned no token");
      cache.token = boot.token;
    }
  }
  if (!cache.projectId) {
    const { projects } = await loomFetch("GET", "/api/projects");
    if (!projects?.length) throw new Error("loom has no projects");
    const pick = config.loom.project
      ? projects.find((p) => p.id === config.loom.project)
      : projects[0];
    if (!pick) throw new Error(`loom project "${config.loom.project}" not found`);
    cache.projectId = pick.id;
    cache.agents = pick.agents.map((a) => a.id);
  }
  return { projectId: cache.projectId, agents: cache.agents };
}

/** Best-effort reachability, for choosing brain=loom vs the LLM fallback. */
export async function loomReachable() {
  try {
    await loomInit();
    return true;
  } catch {
    return false;
  }
}

export function loomAgents() {
  return cache.agents;
}

/** Lock the baton to an agent — the pad's "select". Returns {from, to}. */
export async function loomSelect(agent) {
  const { projectId } = await loomInit();
  return loomFetch("POST", `/api/projects/${projectId}/handoff`, { to: agent });
}

/** The newest event id, so we can poll for only what comes after our message. */
async function latestEventId(projectId) {
  const { events } = await loomFetch("GET", `/api/projects/${projectId}/events?limit=1`);
  return events?.length ? events[events.length - 1].id : 0;
}

/**
 * Send a spoken turn to an agent and wait for its reply.
 *
 * Selects the agent (handoff), sends the transcript as a message, then polls the
 * event stream for that agent's output until it completes or we time out.
 * Returns { reply, done }: `done:false` means the agent is still working and the
 * caller should speak a short "sent, check the thread" instead.
 */
export async function loomAsk(agent, transcript) {
  const { projectId, agents } = await loomInit();
  if (agents.length && !agents.includes(agent)) {
    throw new Error(`unknown agent "${agent}" (have: ${agents.join(", ")})`);
  }

  const sinceId = await latestEventId(projectId);
  await loomFetch("POST", `/api/projects/${projectId}/handoff`, { to: agent }).catch(() => {});
  await loomFetch("POST", `/api/projects/${projectId}/messages`, {
    text: config.loom.voiceHint + transcript,
    agentId: agent,
  });

  const deadline = Date.now() + config.loom.replyTimeoutMs;
  const parts = [];
  let done = false;
  while (Date.now() < deadline && !done) {
    await new Promise((r) => setTimeout(r, config.loom.pollMs));
    let events;
    try {
      ({ events } = await loomFetch("GET", `/api/projects/${projectId}/events?since=${sinceId}&limit=200`));
    } catch {
      continue; // transient — keep polling
    }
    for (const e of events || []) {
      if (e.id <= sinceId) continue;
      // The agent's own output (user messages carry no agentId).
      if (e.kind === "message" && e.agentId === agent) {
        const txt = String(e.payload?.text ?? "").trim();
        if (txt) parts.push(txt);
      } else if (e.kind === "run_complete") {
        done = true;
      } else if (e.kind === "error") {
        const msg = String(e.payload?.message ?? e.payload?.text ?? "agent error");
        if (!parts.length) throw new Error(`loom agent error: ${msg}`);
        done = true;
      }
    }
  }

  const reply = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, config.loom.maxSpeakChars);
  return { reply, done };
}
