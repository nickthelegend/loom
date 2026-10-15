/**
 * Review Triage: what to read first in a turn's diff.
 *
 * An agent hands back twelve changed files and you have five minutes. Most of
 * them are fine to skim; one deleted a test, one touched the auth middleware,
 * one added a dependency. This reads the patch and ranks the files by what a
 * reviewer would want to see first — each with the reasons, said plainly.
 *
 * It flags what the diff shows, never guesses at intent: "a test was removed",
 * not "the agent cheated". Pure: the runtime calls it on every turn_diff.
 */

export type TriageLevel = "high" | "medium" | "low";

export interface TriageItem {
  path: string;
  level: TriageLevel;
  score: number;
  /** Plain reasons, most important first. */
  reasons: string[];
  added: number;
  removed: number;
}

export interface Triage {
  /** Every changed file, the one to read first at the top. */
  files: TriageItem[];
  /** How many files are worth a careful look (high or medium). */
  flagged: number;
}

interface FileDiff { path: string; added: string[]; removed: string[]; deleted: boolean; created: boolean }

/** Split a unified diff (git's, plus Loom's new-file patches) into files. */
export function splitPatch(patch: string): FileDiff[] {
  const out: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of patch.split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) { cur = { path: head[2]!, added: [], removed: [], deleted: false, created: false }; out.push(cur); continue; }
    const note = /^\?\? new file: (.+?)( \(binary\))?$/.exec(line);
    if (note) { cur = null; out.push({ path: note[1]!, added: [], removed: [], deleted: false, created: true }); continue; }
    if (!cur) continue;
    if (line.startsWith("deleted file mode")) cur.deleted = true;
    else if (line.startsWith("new file mode")) cur.created = true;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return out;
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|[._-](test|spec)\.[a-z0-9]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;
const GENERATED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|(^|\/)(dist|build|out|coverage|vendor|node_modules)\/|\.min\.(js|css)$|\.snap$|\.map$/;
const DOCS = /\.(md|mdx|txt|rst)$|(^|\/)(docs?|CHANGELOG|LICENSE)/i;
const SECURITY = /(^|[/_.-])(auth|oauth|login|logout|session|token|jwt|crypto|password|passwd|secret|permission|acl|rbac|security|csrf|cors|middleware|sanitiz|keychain|credential)/i;
const CI = /(^|\/)(\.github\/workflows\/|\.gitlab-ci|\.circleci\/|Jenkinsfile|azure-pipelines)|(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|Procfile|vercel\.json|netlify\.toml|fly\.toml|railway\.json|app\.json|eas\.json)$|\.(tf|tfvars)$|(^|\/)(k8s|kubernetes|helm|deploy)\//i;
const DEPS = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|Cargo\.toml|go\.mod|Gemfile|composer\.json|build\.gradle(\.kts)?|pom\.xml)$/;
const MIGRATION = /(^|\/)(migrations?|migrate|schema)\/|\.sql$|schema\.prisma$|(^|\/)alembic\//i;
const CONFIG = /(^|\/)(\.env[^/]*|tsconfig[^/]*\.json|\.eslintrc[^/]*|eslint\.config\.[a-z]+|vite\.config\.[a-z]+|next\.config\.[a-z]+|webpack\.config\.[a-z]+|jest\.config\.[a-z]+|vitest\.config\.[a-z]+|\.npmrc|\.gitignore)$/;

