/** Git worktree operations shared by Orchestra and crew plays. */
import { execFile } from "./process.js";

export function gitWorktree(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout)));
}
export function createWorktree(root: string, dir: string, branch: string, base: string): Promise<string> {
  return gitWorktree(["worktree", "add", "-q", "-b", branch, dir, base], root);
}
export async function predictMerge(dir: string, left: string, right: string): Promise<{ clean: boolean; detail: string }> {
  try {
    await gitWorktree(["merge-tree", "--write-tree", "--name-only", left, right], dir);
    return { clean: true, detail: "" };
  } catch (error) {
    const result = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (Number(result.code) !== 1) throw new Error(`merge prediction unavailable: ${result.stderr ?? result.message}`);
    return { clean: false, detail: (result.stdout ?? "merge conflict").slice(0, 6000) };
  }
}
