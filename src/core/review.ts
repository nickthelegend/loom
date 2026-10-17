/**
 * Review: the same change read by several agents at once, none of them taking
 * the baton or touching a file, and their findings collected in one place to
 * accept or reject (#253). This file is the pure part — the brief each
 * reviewer gets and the reading of what it sends back. daemon/review.ts runs it.
 */

export type ReviewTarget =
  | { kind: "diff"; diff: string; untracked?: string[] }
  | { kind: "file"; file: string }
  | { kind: "text"; text: string };

export type Severity = "high" | "medium" | "low";

export interface Finding {
  id: string;
  agent: string;
  severity: Severity | null;
  file?: string;
  line?: number;
  text: string;
  /** Other reviewers that flagged the same place — agreement is the strongest signal a review has. */
  agreed?: Array<{ agent: string; text: string }>;
}

export type FindingDecision = "accepted" | "rejected";

/** A subtask brief tops out at 10k; the diff gets what's left after the instructions. */
const DIFF_ROOM = 7_500;

export const READ_ONLY_RULE =
  "This is a READ-ONLY review: do not edit, create or delete any file, and run nothing that changes the project. Read, think, and report.";

/** What a target is called in a title or a card. */
export function targetLabel(t: ReviewTarget | { kind: string; file?: string }): string {
  if (t.kind === "file") return String((t as { file?: string }).file ?? "a file");
  if (t.kind === "diff") return "the uncommitted changes";
  const first = String((t as { text?: string }).text ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  return first ? (first.length > 40 ? `${first.slice(0, 39)}…` : first) : "your request";
}

export function reviewPrompt(target: ReviewTarget, focus?: string): string {
  const what =
    target.kind === "file" ? `Review the file \`${target.file}\` in this project.`
    : target.kind === "text" ? `Review this: ${target.text}`
    : target.diff.trim()
      ? target.diff.length <= DIFF_ROOM
        ? `Review these uncommitted changes (\`git diff HEAD\`):\n\n\`\`\`diff\n${target.diff}\n\`\`\``
        : `Review the uncommitted changes — run \`git diff HEAD\` to read them (${Math.round(target.diff.length / 1000)}k characters, too long to paste here). They start:\n\n\`\`\`diff\n${target.diff.slice(0, 1500)}\n\`\`\``
      : "Review the uncommitted changes (`git diff HEAD`) — there are none tracked yet, so review the new files.";
  const fresh = target.kind === "diff" && target.untracked?.length ? `\nNew files, not yet in git: ${target.untracked.slice(0, 30).join(", ")}${target.untracked.length > 30 ? ", …" : ""}` : "";
  return [
    what + fresh,
    focus ? `Focus on: ${focus}` : "",
    READ_ONLY_RULE,
    "List each finding on its own line, worst first, exactly like this:\n- [high] path/to/file.ts:42 — what is wrong, and the fix\n" +
      "Use [high] for bugs, data loss or security; [medium] for wrong-but-survivable; [low] for style and nits. " +
      "If you find nothing worth changing, say so in one line. Keep anything else short.",
  ].filter(Boolean).join("\n\n");
}

const SEVERITY: Record<string, Severity> = {
  critical: "high", blocker: "high", high: "high", major: "high", severe: "high",
  medium: "medium", med: "medium", moderate: "medium",
  low: "low", minor: "low", nit: "low", nitpick: "low", info: "low", style: "low",
};
const SEV_HEAD = /^(?:\*\*|__)?\s*[[(]?\s*(critical|blocker|high|major|severe|medium|med|moderate|low|minor|nit|nitpick|info|style)\s*[\])]?\s*(?:\*\*|__)?\s*[:—–-]*\s*/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;
const LOC = /`?((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,6})(?::(\d+)(?:[-–]\d+)?)?`?/;

/**
 * The findings in a reviewer's reply. A bullet counts when it carries a
 * severity or points at a file — "Summary: looks fine" is not a finding.
 */
export function parseFindings(reply: string, agent: string, idPrefix = ""): Finding[] {
  const out: Finding[] = [];
  for (const raw of reply.split("\n")) {
    const m = raw.match(BULLET);
    if (!m) continue;
    let body = m[1]!.trim();
    const sev = body.match(SEV_HEAD);
    const severity = sev ? SEVERITY[sev[1]!.toLowerCase()] ?? null : null;
    if (sev) body = body.slice(sev[0].length);
    const loc = body.match(LOC);
    const looksLikeFile = loc && (loc[2] || /\//.test(loc[1]!) || /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|css|scss|html|vue|svelte|json|ya?ml|toml|md|sql|sh)$/i.test(loc[1]!));
    if (!severity && !looksLikeFile) continue;
    let text = body;
    // "path:12 — the problem" → "the problem"
    if (looksLikeFile && body.indexOf(loc![0]) <= 2) text = body.slice(body.indexOf(loc![0]) + loc![0].length).replace(/^\s*[:—–-]+\s*/, "");
    text = text.replace(/\*\*/g, "").trim();
    if (!text) continue;
    out.push({ id: `${idPrefix}${out.length + 1}`, agent, severity, ...(looksLikeFile ? { file: loc![1]! } : {}), ...(looksLikeFile && loc![2] ? { line: Number(loc![2]) } : {}), text: text.slice(0, 600) });
  }
  return out;
}

const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

const rank = (f: Finding) => RANK[f.severity ?? "low"] ?? 3;

/**
 * Every reviewer's findings in one list, worst first, ids unique to the
 * review. Two reviewers pointing at the same file and line are one finding
 * that both agree on — kept at the worse severity, the other's words beside it.
 */
export function collectFindings(reviewId: string, replies: Array<{ agent: string; reply: string }>): Finding[] {
  const merged: Finding[] = [];
  const at = new Map<string, Finding>();
  for (const f of replies.flatMap((r) => parseFindings(r.reply, r.agent))) {
    const key = f.file && f.line ? `${f.file}:${f.line}` : null;
    const same = key ? at.get(key) : undefined;
    if (!same || same.agent === f.agent) {
      merged.push(f);
      if (key && !same) at.set(key, f);
      continue;
    }
    if ((same.agreed ?? []).some((a) => a.agent === f.agent)) continue;
    if (rank(f) < rank(same)) {
      same.agreed = [...(same.agreed ?? []), { agent: same.agent, text: same.text }];
      Object.assign(same, { agent: f.agent, severity: f.severity, text: f.text });
    } else {
      same.agreed = [...(same.agreed ?? []), { agent: f.agent, text: f.text }];
    }
  }
  merged.sort((a, b) => rank(a) - rank(b) || (b.agreed?.length ?? 0) - (a.agreed?.length ?? 0));
  return merged.map((f, i) => ({ ...f, id: `${reviewId}.${i + 1}` }));
}

/** One line for the card and the CLI: "3 reviewers · 7 findings (2 high)". */
export function reviewSummary(results: Array<{ status: string; edited?: string[] }>, findings: Finding[]): string {
  const failed = results.filter((r) => r.status !== "done").length;
  const wrote = results.filter((r) => r.edited?.length).length;
  const high = findings.filter((f) => f.severity === "high").length;
  const agreed = findings.filter((f) => f.agreed?.length).length;
  return `${results.length} reviewer${results.length === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""} · ` +
    (findings.length ? `${findings.length} finding${findings.length === 1 ? "" : "s"}${high ? ` (${high} high)` : ""}${agreed ? ` · ${agreed} flagged by more than one` : ""}` : "no findings") +
    (wrote ? ` · ⚠ ${wrote} changed files in a read-only review` : "");
}

/** How an accepted finding reads as a project decision. */
export function decisionText(f: Finding, note?: string): string {
  return `Review finding accepted (${[f.agent, ...(f.agreed ?? []).map((a) => a.agent)].join(" + ")}${f.severity ? `, ${f.severity}` : ""}): ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : ""}${f.text}${note ? ` — ${note}` : ""}`;
}
