import { RedactedStream } from "../redact.js";
import { agentEnvironment, redactEnvironment } from "./store.js";
import { LiveDeltaThrottle, type LiveFrame } from "../../providers/live.js";
import type { LiveDelta, LiveItem } from "../../providers/ingestion.js";

/** Hold prefixes as well as complete matches, so splitting a private value
 * between two provider chunks cannot reveal it to a websocket subscriber.
 */
export class EnvironmentStream extends RedactedStream {
  private held = "";
  private readonly values: string[];
  constructor(project: string, agent: string) {
    super(); this.values = Object.values(agentEnvironment(project, agent)).filter(v => v.length >= 8).sort((a, b) => b.length - a.length);
  }
  override push(chunk: string): string {
    this.held += chunk;
    let out = "";
    while (this.held) {
      const match = this.values.find(v => this.held.startsWith(v));
      if (match) { out += "[redacted]"; this.held = this.held.slice(match.length); continue; }
      if (this.values.some(v => v.startsWith(this.held))) break;
      out += this.held[0]; this.held = this.held.slice(1);
    }
    return super.push(out);
  }
  override finish(): string {
    const tail = this.held ? "[redacted]" : ""; this.held = "";
    return super.push(tail) + super.finish();
  }
}
export class EnvironmentLiveThrottle extends LiveDeltaThrottle {
  private readonly privateStreams = new Map<string, { stream: EnvironmentStream; delta: LiveDelta }>();
  constructor(private project: () => string, flush: (frame: LiveFrame) => void, interval: number, redact: boolean) { super(flush, interval, redact); }
  override push(delta: LiveDelta): void {
    const key = JSON.stringify([delta.agentId, delta.chat, delta.itemId, delta.streamKind]);
    let entry = this.privateStreams.get(key);
    if (!entry) this.privateStreams.set(key, entry = { stream: new EnvironmentStream(this.project(), delta.agentId), delta });
    const text = entry.stream.push(delta.delta);
    if (text) super.push({ ...delta, delta: text });
  }
  override pushItem(item: LiveItem): void { super.pushItem(redactEnvironment(item, this.project(), item.agentId)); }
  override finish(agent: string, chat: string): void {
    for (const [key, entry] of this.privateStreams) if (entry.delta.agentId === agent && entry.delta.chat === chat) {
      const delta = entry.stream.finish();
      if (delta) super.push({ ...entry.delta, delta });
      this.privateStreams.delete(key);
    }
    super.finish(agent, chat);
  }
  override close(): void { this.privateStreams.clear(); super.close(); }
}
