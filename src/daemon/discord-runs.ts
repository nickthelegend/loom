import fs from "node:fs";
import path from "node:path";
import { listProjects, loomHome } from "../core/registry.js";
import type { LoomEvent } from "../types.js";
import { readBridges } from "./chat-bridge.js";

interface RunThread { projectId?: string; pending?: LoomEvent; channel: string; message?: string; thread?: string; lastEvent?: number }
/** Serial delivery and persisted message IDs make thread creation restart-safe. */
export class DiscordRuns {
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.retryPending(), 30_000);
    this.timer.unref();
  }
  async retryPending(): Promise<void> {
    let rows: Record<string, RunThread>;
    try { rows = JSON.parse(fs.readFileSync(path.join(loomHome(), "discord-runs.json"), "utf8")); } catch { return; }
    for (const row of Object.values(rows)) if (row.projectId && row.pending) await this.deliver(row.projectId, row.pending).catch(() => {});
  }
  constructor(private api = process.env.LOOM_DISCORD_API || "https://discord.com/api/v10") {}
  deliver(projectId: string, event: LoomEvent): Promise<void> {
    if (this.stopped || event.kind !== "orchestra" || typeof event.payload.runId !== "string") return Promise.resolve();
    const cfg = readBridges().discord;
    const info = listProjects().find(p => p.id === projectId);
    if (!cfg?.enabled || !cfg.orchestraChannel || !info || (cfg.project ? ![info.id, info.name].includes(cfg.project) : listProjects().length !== 1)) return Promise.resolve();
    const next = this.pending.catch(() => {}).then(async () => {
      const file = path.join(loomHome(), "discord-runs.json");
      let rows: Record<string, RunThread> = {};
      try { rows = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const key = `${projectId}:${event.payload.runId}`;
      const row = rows[key] ?? { channel: cfg.orchestraChannel! };
      if ((row.lastEvent ?? -1) >= event.id) return;
      const save = () => { rows[key] = row; fs.writeFileSync(file + ".tmp", JSON.stringify(rows), { mode: 0o600 }); fs.renameSync(file + ".tmp", file); };
      const post = async (route: string, body: unknown) => {
        const r = await fetch(this.api + route, { method: "POST", headers: { authorization: `Bot ${cfg.botToken}`, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`Discord update failed (${r.status})`);
        return await r.json() as { id: string };
      };
      row.projectId = projectId; row.pending = event; save();
      const title = `${info.name}: ${String(event.payload.goal ?? event.payload.runId)}`.slice(0, 100);
      if (!row.message) {
        row.message = (await post(`/channels/${row.channel}/messages`, { content: `Orchestra · ${title}`, allowed_mentions: { parse: [] }, nonce: key.slice(-25), enforce_nonce: true })).id;
        save();
      }
      if (!row.thread) {
        // A message can own only one thread; its ID is the thread ID too.
        const r = await fetch(`${this.api}/channels/${row.channel}/messages/${row.message}/threads`, { method: "POST", headers: { authorization: `Bot ${cfg.botToken}`, "content-type": "application/json" }, body: JSON.stringify({ name: title, auto_archive_duration: 1440 }), redirect: "error", signal: AbortSignal.timeout(15_000) });
        const body = await r.json() as { id?: string; code?: number };
        if (!r.ok && body.code !== 160004) throw new Error(`Discord thread failed (${r.status})`);
        row.thread = body.id ?? row.message;
        save();
      }
      const p = event.payload;
      const task = p.task && typeof p.task === "object" ? p.task as Record<string, unknown> : {};
      const landing = p.landing && typeof p.landing === "object" ? p.landing as Record<string, unknown> : {};
      const text = [p.phase, task.title ?? p.title ?? task.id ?? p.taskId, task.status ?? landing.state ?? p.status,
        p.summary ?? p.question ?? p.error ?? p.text ?? p.reason ?? p.why, p.url].filter(Boolean).join(" · ").slice(0, 1900);
      await post(`/channels/${row.thread}/messages`, { content: text || "Orchestra update", allowed_mentions: { parse: [] }, nonce: String(event.id) + key.slice(-15), enforce_nonce: true });
      row.lastEvent = event.id; delete row.pending; save();
    });
    this.pending = next;
    return next;
  }
  async close(): Promise<void> { this.stopped = true; clearInterval(this.timer); await this.pending.catch(() => {}); }
}
