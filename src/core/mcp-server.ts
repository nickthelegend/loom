/**
 * Loom's MCP tool surface. Inspired by T3 Code's McpHttpServer and toolkits
 * (https://github.com/pingdotgg/t3code, MIT). No T3 implementation is copied.
 * Both transports use the caller's DaemonClient, preserving the REST auth wall.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DaemonClient } from "../daemon/client.js";
import { VERSION } from "../version.js";
import { turnOutcome } from "./turn-wait.js";

export const MCP_PROTOCOL = "2025-06-18";
const id = z.string().trim().min(1).max(500);
const text = z.string().trim().min(1).max(100_000);
const project = { project: id };
const wait = { wait: z.boolean().optional(), timeoutMs: z.number().int().min(1).max(300_000).optional() };
const selection = { chat: id.optional(), agent: id.optional(), model: id.optional(), effort: id.optional() };
const pause = () => new Promise(resolve => setTimeout(resolve, 100));

type Tool = {
  name: string; description: string; schema: z.ZodObject; destructive: boolean; readOnly: boolean;
  call: (client: DaemonClient, args: any) => Promise<unknown>;
};
function tool<T extends z.ZodRawShape>(name: string, description: string, shape: T, mode: "read" | "add" | "act",
  call: (client: DaemonClient, args: z.infer<z.ZodObject<T>>) => Promise<unknown>): Tool {
  return { name: `loom_${name}`, description, schema: z.strictObject(shape), readOnly: mode === "read", destructive: mode === "act", call };
}

const tools: Tool[] = [
  tool("status", "Accessible project statuses, or one project's status.", { project: id.optional() }, "read",
    (c, a) => a.project ? c.project(a.project) : c.listProjects()),
  tool("projects", "List the projects accessible to this credential.", {}, "read", c => c.listProjects()),
  tool("agents", "List project agents with their available models.", project, "read", async (c, a) => {
    const { project: p } = await c.project(a.project);
    return { agents: await Promise.all(p.agents.map(async agent => ({ ...agent, models: (await c.models(a.project, agent.id)).models }))) };
  }),
  tool("add_agents", "Add agent instances to a project.", { ...project, kind: id, model: id.optional(), count: z.number().int().min(1).max(100).optional() }, "add",
    (c, a) => c.addAgent(a.project, a.kind, { model: a.model, count: a.count })),
  tool("chats", "List project chats.", project, "read", (c, a) => c.chats(a.project)),
  tool("read_chat", "Read the last N messages in chronological order.", { ...project, chat: id.optional(), limit: z.number().int().min(1).max(1000).optional() }, "read",
    (c, a) => c.chatMessages(a.project, a.chat ?? "main", a.limit ?? 50)),
  tool("send", "Send to a chat or agent. wait returns this request's reply or timedOut, including queued sends.", { ...project, text, ...selection, ...wait }, "act", async (c, a) => {
    const chat = a.chat ?? "main";
    const before = a.wait ? (await c.chatEvents(a.project, chat, { limit: 1 })).events.at(-1)?.id ?? 0 : 0;
    const requestId = randomUUID();
    const sent = await c.send(a.project, a.text, a.agent, { chat, model: a.model, effort: a.effort, requestId });
    if (!a.wait) return sent;
    const end = Date.now() + (a.timeoutMs ?? 60_000);
    const events = [] as Awaited<ReturnType<DaemonClient["events"]>>["events"];
    let cursor = before, started: number | undefined = sent.answered ? before : undefined;
    do {
      const page = (await c.events(a.project, cursor, 1000)).events;
      events.push(...page);
      cursor = page.at(-1)?.id ?? cursor;
      // A previous turn can finish between reading the cursor and submitting.
      // Wait for our dispatch receipt, including when it first enters the queue.
      started ??= events.find(e => e.kind === "status" && e.payload.state === "turn_started" &&
        e.payload.requestId === (sent.requestId ?? requestId))?.id;
      const outcome = started === undefined ? null : turnOutcome(events, sent.agentId, started, chat);
      if (outcome) return { ...sent, ...outcome, timedOut: false };
      await pause();
    } while (Date.now() < end);
    return { ...sent, timedOut: true };
  }),
  tool("steer", "Steer a running agent, or queue input if idle.", { ...project, text, chat: id.optional(), agent: id.optional() }, "act",
    (c, a) => c.steer(a.project, a.text, { chat: a.chat, agentId: a.agent })),
  tool("orchestra_start", "Start an Orchestra. workers contains fleet specs: agent@model:effort xN.", {
    ...project, goal: text, workers: z.array(id).min(1).max(100), orchestrator: id.optional(), maxParallel: z.number().int().min(1).max(100).optional(), plan: z.boolean().optional(),
  }, "act", (c, a) => c.startOrchestra(a.project, { goal: a.goal, workers: a.workers, orchestrator: a.orchestrator, maxParallel: a.maxParallel, plan: a.plan })),
  tool("orchestra_status", "Read one run, or list runs and the active run id.", { ...project, run: id.optional() }, "read",
    (c, a) => a.run ? c.orchestraRun(a.project, a.run) : c.orchestraRuns(a.project)),
  tool("compare", "Compare a prompt across entrants (fleet specs). Optionally wait for results.", { ...project, prompt: text, entrants: z.array(id).min(1).max(8), ...wait }, "act", async (c, a) => {
    let result = await c.compare(a.project, { prompt: a.prompt, entrants: a.entrants });
    if (!a.wait) return result;
    const end = Date.now() + (a.timeoutMs ?? 60_000);
    do {
      result = await c.orchestraRun(a.project, result.run.id);
      if (["completed", "failed", "aborted", "moved", "waiting_human"].includes(result.run.status)) return { ...result, timedOut: false };
      await pause();
    } while (Date.now() < end);
    return { ...result, timedOut: true };
  }),
  tool("brain_search", "Search the project brain.", { ...project, query: text, limit: z.number().int().min(1).max(50).optional() }, "read",
    (c, a) => c.searchBrain(a.project, a.query, { limit: a.limit })),
  tool("remember", "Record a decision, constraint or convention in the project brain.", { ...project, text, kind: z.enum(["decision", "constraint", "convention"]) }, "add",
    (c, a) => c.remember(a.project, a.kind, a.text)),
  tool("report", "Record worker progress. Requires this run's worker credential or an owner token. Does not complete the task.", {
    ...project, run: id, task: id, kind: z.enum(["checkpoint", "needs_input", "stuck", "done"]), text: z.string().max(4000).optional(),
  }, "add", (c, a) => c.report(a.project, a.run, a.task, { kind: a.kind, text: a.text })),
  tool("board", "List board tasks, or add a task (requires title).", { ...project, action: z.enum(["list", "add"]), title: text.optional(), agent: id.optional(), column: z.enum(["working", "needs-you", "in-review", "ready"]).optional() }, "add",
    (c, a) => { if (a.action === "list") return c.listTasks(a.project); if (!a.title) throw new Error("title is required to add a task"); return c.createTask(a.project, a.title, { agent: a.agent, column: a.column }); }),
];

export function mcpTools() {
  return tools.map(t => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema),
    annotations: { readOnlyHint: t.readOnly, destructiveHint: t.destructive, openWorldHint: true } }));
}
export function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Stateless JSON-RPC: notifications never run tools and receive no response. */
export async function mcpRequest(client: DaemonClient, input: unknown, instructions?: string) {
  if (!object(input) || input.jsonrpc !== "2.0" || typeof input.method !== "string" ||
      (input.id !== undefined && typeof input.id !== "string" && typeof input.id !== "number") ||
      (input.params !== undefined && !object(input.params))) return rpcError(null, -32600, "Invalid Request");
  if (input.id === undefined) return null;
  const id = input.id as string | number, params = input.params ?? {};
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  switch (input.method) {
    case "initialize": return result({ protocolVersion: MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "loom", version: VERSION }, ...(instructions ? { instructions } : {}) });
    case "ping": return result({});
    case "tools/list": return result({ tools: mcpTools() });
    case "tools/call": {
      const p = params as Record<string, unknown>;
      const t = tools.find(t => t.name === p.name);
      if (!t) return rpcError(id, -32602, "Unknown tool");
      const parsed = t.schema.safeParse(p.arguments ?? {});
      if (!parsed.success) return rpcError(id, -32602, parsed.error.message);
      try {
        const data = await t.call(client, parsed.data);
        return result({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result({ isError: true, content: [{ type: "text", text: message }], structuredContent: { error: message } });
      }
    }
    default: return rpcError(id, -32601, "Method not found");
  }
}
