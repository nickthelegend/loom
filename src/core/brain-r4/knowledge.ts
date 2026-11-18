import crypto from "node:crypto";
import type { LoomEvent } from "../../types.js";
import type { Brain, BrainExport, Memory, MemoryPatch, NewMemory } from "../brain.js";
import type { EventJournal } from "../eventlog.js";
import { labels, paths } from "./fields.js";

export interface Proposal {
  id: string;
  input: NewMemory;
  target?: string;
  reason?: string;
  state: "pending" | "approved" | "rejected";
}
export interface BrainPack extends BrainExport { pack: string }

interface KnowledgeState {
  settings: { reviewBeforeSaving: boolean };
  proposals: Map<string, Proposal>;
  sources: Set<string>;
  packs: Map<string, BrainPack>;
  prLearned: Set<string>;
  prFailures: Map<string, number>;
  prStarted?: number;
  events: LoomEvent[];
}

/** Project knowledge settings and review decisions share the brain's event journal. */
export class BrainKnowledge {
  private cache: KnowledgeState | null = null;
  private unsubscribe: () => void;

  constructor(private brain: Brain, readonly log: EventJournal) {
    this.unsubscribe = log.onEvent(event => {
      if (!this.cache || event.kind !== "status" || event.payload.state !== "brain_knowledge") return;
      this.fold(this.cache, event);
    });
  }

  close(): void { this.unsubscribe(); this.cache = null; }

  private fold(state: KnowledgeState, event: LoomEvent): void {
    const p = event.payload;
    state.events.push(event);
    switch (p.action) {
      case "settings": state.settings = { reviewBeforeSaving: p.reviewBeforeSaving === true }; break;
      case "propose": {
        const proposal = p.proposal as Proposal;
        state.proposals.set(proposal.id, proposal); break;
      }
      case "review": {
        const proposal = state.proposals.get(String(p.id));
        if (proposal) state.proposals.set(proposal.id, { ...proposal, state: p.decision as Proposal["state"] });
        break;
      }
      case "source_add": state.sources.add(String(p.pattern)); break;
      case "source_remove": state.sources.delete(String(p.pattern)); break;
      case "pack_save": state.packs.set(String(p.name), p.doc as BrainPack); break;
      case "pack_remove": state.packs.delete(String(p.name)); break;
      case "pr_learned": state.prLearned.add(String(p.url)); break;
      case "pr_learn_failed": state.prFailures.set(String(p.url), Number(p.count)); break;
      case "pr_learning_started": state.prStarted ??= event.id; break;
      case "feedback": case "merged": break;
      // Unknown knowledge operations may change the fold; rebuild on the next read.
      default: this.cache = null;
    }
  }

  private state(): KnowledgeState {
    if (!this.cache) {
      const state: KnowledgeState = { settings: { reviewBeforeSaving: false }, proposals: new Map(),
        sources: new Set(), packs: new Map(), prLearned: new Set(), prFailures: new Map(), events: [] };
      for (const event of this.log.list({ kinds: ["status"] })) {
        if (event.payload.state === "brain_knowledge") this.fold(state, event);
      }
      this.cache = state;
    }
    return this.cache;
  }

  sourcePatterns(): string[] { return [...this.state().sources]; }
  prLearningStarted(): number | undefined { return this.state().prStarted; }
  hasLearnedPr(url: string): boolean { return this.state().prLearned.has(url); }
  prFailures(url: string): number { return this.state().prFailures.get(url) ?? 0; }

  record(action: string, data: Record<string, unknown>): void {
    this.log.append({ kind: "status", payload: { state: "brain_knowledge", action, ...data } });
  }

  events(action?: string) {
    return structuredClone(this.state().events.filter(e => !action || e.payload.action === action));
  }

  settings(): { reviewBeforeSaving: boolean } {
    return { ...this.state().settings };
  }

  configure(reviewBeforeSaving: boolean, by: string) {
    this.record("settings", { reviewBeforeSaving, by });
    return this.settings();
  }

  inbox(): Proposal[] {
    return structuredClone([...this.state().proposals.values()].filter(p => p.state === "pending"));
  }

  propose(input: NewMemory, target?: string, reason?: string): Proposal {
    const existing = this.inbox().find(p => p.input.text === input.text && p.target === target && JSON.stringify([p.input.scope ?? {}, p.input.private, p.input.untrusted, p.input.expiresAt, p.input.paths, p.input.pack]) === JSON.stringify([input.scope ?? {}, input.private, input.untrusted, input.expiresAt, input.paths, input.pack]));
    if (existing) return existing;
    const proposal: Proposal = { id: crypto.randomBytes(8).toString("hex"), input, target, reason, state: "pending" };
    this.record("propose", { proposal });
    return proposal;
  }

  learn(input: NewMemory, forceReview = false): Memory | Proposal {
    return forceReview || this.settings().reviewBeforeSaving ? this.propose(input) : this.brain.add(input).memory;
  }

