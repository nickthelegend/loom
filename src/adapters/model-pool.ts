import { createHash } from "node:crypto";
import type { Adapter, AgentConfig, SendInput } from "../types.js";
import { AdapterBase } from "./base.js";

/** Keeps process-bound model choices warm while preserving one public agent identity.
 * Turns still use the runtime's agent lock, so events and interrupts belong to one chat.
 */
export class ModelPool extends AdapterBase {
  override readonly capabilities;
  private readonly instances = new Map<string, Adapter>();
  private readonly starting = new Map<Adapter, Promise<void>>();
  private stopped = false;
  private interrupted = false;
  /** The turn has been handed to an instance (vs. still starting it). */
  private dispatched = false;
  /** Which send owns _busy/dispatched: a new turn may start before the last one's finally runs. */
  private turn = 0;
  private active: Adapter;
  private readonly defaultModel: unknown;
  private readonly defaultEffort: unknown;
  /** Present only when the wrapped kind can answer questions — the runtime duck-types it. */
  respondToUserInput?: (chat: string, requestId: string, answers: Record<string, unknown>) => Promise<void>;
  /** Present only when the wrapped kind can take input mid-turn (#373); goes to the running instance. */
  steer?: (chat: string, text: string) => Promise<boolean>;

  constructor(private readonly cfg: AgentConfig, dir: string, private readonly initial: Adapter,
    private readonly build: (cfg: AgentConfig) => Adapter) {
    super(cfg.id, cfg.kind, dir);
    this.capabilities = initial.capabilities;
    this.active = initial;
    this.defaultModel = cfg.options?.model;
    this.defaultEffort = cfg.options?.effort;
    this.instances.set(this.key(cfg.options?.model, cfg.options?.effort), initial);
    this.watch(initial);
    if (typeof initial.steer === "function") {
      this.steer = (chat, text) => {
        const run = this.active.steer;
        return this.dispatched && run ? run.call(this.active, chat, text) : Promise.resolve(false);
      };
    }
    if (typeof initial.respondToUserInput === "function") {
      // the question belongs to whichever instance ran the turn that asked it
      this.respondToUserInput = (chat, requestId, answers) => {
        const answer = this.active.respondToUserInput;
        if (!answer) throw new Error(`agent "${this.id}" can't take answers to questions`);
        return answer.call(this.active, chat, requestId, answers);
      };
    }
  }

  private key(model: unknown, effort: unknown): string { return JSON.stringify([model ?? null, effort ?? null]); }

  private watch(agent: Adapter): void {
    agent.onEvent(event => { if (this.active === agent) this.emit(event); });
    agent.onStream?.(delta => { if (this.active === agent) this.streamText(delta.text, delta.reasoning); });
  }

  available(): Promise<boolean> { return this.initial.available(); }
  override async selfCheck() { return this.initial instanceof AdapterBase ? this.initial.selfCheck() : super.selfCheck(); }
  private startInstance(agent: Adapter): Promise<void> {
    let start = this.starting.get(agent);
    if (!start) {
      start = agent.start();
      this.starting.set(agent, start);
      void start.catch(() => this.starting.delete(agent));
    }
    return start;
  }
  async start(): Promise<void> { await this.startInstance(this.initial); }
  async stop(): Promise<void> {
    this.stopped = true;
    const interrupted = await Promise.allSettled([this.interrupt()]);
    // A model may still be starting when the project closes. Stop it after startup,
    // otherwise a late server launch can survive the runtime that owned it.
    await Promise.allSettled(this.starting.values());
    const stopped = await Promise.allSettled([...this.instances.values()].map(agent => agent.stop()));
    this.starting.clear();
    const failed = [...interrupted, ...stopped].find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  override async injectMemory(projection: string): Promise<void> {
    await Promise.all([...this.instances.values()].map(agent => agent.injectMemory(projection)));
  }
  /**
   * Busy while starting an instance, then exactly as long as that instance is. The runtime reacts
   * to the instance's completion event before this pool's own send() has unwound, and a stale
   * "busy" there defers config edits and refuses the queued follow-up.
   */
  override busy(): boolean {
    return this._busy && !(this.dispatched && !this.active.busy());
  }
  async interrupt(): Promise<void> { this.interrupted = true; await this.active.interrupt(); }
  override diff(): Promise<string> { return this.active.diff(); }

  async send(input: SendInput): Promise<void> {
    if (this.stopped) throw new Error(`agent "${this.id}" is stopped`);
    if (this.busy()) throw new Error(`agent "${this.id}" is busy`);
    this._busy = true;
    this.dispatched = false;
    const mine = ++this.turn;
    this.interrupted = false;
    try {
      // OpenCode's continuity path can switch models in its native session.
      const key = this.key(input.model ?? this.defaultModel, input.effort ?? this.defaultEffort);
      let agent = input.continuity ? this.initial : this.instances.get(key);
      if (!agent) {
        agent = this.build({ ...this.cfg, options: { ...this.cfg.options,
          ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) } });
        if (agent instanceof AdapterBase) agent.scopeNativeState(createHash("sha256").update(key).digest("hex"));
        this.instances.set(key, agent);
        this.watch(agent);
      }
      this.active = agent;
      await this.startInstance(agent);
      if (this.stopped) throw new Error(`agent "${this.id}" is stopped`);
      if (this.interrupted) { this.emit({ kind: "status", payload: { state: "interrupted" } }); return; }
      // Process-bound choices were supplied at construction; only continuity consumes them per turn.
      const { model: _model, effort: _effort, ...turn } = input;
      this.dispatched = true;
      await agent.send(input.continuity ? input : turn);
    } finally { if (this.turn === mine) { this._busy = false; this.dispatched = false; } }
  }
}
