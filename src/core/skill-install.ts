/**
 * Installing a skill — copying somebody else's SKILL.md into this project.
 *
 * Discovery (core/skills.ts) answers "what do I already have". This answers the
 * other half: a skill you found in a gist, a repo, or a folder on disk becomes
 * `<projectDir>/skills/<id>/`, which is the first root the loader scans and the
 * only one Loom is allowed to write to.
 *
 * ## Why so much of this file is refusal
 *
 * Both entry points take a string from an HTTP body and turn it into filesystem
 * writes, so the interesting cases are all the ones that must not happen:
 *
 *   - **The id is a path.** `id` is joined onto `<projectDir>/skills/`, so an id
 *     of `../../.ssh` writes outside the project. It is validated against a
 *     character class rather than sanitised, because silently rewriting a
 *     malicious id into a benign one installs a skill under a name the caller
 *     didn't ask for, and then everything downstream is about the wrong skill.
 *
 *   - **The URL is a command.** `installSkillFromGit` runs git. Every argument
 *     goes through `execFile` with an array — never a shell string — so a URL
 *     containing `;` or `$(…)` is a URL git will fail to clone, not a command.
 *     The URL is also checked to be http(s) or ssh git first: git happily
 *     accepts `ext::sh -c …` and `--upload-pack=…` as "remotes", and those are
 *     code execution with extra steps.
 *
 *   - **An overwrite is silent.** Installing over an existing skill destroys
 *     whatever the user wrote there. It needs `force`, and the error says which
 *     id collided so the UI can offer the choice instead of guessing.
 *
 * A clone is bounded (90s) and runs with `GIT_TERMINAL_PROMPT=0`: a private repo
 * must fail as a private repo, not hang a request forever on a credential prompt
 * that nobody is at a terminal to answer.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSkillMd } from "./skills.js";

/** A refusal with a reason the UI can show verbatim. Distinct so routes can 400 it. */
export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInstallError";
  }
}

/** Where an installed skill came from — recorded so the caller can say so. */
export type SkillInstallOrigin = "dir" | "git";

export interface SkillInstallResult {
  /** The directory name under `<projectDir>/skills/`, and the skill's id. */
  id: string;
  /** The `name:` from the frontmatter. */
  name: string;
  description: string;
  /** Absolute path to the installed directory. */
  dir: string;
  /** Absolute path to the installed SKILL.md. */
  path: string;
  /** How it arrived: a local directory, or a clone. */
  from: SkillInstallOrigin;
  /** The exact source string the caller gave — the src dir, or the git URL. */
  source: string;
  /** True when an existing skill of the same id was replaced (needs `force`). */
  replaced: boolean;
}

export interface InstallOptions {
  /** Replace an existing skill of the same id instead of refusing. */
  force?: boolean;
  /**
   * Install under this id instead of the source directory's name. Validated
   * exactly like a derived id — the caller doesn't get a shortcut past the
   * traversal check by supplying the id itself.
   */
  id?: string;
}

/**
 * A skill id is a single directory name and nothing else.
 *
 * Letters, digits, dot, dash, underscore. No separators (so it cannot escape),
 * no leading dot (so it cannot be `.` , `..`, or a hidden directory that the
 * loader would then never list), and a length cap so a 4KB id can't be used to
 * probe path limits.
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertSafeId(id: string): string {
  const clean = String(id ?? "").trim();
  if (!clean) throw new SkillInstallError("skill id is empty — cannot tell where to install it");
  if (!ID_RE.test(clean) || clean.includes("..")) {
    throw new SkillInstallError(
      `"${clean}" is not a usable skill id — it must be a single directory name of letters, digits, dot, dash or underscore`,
    );
  }
  return clean;
}

/**
 * Read and validate the SKILL.md that makes a directory a skill.
 *
 * A directory with no SKILL.md is not a skill, and one whose frontmatter has no
 * `name:` is a skill nothing can refer to — the loader would fall back to the
 * directory name, which means installing it produces a manifest whose name was
 * invented here. Both are refused with the path, because "it didn't work" is
 * useless when you cloned a repo with four candidate folders in it.
 */
