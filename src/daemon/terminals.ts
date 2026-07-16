/**
 * Terminal sessions for the workspace, in two flavours behind one interface.
 *
 * `pty` — a real pseudo-terminal via node-pty. The shell believes it's on a
 * tty, so you get everything a terminal is supposed to do: its own prompt,
 * echo, job control (^C/^Z), colour, `less`/`vim`/`htop`, and window size.
 * node-pty is a native module, so it's an *optional* dependency.
 *
 * `pipe` — the fallback when node-pty isn't available (notably Linux without
 * build tools, since node-pty ships prebuilds only for macOS/Windows). A
 * long-lived shell on plain pipes: `cd` and variables persist and ^C works
 * via the process group, but there's no echo or job control, so the client
 * drives it a line at a time and draws its own prompt. See `docs/`.
 *
 * Both keep a scrollback buffer so a client that reloads can be replayed the
 * session it left behind.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);

/** Sentinel the pipe shell prints after each command: `<MARK><rc>\t<cwd>\n`. */
export const TERM_MARK = "__LOOM_END__";

const isWin = process.platform === "win32";
/** Keep the last of a session's output for replay after a client reload. */
const SCROLLBACK_MAX = 256 * 1024;
/** Per-command output budget in pipe mode (a pty is interactive, so unbounded). */
const PIPE_OUTPUT_MAX = 2_000_000;

export type TermMode = "pty" | "pipe";

export interface TermEvents {
  onData(projectId: string, termId: string, chunk: string): void;
  /** pipe mode only: a command finished, with its exit code and new cwd. */
  onCommandEnd(projectId: string, termId: string, exit: number, cwd: string): void;
  onExit(projectId: string, termId: string): void;
  onTitle(projectId: string, termId: string, title: string): void;
}

export interface TerminalSession {
  readonly projectId: string;
  readonly termId: string;
  readonly mode: TermMode;
  cwd: string;
  /** Raw input. In pty mode these are keystrokes; in pipe mode, a command. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  interrupt(): void;
  kill(): void;
  scrollback(): string;
}

// ---------------------------------------------------------------------------
// node-pty loading
// ---------------------------------------------------------------------------

export interface PtyProcess {
  pid: number;
  onData(cb: (d: string) => void): void;
  onExit(cb: () => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): PtyProcess;
}

let ptyModule: PtyModule | null | undefined;
let ptyLoadError: string | null = null;

/**
 * node-pty's macOS/Linux prebuilds ship `spawn-helper` without the executable
 * bit (npm doesn't preserve it through the prebuild archive), and node-pty
 * then fails every spawn with a bare "posix_spawnp failed". Repair it rather
 * than making every user chmod a file inside node_modules.
 */
function fixSpawnHelper(moduleDir: string): void {
  if (isWin) return;
  const roots = [path.join(moduleDir, "prebuilds"), path.join(moduleDir, "build", "Release")];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidates = [path.join(root, entry, "spawn-helper"), path.join(root, entry)];
      for (const file of candidates) {
        try {
          const st = fs.statSync(file);
          if (!st.isFile() || path.basename(file) !== "spawn-helper") continue;
          if (st.mode & 0o111) continue; // already executable
          fs.chmodSync(file, st.mode | 0o755);
        } catch {
          /* not present, or not ours to chmod — the probe below decides */
        }
      }
    }
  }
}

/** Load node-pty once, proving it can actually spawn before we rely on it. */
export function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) return ptyModule;
  // An escape hatch: forces the pipe path on a machine that has node-pty, so
  // the fallback stays exercisable (it is what Linux without a toolchain gets).
  if (process.env.LOOM_NO_PTY === "1") {
    ptyLoadError = "disabled by LOOM_NO_PTY=1";
    ptyModule = null;
    return null;
  }
  try {
    const dir = path.dirname(require_.resolve("node-pty/package.json"));
    fixSpawnHelper(dir);
    const mod = require_("node-pty") as PtyModule;
    // A load isn't proof: the native binary can resolve and still fail to
    // spawn (missing helper, hardened runtime, seccomp). Try it for real.
    const probe = mod.spawn(isWin ? "cmd.exe" : "/bin/sh", [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    probe.kill();
    ptyModule = mod;
  } catch (err) {
    ptyLoadError = (err as Error).message;
    ptyModule = null;
  }
  return ptyModule;
}

export function ptyUnavailableReason(): string | null {
  loadPty();
  return ptyModule ? null : (ptyLoadError ?? "node-pty is not installed");
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    // The pager would sit there waiting for a key we can't easily send in
    // pipe mode; in pty mode `less` works, but git's default pager still
    // fights the small pane, so keep output inline in both.
    PAGER: "cat",
    GIT_PAGER: "cat",
    LOOM_TERMINAL: "1",
  };
}

