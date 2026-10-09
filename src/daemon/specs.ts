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
/** Inside a Playwright testDir, Playwright's own default testMatch applies too. */
const TESTDIR_RE = /\.(spec|test|e2e)\.[cm]?[jt]sx?$/;

const CONFIG_NAMES = ["ts", "js", "mjs", "cjs", "mts", "cts"].map((e) => `playwright.config.${e}`);

export interface PlaywrightSetup {
  /** The config file at the project root, if there is one. */
  config: string | null;
  /** Its testDir, project-relative, when it could be read off the config. */
  testDir: string | null;
  /** package.json lists @playwright/test (or playwright). */
  dependency: boolean;
}

/**
 * Does this project use Playwright, and where does it keep its tests?
 *
 * A `*.spec.ts` alone isn't evidence — Jest and Vitest name theirs the same
 * way, and offering to run those through Playwright is a button that can only
 * fail. A config file or the dependency is. The testDir is read off the
 * config by pattern, not by running it: the common shapes are a string or
 * `path.join(__dirname, "…")`, and anything cleverer falls back to the name
 * match across the project.
 */
export function playwrightSetup(projectDir: string): PlaywrightSetup {
  const config = CONFIG_NAMES.find((n) => fs.existsSync(path.join(projectDir, n))) ?? null;
  let testDir: string | null = null;
  if (config) {
    try {
      const src = fs.readFileSync(path.join(projectDir, config), "utf8").slice(0, 64_000);
      const m =
        /\btestDir\s*:\s*(['"`])([^'"`$]+)\1/.exec(src) ??
        /\btestDir\s*:\s*path\.(?:join|resolve)\(\s*__dirname\s*,\s*(['"`])([^'"`$]+)\1\s*\)/.exec(src);
      if (m?.[2]) {
        const abs = path.resolve(projectDir, m[2]);
        const rel = path.relative(projectDir, abs);
        // a testDir outside the project is not ours to walk
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) testDir = rel.split(path.sep).join("/");
        else if (!rel) testDir = null;
      }
    } catch {
      /* unreadable config — the name match still applies */
    }
  }
  let dependency = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    dependency = "@playwright/test" in deps || "playwright" in deps;
  } catch {
    /* no package.json, or not JSON */
  }
  return { config, testDir, dependency };
}

export interface SpecFile {
  /** Project-relative path, always with forward slashes. */
  path: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * Every Playwright spec in the project.
 *
 * Only in a project that has Playwright (playwrightSetup). Inside a testDir
 * the config names, every spec- or test-named file is Playwright's; without
 * one, it's by name — `*.spec.*` and `*.e2e.*` is the convention Playwright
 * scaffolds and the one agents follow when asked to "write a test". Parsing
 * imports to be cleverer would drag a TS parser in to answer a question the
 * filename already answers.
 */
export function findSpecs(projectDir: string, maxDepth = 6): SpecFile[] {
  const setup = playwrightSetup(projectDir);
  if (!setup.config && !setup.dependency) return [];
  const found: SpecFile[] = [];
  const match = setup.testDir ? TESTDIR_RE : SPEC_RE;
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
      if (!match.test(e.name)) continue;
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
  walk(setup.testDir ? path.join(projectDir, setup.testDir) : projectDir, 0);
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
  /** Ended by Stop, or by running past the timeout — not by the tests. */
  stopped?: "stop" | "timeout";
}

export interface SpecRunnerEvents {
  onLine: (run: SpecRun, line: string) => void;
  onDone: (run: SpecRun) => void;
}

const MAX_LINES = 800;

/** A spec run that's still going after this has hung, not "taking a while". */
export const SPEC_TIMEOUT_MS = 10 * 60_000;

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

  /** How long one run may take (LOOM_SPEC_TIMEOUT_MS overrides, for tests). */
  constructor(private timeoutMs = Number(process.env.LOOM_SPEC_TIMEOUT_MS) || SPEC_TIMEOUT_MS) {}

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

    // Its own process group, so Stop reaches what npx started (the test
    // runner, its workers, the browsers) and not only npx itself.
    const group = process.platform !== "win32";
    const child = spawn(cmd, args as string[], {
      cwd: projectDir,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: group,
    });
    const signal = (sig: NodeJS.Signals): void => {
      try {
        if (group && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };
    let hard: NodeJS.Timeout | null = null;
    const kill = (why: "stop" | "timeout"): void => {
      if (run.exitCode !== undefined) return;
      run.stopped ??= why;
      signal("SIGTERM");
      // a runner that ignores SIGTERM still has to end
      hard ??= setTimeout(() => signal("SIGKILL"), 5_000);
      hard.unref?.();
    };
    const timer = setTimeout(() => {
      const line = `timed out after ${Math.round(this.timeoutMs / 1000)}s — stopping it`;
      run.lines.push(line);
      events.onLine(run, line);
      kill("timeout");
    }, this.timeoutMs);
    timer.unref?.();
    const settle = (): void => {
      clearTimeout(timer);
      if (hard) clearTimeout(hard);
    };

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
      settle();
      this.live.delete(projectId);
      events.onDone(run);
    });
    child.on("close", (code) => {
      if (run.exitCode !== undefined) return; // error path already settled it
      // killed by a signal: no code, and not a pass
      run.exitCode = code ?? (run.stopped ? 130 : 1);
      settle();
      this.live.delete(projectId);
      events.onDone(run);
    });

    this.live.set(projectId, { run, kill: () => kill("stop") });
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
