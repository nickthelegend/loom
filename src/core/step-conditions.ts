/**
 * Conditions a static route can honestly evaluate.
 *
 * Until now a route branched on exactly one thing: the step errored (`onFail`).
 * #34 was the collection point for the rest, and the bar for letting one in was
 * that it must be MECHANICAL — a number the daemon already has, not a judgement
 * about whether the work was any good. "The reviewer wasn't happy" stays with
 * the LLM router, where a judgement belongs.
 *
 * What qualified, all read off the turn's own diff:
 *
 *   changed>10         more than ten files changed
 *   changed<3          fewer than three did
 *   lines>200          more than two hundred lines added+removed
 *   lines<20           fewer than twenty
 *   touched:src/db/**  something under that path changed
 *   !touched:docs/**   nothing under that path did
 *
 * A step carrying one runs only when it holds — "send a big change to the
 * reviewer, let a small one go straight on" without a person deciding each
 * time. A step that can't be measured doesn't get to guess: with no diff to
 * read, `changed>N` and `lines>N` are false and their `<` forms are true,
 * which is exactly what "nothing changed" means.
 */

export interface TurnFacts {
  /** Files the turn changed, repo-relative. */
  files: string[];
  added: number;
  removed: number;
}

export type StepCondition =
  | { kind: "changed"; op: ">" | "<"; n: number }
  | { kind: "lines"; op: ">" | "<"; n: number }
  | { kind: "touched"; glob: string; negated: boolean };

/** A turn that changed nothing — what a host with no diff to offer reports. */
export const NO_CHANGES: TurnFacts = { files: [], added: 0, removed: 0 };

/**
 * Read a condition written the way a person writes one.
 *
 * Anything it doesn't understand is refused here, at parse time, where it can
 * still be fixed — rather than at run time, where an unreadable condition
 * would quietly never match and its step would silently never run.
 */
export function parseStepCondition(raw: string): StepCondition {
  const s = raw.trim();
  const count = /^(changed|files|lines)\s*([<>])\s*(\d+)$/i.exec(s);
  if (count) {
    const kind = count[1]!.toLowerCase() === "lines" ? "lines" : "changed";
    return { kind, op: count[2] as ">" | "<", n: Number(count[3]) };
  }
  const touched = /^(!?)\s*touched\s*:\s*(.+)$/i.exec(s);
  if (touched?.[2]?.trim()) {
    return { kind: "touched", glob: touched[2]!.trim(), negated: touched[1] === "!" };
  }
  throw new Error(
    `I don't understand the condition "${s}" — try changed>10, lines>200, touched:src/db/** or !touched:docs/**`,
  );
}

/** Does the turn meet the condition? */
export function conditionHolds(cond: StepCondition, facts: TurnFacts): boolean {
  if (cond.kind === "changed") {
    return cond.op === ">" ? facts.files.length > cond.n : facts.files.length < cond.n;
  }
  if (cond.kind === "lines") {
    const total = facts.added + facts.removed;
    return cond.op === ">" ? total > cond.n : total < cond.n;
  }
  const hit = facts.files.some((f) => matchesGlob(f, cond.glob));
  return cond.negated ? !hit : hit;
}

/** The condition in the words the thread uses to explain a skipped step. */
export function describeStepCondition(cond: StepCondition): string {
  if (cond.kind === "changed") {
    return `${cond.op === ">" ? "more" : "fewer"} than ${cond.n} files changed`;
  }
  if (cond.kind === "lines") {
    return `${cond.op === ">" ? "more" : "fewer"} than ${cond.n} lines changed`;
  }
  return cond.negated
    ? `nothing under ${cond.glob} changed`
    : `something under ${cond.glob} changed`;
}

/** The turn in the same terms, so the two can be read side by side. */
export function describeFacts(facts: TurnFacts): string {
  const n = facts.files.length;
  return `${n} file${n === 1 ? "" : "s"}, ${facts.added + facts.removed} lines`;
}

/**
 * Small glob matching: `*` within a segment, `**` across segments, `?` for a
 * single character. Enough for the paths people write into a route, and small
 * enough to be obviously right.
 */
export function matchesGlob(file: string, glob: string): boolean {
  // Sentinels: the two `**` forms are set aside while the rest is escaped,
  // then put back as regex. `a/**/b` may match nothing in the middle; a
  // trailing `a/**` means everything underneath.
  const DIRS = "<<anydirs>>";
  const REST = "<<anything>>";
  const pattern = glob.trim().replace(/^\.?\//, "");
  const rx = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, DIRS)
        .replace(/\*\*/g, REST)
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .split(DIRS)
        .join("(?:.*/)?")
        .split(REST)
        .join(".*") +
      "$",
  );
  return rx.test(file.replace(/^\.?\//, ""));
}
