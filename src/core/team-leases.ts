/**
 * Loom Teams, Phase 2 — what a lease covers, and when two leases collide.
 *
 * Decisions this implements (docs/teams-architecture.md §1a):
 *   D28  overlap is computed on REAL files: each lease carries its globs, the
 *        tracked files they match right now, and the literal directory
 *        prefixes of its globs (for files that don't exist yet). Two leases
 *        overlap on a shared file, or where one's file or prefix sits under
 *        the other's prefix. `**\/*.test.ts` vs `src/auth/**` is caught because
 *        the expansion finds src/auth/session.test.ts in both.
 *   D10  hard zones: globs where only one goal may hold a lease at a time.
 *
 * Pure functions, no IO — the hub, the daemon and the phone share them.
 */

export interface LeaseScope {
  globs: string[];
  /** Tracked files the globs match (capped). */
  files: string[];
  /** Literal directory prefixes of the globs, each ending in "/" (or an exact path). */
  prefixes: string[];
}

export const MAX_LEASE_FILES = 500;

/** Normalize a repo-relative path: no leading ./ or /, forward slashes. */
export function normPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * A glob as a RegExp: `**` spans directories, `*` and `?` don't, `{a,b}`
 * alternates. Enough of git's pathspec-ish syntax for declaring touches.
 */
export function globToRegExp(glob: string): RegExp {
  const g = normPath(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // "**/" — zero or more directories
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end > i) {
        re += `(?:${g.slice(i + 1, end).split(",").map(escapeRe).join("|")})`;
        i = end;
      } else re += "\\{";
    } else re += escapeRe(c);
  }
  // A bare directory ("src/auth" or "src/auth/") means everything in it.
  if (!/[*?{]/.test(g)) return new RegExp(`^${escapeRe(g.replace(/\/$/, ""))}(?:/.*)?$`);
  return new RegExp(`^${re}$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

/** The literal part of a glob before its first wildcard, as a directory (or exact path). */
export function literalPrefix(glob: string): string {
  const g = normPath(glob);
  const wild = g.search(/[*?{]/);
  if (wild < 0) return g; // an exact path or a bare directory
  const head = g.slice(0, wild);
  const slash = head.lastIndexOf("/");
  return slash < 0 ? "" : head.slice(0, slash + 1);
}

/** Build a lease scope from declared globs against the repo's tracked files. */
export function scopeOf(globs: string[], tracked: string[]): LeaseScope {
  const clean = [...new Set(globs.map(normPath).filter(Boolean))].slice(0, 50);
  const res = clean.map(globToRegExp);
  const files: string[] = [];
  for (const f of tracked) {
    const p = normPath(f);
    if (res.some((r) => r.test(p))) {
      files.push(p);
      if (files.length >= MAX_LEASE_FILES) break;
    }
  }
  const prefixes = [...new Set(clean.map(literalPrefix))];
  return { globs: clean, files, prefixes };
}

/** `under("src/auth/x.ts", "src/auth/")` — a path inside a prefix (or equal to an exact one). */
function under(p: string, prefix: string): boolean {
  if (prefix === "") return true; // a glob starting with a wildcard covers the whole repo
  if (prefix.endsWith("/")) return p.startsWith(prefix);
  return p === prefix || p.startsWith(prefix + "/");
}

/**
 * Where two scopes collide: shared files, files of one under a prefix of the
 * other, and nested prefixes (two plans for the same not-yet-existing folder).
 * Empty when they don't overlap. Repo-wide prefixes ("") only collide through
 * real files — a `**\/*.md` lease must not look like it owns everything.
 */
export function overlap(a: LeaseScope, b: LeaseScope): string[] {
  const out = new Set<string>();
  const bFiles = new Set(b.files);
  for (const f of a.files) if (bFiles.has(f)) out.add(f);
  const aPre = a.prefixes.filter((p) => p !== "");
  const bPre = b.prefixes.filter((p) => p !== "");
  const aRe = a.globs.map(globToRegExp);
  const bRe = b.globs.map(globToRegExp);
  for (const f of a.files) if (bPre.some((p) => under(f, p)) && bRe.some((r) => r.test(f))) out.add(f);
  for (const f of b.files) if (aPre.some((p) => under(f, p)) && aRe.some((r) => r.test(f))) out.add(f);
  for (const pa of aPre) for (const pb of bPre) if (under(pa, pb) || under(pb, pa)) out.add(pa.length >= pb.length ? pa : pb);
  return [...out].sort();
}

/** The first hard zone this scope touches, or null. */
export function zoneOf(scope: LeaseScope, zones: string[]): string | null {
  for (const z of zones) {
    const re = globToRegExp(z);
    const zp = literalPrefix(z);
    if (scope.files.some((f) => re.test(f))) return z;
    if (scope.prefixes.some((p) => p !== "" && (under(p, zp) || (zp !== "" && under(zp, p))))) return z;
  }
  return null;
}

/** Does a path fall inside any of these globs? (Drift detection, D33.) */
export function covered(path: string, globs: string[]): boolean {
  const p = normPath(path);
  return globs.some((g) => globToRegExp(g).test(p));
}