function readManifest(dir: string): { name: string; description: string; file: string } {
  const file = path.join(dir, "SKILL.md");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new SkillInstallError(`no readable SKILL.md in ${dir} — a skill is a directory containing SKILL.md`);
  }
  const { name, description } = parseSkillMd(raw);
  if (!name.trim()) {
    throw new SkillInstallError(`${file} has no \`name:\` in its frontmatter — a skill needs one to be referred to`);
  }
  return { name: name.trim(), description, file };
}

/**
 * Copy a skill directory into the project.
 *
 * The whole directory comes across, not just SKILL.md: skills reference scripts
 * and `references/` files next to them, and a skill installed without its
 * attachments is a skill whose instructions point at nothing.
 */
/**
 * Author a skill in place: scaffold `skills/<id>/SKILL.md`, validated.
 *
 * Skills could be browsed and installed but never written — authoring one
 * meant knowing the frontmatter convention by heart and hand-building the
 * directory. The validation is the same reader the roster uses (parseSkillMd),
 * so a skill this accepts is a skill the loader will actually offer: refusing
 * to write anything the roster would silently drop is the whole point.
 */
export function authorSkill(
  projectDir: string,
  input: { id: string; name: string; description: string; body?: string },
): { dir: string; file: string } {
  const id = input.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new SkillInstallError("a skill needs an id (letters, digits, dashes)");
  const name = input.name.trim();
  if (!name) throw new SkillInstallError("a skill needs a name");
  const description = input.description.trim();
  if (!description) {
    throw new SkillInstallError(
      "a skill needs a description — it's how agents decide when to use it",
    );
  }
  const skillsDir = path.join(projectDir, "skills");
  const dest = path.join(skillsDir, id);
  if (path.dirname(dest) !== skillsDir) {
    throw new SkillInstallError(`refusing "${id}" — it resolves outside ${skillsDir}`);
  }
  const file = path.join(dest, "SKILL.md");
  if (fs.existsSync(file)) {
    throw new SkillInstallError(`"${id}" already exists — edit ${file} instead`);
  }
  const md =
    `---\n` +
    `name: ${name}\n` +
    `description: ${description}\n` +
    `---\n\n` +
    (input.body?.trim()
      ? `${input.body.trim()}\n`
      : `# ${name}\n\nWrite the instructions an agent should follow here.\n\n` +
        `## When to use\n\n${description}\n\n## Steps\n\n1. …\n`);
  // Round-trip through the real parser before anything touches disk.
  const parsed = parseSkillMd(md);
  if (parsed.name !== name || parsed.description !== description) {
    throw new SkillInstallError(
      "the generated frontmatter didn't survive the parser — check for YAML-breaking characters",
    );
  }
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(file, md);
  return { dir: dest, file };
}

export function installSkillFromDir(
  srcDir: string,
  projectDir: string,
  opts: InstallOptions = {},
): SkillInstallResult {
  const src = path.resolve(String(srcDir ?? "").trim());
  if (!src || src === path.parse(src).root) {
    throw new SkillInstallError("no source directory given");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(src);
  } catch {
    throw new SkillInstallError(`${src} does not exist`);
  }
  if (!stat.isDirectory()) throw new SkillInstallError(`${src} is not a directory`);

  const id = assertSafeId(opts.id ?? path.basename(src));
  const { name, description } = readManifest(src);

  const skillsDir = path.join(projectDir, "skills");
  const dest = path.join(skillsDir, id);
  // Belt and braces: assertSafeId already forbids separators, so this can only
  // fire if that regex is ever loosened. It is cheap and it is the check that
  // actually protects the filesystem, so it stays.
  if (path.dirname(dest) !== skillsDir) {
    throw new SkillInstallError(`refusing to install "${id}" — it resolves outside ${skillsDir}`);
  }
  if (path.resolve(dest) === src) {
    throw new SkillInstallError(`${src} is already this project's "${id}" skill`);
  }

  const existed = fs.existsSync(dest);
  if (existed && !opts.force) {
    throw new SkillInstallError(`a skill named "${id}" is already installed — pass force to replace it`);
  }
  fs.mkdirSync(skillsDir, { recursive: true });
  if (existed) fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });

  return {
    id,
    name,
    description,
    dir: dest,
    path: path.join(dest, "SKILL.md"),
    from: "dir",
    source: src,
    replaced: existed,
  };
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/**
 * The remote forms git can be handed safely.
 *
 * https/http and ssh (both `ssh://host/path` and the scp-ish `git@host:path`).
 * Deliberately NOT `file://`, `ext::`, `--upload-pack=`, or a bare local path:
 * the transport helpers behind those run programs of the remote's choosing, and
 * a URL field in a web form is not where that decision should be made.
 */
