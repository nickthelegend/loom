import fs from "node:fs";
import path from "node:path";
import { projectGit } from "../project-creation.js";

function read(dir: string, file: string): string {
  const p = path.join(dir, file);
  const stat = fs.lstatSync(p, { throwIfNoEntry: false });
  return stat?.isFile() && stat.size < 1_000_000 ? fs.readFileSync(p, "utf8") : "";
}
export function detectStack(dir: string) {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try { pkg = JSON.parse(read(dir, "package.json")); } catch { /* A malformed manifest is reported as a missing test command. */ }
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const python = Boolean(read(dir, "pyproject.toml") || read(dir, "requirements.txt") || fs.existsSync(path.join(dir, "main.py")));
  const stack = deps.expo ? "Expo / React Native" : deps.next ? "Next.js" : deps.react ? "React" : python ? "Python" : read(dir, "tsconfig.json") ? "TypeScript" : read(dir, "package.json") ? "Node.js" : fs.existsSync(path.join(dir, "index.html")) ? "static site" : "repository";
  const testCommand = typeof pkg?.scripts?.test === "string" && pkg.scripts.test.trim() && !/no test specified/i.test(pkg.scripts.test) ? "npm test" : python && (fs.existsSync(path.join(dir, "tests")) || fs.existsSync(path.join(dir, "test_main.py"))) ? "python -m unittest discover" : null;
  return { stack, testCommand };
}

function repoSize(dir: string) {
  let bytes = 0, files = 0, truncated = false;
  const walk = (folder: string, depth: number) => {
    if (depth > 30 || files > 20_000) { truncated = true; return; }
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if ([".git", ".loom", "node_modules", ".venv", "venv"].includes(entry.name)) continue;
      if (++files > 20_000) { truncated = true; return; }
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) bytes += fs.statSync(full).size;
    }
  };
  walk(dir, 0);
  return { bytes, files, truncated };
}
export async function projectReadiness(dir: string, fix = false) {
  const { stack, testCommand } = detectStack(dir);
  const applied: string[] = [];
  const instruction = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"].find(f => read(dir, f).trim());
  const draft = `# Agent instructions\n\n## Project\nThis is a ${stack} project. Read the existing code before changing it.\n\n## Verification\n${testCommand ? `Run \`${testCommand}\` after changes.` : "Document and run the project's test command before submitting changes."}\n\n## Working agreements\nKeep changes focused. Do not commit secrets. Explain what changed and what you tested.\n`;
  const ignorePath = path.join(dir, ".gitignore");
  const ignore = read(dir, ".gitignore");
  const ignored = /^(?:\/)?\.loom\/?\s*$/m.test(ignore);
  const ignoreStat = fs.lstatSync(ignorePath, { throwIfNoEntry: false });
  if (fix && !ignored && ignoreStat && (!ignoreStat.isFile() || ignoreStat.nlink !== 1 || ignoreStat.size >= 1_000_000)) {
    throw new Error(".gitignore must be a regular file smaller than 1 MB with no hard links");
  }
  if (fix && !instruction && !fs.existsSync(path.join(dir, "AGENTS.md"))) {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), draft, { flag: "wx" }); applied.push("Drafted AGENTS.md; review it for project-specific instructions.");
  }
  if (fix && !ignored) {
    // Append through a no-follow descriptor so the original ignore rules remain intact.
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0) | (ignoreStat ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
    const fd = fs.openSync(ignorePath, flags, 0o644);
    try { fs.writeFileSync(fd, `${ignore && !ignore.endsWith("\n") ? "\n" : ""}.loom/\n`); }
    finally { fs.closeSync(fd); }
    applied.push("Added .loom/ to .gitignore.");
  }
  const git = await projectGit(["status", "--porcelain", "--untracked-files=normal"], dir).then(s => ({ available: true, clean: !s, detail: s ? "Uncommitted changes; review them before running a fleet." : "Working tree is clean." })).catch(() => ({ available: false, clean: false, detail: "Not a Git repository. Initialize Git before using worktrees." }));
  const size = repoSize(dir);
  const checks = [
    { id: "tests", ok: Boolean(testCommand), detail: testCommand ?? "Add a test command to package.json or Python tests.", fix: null },
    { id: "instructions", ok: Boolean(instruction || applied.some(s => s.startsWith("Drafted"))), detail: instruction ?? (fix ? "Review the drafted AGENTS.md." : "Add agent instructions."), fix: !instruction ? "Draft AGENTS.md" : null },
    { id: "git", ok: git.available && git.clean, detail: git.detail, fix: null },
    { id: "ignore", ok: ignored || applied.some(s => s.startsWith("Added")), detail: "Keep .loom/ local using .gitignore.", fix: !ignored ? "Ignore .loom/" : null },
    { id: "size", ok: !size.truncated && size.bytes < 100_000_000, detail: `${size.bytes} bytes in ${size.files} entries (excluding dependencies and Git metadata)${size.truncated ? "; scan limit reached" : ""}.`, fix: null },
  ];
  return { score: checks.filter(c => c.ok).length * 20, stack, testCommand, checks, draft, applied };
}
export async function starterPrompts(dir: string) {
  const { stack, testCommand } = detectStack(dir);
  const changed = await projectGit(["status", "--porcelain"], dir).then(Boolean).catch(() => false);
  return { stack, prompts: [
    { id: "explain", text: `Explain this ${stack} project's architecture and where to make a small first change.` },
    { id: "tests", text: testCommand ? `Run ${testCommand}, explain any failures and propose a focused fix.` : `Set up a small, useful test suite for this ${stack} project.` },
    { id: "review", text: changed ? "Review my uncommitted changes for bugs and missing tests. Do not edit files." : "Review this project's main entry point for bugs. Do not edit files." },
    { id: "plan", text: `Make a plan for one small improvement to this ${stack} project, with acceptance checks.` },
    { id: "instructions", text: "Read the project and suggest accurate AGENTS.md instructions, including build and test commands." },
  ] };
}
