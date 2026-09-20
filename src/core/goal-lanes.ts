/**
 * Two goals at once, when they can't collide.
 *
 * One goal at a time is the safe answer, and for a long while it was the only
 * one: worktrees, the baton, and a single integration branch make two goals
 * editing the same files a merge nobody can explain. The prompt queue exists
 * because of that limit.
 *
 * Teams already solved the hard half — `landing.lanes` are path scopes, and
 * goals in different lanes land without arbitration. This is the same idea
 * locally: a goal declares the paths it expects to touch, and two goals run
 * together only when those paths are disjoint. Anything overlapping queues as
 * it always did, with the overlap named as the reason.
 *
 * The default stays one at a time. Nothing here changes for anyone who doesn't
 * ask for more.
 */

export interface GoalScope {
  runId: string;
  goal: string;
  /** The globs this goal expects to touch, from its plan's `touches`. */
  paths: string[];
}

/** Everything, when a goal hasn't said what it touches. */
export const UNSCOPED = "**";

/**
 * Do two path sets overlap?
 *
 * Deliberately conservative: anything it cannot prove disjoint counts as an
 * overlap. A false "they collide" costs you a queued goal; a false "they're
 * fine" costs you a merge you can't explain.
 */
export function overlaps(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return true; // unknown scope touches everything
  for (const x of a) {
    for (const y of b) {
      if (globsIntersect(x, y)) return true;
    }
  }
  return false;
}

/** Which of the two globs' prefixes collide, in words a person can check. */
export function overlapReason(a: string[], b: string[]): string | null {
  if (!a.length || !b.length) return "one of them doesn't say what it touches";
  for (const x of a) {
    for (const y of b) {
      if (globsIntersect(x, y)) return `${x} and ${y}`;
    }
  }
  return null;
}

/**
 * Two globs intersect when one's fixed prefix contains the other's.
 *
 * Not a full glob algebra — a full one would be more precise and much easier
 * to get subtly wrong. Everything up to the first wildcard is compared as a
 * path prefix, which is exactly the question being asked: could these two ever
 * write the same file?
 */
export function globsIntersect(a: string, b: string): boolean {
  const pa = fixedPrefix(a);
  const pb = fixedPrefix(b);
  if (pa === "" || pb === "") return true; // a leading wildcard reaches anything
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** The part of a glob before its first wildcard, normalised. */
export function fixedPrefix(glob: string): string {
  const g = glob.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  const wild = g.search(/[*?[{]/);
  const head = wild < 0 ? g : g.slice(0, wild);
  // "src/auth/**" → "src/auth/", "src/a*.ts" → "src/", "src/app.ts" → "src/app.ts"
  const cut = head.lastIndexOf("/");
  if (wild < 0) return head;
  return cut < 0 ? "" : head.slice(0, cut + 1);
}

/**
 * May `candidate` start while `running` are in flight?
 *
 * Returns null to go, or the reason it must wait — the same shape the queue
 * uses for everything else it's waiting on.
 */
export function blockedBy(candidate: GoalScope, running: GoalScope[], maxConcurrent: number): string | null {
  if (running.length === 0) return null;
  if (running.length >= Math.max(1, maxConcurrent)) {
    // Name the goal when there's one to name: "waiting for X" beats a count.
    return running.length === 1
      ? `waiting for the goal "${running[0]!.goal.slice(0, 60)}" to finish`
      : `waiting — ${running.length} goals already running (maxConcurrentGoals is ${maxConcurrent})`;
  }
  for (const other of running) {
    if (overlaps(candidate.paths, other.paths)) {
      const why = overlapReason(candidate.paths, other.paths);
      return `waiting for "${other.goal.slice(0, 50)}" — both touch ${why}`;
    }
  }
  return null;
}