const GIT_URL_RE = /^(?:https?:\/\/[^\s]+|ssh:\/\/[^\s]+|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+)$/;

function assertGitUrl(url: string): string {
  const clean = String(url ?? "").trim();
  if (!clean) throw new SkillInstallError("no git URL given");
  if (clean.startsWith("-")) {
    // `git clone -- <url>` already stops this, but a URL that looks like a flag
    // is never a real repository and the error is clearer here.
    throw new SkillInstallError(`"${clean}" is not a git URL`);
  }
  if (!GIT_URL_RE.test(clean)) {
    throw new SkillInstallError(
      `"${clean}" is not a git URL — expected https://…, ssh://…, or git@host:owner/repo`,
    );
  }
  return clean;
}

/** The repository's own name, used as the skill id when SKILL.md sits at the root. */
function repoName(url: string): string {
  const tail = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return tail.replace(/\.git$/i, "");
}

function runGit(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        // No credential prompt, no interactive host-key question: this runs
        // inside an HTTP handler where there is nobody to answer either.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GCM_INTERACTIVE: "never" },
      },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).split("\n").find((l) => l.trim())?.trim() ?? "";
          reject(new SkillInstallError(detail || `git ${args[0]} failed`));
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * Clone a repository and install the skill inside it.
 *
 * `--depth 1` because history is irrelevant to a directory of markdown, and a
 * shallow clone of a large skills repo is the difference between a second and a
 * minute. The SKILL.md is looked for at the repo root first and then one level
 * down — the two layouts people actually publish ("this repo IS a skill" and
 * "this repo is a folder of skills"). Deeper than that is ambiguous: a repo with
 * `a/b/SKILL.md` and `c/d/SKILL.md` has no obvious answer, and picking one is
 * how you install something the user didn't choose.
 *
 * The temp clone is removed on every path, including the failures.
 */
export async function installSkillFromGit(
  url: string,
  projectDir: string,
  opts: InstallOptions & { timeoutMs?: number } = {},
): Promise<SkillInstallResult> {
  const remote = assertGitUrl(url);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-skill-"));
  const checkout = path.join(tmp, "repo");
  try {
    await runGit(["clone", "--depth", "1", "--quiet", "--", remote, checkout], tmp, opts.timeoutMs ?? 90_000);

    const found = findSkillDir(checkout);
    if (!found) {
      throw new SkillInstallError(
        `no SKILL.md found in ${remote} — looked in the repository root and one level below it`,
      );
    }
    // The id comes from the subdirectory when the repo holds several skills, and
    // from the repository name when the repo *is* the skill. Either way it goes
    // through the same validation as a hand-typed one.
    const derived = found === checkout ? repoName(remote) : path.basename(found);
    const installed = installSkillFromDir(found, projectDir, { ...opts, id: opts.id ?? derived });
    return { ...installed, from: "git", source: remote };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // A leftover clone in the OS temp dir is not worth failing an install over.
    }
  }
}

/**
 * The repo root if it is itself a skill, else the first child directory that is.
 *
 * Exported for the tests: the two layouts this handles are the whole of the
 * git installer's judgement, and a clone is the one part of that path a test
 * can't reach offline.
 */
export function findSkillDir(root: string): string | null {
  if (fs.existsSync(path.join(root, "SKILL.md"))) return root;
  let children: string[] = [];
  try {
    children = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return null;
  }
  for (const child of children) {
    if (fs.existsSync(path.join(root, child, "SKILL.md"))) return path.join(root, child);
  }
  return null;
}