class PtySession implements TerminalSession {
  readonly mode = "pty" as const;
  private buf = "";
  private proc: PtyProcess;
  constructor(
    readonly projectId: string,
    readonly termId: string,
    public cwd: string,
    mod: PtyModule,
    events: TermEvents,
    cols: number,
    rows: number,
  ) {
    const shell = isWin ? "cmd.exe" : process.env.SHELL || "/bin/sh";
    this.proc = mod.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: baseEnv(),
    });
    this.proc.onData((d) => {
      this.buf = (this.buf + d).slice(-SCROLLBACK_MAX);
      // OSC 7 (cwd) and OSC 0/2 (title) are how a shell reports where it is;
      // read them if present, but never strip them — the emulator wants them.
      const cwdMatch = /\u001b\]7;file:\/\/[^/]*([^\u0007\u001b]*)(?:\u0007|\u001b\\)/.exec(d);
      if (cwdMatch?.[1]) this.cwd = decodeURIComponent(cwdMatch[1]);
      const titleMatch = /\u001b\][02];([^\u0007\u001b]*)(?:\u0007|\u001b\\)/.exec(d);
      if (titleMatch?.[1]) events.onTitle(projectId, termId, titleMatch[1]);
      events.onData(projectId, termId, d);
    });
    this.proc.onExit(() => events.onExit(projectId, termId));
  }
  write(data: string): void {
    this.proc.write(data);
  }
  resize(cols: number, rows: number): void {
    try {
      this.proc.resize(Math.max(2, cols), Math.max(1, rows));
    } catch {
      /* the pty went away mid-resize */
    }
  }
  interrupt(): void {
    // A real tty turns ^C into SIGINT for the foreground job itself.
    this.write("\u0003");
  }
  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
  scrollback(): string {
    return this.buf;
  }
}