/** What an added line can do that deserves eyes, said the way a reviewer would. */
const RISKY: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(sk|rk|pk)_(live|test)_[0-9a-zA-Z]{16,}|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[baprs]-[A-Za-z0-9-]{10,}/, "what looks like a secret key"],
  [/\b(password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["'][^"'\s]{6,}["']/i, "a hard-coded credential"],
  [/\beval\s*\(|new Function\s*\(/, "eval of a string"],
  [/\b(child_process|execSync|spawnSync|os\.system|subprocess\.(call|run|Popen)|shell\s*=\s*True)\b/, "running shell commands"],
  [/\brm\s+-[a-z]*r[a-z]*f|\bgit\s+push\b.*--force|\bgit\s+reset\s+--hard|\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i, "a destructive command"],
  [/dangerouslySetInnerHTML|\.innerHTML\s*=|v-html=/, "raw HTML injection"],
  [/rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED/, "TLS checks turned off"],
  [/chmod\s+(-R\s+)?777|Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*/, "wide-open permissions"],
  [/@ts-ignore|@ts-nocheck|eslint-disable(?!-next-line\s+no-console)|#\s*type:\s*ignore|# noqa/, "a check silenced"],
];

const SKIPPED_TEST = /\b(it|test|describe)\.(skip|only|todo)\s*\(|\b(xit|xdescribe|fit|fdescribe)\s*\(|@pytest\.mark\.skip|\bt\.Skip\(|#\[ignore\]/;
const TEST_CASE = /\b(it|test)\s*\(\s*["'`]|\bdef test_|\bfunc Test[A-Z]|#\[test\]|\bexpect\s*\(|\bassert/;

export function triage(patch: string, files: Array<{ path: string; status?: string }> = []): Triage {
  const diffs = new Map(splitPatch(patch).map((d) => [d.path, d]));
  // a file git saw change but the patch doesn't show (truncated, binary, a rename): still listed
  for (const f of files) if (!diffs.has(f.path)) diffs.set(f.path, { path: f.path, added: [], removed: [], deleted: /D/.test(f.status ?? ""), created: (f.status ?? "") === "??" });
  const all = [...diffs.values()];
  const testsTouched = all.some((d) => TEST_FILE.test(d.path) && !d.deleted);
  const items = all.map((d): TriageItem => {
    const reasons: Array<[number, string]> = [];
    const isTest = TEST_FILE.test(d.path);
    const say = (w: number, why: string) => { if (!reasons.some(([, r]) => r === why)) reasons.push([w, why]); };
    const added = d.added.join("\n");

    for (const [re, what] of RISKY) if (re.test(added)) say(what.includes("secret") || what.includes("credential") ? 100 : 30, `adds ${what}`);
    if (isTest) {
      if (d.deleted) say(45, "deletes a test file");
      else {
        if (SKIPPED_TEST.test(added)) say(40, "skips or focuses a test");
        const gone = d.removed.filter((l) => TEST_CASE.test(l)).length - d.added.filter((l) => TEST_CASE.test(l)).length;
        if (gone >= 2) say(35, `removes ${gone} test assertions or cases`);
      }
    }
    if (MIGRATION.test(d.path)) say(35, "changes the database schema or a migration");
    if (SECURITY.test(d.path) && !isTest) say(30, "touches auth or security code");
    if (CI.test(d.path)) say(25, "changes CI, build or deploy");
    if (DEPS.test(d.path) && d.added.some((l) => /["']?[@\w./-]+["']?\s*[:=]\s*["']?[~^<>=]?\d/.test(l) || /^[\w.-]+([=<>~!]=|>|<)/.test(l.trim()))) say(20, "adds or changes dependencies");
    if (CONFIG.test(d.path)) say(15, "changes project config");
    if (d.deleted && !isTest && !GENERATED.test(d.path)) say(15, "deletes the file");
    const lines = d.added.length + d.removed.length;
    const source = !isTest && !DOCS.test(d.path) && !GENERATED.test(d.path) && !CONFIG.test(d.path) && !DEPS.test(d.path);
    if (source && lines >= 20 && !testsTouched) say(15, `${lines} lines changed and no test was touched this turn`);

    let score = reasons.reduce((n, [w]) => n + w, 0) + Math.min(10, Math.round(lines / 25));
    if (GENERATED.test(d.path) && score < 100) { score = Math.round(score * 0.2); say(0, "generated or a lockfile: skim it"); }
    else if (DOCS.test(d.path) && score < 30) say(0, "docs");
    const ranked = reasons.sort((a, b) => b[0] - a[0]).map(([, r]) => r);
    const level: TriageLevel = score >= 40 || reasons.some(([w]) => w >= 40) ? "high" : score >= 15 ? "medium" : "low";
    return { path: d.path, level, score, reasons: ranked, added: d.added.length, removed: d.removed.length };
  });
  items.sort((a, b) => b.score - a.score || (b.added + b.removed) - (a.added + a.removed) || a.path.localeCompare(b.path));
  return { files: items, flagged: items.filter((i) => i.level !== "low").length };
}
