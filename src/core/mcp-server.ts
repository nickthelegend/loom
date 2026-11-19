/**
 * Loom's MCP tool surface. Inspired by T3 Code's McpHttpServer and toolkits
 * (https://github.com/pingdotgg/t3code, MIT). No T3 implementation is copied.
 * Both transports use the caller's DaemonClient, preserving the REST auth wall.
 */
import { listResources, readResource, listPrompts, getPrompt } from "./agentic-r4/mcp-content.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type DaemonClient, DaemonError } from "../daemon/client.js";
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
  tool("scoreboard", "Recorded model standings for accessible projects.", { project: id.optional(), window: z.enum(["7d", "30d", "all"]).optional() }, "read",
    (c, a) => c.scoreboard(a.project ?? "all", a.window ?? "30d")),
  tool("fleets", "List saved machine-wide fleets. Requires an owner or unscoped device.", {}, "read", c => c.fleets()),
  tool("try", "Create or reopen a demo project on this machine. Requires an owner or unscoped device.", { dir: id.optional(), agents: z.number().int().min(1).max(8).optional() }, "add", (c, a) => c.tryProject(a)),
  tool("memory_list", "List project memories, optionally filtered by kind.", { ...project, kind: z.enum(["decision", "constraint", "convention", "fact", "failure", "task"]).optional(), limit: z.number().int().min(1).max(1000).optional() }, "read",
    (c, a) => c.brain(a.project, { kind: a.kind, limit: a.limit })),
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
  tool("queue", "Read the project prompt queue, or enqueue a prompt.", { ...project, text: text.optional(), chat: id.optional(), agent: id.optional() }, "add",
    (c, a) => a.text ? c.queueAdd(a.project, { text: a.text, chat: a.chat, target: a.agent }) : c.queue(a.project)),
  tool("approvals", "List pending project approvals.", project, "read", (c, a) => c.api("GET", `/api/projects/${encodeURIComponent(a.project)}/approvals`)),
  tool("orchestra_retry", "Retry a failed, blocked or stalled Orchestra task on an agent/model.", { ...project, run: id, task: id, agent: id }, "act",
    (c, a) => c.api("POST", `/api/projects/${encodeURIComponent(a.project)}/r4/retry`, { run: a.run, task: a.task, agent: a.agent })),
  tool("review", "Start a read-only review, or list reviews when agents is omitted.", { ...project, agents: z.array(id).min(1).optional(), text: text.optional(), file: id.optional(), focus: text.optional() }, "add",
    (c, a) => a.agents ? c.startReview(a.project, { agents: a.agents, text: a.text, file: a.file, focus: a.focus }) : c.reviews(a.project)),
  tool("costs", "Read project cost and token accounting.", project, "read", (c, a) => c.costs(a.project)),
  tool("triggers", "List project triggers and their recent runs.", project, "read", (c, a) => c.triggers(a.project)),
  tool("consult", "Ask another agent/model a read-only question during an active turn. No nested consults; usage belongs to the asking turn.",
    { ...project, chat: id.optional(), agent: id.optional(), model: id.optional(), question: text }, "read",
    (c, a) => c.api("POST", `/api/projects/${encodeURIComponent(a.project)}/r4/consult`, a, 125_000)),

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
    case "initialize": return result({ protocolVersion: MCP_PROTOCOL, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "loom", version: VERSION }, ...(instructions ? { instructions } : {}) });
    case "ping": return result({});
    case "resources/list":
    case "resources/read":
    case "prompts/list":
    case "prompts/get": {
      try {
        const p = params as Record<string, unknown>;
        return result(input.method === "resources/list" ? await listResources(client)
          : input.method === "resources/read" ? await readResource(client, p.uri)
          : input.method === "prompts/list" ? await listPrompts(client) : await getPrompt(client, p.name, p.arguments));
      } catch (error) {
        if (input.method === "prompts/list" && error instanceof DaemonError && error.status === 403) return result({ prompts: [] });
        return rpcError(id, -32602, error instanceof Error ? error.message : String(error));
      }
    }
    case "tools/list": {
      try {
        const { projects } = await client.listProjects();
        const settings = await Promise.all(projects.map(p => client.api<{ disabledTools: string[] }>("GET", `/api/projects/${encodeURIComponent(p.id)}/r4/tools`)));
        return result({ tools: mcpTools().filter(t => !settings.length || settings.some(s => !s.disabledTools.includes(t.name))) });
      } catch (error) { return rpcError(id, -32603, String(error)); }
    }
    case "tools/call": {
      const p = params as Record<string, unknown>;
      const t = tools.find(t => t.name === p.name);
      if (!t) return rpcError(id, -32602, "Unknown tool");
      const parsed = t.schema.safeParse(p.arguments ?? {});
      if (!parsed.success) return rpcError(id, -32602, parsed.error.message);
      const args = parsed.data as Record<string, unknown>;
      let target = typeof args.project === "string" ? args.project : undefined;
      const started = Date.now();
      let failure: string | undefined;
      try {
        if (!target) {
          const { projects } = await client.listProjects();
          if (projects.length) {
            const policies = await Promise.all(projects.map(async p => ({ id: p.id, settings: await client.api<{ disabledTools: string[] }>("GET", `/api/projects/${encodeURIComponent(p.id)}/r4/tools`) })));
            target = (policies.find(p => !p.settings.disabledTools.includes(t.name)) ?? policies[0])!.id;
          }
        }
        if (target) {
          const settings = await client.api<{ disabledTools: string[] }>("GET", `/api/projects/${encodeURIComponent(target)}/r4/tools`);
          if (settings.disabledTools.includes(t.name)) throw new Error(`${t.name} is disabled for this project`);
        }
        const data = await t.call(client, parsed.data);
        return result({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failure = message;
        return result({ isError: true, content: [{ type: "text", text: message }], structuredContent: { error: message } });
      } finally {
        if (target) await client.api("POST", `/api/projects/${encodeURIComponent(target)}/r4/log`, { tool: t.name, durationMs: Date.now() - started, ok: !failure, ...(failure ? { error: failure.slice(0, 4000) } : {}) }).catch(() => {});
      }
    }
    default: return rpcError(id, -32601, "Method not found");
  }
}
