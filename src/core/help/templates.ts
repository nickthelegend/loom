import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloneSource, projectGit } from "../project-creation.js";

/** Copy source files only. Never import a template's Git identity, credentials or Loom config. */
export async function applyExternalTemplate(dir: string, source: string): Promise<void> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-template-"));
  const created: string[] = [], folders: string[] = [];
  try {
    let from = path.resolve(source);
    if (!fs.existsSync(from)) {
      const { url } = cloneSource(source);
      from = path.join(temp, "source");
      await projectGit(["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", ...(url.startsWith("file:") ? ["-c", "protocol.file.allow=always"] : []), "clone", "--depth", "1", "--", url, from], temp, { signal: AbortSignal.timeout(120_000) });
    }
    if (!fs.lstatSync(from).isDirectory()) throw new Error("template must be a directory or a Git URL");
    const root = fs.realpathSync(from), destination = fs.realpathSync(dir);
    if (destination === root || destination.startsWith(root + path.sep)) throw new Error("destination cannot be inside the template");
    const entries: Array<{ relative: string; source: string }> = [];
    let bytes = 0;
    const walk = (folder: string, relative = "") => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if ([".git", ".loom", "node_modules", ".venv", ".env"].includes(entry.name) || entry.name.startsWith(".env.")) continue;
        const rel = path.join(relative, entry.name), full = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`template contains a symlink: ${rel}`);
        if (entry.isDirectory()) { walk(full, rel); continue; }
        if (!entry.isFile()) throw new Error(`template contains a special file: ${rel}`);
        bytes += fs.statSync(full).size;
        if (entries.length >= 10_000 || bytes > 100_000_000) throw new Error("template exceeds 10,000 files or 100 MB");
        let target = path.join(destination, rel);
        if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) throw new Error(`template would overwrite ${rel}`);
        for (target = path.dirname(target); target !== destination; target = path.dirname(target)) {
          const stat = fs.lstatSync(target, { throwIfNoEntry: false });
          if (stat && !stat.isDirectory()) throw new Error(`template destination is not a regular directory: ${target}`);
        }
        entries.push({ relative: rel, source: full });
      }
    };
    walk(root);
    for (const entry of entries) {
      const target = path.join(destination, entry.relative), parents: string[] = [];
      for (let p = path.dirname(target); p !== destination && !fs.existsSync(p); p = path.dirname(p)) parents.unshift(p);
      for (const p of parents) { fs.mkdirSync(p); folders.push(p); }
      fs.copyFileSync(entry.source, target, fs.constants.COPYFILE_EXCL); created.push(target);
    }
  } catch (error) {
    for (const f of created.reverse()) fs.unlinkSync(f);
    for (const d of folders.reverse()) fs.rmdirSync(d);
    throw error;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
