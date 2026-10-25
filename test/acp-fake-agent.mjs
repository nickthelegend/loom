// A stand-in ACP agent (Agent Client Protocol over stdio, newline-delimited JSON-RPC) for
// test/acp.test.ts. What it does depends on the prompt: "run: <cmd>" asks permission to run a
// command, "edit" reports a diff, "slow" waits to be cancelled, "ask" ends on a question.
import fs from "node:fs";
import readline from "node:readline";

const log = (m) => process.env.FAKE_ACP_LOG && fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(m) + "\n");
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const sessions = new Set();
const waiting = new Map(); // our request id → resolve
let cancel = null;
let n = 0, myId = 1000;

const ask = (params) => new Promise((resolve) => { const id = myId++; waiting.set(id, resolve); send({ id, method: "session/request_permission", params }); });

process.stdout.write("a log line on stdout that isn't JSON\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method) log({ method: m.method, params: m.params });
  if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); return; }
  if (m.method === "session/cancel") { cancel?.(); return; }
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    case "session/new": { const id = `s${++n}`; sessions.add(id); return reply({ sessionId: id, modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "bypassPermissions" }] } }); }
    case "session/load":
      if (!sessions.has(m.params.sessionId)) return send({ id: m.id, error: { code: -32000, message: "no such session" } });
      update(m.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED HISTORY" } });
      return reply(null);
    case "session/set_mode": return reply(null);
    case "session/prompt": {
      const sid = m.params.sessionId;
      const text = m.params.prompt.map((p) => p.text).join("\n");
      update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking it over" } });
      update(sid, { sessionUpdate: "plan", entries: [{ content: "do it", priority: "high", status: "in_progress" }] });
      const run = /run: (.+)/.exec(text);
      if (run) {
        update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: `Run ${run[1]}`, kind: "execute", status: "pending", rawInput: { command: run[1] } });
        const r = await ask({ sessionId: sid, toolCall: { toolCallId: "t1", title: `Run ${run[1]}`, kind: "execute", rawInput: { command: run[1] } },
          options: [{ optionId: "yes-once", name: "Allow", kind: "allow_once" }, { optionId: "yes-always", name: "Always", kind: "allow_always" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
        const outcome = r?.outcome?.outcome === "selected" ? r.outcome.optionId : "cancelled";
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: outcome.startsWith("yes") ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: `ran: ${outcome}` } }] });
        update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission: ${outcome}` } });
      }
      if (/edit/.test(text)) {
        update(sid, { sessionUpdate: "tool_call", toolCallId: "t2", title: "Write a.txt", kind: "edit", status: "completed", rawInput: { path: "a.txt" }, content: [{ type: "diff", path: "a.txt", oldText: null, newText: "x" }] });
      }
      if (/slow/.test(text)) { await new Promise((r) => { cancel = r; }); cancel = null; return reply({ stopReason: "cancelled" }); }
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: /ask/.test(text) ? "which file should I change?" : `from ACP (${sid}): ${text.split("\n").pop()}` } });
      return reply({ stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 34 } });
    }
    default: return send({ id: m.id, error: { code: -32601, message: "unknown" } });
  }
});
