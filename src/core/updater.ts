/**
 * Is there a newer Loom, and can this copy fetch it?
 *
 * Two questions, and they have different answers depending on how Loom got
 * here. A git checkout pulls and rebuilds; a global npm install reinstalls
 * itself from the same spec it came from; anything else (a packaged desktop
 * app, a copied folder) is told plainly to download the release rather than
 * having a command guessed at and run over it.
 *
 * Nothing here decides on its own to upgrade. `check` looks, `plan` says what
 * would happen in the exact words of the command, and the daemon runs it only
 * when someone asks.
 */

import fs from "node:fs";
import path from "node:path";

export type InstallKind = "git" | "npm-global" | "unknown";

export interface Release {
  /** The tag without its leading v — comparable with VERSION. */
  version: string;
  tag: string;
  url: string;
  publishedAt: string | null;
}

export interface UpdatePlan {
  /** What this copy is, and so what updating it means. */
  install: InstallKind;
  /** The directory the commands run in (a checkout, or the global prefix). */
  cwd: string | null;
  /** Each step, in the words that will be run — nothing hidden. */
  steps: Array<{ cmd: string; args: string[] }>;
  /** Null when we can update; otherwise why we won't try. */
  refusal: string | null;
}

/** The repository releases are read from. Overridable for testing and forks. */
export const RELEASES_REPO = process.env.LOOM_RELEASES_REPO || "nickthelegend/loom";

/** How long a release check is trusted, so a background poll can't hammer the API. */
export const CHECK_TTL_MS = 6 * 60 * 60_000;

/**
 * Semver-ish comparison, enough for `v0.2.10` > `v0.2.9` and prereleases
 * sorting under their release. Unknown shapes compare as equal, which means
 * "no update" — the safe direction.
 */
export function newerThan(a: string, b: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x.nums[i]! !== y.nums[i]!) return x.nums[i]! > y.nums[i]!;
  }
  // 1.0.0 is newer than 1.0.0-rc1; two prereleases compare as strings.
  if (x.pre === y.pre) return false;
  if (!x.pre) return true;
  if (!y.pre) return false;
  return x.pre > y.pre;
}

/** The newest published release, or null when the network or the repo says nothing. */
export async function latestRelease(
  fetchImpl: typeof fetch = fetch,
  repo: string = RELEASES_REPO,
): Promise<Release | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: ctl.signal,
      headers: { accept: "application/vnd.github+json", "user-agent": "loom-updater" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: string; html_url?: string; published_at?: string; draft?: boolean; prerelease?: boolean };
    if (!body.tag_name || body.draft) return null;
    return {
      version: body.tag_name.replace(/^v/, ""),
      tag: body.tag_name,
      url: body.html_url ?? `https://github.com/${repo}/releases/tag/${body.tag_name}`,
      publishedAt: body.published_at ?? null,
    };
  } catch {
    // offline, rate-limited, a repo with no releases: not an error, just no answer
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How this copy of Loom was installed, from where its own code sits.
 *
 * A checkout has a .git above it. A global npm install lives under a
 * node_modules whose package.json is ours. Everything else is unknown, and
 * unknown is a fine answer — it just means we don't run anything.
 */
export function detectInstall(moduleDir: string): { kind: InstallKind; cwd: string | null; spec?: string } {
  let dir = moduleDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return { kind: "git", cwd: dir };
    // .../lib/node_modules/@loompad/cli/dist → the package root holds package.json
    const pkgFile = path.join(dir, "package.json");
    if (fs.existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { name?: string };
        if (pkg.name && dir.includes(`${path.sep}node_modules${path.sep}`)) {
          return { kind: "npm-global", cwd: dir, spec: `github:${RELEASES_REPO}` };
        }
      } catch {
        /* a package.json we can't read tells us nothing */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { kind: "unknown", cwd: null };
}

/** What updating this copy would actually run. */
export function plan(install: { kind: InstallKind; cwd: string | null; spec?: string }): UpdatePlan {
  if (install.kind === "git" && install.cwd) {
    return {
      install: "git",
      cwd: install.cwd,
      steps: [
        { cmd: "git", args: ["pull", "--ff-only"] },
        { cmd: "npm", args: ["install", "--no-audit", "--no-fund"] },
        { cmd: "npm", args: ["run", "build"] },
      ],
      refusal: null,
    };
  }
  if (install.kind === "npm-global") {
    return {
      install: "npm-global",
      cwd: install.cwd,
      steps: [{ cmd: "npm", args: ["install", "-g", install.spec ?? `github:${RELEASES_REPO}`] }],
      refusal: null,
    };
  }
  return {
    install: "unknown",
    cwd: null,
    steps: [],
    refusal: "this copy of Loom wasn't installed from git or npm — download the release instead",
  };
}

/** A git checkout with uncommitted work is yours, not ours to rebase. */
export function refuseDirtyCheckout(status: string): string | null {
  return status.trim() ? "this checkout has uncommitted changes — commit or stash them first" : null;
}
