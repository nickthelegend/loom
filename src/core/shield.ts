/**
 * Blast-Radius Shield: a command that can't be taken back, caught the moment
 * an agent runs it.
 *
 * Most CLIs report a command after it ran, so the shield can't veto the first
 * one — what it can do is say so at once and stop the turn before it does
 * more. Rewind (on the turn's card) puts the files back; a force-push or a
 * dropped table it can't, which is why those are named plainly. Pure.
 */

export type Danger = { what: string; why: string };

const HOME = /(?:^|\s)(?:~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/?(?:\s|$)/;

/** What's dangerous about this command, or null. Reads the shell text only — never guesses at intent. */
export function dangerOf(command: string, projectDir?: string): Danger | null {
  const c = command.replace(/\s+/g, " ").trim();
  if (!c) return null;
  // git: rewriting what others have, or throwing work away
  if (/\bgit\s+push\b[^|;&]*(?:\s--force(?!-with-lease)\b|\s-f\b|\s\+\S+)/.test(c)) return { what: "a force-push", why: "it rewrites the remote's history — teammates' work on that branch can be lost, and Rewind can't undo it" };
  if (/\bgit\s+reset\s+--hard\b/.test(c)) return { what: "git reset --hard", why: "uncommitted work in the tree is thrown away" };
  if (/\bgit\s+clean\s+-[a-z]*f[a-z]*d|\bgit\s+clean\s+-[a-z]*d[a-z]*f/.test(c)) return { what: "git clean -fd", why: "every untracked file is deleted" };
  if (/\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/.test(c)) return { what: "discarding every change", why: "all uncommitted edits in the tree are thrown away" };
  if (/\bgit\s+branch\s+-D\b/.test(c)) return { what: "force-deleting a branch", why: "commits only on that branch become unreachable" };
  if (/\bgit\s+(?:filter-branch|filter-repo)\b|\bgit\s+rebase\b[^|;&]*\s(?:origin\/)?(?:main|master)\b.*--onto/.test(c)) return { what: "rewriting git history", why: "every commit after the change gets a new id" };
  // files: deleting outside the project, or everything
  const rm = /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\b(.*)$/.exec(c) ?? /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*[rR]\b(.*)$/.exec(c);
  if (rm) {
    const target = rm[1] ?? "";
    if (/(?:^|\s)\/(?:\s|$|\*)/.test(target) || HOME.test(` ${target} `) || /(?:^|\s)\.\.(?:\/|\s|$)/.test(target) || /(?:^|\s)\*(?:\s|$)/.test(target))
      return { what: "a recursive delete outside the work", why: "it deletes beyond the project (/, your home, .., or everything here)" };
    for (const p of target.split(/\s+/).filter((x) => x.startsWith("/"))) {
      if (!projectDir || !(p === projectDir || p.startsWith(projectDir.replace(/\/$/, "") + "/"))) return { what: "a recursive delete outside the project", why: `it deletes ${p}` };
    }
  }
  if (/\bfind\b[^|;&]*\s-delete\b/.test(c) && /\bfind\s+(?:\/|~)(?:\s|$)/.test(c)) return { what: "a find -delete across the disk", why: "it deletes matches anywhere under / or your home" };
  // data
  if (/\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i.test(c)) return { what: "dropping a table or database", why: "the data is gone unless there's a backup" };
  if (/\bTRUNCATE\s+(?:TABLE\s+)?\w/i.test(c)) return { what: "truncating a table", why: "every row is deleted" };
  if (/\bDELETE\s+FROM\s+\w+\s*(?:;|"|'|$)/i.test(c)) return { what: "a DELETE with no WHERE", why: "every row in the table is deleted" };
  if (/\b(?:prisma\s+migrate\s+reset|rails\s+db:(?:drop|reset)|dropdb)\b/.test(c)) return { what: "resetting the database", why: "it drops the database and everything in it" };
  // infrastructure and publishing
  if (/\bterraform\s+(?:destroy|apply\b[^|;&]*-auto-approve)/.test(c)) return { what: "terraform destroy/auto-approve", why: "it changes real infrastructure with no review" };
  if (/\bkubectl\s+delete\b/.test(c)) return { what: "kubectl delete", why: "it removes live cluster resources" };
  if (/\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/.test(c)) return { what: "publishing a package", why: "a published version can't be unpublished cleanly" };
  if (/\bdocker\s+system\s+prune\b[^|;&]*-a/.test(c)) return { what: "docker system prune -a", why: "every unused image, container and volume goes" };
  // the machine
  if (/\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/.test(c)) return { what: "piping a download into a shell", why: "it runs code from the internet unread" };
  if (/\bsudo\b/.test(c)) return { what: "sudo", why: "it runs as root, outside anything Loom can put back" };
  if (/\bchmod\s+(?:-R\s+)?777\b/.test(c)) return { what: "chmod 777", why: "anyone on the machine can then change those files" };
  if (/\b(?:mkfs|diskutil\s+erase|dd\s+[^|;&]*of=\/dev\/)/.test(c)) return { what: "writing to a disk device", why: "it can erase a drive" };
  return null;
}

/** The shell command a tool call ran, however the adapter reports it. */
export function commandOf(p: Record<string, unknown>): string | null {
  if (typeof p.command === "string" && p.command.trim()) return p.command;
  const tool = String(p.tool ?? "").toLowerCase();
  const input = p.input as Record<string, unknown> | undefined;
  if ((tool === "shell" || tool === "bash" || tool === "run_command" || tool === "exec") && typeof input?.command === "string") return input.command;
  return null;
}