class PipeSession implements TerminalSession {
  readonly mode = "pipe" as const;
  private child: ChildProcess;
  private pending = "";
  private buf = "";
  private sent = 0;
  constructor(
    readonly projectId: string,
    readonly termId: string,
    public cwd: string,
    private events: TermEvents,
  ) {
    const shell = isWin ? "cmd.exe" : process.env.SHELL || "/bin/sh";
    this.child = spawn(shell, isWin ? [] : ["-s"], {
      cwd,
      detached: !isWin, // own process group, so ^C reaches the foreground job
      env: baseEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A non-interactive shell dies on SIGINT by default, taking the session
    // with it. A handled signal resets to default in children, so the shell
    // survives while the foreground job still dies.
    if (!isWin) this.child.stdin?.write("trap ':' INT\n");
    const onData = (b: Buffer) => this.pump(b.toString("utf8"));
    this.child.stdout?.on("data", onData);
    this.child.stderr?.on("data", onData);
    this.child.on("error", (err) => events.onData(projectId, termId, `loom: ${err.message}\n`));
    this.child.on("close", () => events.onExit(projectId, termId));
  }
  write(data: string): void {
    this.sent = 0;
    const probe = isWin
      ? `\r\necho ${TERM_MARK}%ERRORLEVEL%\t%CD%\r\n`
      : `\n__loom_rc=$?; printf '\\n${TERM_MARK}%s\\t%s\\n' "$__loom_rc" "$PWD"\n`;
    this.child.stdin?.write(data + probe);
  }
  resize(): void {
    /* no tty to resize */
  }
  interrupt(): void {
    if (!this.child.pid) return;
    try {
      process.kill(-this.child.pid, "SIGINT");
    } catch {
      try {
        this.child.kill("SIGINT");
      } catch {
        /* gone */
      }
    }
  }
  kill(): void {
    try {
      if (this.child.pid && !isWin) process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  scrollback(): string {
    return this.buf;
  }
  /**
   * Strip the end-of-command sentinel out of the stream and report it. It can
   * straddle two reads, so hold back any trailing partial match.
   */
  private pump(text: string): void {
    this.pending += text;
    for (;;) {
      const idx = this.pending.indexOf(TERM_MARK);
      if (idx === -1) break;
      const nl = this.pending.indexOf("\n", idx);
      if (nl === -1) {
        this.emit(this.pending.slice(0, idx));
        this.pending = this.pending.slice(idx);
        return;
      }
      // the sentinel is printed with a leading newline so it lands on its own
      // line; drop that one back off so output isn't padded by a blank line
      let pre = this.pending.slice(0, idx);
      if (pre.endsWith("\n")) pre = pre.slice(0, -1);
      this.emit(pre);
      const line = this.pending.slice(idx + TERM_MARK.length, nl);
      const tab = line.indexOf("\t");
      const code = Number(tab === -1 ? line : line.slice(0, tab));
      const cwd = tab === -1 ? "" : line.slice(tab + 1).trim();
      if (cwd) this.cwd = cwd;
      this.pending = this.pending.slice(nl + 1);
      this.events.onCommandEnd(
        this.projectId,
        this.termId,
        Number.isFinite(code) ? code : 0,
        this.cwd,
      );
    }
    let hold = 0;
    for (let i = Math.min(TERM_MARK.length - 1, this.pending.length); i > 0; i--) {
      if (this.pending.endsWith(TERM_MARK.slice(0, i))) {
        hold = i;
        break;
      }
    }
    const emit = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    this.emit(emit);
  }
  private emit(chunk: string): void {
    if (!chunk) return;
    if (this.sent >= PIPE_OUTPUT_MAX) return;
    let out = chunk;
    if (this.sent + out.length > PIPE_OUTPUT_MAX) {
      out = out.slice(0, PIPE_OUTPUT_MAX - this.sent) + "\n…output truncated…\n";
    }
    this.sent += out.length;
    this.buf = (this.buf + out).slice(-SCROLLBACK_MAX);
    this.events.onData(this.projectId, this.termId, out);
  }
}

// ---------------------------------------------------------------------------
// manager
// ---------------------------------------------------------------------------

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  constructor(
    private events: TermEvents,
    private maxSessions = 12,
  ) {}

  get mode(): TermMode {
    return loadPty() ? "pty" : "pipe";
  }

  private key(projectId: string, termId: string): string {
    return `${projectId}:${termId}`;
  }

  get(projectId: string, termId: string): TerminalSession | undefined {
    return this.sessions.get(this.key(projectId, termId));
  }

  open(
    projectId: string,
    termId: string,
    dir: string,
    cols = 80,
    rows = 24,
  ): TerminalSession {
    const existing = this.get(projectId, termId);
    if (existing) return existing;
    if (this.sessions.size >= this.maxSessions) throw new Error("too many terminal sessions");
    const mod = loadPty();
    const sess: TerminalSession = mod
      ? new PtySession(projectId, termId, dir, mod, this.events, cols, rows)
      : new PipeSession(projectId, termId, dir, this.events);
    this.sessions.set(this.key(projectId, termId), sess);
    return sess;
  }

  close(projectId: string, termId: string): void {
    const key = this.key(projectId, termId);
    const sess = this.sessions.get(key);
    if (!sess) return;
    this.sessions.delete(key);
    sess.kill();
  }

  /** Drop a session from the registry once its process is gone. */
  forget(projectId: string, termId: string): void {
    this.sessions.delete(this.key(projectId, termId));
  }

  closeAll(): void {
    for (const [key, sess] of this.sessions) {
      this.sessions.delete(key);
      sess.kill();
    }
  }
}
