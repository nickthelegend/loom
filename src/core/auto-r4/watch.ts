import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { matchesGlob } from "../step-conditions.js";

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a! > 0 && a! < 224 && a !== 10 && a !== 127 && !(a === 169 && b === 254) &&
      !(a === 192 && [0, 168].includes(b!)) && !(a === 172 && b! >= 16 && b! <= 31) &&
      !(a === 100 && b! >= 64 && b! <= 127) && !(a === 198 && [18, 19].includes(b!));
  }
  return isIP(address) === 6 && /^[23]/i.test(address);
}
export function publicUrl(input: string): URL {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash ||
      url.hostname === "localhost" || (isIP(url.hostname.replace(/^\[|\]$/g, "")) && !publicAddress(url.hostname.replace(/^\[|\]$/g, "")))) throw new Error("URL must be public HTTP(S), without credentials or fragments");
  return url;
}

/** Like Markdown import, pin the checked DNS answer and check every redirect. */
export async function readWatchUrl(input: string, select?: string): Promise<string> {
  const signal = AbortSignal.timeout(10_000);
  async function get(input: string, redirects = 0): Promise<string> {
    if (redirects > 3) throw new Error("too many redirects");
    const url = publicUrl(input);
    const addresses = await Promise.race([lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true }), new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("URL timed out")), { once: true }))]);
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error("URL must resolve to a public address");
    const address = addresses[0]!;
    return new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).get(url, { signal,
        lookup: (_host, opts, cb) => { if (opts.all) cb(null, [address]); else cb(null, address.address, address.family); },
        headers: { accept: "text/html, application/json, text/plain", "accept-encoding": "identity" },
      }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
          response.destroy(); get(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject); return;
        }
        if (response.statusCode !== 200) { response.destroy(); reject(new Error(`URL returned HTTP ${response.statusCode}`)); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1_000_000) { response.destroy(); reject(new Error("URL exceeds 1 MB")); } else chunks.push(chunk); });
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      });
      request.on("error", reject);
    });
  }
  const text = await get(input);
  if (!select) return text;
  const value = select.split(".").reduce<unknown>((v, key) => v && typeof v === "object" && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined, JSON.parse(text));
  if (value === undefined) throw new Error(`JSON path ${select} was not found`);
  return JSON.stringify(value);
}

export function fileSnapshot(dir: string, glob: string): Map<string, string> {
  const result = new Map<string, string>(); let count = 0;
  function walk(relative: string): void {
    const full = path.join(dir, relative);
    if (relative && fs.existsSync(path.join(full, ".git"))) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if ([".git", ".loom", "worktrees", ".worktrees", "node_modules"].includes(entry.name) || entry.isSymbolicLink()) continue;
      if (++count > 50_000) throw new Error("file watch exceeds 50000 entries; narrow the project");
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && matchesGlob(name, glob)) { const s = fs.statSync(path.join(dir, name)); result.set(name, `${s.mtimeMs}:${s.ctimeMs}:${s.size}`); }
    }
  }
  // Start at the literal directory prefix, checking every ancestor so a narrow
  // glob cannot bypass the exclusions or follow a symlink into another tree.
  const parts = glob.split("/");
  const wildcard = parts.findIndex(part => /[*?\[]/.test(part));
  const prefix = parts.slice(0, wildcard < 0 ? -1 : wildcard);
  let relative = "";
  for (const part of prefix) {
    if (["..", ".git", ".loom", "worktrees", ".worktrees", "node_modules"].includes(part)) return result;
    relative = relative ? `${relative}/${part}` : part;
    const full = path.join(dir, relative);
    try { if (!fs.lstatSync(full).isDirectory() || fs.existsSync(path.join(full, ".git"))) return result; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return result; throw e; }
  }
  walk(relative); return result;
}

export class FileChanges {
  private snapshots = new Map<string, { files: Map<string, string>; pending: Set<string>; at: number }>();
  restore(key: string, files: string[]): void {
    const prior = this.snapshots.get(key);
    if (prior) files.forEach(file => prior.pending.add(file));
  }
  poll(key: string, dir: string, glob: string, now = Date.now()): string[] {
    const files = fileSnapshot(dir, glob), prior = this.snapshots.get(key);
    if (!prior) { this.snapshots.set(key, { files, pending: new Set(), at: now }); return []; }
    const changed = [...new Set([...files.keys(), ...prior.files.keys()])].filter(f => files.get(f) !== prior.files.get(f));
    prior.files = files;
    if (changed.length) { changed.forEach(f => prior.pending.add(f)); prior.at = now; }
    if (now - prior.at < 15_000 || !prior.pending.size) return [];
    const out = [...prior.pending].sort(); prior.pending.clear(); return out;
  }
}
