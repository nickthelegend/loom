/**
 * Hands for a model agent.
 *
 * A CLI agent arrives with hands: `claude` can open a file, write a patch, run
 * a test. A bare chat-completions endpoint cannot, so the first model agent
 * was a thinker asked to review code it could not read.
 *
 * Three tools read — `read_file`, `list_files`, `search` — and they are always
 * available once a project turns tools on, because reading inside the project
 * is not a thing worth interrupting someone about. Two tools change something
 * — `write_file` and `run` — and they live at the bottom of this file behind
 * an approval, offered only when the project asked for them.
 *
 * ## The boundary
 *
 * Every path is resolved and proven to be inside the project before anything
 * opens it, because these paths come from a model, which is to say from
 * whatever the model read last. `.git` and `.loom` are excluded: one holds the
 * repository's internals and the other holds Loom's own bookkeeping, and
 * neither is what "read the code" means. Output is bounded, because a model
 * that asks for a 40MB file should get an answer rather than an incident.
 */

import fs from "node:fs";
import path from "node:path";

/** What the wire calls a tool the model may use. */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  /** What goes back to the model. Bounded, and truthful when it was cut. */
  content: string;
  /** For the thread: a one-line summary of what happened. */
  summary: string;
  ok: boolean;
}

/** As much of a file as is worth sending back. */
export const MAX_FILE_CHARS = 60_000;
/** How many paths a listing or a search may return. */
export const MAX_ENTRIES = 300;
/** How many tool hops one turn may take before it has to say something. */
export const MAX_HOPS = 8;

const HIDDEN = new Set([".git", ".loom", "node_modules", ".next", "dist", "build", ".venv"]);

export const READ_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the project. Returns the file's contents with line numbers. Use this before saying anything specific about code.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project root." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and directories in the project. Skips .git, .loom, node_modules and build output.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory relative to the project root. Defaults to the root." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Find which files contain a string, and on which lines. Plain text, not a regular expression.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The text to look for." },
          path: { type: "string", description: "Directory to search under. Defaults to the root." },
        },
        required: ["query"],
      },
    },
  },
];

/**
 * Resolve a model-supplied path inside the project, or refuse.
 *
 * The paths here come from a model, which means they come from whatever the
 * model last read — a file in the repo could ask it to read `../../.ssh/id_rsa`
 * and it might. So this is not a formality: resolve, then prove containment,
 * then check it isn't one of the hidden directories.
 */
export function insideProject(root: string, rel: string): string {
  const base = path.resolve(root);
  const full = path.resolve(base, rel || ".");
  contained(base, full, rel);
  // The lexical check alone is not the boundary: `leak -> /elsewhere` is inside
  // by name and outside by what fs.readFileSync actually opens. Prove it again
  // on the real path — the deepest part that exists, through every link — and
  // hand back that path, so what was checked is what gets opened.
  const realBase = realOrSelf(base);
  const real = realPath(full, rel);
  contained(realBase, real, rel);
  return real;
}

function contained(base: string, full: string, rel: string): void {
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`"${rel}" is outside the project`);
  }
  const parts = path.relative(base, full).split(path.sep).filter(Boolean);
  const blocked = parts.find((p) => HIDDEN.has(process.platform === "win32" ? p.toLowerCase() : p));
  if (blocked) throw new Error(`"${blocked}" isn't readable from here`);
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * A path with every existing component resolved through its links; the parts
 * that don't exist yet (a file about to be written) are appended as named. A
 * link that points nowhere is refused: writing through it would create its
 * target, wherever that is.
 */
function realPath(full: string, rel: string): string {
  const rest: string[] = [];
  let probe = full;
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...rest.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      let dangling = false;
      try {
        dangling = fs.lstatSync(probe).isSymbolicLink();
      } catch {
        /* doesn't exist at all: keep walking up */
      }
      if (dangling) throw new Error(`"${rel}" goes through a link that points nowhere`);
      const parent = path.dirname(probe);
      if (parent === probe) return full;
      rest.push(path.basename(probe));
      probe = parent;
    }
  }
}

function cut(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  return { text: `${text.slice(0, limit)}\n… (truncated at ${limit} characters)`, cut: true };
}

