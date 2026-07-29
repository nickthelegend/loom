/**
 * Playwright specs: find them, run one, stream what happened.
 *
 * Agents write browser tests constantly and Loom had nowhere to watch them run —
 * you alt-tabbed to a terminal, ran the file blind, and read a stack trace. The
 * Browser tab closes that loop: list the project's specs, run one with a click,
 * watch the reporter line by line, and hand a failure straight back to an agent.
 *
 * Playwright is deliberately the PROJECT's dependency, not Loom's. We run
 * `npx playwright test` in the project's own directory; a project without
 * Playwright gets told that plainly instead of Loom shipping a browser runner
 * the project didn't ask for.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Directories never worth walking. Deep, huge, and never contain user specs. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".loom",
  "coverage",
  "playwright-report",
  "test-results",
]);

const SPEC_RE = /\.(spec|e2e)\.(ts|tsx|js|mjs|cjs)$/;

export interface SpecFile {
  /** Project-relative path, always with forward slashes. */
  path: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * Every Playwright-shaped spec in the project, by name.
 *
 * Name-based on purpose: `*.spec.*` and `*.e2e.*` is the convention Playwright
 * scaffolds and the one agents follow when asked to "write a test". Parsing
 * imports to be cleverer would drag a TS parser in to answer a question the
 * filename already answers.
 */
export function findSpecs(projectDir: string, maxDepth = 6): SpecFile[] {
  const found: SpecFile[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || found.length >= 200) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — not this feature's problem
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
          walk(path.join(dir, e.name), depth + 1);
        }
        continue;
      }
      if (!SPEC_RE.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      try {
        const st = fs.statSync(abs);
        found.push({
          path: path.relative(projectDir, abs).split(path.sep).join("/"),
          bytes: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        /* raced a delete — skip */
      }
    }
  };
  walk(projectDir, 0);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export interface SpecRun {
  id: string;
  file: string;
  startedAt: number;
  /** Set when the process ends. 0 = every test passed. */
  exitCode?: number;
  /** The reporter's output so far, capped. */
  lines: string[];
}

export interface SpecRunnerEvents {
  onLine: (run: SpecRun, line: string) => void;
  onDone: (run: SpecRun) => void;
}

const MAX_LINES = 800;

/**
 * One spec run per project at a time.
 *
 * Not a queue — a refusal. Two Playwright runs in one project fight over ports,
 * dev servers and trace directories, and the second's output interleaved into
 * the first's is worse than either alone. The UI disables Run while one is
 * live, and the API says "already running" to anyone else.
 */
export class SpecRunner {
  private live = new Map<string, { run: SpecRun; kill: () => void }>();

  running(projectId: string): SpecRun | null {
    return this.live.get(projectId)?.run ?? null;
  }

  /**
   * Start `npx playwright test <file>` in the project directory.
   *
   * The command is overridable via LOOM_SPEC_CMD so tests can exercise the
   * whole streaming path with a shell one-liner instead of installing
   * Playwright into a fixture project.
   */
  start(
    projectId: string,
    projectDir: string,
    file: string,
    events: SpecRunnerEvents,
  ): SpecRun {
    if (this.live.has(projectId)) {
      throw new Error("a spec run is already in progress in this project");
    }
    // The file must be one discovery would offer. This is the same "the rail
    // only offers ADES" rule: accepting any path lets a caller run arbitrary
    // files through npx with the daemon's hands.
    const known = findSpecs(projectDir).some((s) => s.path === file);
    if (!known) throw new Error(`"${file}" is not a spec in this project`);

    const run: SpecRun = {
      id: Math.random().toString(36).slice(2, 10),
      file,
      startedAt: Date.now(),
      lines: [],
    };

    const custom = process.env.LOOM_SPEC_CMD;
    const [cmd, args] = custom
      ? ["/bin/sh", ["-c", custom.replaceAll("{file}", file)]]
      : ["npx", ["--no-install", "playwright", "test", file, "--reporter=line"]];

    const child = spawn(cmd, args as string[], {
      cwd: projectDir,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const push = (chunk: Buffer): void => {
      for (const raw of chunk.toString().split("\n")) {
        const line = raw.trimEnd();
        if (!line) continue;
        run.lines.push(line);
        if (run.lines.length > MAX_LINES) run.lines.shift();
        events.onLine(run, line);
      }
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);

    child.on("error", (err) => {
      // npx missing, spawn refused — the run "ended" without starting.
      run.lines.push(`could not start: ${err.message}`);
      events.onLine(run, run.lines[run.lines.length - 1]!);
      run.exitCode = 127;
      this.live.delete(projectId);
      events.onDone(run);
    });
    child.on("close", (code) => {
      if (run.exitCode !== undefined) return; // error path already settled it
      run.exitCode = code ?? 1;
      this.live.delete(projectId);
      events.onDone(run);
    });

    this.live.set(projectId, { run, kill: () => child.kill("SIGTERM") });
    return run;
  }

  stop(projectId: string): boolean {
    const entry = this.live.get(projectId);
    if (!entry) return false;
    entry.kill();
    return true;
  }

  /** Kill everything — daemon shutdown. */
  closeAll(): void {
    for (const { kill } of this.live.values()) kill();
    this.live.clear();
  }
}
