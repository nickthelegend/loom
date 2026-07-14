/**
 * ProjectRuntime — one live project inside the daemon: its event log, its
 * agents, and its baton. All mutations flow through here so the log stays
 * the single source of truth.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  AnyAgent,
  LoomEvent,
  ProjectConfig,
  ProjectInfo,
  ProjectStatus,
  SendInput,
} from "../types.js";
import { isAdapter } from "../types.js";
import { createAgent } from "../adapters/index.js";
import { BatonManager, NotHolderError } from "../core/baton.js";
import { EventLog } from "../core/eventlog.js";
import { notify } from "../core/notify.js";
import { buildBriefing, buildProjection } from "../core/projection.js";
import {
  projectLoomDir,
  readProjectConfig,
  writeMemoryFile,
} from "../core/registry.js";
import { suggestHandoff } from "../core/suggestions.js";

const PROJECTION_WINDOW = 400; // recent events distilled on handoff

export class ProjectRuntime {
  readonly info: ProjectInfo;
  readonly config: ProjectConfig;
  readonly log: EventLog;
  readonly baton: BatonManager;
  private agents = new Map<string, AnyAgent>();
  private startedAgents = new Set<string>();
  private configMtime = 0;

  private constructor(info: ProjectInfo, config: ProjectConfig, log: EventLog) {
    this.info = info;
    this.config = config;
    this.log = log;
    this.baton = new BatonManager(info.dir, log);

    for (const agentCfg of config.agents) {
      const agent = createAgent(agentCfg, info.dir);
      this.agents.set(agentCfg.id, agent);
      agent.onEvent((e) => {
        const event = this.log.append({ kind: e.kind, agentId: agent.id, payload: e.payload });
        this.afterAgentEvent(event);
      });
    }
  }

  static async open(info: ProjectInfo): Promise<ProjectRuntime> {
    const config = readProjectConfig(info.dir);
    if (!config) throw new Error(`project at ${info.dir} has no .loom/config.json — run loom init`);
    const log = await EventLog.open(projectLoomDir(info.dir));
    const rt = new ProjectRuntime(info, config, log);
    rt.configMtime = configMtimeOf(info.dir);
    return rt;
  }

  /** Has .loom/config.json changed since this runtime was opened? */
  configStale(): boolean {
    return configMtimeOf(this.info.dir) > this.configMtime;
  }

  /** Any adapter mid-turn? (Hot reloads are deferred while work is in flight.) */
  anyBusy(): boolean {
    return [...this.agents.values()].some((a) => isAdapter(a) && a.busy());
  }

  agent(id: string): AnyAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`unknown agent "${id}" in project "${this.info.name}"`);
    return agent;
  }

  private async ensureStarted(agentId: string): Promise<AnyAgent> {
    const agent = this.agent(agentId);
    if (!this.startedAgents.has(agentId)) {
      await agent.start();
      this.startedAgents.add(agentId);
    }
    return agent;
  }

  /** Fire-and-notify hooks + suggested handoffs, driven off the log. */
  private afterAgentEvent(event: LoomEvent): void {
    if (event.kind === "needs_input") {
      notify({
        title: `Loom · ${this.info.name}`,
        body: `${event.agentId} needs input: ${String(event.payload.question ?? "")}`,
      });
    } else if (event.kind === "run_complete") {
      notify({
        title: `Loom · ${this.info.name}`,
        body: `${event.agentId} finished its turn`,
      });
    } else if (event.kind === "message") {
      const suggestion = suggestHandoff(event, this.config, this.baton.holder());
      if (suggestion) {
        this.log.append({ kind: "suggestion", payload: { ...suggestion, from: event.agentId } });
      }
    }
  }

  /**
   * Send a user message. Routing rules (decided in the design interview):
   *  - no explicit agent → goes to the baton holder (or defaultAgent/first
   *    adapter on first contact, which acquires the baton);
   *  - explicit agent that is NOT the holder → NotHolderError; surfaces
   *    prompt the user to confirm a handoff (explicit, never silent).
   */
  async sendMessage(text: string, agentId?: string): Promise<{ agentId: string }> {
    let target = agentId ?? this.baton.holder() ?? this.defaultAdapterId();
    const agent = this.agent(target);
    if (!isAdapter(agent)) {
      throw new Error(`agent "${target}" is a bridge (read-only) — it cannot take turns`);
    }

    const holder = this.baton.holder();
    if (holder === null) {
      this.baton.acquire(target);
    } else if (holder !== target) {
      throw new NotHolderError(target, holder);
    }

    this.log.append({ kind: "message", payload: { text, author: "user" } });
    await this.ensureStarted(target);

    const pendingBriefing = this.consumePendingBriefing(target);
    const input: SendInput = pendingBriefing ? { text, briefing: pendingBriefing } : { text };
    // Fire-and-notify: the turn runs in the background; progress streams
    // into the log and completion lands as run_complete.
    void agent.send(input).catch((err) => {
      this.log.append({
        kind: "error",
        agentId: target,
        payload: { message: String(err instanceof Error ? err.message : err) },
      });
    });
    return { agentId: target };
  }

  private defaultAdapterId(): string {
    const cfg =
      (this.config.defaultAgent &&
        this.config.agents.find((a) => a.id === this.config.defaultAgent)) ||
      this.config.agents.find((a) => isAdapter(this.agent(a.id)));
    if (!cfg) throw new Error(`project "${this.info.name}" has no full-duplex adapters`);
    return cfg.id;
  }

  // -------------------------------------------------------------------------
  // Handoff
  // -------------------------------------------------------------------------

  /** Briefings are injected with the first turn after a handoff. */
  private pendingBriefings = new Map<string, string>();

  private consumePendingBriefing(agentId: string): string | undefined {
    const briefing = this.pendingBriefings.get(agentId);
    this.pendingBriefings.delete(agentId);
    return briefing;
  }

  /**
   * Explicit baton pass: interrupt the current holder if mid-turn, project
   * the log into the target's namespaced memory, arm the one-shot briefing.
   */
  async handoff(to: string): Promise<{ from: string | null }> {
    const target = this.agent(to);
    if (!isAdapter(target)) {
      throw new Error(`cannot hand the baton to "${to}" — bridges are read-only by design`);
    }

    const holder = this.baton.holder();
    if (holder && holder !== to) {
      const current = this.agent(holder);
      if (isAdapter(current) && current.busy()) {
        await current.interrupt();
      }
    }

    const events = this.log.list({ limit: PROJECTION_WINDOW });
    const input = {
      projectName: this.info.name,
      config: this.config,
      events,
      targetAgentId: to,
      fromAgentId: holder,
    };
    const projection = buildProjection(input);
    await target.injectMemory(projection);
    writeMemoryFile(this.info.dir, to, projection); // idempotent with default impl
    this.pendingBriefings.set(to, buildBriefing(input));

    const { from } = this.baton.handoff(to, { projected: true });
    await this.ensureStarted(to);
    return { from };
  }

  async interrupt(): Promise<{ interrupted: string | null }> {
    const holder = this.baton.holder();
    if (!holder) return { interrupted: null };
    const agent = this.agent(holder);
    if (isAdapter(agent) && agent.busy()) {
      await agent.interrupt();
      return { interrupted: holder };
    }
    return { interrupted: null };
  }

  // -------------------------------------------------------------------------
  // Status / board
  // -------------------------------------------------------------------------

  async status(): Promise<ProjectStatus> {
    const holder = this.baton.holder();
    const agents = await Promise.all(
      this.config.agents.map(async (cfg) => {
        const agent = this.agent(cfg.id);
        return {
          id: cfg.id,
          kind: cfg.kind,
          role: cfg.role,
          tier: agent.capabilities.tier,
          available: await agent.available().catch(() => false),
          busy: isAdapter(agent) ? agent.busy() : false,
          holdsBaton: holder === cfg.id,
        };
      }),
    );
    const recent = this.log.list({ limit: 50 });
    const lastEvent = recent[recent.length - 1] ?? null;
    const lastUserMsg = [...recent]
      .reverse()
      .find((e) => e.kind === "message" && !e.agentId);
    const lastNeedsInput = [...recent].reverse().find((e) => e.kind === "needs_input");
    const needsInput = Boolean(
      lastNeedsInput && (!lastUserMsg || lastNeedsInput.id > lastUserMsg.id),
    );
    return {
      id: this.info.id,
      name: this.info.name,
      dir: this.info.dir,
      holder,
      agents,
      lastEvent,
      needsInput,
    };
  }

  async close(): Promise<void> {
    for (const id of this.startedAgents) {
      await this.agent(id).stop().catch(() => {});
    }
    this.startedAgents.clear();
    this.log.close();
  }
}

export function relativeToProject(projectDir: string, p: string): string {
  return path.isAbsolute(p) ? path.relative(projectDir, p) : p;
}

function configMtimeOf(projectDir: string): number {
  try {
    return fs.statSync(path.join(projectDir, ".loom", "config.json")).mtimeMs;
  } catch {
    return 0;
  }
}
