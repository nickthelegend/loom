import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ContinuityError, digest } from "./contracts.js";

/** Immutable local retrieval evidence, finalized before its packet is stored.
 * No model-selected path, credentials, SQLite write access or daemon dependency. */
export class ContextArtifacts {
  private readonly root: string;
  private readonly workspace: string;
  constructor(workspace: string) {
    const canonical = fs.realpathSync(workspace);
    this.workspace = canonical;
    this.root = path.join(canonical, ".loom", "brain", "artifacts");
    for (const part of [".loom", ".loom/brain", ".loom/brain/artifacts"]) {
      const dir = path.join(canonical, part);
      if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()))
        throw new ContinuityError("invalid", "Brain artifact directory must be a local directory, not a symlink");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
  put(text: string): { hash: string; relativePath: string; bytes: number } {
    this.assertRoot();
    const bytes = Buffer.byteLength(text);
    if (bytes > 32_000_000) throw new ContinuityError("overflow", "source retrieval artifact exceeds 32 MB; narrow reviewed checkpoint sources");
    const hash = digest(text), relativePath = `.loom/brain/artifacts/${hash}.json`, file = path.join(this.root, `${hash}.json`);
    if (fs.existsSync(file)) { this.read(hash); return { hash, relativePath, bytes }; }
    const temporary = path.join(this.root, `.pending-${randomUUID()}`);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      try { fs.writeFileSync(fd, text); fs.fchmodSync(fd, 0o400); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      this.assertRoot();
      // Exclusive publication: never replace an existing immutable artifact.
      try { fs.linkSync(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; this.read(hash); }
    } finally { fs.unlinkSync(temporary); }
    // macOS/Linux support fsync on a directory; Windows may reject it. The
    // file has still been flushed; never treat a rejected directory fsync as
    // acknowledgement of a durable packet.
    let directory: number | undefined;
    try { directory = fs.openSync(this.root, "r"); fs.fsyncSync(directory); }
    catch (error) { if (process.platform !== "win32") throw error; }
    finally { if (directory !== undefined) fs.closeSync(directory); }
    return { hash, relativePath, bytes };
  }
  read(hash: string): string {
    this.assertRoot();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ContinuityError("invalid", "invalid artifact hash");
    const file = path.join(this.root, `${hash}.json`);
    // O_NOFOLLOW is unavailable on Windows. Reject reparse-point symlinks
    // explicitly there as well, before following any artifact path.
    if (fs.lstatSync(file).isSymbolicLink()) throw new ContinuityError("invalid", "unsafe retrieval artifact symlink");
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new ContinuityError("invalid", "unsafe retrieval artifact symlink");
      throw error;
    }
    let text: string;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 32_000_000) throw new ContinuityError("invalid", "unsafe or oversized retrieval artifact");
      text = fs.readFileSync(fd, "utf8");
      this.assertRoot();
      const current = fs.lstatSync(file);
      if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev)
        throw new ContinuityError("invalid", "unsafe retrieval artifact changed while reading");
    } finally { fs.closeSync(fd); }
    if (digest(text) !== hash) throw new ContinuityError("invalid", "retrieval artifact integrity mismatch");
    return text;
  }
  private assertRoot(): void {
    for (const part of [".loom", ".loom/brain", ".loom/brain/artifacts"]) {
      const dir = path.join(this.workspace, part);
      if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== dir)
        throw new ContinuityError("invalid", "Brain artifact directory changed or became a symlink");
    }
  }
}
