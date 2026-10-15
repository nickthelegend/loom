import { execFile } from "../process.js";
import { promisify } from "node:util";
import fs from "node:fs";
import { codexBin } from "../../providers/codex/adapter.js";
import { claudeBin } from "../../providers/claude/adapter.js";
import { digest } from "./contracts.js";
import { probeWindowsJobs } from "../windows-jobs.js";

const exec = promisify(execFile);
/** Protocol each adapter speaks. Any installed version may run; drift in the
 * event stream shows up as missing acceptance evidence, never as success. */
export const NATIVE_PROTOCOLS = {
  codex: { protocol: "codex-app-server-v2", acceptance: "turn/start response or turn/started", compaction: "contextCompaction item", tested: ["0.153.4"] },
  "claude-code": { protocol: "claude-agent-sdk-stream-json-v1", acceptance: "status requesting or assistant/result output", compaction: "status compacting + compact_boundary", tested: ["2.1.278"] },
  opencode: { protocol: "opencode-serve-api-v2", acceptance: "prompt admitted (/api/session/{id}/prompt or /session/{id}/prompt_async 204)", compaction: "session.next.compaction.ended or session.compacted", tested: ["1.18.31", "1.19.0"] },
} as const;
export type NativeKind = keyof typeof NATIVE_PROTOCOLS;
/** The harnesses native continuity speaks to, in one place. */
export const NATIVE_KINDS = Object.keys(NATIVE_PROTOCOLS) as NativeKind[];
export const isNativeKind = (kind: string): kind is NativeKind => (NATIVE_KINDS as string[]).includes(kind);

export interface HarnessHealth {
  kind: string;
  available: boolean;
  version: string | null;
  /** Fixtures in this repo exercised this exact version. Informational only. */
  tested: boolean;
  binary: string | null;
  fingerprint: string | null;
  error?: string;
  checkedAt: number;
}

/** A bounded `--version` probe. Never throws; an unreachable CLI is reported. */
export async function probeHarness(kind: string, options: Record<string, unknown>): Promise<HarnessHealth> {
  const checkedAt = Date.now();
  const down = (error: string, binary: string | null = null): HarnessHealth =>
    ({ kind, available: false, version: null, tested: false, binary, fingerprint: null, error, checkedAt });
  if (process.platform === "win32") {
    try { await probeWindowsJobs(); }
    catch (error) { return down(`Windows Job Object containment is unavailable: ${(error as Error).message}`); }
  }
  if (!isNativeKind(kind)) return down(`no native continuity protocol for ${kind}`);
  const override = typeof options.bin === "string" ? options.bin : undefined;
  // An opencode agent pointed at a running server is as reachable as that server.
  if (kind === "opencode" && typeof options.baseUrl === "string" && options.baseUrl) {
    try {
      const url = options.baseUrl.replace(/\/$/, "");
      let res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) res = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok || !(await res.json() as { healthy?: boolean }).healthy) return down(`opencode server at ${options.baseUrl} did not report healthy`);
    } catch (error) {
      return down(`opencode server at ${options.baseUrl} is not reachable: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    }
    return { kind, available: true, version: null, tested: false, binary: null,
      fingerprint: digest(JSON.stringify([options.baseUrl, NATIVE_PROTOCOLS.opencode.protocol])), checkedAt };
  }
  const bin = kind === "codex" ? codexBin(override) : kind === "claude-code" ? claudeBin(override) : override ?? "opencode";
  if (!bin) return down(`${kind} CLI was not found`);
  let version: string | null;
  try {
    const { stdout } = await exec(bin, ["--version"], { timeout: 5000, maxBuffer: 4096 });
    version = stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
  } catch (error) {
    return down(`${kind} did not answer a version probe: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`, bin);
  }
  const profile = NATIVE_PROTOCOLS[kind];
  const identity = fs.existsSync(bin) ? [fs.realpathSync(bin), fs.statSync(bin).size] : [bin];
  return { kind, available: true, version, tested: version !== null && (profile.tested as readonly string[]).includes(version),
    binary: bin, fingerprint: digest(JSON.stringify([identity, version, profile.protocol])), checkedAt };
}

export interface HarnessTarget { id: string; kind: string; options: Record<string, unknown> }

/**
 * Keeps each native harness's reachability current: a probe every interval,
 * and on demand before dispatch when the last result is older than that.
 */
export class HarnessMonitor {
  private readonly health = new Map<string, HarnessHealth>();
  private readonly inflight = new Map<string, Promise<HarnessHealth>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly targets: () => HarnessTarget[],
    private readonly onChange: (id: string, next: HarnessHealth, previous: HarnessHealth | undefined) => void = () => {},
    readonly intervalMs = 20_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  get(id: string): HarnessHealth | undefined { return this.health.get(id); }
  report(): Record<string, HarnessHealth> { return Object.fromEntries(this.health); }

  async pollAll(): Promise<void> {
    const targets = this.targets().filter(t => isNativeKind(t.kind));
    const ids = new Set(targets.map(t => t.id));
    for (const id of [...this.health.keys()]) if (!ids.has(id)) this.health.delete(id);
    await Promise.all(targets.map(t => this.poll(t)));
  }

  /** A result no older than the poll interval; probes now when stale. */
  async ensure(id: string): Promise<HarnessHealth> {
    const cached = this.health.get(id);
    if (cached && Date.now() - cached.checkedAt < this.intervalMs) return cached;
    const target = this.targets().find(t => t.id === id);
    if (!target) return { kind: "unknown", available: false, version: null, tested: false, binary: null, fingerprint: null, error: `no agent "${id}"`, checkedAt: Date.now() };
    return this.poll(target);
  }

  private poll(target: HarnessTarget): Promise<HarnessHealth> {
    const pending = this.inflight.get(target.id);
    if (pending) return pending;
    const probe = probeHarness(target.kind, target.options).then(next => {
      const previous = this.health.get(target.id);
      this.health.set(target.id, next);
      if (!previous || previous.available !== next.available || previous.version !== next.version) this.onChange(target.id, next, previous);
      return next;
    }).finally(() => this.inflight.delete(target.id));
    this.inflight.set(target.id, probe);
    return probe;
  }
}
