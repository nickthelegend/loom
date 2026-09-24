/**
 * An agent that is a model, not a command.
 *
 * Every other adapter here wraps a CLI: spawn it, feed it stdin, parse what it
 * prints. That buys tools, a session and someone else's auth, and it costs
 * whatever that CLI's subscription costs — for every turn, including the ones
 * that are a sentence long.
 *
 * This one is an HTTP request. `POST {provider}/v1/chat/completions`, streamed,
 * with the conversation Loom already has. It has no tools yet (#87) and does
 * not pretend to: what it is good for is the work that is thinking rather than
 * editing — planning, reviewing, summarising, answering, routing — which is
 * most of what a fleet actually does between edits, and which free quota is
 * very happy to pay for.
 *
 * ## What it keeps
 *
 * The conversation. A CLI remembers its own session; this doesn't, so the
 * adapter holds the messages and sends them each turn. That is also why
 * `interrupt()` can be honest: aborting the request ends the turn, and what
 * was streamed before the abort stays in the transcript, because the person
 * saw it.
 *
 * ## What it refuses
 *
 * To guess. A model name that the provider doesn't have is an error at `send`
 * with the provider's own words, not a silent fallback to something else — the
 * one exception being an exhausted free pool, where trying the next model in
 * `fallbacks` is exactly what the person configured it for (#83).
 */

import type { SendInput } from "../types.js";
import {
  MAX_HOPS,
  applyRun,
  applyWrite,
  describeWrite,
  isWriteTool,
  runReadTool,
  toolsFor,
  type ToolCall,
  type ToolResult,
} from "../core/model-tools.js";
import { requestApproval } from "../core/approvals.js";
import { permissionFor } from "../core/permissions.js";
import {
  chatUrl,
  explainStatus,
  isExhausted,
  modelsUrl,
  requestHeaders,
  resolveProvider,
  specFor,
  type ResolvedProvider,
} from "../core/providers.js";
import { AdapterBase, type AgentCheck } from "./base.js";

/** One turn of the conversation, as the wire wants it. */
interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on an assistant turn that asked for tools. */
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  /** Set on the answer to one. */
  tool_call_id?: string;
}