  review(id: string, action: "approve" | "edit" | "reject", by: string, text?: string) {
    const proposal = this.inbox().find(p => p.id === id);
    if (!proposal) throw new Error("no such inbox proposal");
    if (action === "edit") {
      if (!text?.trim()) throw new Error("edited proposal needs text");
      const edited = { ...proposal, input: { ...proposal.input, text: text.trim() } };
      this.record("propose", { proposal: edited, by });
      return { proposal: edited };
    }
    let memory: Memory | undefined;
    if (action === "approve") {
      if (proposal.target) {
        const current = this.brain.get(proposal.target);
        if (!current) throw new Error("the original memory no longer exists");
        // Review never promotes a chat/private/outside memory into wider authority.
        const patch: MemoryPatch = { text: proposal.input.text, evidence: proposal.input.evidence,
          untrusted: Boolean(current.untrusted || proposal.input.untrusted),
          private: Boolean(current.private || proposal.input.private), archived: false };
        memory = this.brain.update(current.id, patch, by);
      } else memory = this.brain.add(proposal.input).memory;
    }
    this.record("review", { id, decision: action === "approve" ? "approved" : "rejected", by });
    return { memory, reviewed: true };
  }

  tag(id: string, tags: string[], by: string): Memory {
    const memory = this.brain.get(id);
    if (!memory) throw new Error("no such memory");
    return this.brain.update(id, { tags: labels([...(memory.tags ?? []), ...tags]) }, by);
  }

  feedback(id: string, value: "helpful" | "wrong", injection: number, by: string) {
    const event = this.log.list({ kinds: ["status"], since: injection - 1, before: injection + 1, limit: 1 }).find(e => e.id === injection && e.payload.state === "memory_injection");
    const snapshot = (event?.payload.memories as Array<{ id: string; text: string }> | undefined)?.find(m => m.id === id);
    if (!snapshot) throw new Error("memory was not in that turn's explanation");
    const memory = this.brain.get(id);
    if (!memory) throw new Error("no such memory");
    if (memory.source) throw new Error("edit the source document and refresh it to correct this chunk");
    this.record("feedback", { id, value, injection, by });
    if (value === "wrong") {
      this.brain.update(id, { archived: true }, by);
      this.propose({ ...memory, text: memory.text }, id, `Marked wrong in turn ${event!.payload.turn}: ${snapshot.text}`);
    }
    return { recorded: true };
  }

  packs(): Array<{ name: string; saved?: BrainPack; installed: number }> {
    const saved = this.state().packs, memories = this.brain.all();
    const installed = new Map<string, number>();
    for (const memory of memories) if (memory.pack) installed.set(memory.pack, (installed.get(memory.pack) ?? 0) + 1);
    const names = new Set([...saved.keys(), ...installed.keys()]);
    return [...names].map(name => ({ name, saved: structuredClone(saved.get(name)), installed: installed.get(name) ?? 0 }));
  }

  savePack(name: string, project: string, tag?: string): BrainPack {
    const doc = { ...this.brain.export(project, { tag, liveOnly: true }), pack: name };
    this.record("pack_save", { name, doc });
    return doc;
  }

  installPack(doc: BrainPack, by: string, untrusted = false) {
    for (const memory of doc.memories) { labels(memory.tags); paths(memory.paths); }
    const portable = { ...doc, memories: doc.memories.map(m => ({ ...m, pack: doc.pack,
      ...(untrusted ? { untrusted: true, pinned: false } : {}) })) };
    return this.brain.import(portable, { agentId: by, eventId: this.log.lastId(), ts: Date.now() });
  }

  removePack(name: string, by: string) {
    let removed = 0;
    for (const memory of this.brain.all()) if (memory.pack === name && this.brain.forget(memory.id, `removed pack ${name}`, by)) removed++;
    this.record("pack_remove", { name, by });
    return { removed };
  }

  changes(since: number) {
    return this.log.list({ kinds: ["memory_add", "memory_update", "memory_forget", "status"], sinceTs: since }).flatMap(e => {
      const memory = e.payload.memory as Memory | undefined;
      const patch = e.payload.patch as MemoryPatch | undefined;
      const merged = e.kind === "status" && e.payload.state === "brain_knowledge" && e.payload.action === "merged";
      if (e.kind === "status" && !merged || e.payload.confirm) return [];
      return [{ eventId: e.id, ts: e.ts, id: memory?.id ?? String(e.payload.id),
        action: merged ? "merged" : e.kind === "memory_add" ? "added" : e.kind === "memory_forget" ? "forgotten" : patch?.archived ? "archived" : "edited",
        text: memory?.text ?? patch?.text ?? String(e.payload.text ?? this.brain.get(String(e.payload.id))?.text ?? ""),
        by: e.agentId ?? String(e.payload.by ?? "user") }];
    });
  }
}

export function sinceTime(value = "7d", now = Date.now()): number {
  const relative = /^(\d+)([dhm])$/.exec(value);
  const result = relative ? now - Number(relative[1]) * ({ d: 86400000, h: 3600000, m: 60000 }[relative[2]!] ?? 0) : Date.parse(value);
  if (!Number.isFinite(result) || result < 0) throw new Error("since must be an ISO date or a duration such as 7d");
  return result;
}

export const INTERVIEW = [
  { key: "tests", question: "How do you run the tests?", kind: "fact", prefix: "Test command: " },
  { key: "conventions", question: "What conventions should agents follow?", kind: "convention", prefix: "Project conventions: " },
  { key: "avoid", question: "Which areas should agents leave alone?", kind: "constraint", prefix: "Leave these areas alone: " },
] as const;
