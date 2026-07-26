/**
 * Skills — SKILL.md context blocks injected into an agent's system prompt.
 *
 * A skill is a directory `skills/<id>/SKILL.md` with YAML frontmatter (name,
 * description) and a markdown body. Enabled skills (per project, in
 * .loom/config.json) get their bodies prepended to the briefing so every agent
 * follows the same conventions/procedures. Plus a keyword matcher that suggests
 * a relevant skill as the user types.
 *
 * ## Why the search widened
 *
 * This used to look in exactly two places: the project's own `skills/` and the
 * daemon's bundled one. Which meant that on a machine with dozens of skills
 * already installed — `~/.claude/skills`, plus everything a marketplace plugin
 * dropped into `~/.claude/plugins/cache/…` — Loom reported that you had one.
 * The skills were right there on disk and the picker said "agent-triage" and
 * nothing else. That is not a small omission: skills are the one place a user
 * writes down how their agents should behave, and Loom was ignoring all of them
 * because it only knew one directory layout.
 *
 * `discoverSkillRoots` knows the four layouts that actually exist. Each root
 * carries an `origin` so a manifest can say where it came from, because "you
 * have 60 skills" is much less useful than "3 of these are yours, 40 came from
 * a plugin, and this one is the project's". First root wins on a duplicate id,
 * so a project can shadow a user skill with its own version of the same name —
 * the same precedence Claude Code itself uses.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where a skill came from, which is the difference between "the project ships
 * this" and "this happens to be installed on the laptop". The UI needs it to
 * label a row; `removeSkill` needs it to refuse deleting somebody else's file.
 */
export type SkillOrigin = "project" | "user" | "plugin" | "bundled";

/** A directory to scan for `<id>/SKILL.md`, tagged with where it sits. */
export interface SkillRoot {
  dir: string;
  origin: SkillOrigin;
}

export interface SkillManifest {
  id: string; // the directory name
  name: string;
  description: string;
  path: string;
  body: string;
  enabled: boolean;
  /** The root directory this skill was found under (not the SKILL.md path). */
  source: string;
  origin: SkillOrigin;
}

