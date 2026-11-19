import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { status } from "../git.js";
import { redactText } from "../redact.js";
import type { LinkDetails } from "./links.js";
const exec = promisify(execFile);
export async function snapshotChanges(dir: string): Promise<NonNullable<LinkDetails["changes"]>> {
  const state = await status(dir);
  const names = [...new Set([...state.staged.map(f => f.path), ...state.unstaged.map(f => f.path), ...state.untracked])].filter(p => p !== ".loom" && !p.startsWith(".loom/"));
  if (names.length > 200) throw new Error("share at most 200 changed files at once");
  const files = [];
  let size = 0;
  const git = async (args: string[]) => (await exec("git", args, { cwd: dir, maxBuffer: 2_000_000 })).stdout;
  const head = await git(["rev-parse", "--verify", "HEAD"]).then(() => "HEAD").catch(() => "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  for (const name of names) {
    let diff: string;
    const file = path.resolve(dir, name);
    if (!file.startsWith(path.resolve(dir) + path.sep)) throw new Error("invalid changed path");
    if (state.untracked.includes(name)) {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || !fs.realpathSync(file).startsWith(fs.realpathSync(dir) + path.sep)) throw new Error(`cannot share symlink or special file: ${name}`);
      if (st.size > 256_000) throw new Error(`file too large to share: ${name}`);
      const text = fs.readFileSync(file, "utf8");
      diff = text.includes("\0") ? "Binary file (contents omitted)" : `--- /dev/null\n+++ b/${name}\n` + text.split("\n").map(l => `+${l}`).join("\n");
    } else diff = await git(["diff", "--no-ext-diff", "--no-textconv", head, "--", name]);
    size += diff.length;
    if (size > 1_000_000) throw new Error("changes exceed the 1 MB share limit");
    files.push({ path: redactText(name), diff: redactText(diff) });
  }
  return { branch: state.branch, files };
}