export interface ModelAdapterOptions {
  provider?: string;
  model?: string;
  /** Tried in order when the provider says the pool is dry (402/429). */
  fallbacks?: string[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** How much conversation to send back each turn. */
  history?: number;
  /**
   * Let it read the project: read_file, list_files, search (core/model-tools).
   * Read-only, inside the project, bounded. Off unless asked for — a model
   * that can read your repository should be a decision, not a default.
   */
  tools?: boolean;
  /**
   * Let it write files too. Every write is a card you allow or deny, unless
   * the agent's permission mode is `bypass`.
   */
  write?: boolean;
  /**
   * Commands it may run, as prefixes: `["npm test", "npx tsc --noEmit"]`.
   * Without this there is no `run` tool at all — a shell a model can reach
   * is not something to have by default, and "allowed: nothing" is a tool
   * that lies.
   */
  run?: string[];
  /** bypass | auto | ask. See core/permissions.ts. */
  permissions?: string;
  /**
   * Which project this agent belongs to, for the approval card. Set by the
   * runtime when it builds the agent — the same field every adapter gets.
   */
  loomProject?: string;
}

/**
 * "openrouter/google/gemma-4-31b-it:free" → provider "openrouter", model
 * "google/gemma-4-31b-it:free".
 *
 * The model pickers list every provider's models in one list, so each id there
 * carries its provider in front. Stored as-is, that whole string went to the
 * provider as the model name — which no provider has — and the agent reported
 * itself unavailable. Only a prefix that IS a provider is split off: model
 * ids have slashes of their own ("google/…"), and those stay.
 */
export function splitQualifiedModel<T extends { model?: string; provider?: string }>(opts: T): T {
  const m = opts.model?.trim();
  if (!m || opts.provider) return opts;
  const cut = m.indexOf("/");
  if (cut <= 0) return opts;
  const head = m.slice(0, cut).toLowerCase();
  // "openai/…" is also how OpenRouter names OpenAI's models, so a bare
  // "openai/gpt-4o" means that model on the default provider — never split it.
  if (head === "openai" || !specFor(head)) return opts;
  return { ...opts, provider: head, model: m.slice(cut + 1) };
}

const DEFAULT_HISTORY = 24;
const DEFAULT_MAX_TOKENS = 4096;

export class ModelAdapter extends AdapterBase {
  private opts: ModelAdapterOptions;
  private history: WireMessage[] = [];
  private abort: AbortController | null = null;
  /** Set when a turn is cut short by us, so the error isn't reported as one. */
  private interrupted = false;

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, "model", projectDir);
    this.opts = splitQualifiedModel(options as ModelAdapterOptions);
  }

  private provider(): ResolvedProvider | null {
    return resolveProvider(this.opts.provider ?? "openrouter");
  }

  /** The models to try, in order: the configured one, then its fallbacks. */
  private chain(): string[] {
    const first = this.opts.model?.trim();
    const rest = (this.opts.fallbacks ?? []).map((m) => m.trim()).filter(Boolean);
    return [...(first ? [first] : []), ...rest.filter((m) => m !== first)];
  }

  /**
   * Reachable and usable: the provider answers, and the model is in its list.
   *
   * "Is a binary on PATH" has no meaning here, and neither does "did the key
   * parse" — the only useful answer is whether a turn would work.
   */
  async available(): Promise<boolean> {
    const p = this.provider();
    if (!p) return false;
    if (!p.key && p.id !== "ollama") return false;
    try {
      const res = await fetch(modelsUrl(p), { headers: requestHeaders(p) });
      if (!res.ok) return false;
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? []).map((m) => String(m.id));
      const want = this.chain();
      return want.length === 0 || want.some((m) => ids.includes(m));
    } catch {
      return false;
    }
  }

  async selfCheck(): Promise<AgentCheck[]> {
    const p = this.provider();
    if (!p) return [{ name: "provider", ok: false, detail: `unknown provider "${this.opts.provider ?? "openrouter"}"` }];
    const checks: AgentCheck[] = [];
    const keyed = !!p.key || p.id === "ollama";
    checks.push({ name: "key", ok: keyed, detail: keyed ? `${p.label} key is set` : `no ${p.label} key — add one in Settings → Models` });
    if (!keyed) return checks;
    try {
      const res = await fetch(modelsUrl(p), { headers: requestHeaders(p), signal: AbortSignal.timeout(10_000) });
      checks.push({ name: "reachable", ok: res.ok, detail: res.ok ? `${p.label} answers` : `${p.label} said ${res.status}` });
      if (!res.ok) return checks;
      const ids = (((await res.json()) as { data?: Array<{ id?: string }> }).data ?? []).map((m) => String(m.id));
      const want = this.chain();
      const hit = want.find((m) => ids.includes(m));
      checks.push({
        name: "model",
        ok: want.length === 0 || !!hit,
        detail: want.length === 0 ? "no model pinned — the provider picks" : hit ? `${hit} is listed` : `${want[0]} isn't in ${p.label}'s list any more`,
      });
    } catch (err) {
      checks.push({ name: "reachable", ok: false, detail: `couldn't reach ${p.label} — ${(err as Error).message}` });
    }
    return checks;
  }

  async start(): Promise<void> {
    this.emit({ kind: "status", payload: { state: "started", model: this.opts.model ?? "" } });
  }

  async stop(): Promise<void> {
    await this.interrupt();
    this.emit({ kind: "status", payload: { state: "stopped" } });
  }

  async interrupt(): Promise<void> {
    if (!this._busy) return;
    this.interrupted = true;
    this.abort?.abort();
  }

  /** The tools this agent may be offered — only ones it can really use. */
  private tools() {
    if (!this.opts.tools) return [];
    return toolsFor({
      ...(this.opts.write ? { write: true } : {}),
      ...(this.opts.run?.length ? { run: this.opts.run } : {}),
    });
  }

  /**
   * Run one tool call, asking first when the call changes something.
   *
   * `bypass` is the only mode that doesn't ask. `auto` and `ask` both do —
   * which is stricter than the CLI mapping, where `auto` lets an agent edit
   * freely, and deliberately so: a CLI in auto is one you installed and
   * signed into, and this is a model you picked off a list an hour ago.
   */
  private async runTool(call: ToolCall): Promise<ToolResult> {
    if (!isWriteTool(call.name)) return runReadTool(this.projectDir, call);

    const mode = permissionFor("model", this.opts as Record<string, unknown>);
    if (mode !== "bypass") {
      const summary =
        call.name === "write_file"
          ? describeWrite(this.projectDir, call)
          : `run ${String(call.args.command ?? "")}`;
      const decision = await requestApproval({
        project: this.opts.loomProject ?? "",
        agent: this.id,
        tool: call.name,
        input: call.args,
        summary,
      });
      if (decision.behavior !== "allow") {
        const why = decision.message ? `: ${decision.message}` : "";
        return {
          id: call.id,
          name: call.name,
          content: `Denied by the person${why}. Do not try again; say what you would have done instead.`,
          summary: `${call.name} denied${why}`,
          ok: false,
        };
      }
    }

    if (call.name === "write_file") {
      const result = applyWrite(this.projectDir, call);
      // The same event every other adapter emits when it edits: the turn diff
      // and the file tree are built from these.
      if (result.ok) this.emit({ kind: "file_edit", payload: { path: String(call.args.path ?? "") } });
      return result;
    }
    return applyRun(this.projectDir, call, this.opts.run ?? []);
  }

  /** Loom's memory file is the system prompt here — there's nowhere else to put it. */
  private systemPrompt(): string {
    return [
      this.opts.system,
      `You are "${this.id}", one agent in a Loom project.`,
      this.opts.tools
        ? [
            "You can read this project with read_file, list_files and search. Read before you describe code — a guess about a file you have not opened is worse than saying you have not opened it.",
            this.opts.write
              ? "You can write files with write_file. It replaces the whole file, so read it first unless you are creating it, and say in `why` what the change does — a person sees that and decides."
              : "You cannot write files.",
            this.opts.run?.length
              ? `You can run: ${this.opts.run.join(", ")}. Nothing else, and there is no shell.`
              : "You cannot run commands.",
          ].join(" ")
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`model agent "${this.id}" is busy`);
    const p = this.provider();
    if (!p) {
      throw new Error(
        `agent "${this.id}" names provider "${this.opts.provider ?? "openrouter"}", which isn't configured — \`loom providers\``,
      );
    }
    if (!p.key && p.id !== "ollama") {
      throw new Error(`${p.label} has no key — \`loom providers set ${p.id} --key …\``);
    }
    // A thread can pin a model (types.ts SendInput.model): it takes the place
    // of the configured one for this turn, and the fallbacks still apply.
    const chain = input.model ? [input.model, ...this.chain().filter((m) => m !== input.model)] : this.chain();
    if (!chain.length) throw new Error(`agent "${this.id}" has no model set — \`loom model ${this.id} <name>\``);

    this._busy = true;
    this.interrupted = false;
    const started = Date.now();
    try {
      // The briefing rides with the turn, exactly as it does for a CLI: it is
      // context for this turn, not a permanent part of the conversation.
      const text = input.briefing ? `${input.briefing}\n\n---\n\n${input.text}` : input.text;
      this.history.push({ role: "user", content: text });

      let lastError = "";
      for (const [i, model] of chain.entries()) {
        if (this.interrupted) break;
        if (i > 0) {
          // Say it once, in the thread, so a turn that answered on the second
          // model never looks like it answered on the first.
          this.emit({
            kind: "status",
            payload: { state: "model_fallback", from: chain[i - 1], to: model, reason: lastError },
          });
        }
        const result = await this.turn(p, model, started);
        if (result.ok) return;
        lastError = result.error;
        if (!result.retryable) break;
      }
      if (this.interrupted) {
        this.emit({ kind: "status", payload: { state: "interrupted" } });
        return;
      }
      this.emit({ kind: "error", payload: { message: lastError || "the model didn't answer" } });
    } finally {
      this._busy = false;
      this.abort = null;
    }
  }

  /**
   * One attempt at one model, including however many tool hops it asks for.
   *
   * The loop is bounded: a model that keeps reading and never answers is
   * spending someone's quota in a circle, so after MAX_HOPS it is told to
   * answer with what it has rather than being cut off mid-thought.
   */
  private async turn(
    p: ResolvedProvider,
    model: string,
    started: number,
  ): Promise<{ ok: true } | { ok: false; error: string; retryable: boolean }> {
    const scratch: WireMessage[] = [];
    let answered = "";
    let totals: Record<string, number> | undefined;

    for (let hop = 0; ; hop++) {
      const step = await this.once(p, model, scratch, hop);
      if (!step.ok) return step;
      answered += step.text;
      if (step.usage) {
        totals = totals ?? {};
        for (const [k, v] of Object.entries(step.usage)) {
          if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
        }
      }
      if (!step.calls.length) break;

      // What it asked for, and what it got — in the thread, like any agent's
      // tool use, because work nobody can see is work nobody can check.
      scratch.push({
        role: "assistant",
        content: step.text,
        tool_calls: step.calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      });
      for (const call of step.calls) {
        const result = await this.runTool(call);
        this.emit({
          kind: "tool_call",
          payload: { name: call.name, args: call.args, summary: result.summary, ok: result.ok },
        });
        scratch.push({ role: "tool", tool_call_id: call.id, content: result.content });
      }
      if (hop + 1 >= MAX_HOPS) {
        scratch.push({
          role: "user",
          content: `You have used ${MAX_HOPS} tool calls on this turn. Answer now with what you have.`,
        });
      }
      if (this.interrupted) return { ok: false, error: "interrupted", retryable: false };
    }

    if (answered.trim()) this.history.push({ role: "assistant", content: answered });
    this.emit({
      kind: "run_complete",
      payload: {
        durationMs: Date.now() - started,
        model,
        provider: p.id,
        ...(totals
          ? {
              inputTokens: totals.prompt_tokens ?? 0,
              outputTokens: totals.completion_tokens ?? 0,
              ...(p.free(model) ? { costUsd: 0 } : {}),
            }
          : {}),
      },
    });
    return { ok: true };
  }

  /** One request. Returns what was said and what it asked to run. */
  private async once(
    p: ResolvedProvider,
    model: string,
    scratch: WireMessage[],
    hop: number,
  ): Promise<
    | { ok: true; text: string; calls: ToolCall[]; usage?: Record<string, number> }
    | { ok: false; error: string; retryable: boolean }
  > {
    const messages: WireMessage[] = [
      { role: "system", content: this.systemPrompt() },
      ...this.history.slice(-(this.opts.history ?? DEFAULT_HISTORY)),
      ...scratch,
    ];
    this.abort = new AbortController();

    let res: Response;
    try {
      res = await fetch(chatUrl(p), {
        method: "POST",
        headers: requestHeaders(p),
        signal: this.abort.signal,
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
          // Offered only when the project asked for it, and never past the
          // hop budget — the last request of a turn must be an answer.
          ...(this.tools().length && hop < MAX_HOPS ? { tools: this.tools() } : {}),
        }),
      });
    } catch (err) {
      if (this.interrupted) return { ok: false, error: "interrupted", retryable: false };
      return { ok: false, error: `couldn't reach ${p.label}: ${String((err as Error).message)}`, retryable: false };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: explainStatus(res.status, body, p),
        // A dry pool is the case fallbacks exist for; a wrong model name is not.
        retryable: isExhausted(res.status),
      };
    }
    if (!res.body) return { ok: false, error: `${p.label} sent no body`, retryable: false };

    const out = await this.readStream(res.body, model);
    if (this.interrupted) return { ok: false, error: "interrupted", retryable: false };
    if (out.error) return { ok: false, error: out.error, retryable: false };
    return { ok: true, text: out.text, calls: out.calls, ...(out.usage ? { usage: out.usage } : {}) };
  }

  /**
   * Read the SSE stream, emitting as it arrives.
   *
   * Reasoning deltas come back on their own field and are emitted as
   * reasoning, which the thread already renders differently — a model that
   * thinks out loud shouldn't have its thinking read as its answer.
   */
  private async readStream(
    body: ReadableStream<Uint8Array>,
    model: string,
  ): Promise<{ text: string; calls: ToolCall[]; usage?: Record<string, number>; error?: string }> {
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let thought = "";
    let usage: Record<string, number> | undefined;
    // Tool calls stream in pieces too: the name arrives once, the arguments
    // in fragments, keyed by index.
    const partial = new Map<number, { id: string; name: string; args: string }>();

    // Every token goes to the live view as it lands; the log gets the reply
    // once, whole. It used to log a message per sentence, which read in the
    // thread as a reply chopped into a stack of separate bubbles.
    const flush = () => {
      if (thought.trim()) this.emit({ kind: "message", payload: { text: thought, reasoning: true, model } });
      if (text.trim()) this.emit({ kind: "message", payload: { text, model } });
      thought = "";
    };

    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let frame: {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
            usage?: Record<string, number>;
            error?: { message?: string };
          };
          try {
            frame = JSON.parse(data);
          } catch {
            continue; // a partial frame; the next chunk completes it
          }
          if (frame.error?.message) {
            flush();
            return { text, calls: [], error: frame.error.message };
          }
          if (frame.usage) usage = frame.usage;
          const delta = frame.choices?.[0]?.delta;
          if (delta?.reasoning_content) {
            thought += delta.reasoning_content;
            this.streamText(delta.reasoning_content, true);
          }
          if (delta?.content) {
            text += delta.content;
            this.streamText(delta.content);
          }
          for (const tc of delta?.tool_calls ?? []) {
            const at = tc.index ?? 0;
            const have = partial.get(at) ?? { id: "", name: "", args: "" };
            partial.set(at, {
              id: tc.id ?? have.id,
              name: tc.function?.name ?? have.name,
              args: have.args + (tc.function?.arguments ?? ""),
            });
          }
        }
      }
    } catch (err) {
      flush();
      if (this.interrupted) return { text, calls: [] };
      return { text, calls: [], error: `the stream broke: ${String((err as Error).message)}` };
    }
    flush();
    // Arguments that don't parse are a call we can't honestly run, so it is
    // dropped rather than guessed at — the model gets no result for it and
    // says what it can.
    const calls: ToolCall[] = [];
    for (const [i, c] of partial) {
      if (!c.name) continue;
      try {
        calls.push({ id: c.id || `call_${i}`, name: c.name, args: JSON.parse(c.args || "{}") });
      } catch {
        /* unparseable arguments: not a call we can run */
      }
    }
    return { text, calls, ...(usage ? { usage } : {}) };
  }
}