function numbered(body: string): string {
  return body
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4)} ${line}`)
    .join("\n");
}

/** Run one tool call against the project. Never throws: a refusal is a result. */
export function runReadTool(root: string, call: ToolCall): ToolResult {
  const fail = (message: string): ToolResult => ({
    id: call.id,
    name: call.name,
    content: `Error: ${message}`,
    summary: `${call.name} — ${message}`,
    ok: false,
  });
  try {
    if (call.name === "read_file") {
      const rel = String(call.args.path ?? "");
      if (!rel) return fail("read_file needs a path");
      const full = insideProject(root, rel);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) return fail(`"${rel}" is a directory — use list_files`);
      const raw = fs.readFileSync(full, "utf8");
      // A binary file read as UTF-8 is a page of replacement characters, which
      // wastes the model's context and tells it nothing.
      if (raw.includes("\0")) return fail(`"${rel}" isn't a text file`);
      const { text, cut: wasCut } = cut(numbered(raw), MAX_FILE_CHARS);
      return {
        id: call.id,
        name: call.name,
        content: text,
        summary: `read ${rel} (${raw.split("\n").length} lines${wasCut ? ", truncated" : ""})`,
        ok: true,
      };
    }

    if (call.name === "list_files") {
      const rel = String(call.args.path ?? ".");
      const full = insideProject(root, rel);
      const entries = fs
        .readdirSync(full, { withFileTypes: true })
        .filter((e) => !HIDDEN.has(e.name))
        .slice(0, MAX_ENTRIES)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return {
        id: call.id,
        name: call.name,
        content: entries.join("\n") || "(empty)",
        summary: `listed ${rel} (${entries.length} entries)`,
        ok: true,
      };
    }

    if (call.name === "search") {
      const query = String(call.args.query ?? "");
      if (!query) return fail("search needs a query");
      const root2 = insideProject(root, String(call.args.path ?? "."));
      // insideProject hands back real paths, so hits are named relative to the real root
      const base = realOrSelf(path.resolve(root));
      const hits: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 8 || hits.length >= MAX_ENTRIES) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (hits.length >= MAX_ENTRIES) return;
          if (HIDDEN.has(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(full, depth + 1);
            continue;
          }
          // A link is read only when where it really leads is inside the
          // project too, and never followed into a directory (cycles).
          let target = full;
          if (e.isSymbolicLink()) {
            try {
              target = insideProject(root, path.relative(base, full));
              if (fs.statSync(target).isDirectory()) continue;
            } catch {
              continue;
            }
          }
          let body: string;
          try {
            if (fs.statSync(target).size > 2_000_000) continue;
            body = fs.readFileSync(target, "utf8");
          } catch {
            continue;
          }
          if (body.includes("\0") || !body.includes(query)) continue;
          body.split("\n").forEach((line, i) => {
            if (hits.length < MAX_ENTRIES && line.includes(query)) {
              hits.push(`${path.relative(base, full).split(path.sep).join("/")}:${i + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
        }
      };
      walk(root2, 0);
      return {
        id: call.id,
        name: call.name,
        content: hits.join("\n") || `no match for "${query}"`,
        summary: `searched for "${query}" (${hits.length} hit${hits.length === 1 ? "" : "s"})`,
        ok: true,
      };
    }

    return fail(`no tool called "${call.name}"`);
  } catch (err) {
    return fail(String((err as Error).message));
  }
}

// ---------------------------------------------------------------------------
// The ones that change something
// ---------------------------------------------------------------------------
//
// A model that can write files is exactly as dangerous as a CLI that can, and
// the answer is the one Loom already gives for CLIs: the project's permission
// mode decides, and in "ask" every one of these is a card a person allows or
// denies before anything happens.
//
// Two rules hold for both tools here. **A tool is only offered when it can
// actually be used** — `write_file` appears when the project asked for write
// access, `run` appears only when there is an allow-list for it — because a
// model told it has a tool that always refuses will keep trying it and say
// odd things about why. And **the allow-list is a prefix match on the whole
// command**, so "npm test" permits `npm test --watch` and nothing else; there
// is no shell, no pipes, no `&&`.

import { execFile } from "./process.js";

/** How long one allowed command may run before it's killed. */
export const RUN_TIMEOUT_MS = 120_000;
/** How much of its output goes back to the model. */
export const MAX_OUTPUT_CHARS = 20_000;

export const WRITE_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "Write a text file in the project, creating it if needed. This replaces the whole file, so read it first unless you are creating it. The person is asked before anything is written.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root." },
        content: { type: "string", description: "The complete new contents of the file." },
        why: { type: "string", description: "One line: what this change does. Shown to the person." },
      },
      required: ["path", "content"],
    },
  },
};

export function runTool(allowed: string[]): ToolSpec {
  return {
    type: "function",
    function: {
      name: "run",
      description: `Run one of these commands in the project: ${allowed.join(", ")}. No shell — no pipes, no &&, no redirection. The person is asked first.`,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: `The command. Must start with one of: ${allowed.join(", ")}` },
        },
        required: ["command"],
      },
    },
  };
}

/** Which tools this agent may be offered, given what the project allowed. */
export function toolsFor(opts: { write?: boolean; run?: string[] }): ToolSpec[] {
  return [
    ...READ_TOOLS,
    ...(opts.write ? [WRITE_TOOL] : []),
    ...(opts.run?.length ? [runTool(opts.run)] : []),
  ];
}

/** Is this one of the tools that changes something? */
export function isWriteTool(name: string): boolean {
  return name === "write_file" || name === "run";
}

/**
 * What a person is shown when asked about a write.
 *
 * The path and the reason, plus how much of the file changes — "writes 900
 * lines to src/app.ts, which currently has 12" is the sentence that stops a
 * bad edit, and a raw JSON dump of the whole new file is not.
 */
export function describeWrite(root: string, call: ToolCall): string {
  const rel = String(call.args.path ?? "?");
  const content = String(call.args.content ?? "");
  const why = String(call.args.why ?? "").trim();
  let existing = "";
  try {
    const full = insideProject(root, rel);
    const was = fs.readFileSync(full, "utf8").split("\n").length;
    existing = ` (replacing ${was} line${was === 1 ? "" : "s"})`;
  } catch {
    existing = " (new file)";
  }
  const lines = content.split("\n").length;
  return `write ${rel}: ${lines} line${lines === 1 ? "" : "s"}${existing}${why ? ` — ${why}` : ""}`;
}

/** Write a file, having been allowed to. Refuses outside the project. */
export function applyWrite(root: string, call: ToolCall): ToolResult {
  const rel = String(call.args.path ?? "");
  const content = call.args.content;
  const fail = (message: string): ToolResult => ({
    id: call.id,
    name: call.name,
    content: `Error: ${message}`,
    summary: `write_file — ${message}`,
    ok: false,
  });
  if (!rel) return fail("write_file needs a path");
  if (typeof content !== "string") return fail("write_file needs content, as a string");
  try {
    const full = insideProject(root, rel);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return fail(`"${rel}" is a directory`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    const lines = content.split("\n").length;
    return {
      id: call.id,
      name: call.name,
      content: `Wrote ${rel} (${lines} lines).`,
      summary: `wrote ${rel} (${lines} lines)`,
      ok: true,
    };
  } catch (err) {
    return fail(String((err as Error).message));
  }
}

/**
 * Does the allow-list permit this command?
 *
 * A prefix match on whole words, so "npm test" allows `npm test --watch` and
 * not `npm testify`, and anything a shell would treat specially is refused
 * outright — these arguments come from a model, and `npm test; rm -rf ~` is
 * the obvious thing to guard against.
 */
export function allowsCommand(allowed: string[], command: string): boolean {
  const clean = command.trim();
  if (!clean || /[;&|><`$\n\r\\]/.test(clean)) return false;
  return allowed.some((a) => {
    const prefix = a.trim();
    if (!prefix) return false;
    return clean === prefix || clean.startsWith(`${prefix} `);
  });
}

/** Run an allowed command. No shell: the words are the words. */
export async function applyRun(root: string, call: ToolCall, allowed: string[]): Promise<ToolResult> {
  const command = String(call.args.command ?? "");
  const fail = (message: string): ToolResult => ({
    id: call.id,
    name: call.name,
    content: `Error: ${message}`,
    summary: `run — ${message}`,
    ok: false,
  });
  if (!allowsCommand(allowed, command)) {
    return fail(`"${command}" isn't allowed here. Allowed: ${allowed.join(", ")}`);
  }
  const [bin, ...args] = command.trim().split(/\s+/);
  if (!bin) return fail("run needs a command");
  return new Promise<ToolResult>((resolve) => {
    execFile(
      bin,
      args,
      { cwd: root, timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = cut(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim(), MAX_OUTPUT_CHARS).text;
        const code = (err as { code?: number } | null)?.code;
        resolve({
          id: call.id,
          name: call.name,
          // A non-zero exit is an answer, not a tool failure: "the tests fail"
          // is exactly what the model asked to find out.
          content: `$ ${command}\nexit ${code ?? 0}\n${out || "(no output)"}`,
          summary: `ran ${command} — exit ${code ?? 0}`,
          ok: true,
        });
      },
    );
  });
}
