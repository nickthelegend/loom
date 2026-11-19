import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loomHome, readDaemonConfig } from "./registry.js";
import { logbook } from "./logbook.js";
import { redactTriage } from "./redact.js";
import { listProviders, resolveProvider } from "./providers.js";
import { VERSION } from "../version.js";

/** Only diagnostics go in this bundle; no configs, prompts, or environment dump. */
export function writeCrashReport(kind: string, error: unknown): string {
  const config = readDaemonConfig();
  const secrets = [config?.adminToken, ...config?.clients.flatMap(c => [c.token, c.relayKey]) ?? [],
    ...listProviders().map(p => resolveProvider(p.id)?.key),
    ...Object.entries(process.env).filter(([key]) => /key|token|secret|password|credential/i.test(key)).map(([, value]) => value)]
    .filter((s): s is string => Boolean(s));
  const clean = (s: string) => redactTriage(s, { secrets });
  const dir = path.join(loomHome(), "crashes");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `crash-${Date.now()}-${randomUUID()}.json`);
  const report = {
    format: "loom-crash", version: VERSION, at: new Date().toISOString(), kind,
    node: process.version, platform: process.platform, arch: process.arch, uptime: process.uptime(),
    error: clean(error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 16000),
    logs: logbook.list({ limit: 50 }).map(r => ({ at: r.at, level: r.level, scope: clean(r.scope), message: clean(r.message), detail: clean(r.detail ?? "") })),
  };
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  const files = fs.readdirSync(dir).filter(n => /^crash-\d+-[\w-]+\.json$/.test(n)).sort().reverse();
  for (const old of files.slice(10)) fs.unlinkSync(path.join(dir, old));
  return file;
}
