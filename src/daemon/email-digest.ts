import fs from "node:fs";
import path from "node:path";
import { digest } from "../core/digest.js";
import { listProjects, loomHome } from "../core/registry.js";
import { sendMail, type SmtpSettings } from "../core/smtp.js";
import { logbook } from "../core/logbook.js";
import type { ProjectRuntime } from "./runtime.js";

const file = () => path.join(loomHome(), "email-digest.json");
export function readEmail(): SmtpSettings {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")) as SmtpSettings; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return { enabled: false, host: "", port: 465, security: "tls", username: "", password: "", from: "", to: "", everyHours: 24 };
}
export function publicEmail() { const { password, ...rest } = readEmail(); return { ...rest, hasPassword: Boolean(password) }; }
export function saveEmail(b: Record<string, unknown>): void {
  const cur = readEmail();
  const next = { ...cur };
  for (const k of ["host", "username", "password", "from", "to"] as const) {
    if (b[k] !== undefined) {
      if (typeof b[k] !== "string" || /[\r\n\0]/.test(b[k])) throw new Error(`Invalid ${k}`);
      next[k] = b[k];
    }
  }
  if (b.enabled !== undefined) { if (typeof b.enabled !== "boolean") throw new Error("enabled must be boolean"); next.enabled = b.enabled; }
  if (b.security !== undefined) { if (b.security !== "tls" && b.security !== "starttls") throw new Error("Use tls or starttls"); next.security = b.security; }
  for (const k of ["port", "everyHours"] as const) if (b[k] !== undefined) next[k] = Number(b[k]);
  if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535 || !Number.isFinite(next.everyHours) || next.everyHours < 1 || next.everyHours > 168) throw new Error("Use a valid port and an interval from 1 to 168 hours");
  if (next.enabled && (!/^[a-zA-Z0-9.:-]+$/.test(next.host) || !/^[^\s<>@]+@[^\s<>@]+$/.test(next.from) || !/^[^\s<>@]+@[^\s<>@]+$/.test(next.to))) throw new Error("Set the SMTP host, sender and recipient email addresses");
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(file() + ".tmp", JSON.stringify(next), { mode: 0o600 }); fs.renameSync(file() + ".tmp", file());
}
export class EmailDigest {
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> | null = null;
  constructor(private runtime: (id: string) => Promise<ProjectRuntime>, private send = sendMail) {}
  start() { this.timer = setInterval(() => void this.tick().catch(() => logbook.warn("email", "Digest delivery failed; will retry")), 60_000); this.timer.unref(); }
  async close() { clearInterval(this.timer); await this.pending?.catch(() => {}); }
  async preview(): Promise<string> {
    const cfg = readEmail();
    const since = cfg.lastSentAt ?? Date.now() - cfg.everyHours * 3_600_000;
    const parts = ["Loom digest"];
    for (const info of listProjects()) {
      const rt = await this.runtime(info.id);
      const d = digest(rt.log.list({ limit: 4000 }), since);
      parts.push(`\n${info.name}`, ...d.lines.map(l => l.text), ...(d.waiting.length ? [`Waiting: ${d.waiting.join(", ")}`] : []));
    }
    return parts.join("\n");
  }
  tick(force = false): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const cfg = readEmail(), now = Date.now();
      if (!cfg.enabled) { if (force) throw new Error("Enable SMTP digest settings first"); return; }
      if (!force && now - (cfg.lastSentAt ?? 0) < cfg.everyHours * 3_600_000) return;
      const text = await this.preview();
      await this.send(cfg, "Loom digest", text);
      const fresh = readEmail();
      // Preserve settings edited while the SMTP server was responding.
      fs.writeFileSync(file() + ".tmp", JSON.stringify({ ...fresh, lastSentAt: now }), { mode: 0o600 }); fs.renameSync(file() + ".tmp", file());
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}