/** Split a SKILL.md into its frontmatter fields and the body after it. */
export function parseSkillMd(text: string): { name: string; description: string; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return { name: "", description: "", body: text.trim() };
  const fm = m[1]!;
  const body = (m[2] ?? "").trim();
  const field = (key: string): string => {
    // key: value  (value may be a folded `>` block continued on indented lines)
    const re = new RegExp(`^${key}\\s*:\\s*(>-?|\\|-?)?[ \\t]*(.*)$`, "m");
    const fmm = re.exec(fm);
    if (!fmm) return "";
    if (fmm[1]) {
      // folded/literal block: gather the following indented lines
      const start = fm.indexOf(fmm[0]) + fmm[0].length;
      const rest = fm.slice(start).split("\n");
      const lines: string[] = fmm[2] ? [fmm[2]] : [];
      for (const l of rest) {
        if (/^\s+\S/.test(l) || l.trim() === "") lines.push(l.trim());
        else break;
      }
      return lines.join(" ").trim();
    }
    return fmm[2]!.replace(/^["']|["']$/g, "").trim();
  };
  return { name: field("name"), description: field("description"), body };
}

/**
 * Scan the given roots for `<dir>/SKILL.md`, deduped by id (first root wins).
 *
 * A plain string root is accepted and reported as `origin: "project"` — the
 * callers that predate origins pass their own single directory and that is what
 * it means to them. Anything unreadable (a root that doesn't exist, a directory
 * with no SKILL.md, a permission error on somebody else's plugin cache) is
 * skipped rather than thrown: this runs on every list request and on every turn,
 * and one bad directory must not take the roster with it.
 */
export function loadSkills(
  roots: Array<string | SkillRoot>,
  enabledMap: Record<string, boolean> = {},
): SkillManifest[] {
  const byId = new Map<string, SkillManifest>();
  for (const raw of roots) {
    const root: SkillRoot = typeof raw === "string" ? { dir: raw, origin: "project" } : raw;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue; // no such dir
    }
    for (const id of entries) {
      if (byId.has(id)) continue;
      const p = path.join(root.dir, id, "SKILL.md");
      let text: string;
      try {
        text = fs.readFileSync(p, "utf8");
      } catch {
        continue; // no SKILL.md in this dir
      }
      const { name, description, body } = parseSkillMd(text);
      byId.set(id, {
        id,
        name: name || id,
        description,
        path: p,
        body,
        enabled: enabledMap[id] === true,
        source: root.dir,
        origin: root.origin,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Where skills live
// ---------------------------------------------------------------------------

/**
 * Claude Code's config directory. `CLAUDE_CONFIG_DIR` is its own documented
 * override, so honouring it is both correct for a user who has moved theirs and
 * the hook the tests use to keep discovery off the developer's real machine.
 */
export function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return override ? override : path.join(os.homedir(), ".claude");
}

/** Directory names to try under a plugin's checkout, in the order they win. */
const PLUGIN_SKILL_SUBDIRS = ["skills", path.join(".claude", "skills")];

/**
 * Skill directories belonging to installed marketplace plugins.
 *
 * The cache is laid out `<home>/plugins/cache/<marketplace>/<plugin>/…`, and the
 * "…" is the part that has moved between Claude Code versions: some installs put
 * `skills/` directly under the plugin, newer ones interpose a version directory
 * (`<plugin>/1.1.0/skills`), and a few plugins nest theirs under `.claude/`.
 * Rather than guess one, this walks the two levels that are stable and probes
 * every shape at each — a directory that isn't there costs one failed stat.
 *
 * Bounded on purpose: two `readdir` levels, no recursion. A plugin cache is
 * somebody else's tree and can be arbitrarily deep; walking it looking for
 * SKILL.md would turn a list request into a full-disk scan.
 */
export function pluginSkillRoots(home = claudeHome()): string[] {
  const cache = path.join(home, "plugins", "cache");
  const out: string[] = [];
  const dirsIn = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return []; // no cache, or not ours to read
    }
  };
  const collect = (base: string): void => {
    for (const sub of PLUGIN_SKILL_SUBDIRS) {
      const candidate = path.join(base, sub);
      try {
        if (fs.statSync(candidate).isDirectory()) out.push(candidate);
      } catch {
        // not this layout
      }
    }
  };
  for (const marketplace of dirsIn(cache)) {
    for (const plugin of dirsIn(path.join(cache, marketplace))) {
      const pluginDir = path.join(cache, marketplace, plugin);
      collect(pluginDir);
      // …and the versioned layout, `<plugin>/<version>/skills`.
      for (const version of dirsIn(pluginDir)) collect(path.join(pluginDir, version));
    }
  }
  return out;
}

/**
 * Every root a project can draw skills from, in precedence order.
 *
 * Project first (a repo's own conventions beat anything installed globally),
 * then the user's, then plugins, then whatever the daemon was started next to.
 * `bundledDir` is last because it is the weakest claim of the four: it is
 * "there was a skills/ folder in the process's cwd", which is Loom's own
 * checkout when you run it from source and nothing at all when you don't.
 */
export function discoverSkillRoots(projectDir: string, bundledDir?: string): SkillRoot[] {
  const roots: SkillRoot[] = [
    { dir: path.join(projectDir, "skills"), origin: "project" },
    { dir: path.join(projectDir, ".claude", "skills"), origin: "project" },
    { dir: path.join(claudeHome(), "skills"), origin: "user" },
    ...pluginSkillRoots().map((dir): SkillRoot => ({ dir, origin: "plugin" })),
  ];
  if (bundledDir) roots.push({ dir: bundledDir, origin: "bundled" });
  // Two roots can resolve to the same directory (running the daemon from inside
  // the project makes cwd/skills the project's own). Keeping both would be
  // harmless — loadSkills dedupes by id — but it would report the bundled root
  // as the source of a project skill, which is a wrong answer, not a slow one.
  const seen = new Set<string>();
  return roots.filter((r) => (seen.has(r.dir) ? false : (seen.add(r.dir), true)));
}

/**
 * One row of the skill picker: everything a list screen needs and nothing it
 * doesn't. The body is deliberately absent — see ProjectRuntime#skillsCatalog.
 */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  origin: SkillOrigin;
  /** The root directory it was found under, so the UI can say where it lives. */
  source: string;
  /** Does it live in this project's own `skills/` dir (and so can be removed)? */
  installed: boolean;
}

/** The block prepended to a briefing for the enabled skills. Empty if none. */
export function buildSkillsBlock(skills: SkillManifest[]): string {
  const on = skills.filter((s) => s.enabled && s.body.trim());
  if (!on.length) return "";
  return `--- ACTIVE SKILLS ---\n${on.map((s) => s.body.trim()).join("\n---\n")}\n--- END ACTIVE SKILLS ---\n`;
}

/** Keyword → skill-id rules, most specific first. */
const SUGGEST_RULES: Array<{ id: RegExp; when: RegExp }> = [
  { id: /triage/i, when: /\btriage\b|why did|failing|failed|debug (the )?agent|root[- ]?cause|stall/i },
  { id: /clickhouse|generating-queries|query/i, when: /\bquery\b|clickhouse|\btraces?\b|\bspans?\b/i },
  { id: /creating-alerts|alert/i, when: /\balert\b|threshold|\bfire[sd]?\b|notify me|page me/i },
  { id: /creating-dashboards|dashboard/i, when: /dashboard/i },
];

/** The single best skill to suggest for a message, or null. */
export function suggestSkill(message: string, skills: SkillManifest[]): SkillManifest | null {
  const msg = message || "";
  if (msg.trim().length < 4) return null;
  for (const rule of SUGGEST_RULES) {
    if (!rule.when.test(msg)) continue;
    const hit = skills.find((s) => !s.enabled && rule.id.test(s.id));
    if (hit) return hit;
  }
  return null;
}
