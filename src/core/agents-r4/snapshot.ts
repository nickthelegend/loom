import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

/** Include ignored and untracked files too. If a tree is too large or changes
 * while being read, decline automatic retries rather than assume no edits.
 */
export async function retrySnapshot(dir: string): Promise<string | null> {
  const hash = createHash("sha256"); let files = 0, bytes = 0;
  async function walk(folder: string): Promise<void> {
    const entries = (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".loom") continue;
      const full = path.join(folder, entry.name), relative = path.relative(dir, full);
      hash.update(relative + "\0");
      if (++files > 50_000) throw new Error("snapshot too large");
      if (entry.isSymbolicLink()) hash.update(JSON.stringify(["link", await fs.readlink(full)]));
      else if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const before = await fs.stat(full); bytes += before.size;
        if (bytes > 128 * 1024 * 1024) throw new Error("snapshot too large");
        hash.update(JSON.stringify(["file", before.mode, before.size])); hash.update(await fs.readFile(full));
        const after = await fs.stat(full);
        if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("file changed during snapshot");
      } else throw new Error("unsupported file");
    }
  }
  try { await walk(dir); return hash.digest("hex"); } catch { return null; }
}
