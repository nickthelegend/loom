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
  chatUrl,
  explainStatus,
  isExhausted,
  modelsUrl,
  requestHeaders,
  resolveProvider,
  type ResolvedProvider,
} from "../core/providers.js";
import { AdapterBase } from "./base.js";

/** One turn of the conversation, as the wire wants it. */
interface WireMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
    this.opts = options as ModelAdapterOptions;
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

  /** Loom's memory file is the system prompt here — there's nowhere else to put it. */
  private systemPrompt(): string {
    return [this.opts.system, `You are "${this.id}", one agent in a Loom project.`]
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
    const chain = this.chain();
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

  /** One attempt at one model. Streams as it goes. */
  private async turn(
    p: ResolvedProvider,
    model: string,
    started: number,
  ): Promise<{ ok: true } | { ok: false; error: string; retryable: boolean }> {
    const messages: WireMessage[] = [
      { role: "system", content: this.systemPrompt() },
      ...this.history.slice(-(this.opts.history ?? DEFAULT_HISTORY)),
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

    if (out.text.trim()) this.history.push({ role: "assistant", content: out.text });
    this.emit({
      kind: "run_complete",
      payload: {
        durationMs: Date.now() - started,
        model,
        provider: p.id,
        ...(out.usage
          ? {
              inputTokens: out.usage.prompt_tokens ?? 0,
              outputTokens: out.usage.completion_tokens ?? 0,
              // Free means free: a number Loom didn't measure is worse than none.
              ...(p.free(model) ? { costUsd: 0 } : {}),
            }
          : {}),
      },
    });
    return { ok: true };
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
  ): Promise<{ text: string; usage?: Record<string, number>; error?: string }> {
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let pending = "";
    let usage: Record<string, number> | undefined;

    // Emit on sentence-ish boundaries rather than per token: one event per
    // token would be a few hundred rows in the log for one paragraph.
    const flush = (force = false) => {
      if (!pending) return;
      if (!force && pending.length < 80 && !/[.!?\n]\s*$/.test(pending)) return;
      this.emit({ kind: "message", payload: { text: pending, model } });
      text += pending;
      pending = "";
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
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
            usage?: Record<string, number>;
            error?: { message?: string };
          };
          try {
            frame = JSON.parse(data);
          } catch {
            continue; // a partial frame; the next chunk completes it
          }
          if (frame.error?.message) return { text, error: frame.error.message };
          if (frame.usage) usage = frame.usage;
          const delta = frame.choices?.[0]?.delta;
          if (delta?.reasoning_content) {
            this.emit({
              kind: "message",
              payload: { text: delta.reasoning_content, reasoning: true, model },
            });
          }
          if (delta?.content) {
            pending += delta.content;
            flush();
          }
        }
      }
    } catch (err) {
      flush(true);
      if (this.interrupted) return { text };
      return { text, error: `the stream broke: ${String((err as Error).message)}` };
    }
    flush(true);
    return { text, ...(usage ? { usage } : {}) };
  }
}
