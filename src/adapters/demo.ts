import fs from "node:fs";
import path from "node:path";
import type { SendInput } from "../types.js";
import { ADAPTER_CAPABILITIES, AdapterBase } from "./base.js";

export const DEMO_LABEL = "Demo — scripted, offline, free";
export const DEMO_MODELS = ["demo-smart", "demo-fast"];
const disclosure = "I'm Loom's demo agent; connect a real agent to do real work.";
const darkMode = "\n@media (prefers-color-scheme: dark) {\n  :root { color: #eee; background: #181818; color-scheme: dark; }\n  main { background: #282828; }\n}\n";
const filterCode = "export function visibleTodos(todos, filter = 'all') {\n  return todos.filter(todo => filter === 'active' ? !todo.completed : filter === 'completed' ? todo.completed : true);\n}\n";
const extraTests = "\nassert.deepEqual(visibleTodos(todos, 'all'), todos);\nassert.equal(visibleTodos(todos).length, 2);\nassert.deepEqual(visibleTodos([], 'active'), []);\nconsole.log('PASS: explicit all filter and empty active list');\n";

/** In-process demonstration only: file edits are real; shell output and usage are simulated. */
export class DemoAdapter extends AdapterBase {
  override readonly capabilities = { ...ADAPTER_CAPABILITIES, steer: true };
  private aborted = false;
  private chat: string | null = null;
  private steered: string[] = [];
  private orchestraBriefing = "";
  private wake?: () => void;
  private finished?: Promise<void>;

  constructor(id: string, dir: string, private readonly options: Record<string, unknown> = {}) {
    super(id, "demo", dir);
  }

  async available(): Promise<boolean> { return true; }
  async start(): Promise<void> { this.emit({ kind: "status", payload: { state: "started" } }); }
  async stop(): Promise<void> {
    await this.interrupt();
    this.emit({ kind: "status", payload: { state: "stopped" } });
  }

  async interrupt(): Promise<void> {
    this.aborted = true;
    this.wake?.();
    await this.finished;
  }

  async steer(chat: string, text: string): Promise<boolean> {
    if (!this._busy || this.aborted || this.chat !== chat) return false;
    this.steered.push(text);
    return true;
  }

  private async pause(ms: number): Promise<void> {
    if (this.aborted) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private read(file: string): string {
    const target = path.resolve(this.projectDir, file);
    if (!target.startsWith(path.resolve(this.projectDir) + path.sep)) throw new Error("demo edit outside project");
    // Even fixed script paths can be symlinks in a repo someone has modified.
    let current = this.projectDir;
    for (const part of file.split("/")) {
      current = path.join(current, part);
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("demo will not follow symlinks");
    }
    return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  }

  private edit(file: string, content: string): boolean {
    const before = this.read(file);
    if (before === content) return false;
    fs.mkdirSync(path.dirname(path.join(this.projectDir, file)), { recursive: true });
    fs.writeFileSync(path.join(this.projectDir, file), content);
    this.emit({ kind: "tool_call", payload: { tool: "edit", summary: `edit: ${file}`, path: file, ok: true } });
    this.emit({ kind: "file_edit", payload: { path: file } });
    return true;
  }

  async send(input: SendInput): Promise<void> {
    if (this._busy) throw new Error(`demo agent "${this.id}" is busy`);
    this._busy = true;
    this.aborted = false;
    this.chat = input.chat ?? "main";
    this.steered = [];
    this.beginContinuity(input);
    if (input.briefing?.includes("You are the ORCHESTRATOR")) this.orchestraBriefing = input.briefing;
    let finish!: () => void;
    this.finished = new Promise(resolve => { finish = resolve; });
    const started = Date.now();
    // Total simulated streaming time defaults to three seconds; tests can set it to zero.
    const configured = Number(process.env.LOOM_DEMO_DURATION_MS ?? 3000);
    const duration = Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 6000) : 3000;
    try {
      this.streamText("I'll inspect the demo and make a small, focused change.\n", true);
      await this.pause(duration / 4);
      if (this.aborted) return;
      const readme = this.read("README.md");
      this.emit({ kind: "tool_call", payload: { tool: "read", summary: "read: README.md", path: "README.md", preview: readme.slice(0, 400), ok: true } });
      await this.pause(duration / 4);
      if (this.aborted) return;
      let reply: string;
      if (this.orchestraBriefing) {
        reply = this.orchestrate({ ...input, briefing: this.orchestraBriefing });
      } else if (input.text.includes("This is a READ-ONLY review")) {
        reply = input.text.includes("function first(items)")
          ? "- [high] example.js:1 — first([]) dereferences undefined. Guard empty input and add an empty-list test.\nScripted finding for the supplied demo example; no files were changed."
          : "Scripted read-only review: inspect the target and verify edge cases. No files were changed.";
      } else if (/demo release codename/i.test(input.text)) {
        reply = input.briefing?.includes("copper lantern")
          ? "The release codename is copper lantern. I reused the shared decision taught by the other Demo agent."
          : "No release codename decision was in my briefing. Teach a shared memory, then try again.";
      } else if (input.briefing?.includes("[Loom · Plan mode]") || /\b(make a plan|plan the|plan for)\b/i.test(input.text)) {
        const plan = ["---", 'title: "Demo implementation plan"', "status: proposed", "---", "# Demo plan", "## Goal", input.text,
          "## Context", "styles.css controls appearance; filter.js selects todos; test.mjs checks behavior.",
          "## Approach", "Make small independent edits, then verify them.", "## Tasks",
          "1. Add dark mode in styles.css using prefers-color-scheme. Accept when dark system themes use readable colors.",
          "2. Add active/completed filtering in filter.js. Accept when each selection shows the matching todos.",
          "3. Extend test.mjs with empty-list checks. Accept when npm test passes.",
          "## Risks", "This is a scripted example; review the real diff.", "## Verification", "Run npm test, then inspect the app in a browser.", ""].join("\n");
        this.edit(".loom/plans/demo.md", plan);
        reply = "The plan is complete: three tasks in .loom/plans/demo.md. No application code changed.";
      } else if (/\bexplain\b/i.test(input.text) || /do not (edit|change)|read.only/i.test(input.briefing ?? "")) {
        reply = "This is a dependency-free todo app. index.html provides the page, app.js handles todos, styles.css controls appearance, filter.js selects visible items, and test.mjs runs with Node. Try ‘add dark mode’ or ‘add a todo filter’.";
      } else {
        let file: string, content: string;
        if (/dark\s*mode/i.test(input.text)) {
          file = "styles.css";
          const before = this.read(file);
          content = before.includes("prefers-color-scheme: dark") ? before : before + darkMode;
        } else if (/\bfilter\b/i.test(input.text)) {
          file = "filter.js"; content = filterCode;
        } else if (/\btests?\b/i.test(input.text)) {
          file = "test.mjs";
          const before = this.read(file);
          content = before.includes("PASS: explicit all filter") ? before : before + extraTests;
        } else {
          file = "DEMO-NOTES.md";
          content = this.read(file) + "- Explored a scripted Loom demo turn. Connect a real agent for custom work.\n";
        }
        const changed = this.edit(file, content);
        reply = changed ? `Updated ${file}. Review the real diff or rewind this turn.` : `${file} already includes this demo change.`;
        this.emit({ kind: "tool_call", payload: { tool: "shell", summary: "npm test (simulated)", command: "npm test", preview: "Demo simulation — command was not executed.\nPASS: 3 scripted checks", exitCode: 0, ok: true, simulated: true } });
        reply += " Test output is simulated; run npm test yourself to verify.";
      }
      reply = `${reply}\n\n${disclosure}`;
      const chunks = reply.match(/.{1,70}(?:\s|$)|.{1,70}/gs) ?? [reply];
      for (const chunk of chunks) {
        if (this.aborted) return;
        this.streamText(chunk);
        await this.pause(duration / 2 / chunks.length);
      }
      if (this.aborted) return;
      for (const text of this.steered) {
        const extra = `\nSteering received: ${text}`;
        this.streamText(extra);
        reply += extra;
      }
      this.emit({ kind: "message", payload: { text: reply } });
      const selected = input.model ?? this.options.model;
      const model = typeof selected === "string" && selected.startsWith("demo-") ? selected : "demo-smart";
      this.emit({ kind: "status", payload: { state: "turn_cost", costUsd: 0 } });
      this.emit({ kind: "run_complete", payload: { durationMs: Date.now() - started, model, costUsd: 0,
        inputTokens: Math.ceil(input.text.length / 4) + 20, outputTokens: Math.ceil(reply.length / 4), simulated: true } });
    } catch (error) {
      this.emit({ kind: "error", payload: { message: error instanceof Error ? error.message : String(error) } });
    } finally {
      if (this.aborted) this.emit({ kind: "status", payload: { state: "interrupted" } });
      this._busy = false;
      this.chat = null;
      this.endContinuity();
      finish();
      this.finished = undefined;
    }
  }

  private orchestrate(input: SendInput): string {
    let actions: Record<string, unknown>[];
    if (input.text.includes("Status of orchestra run")) {
      actions = /— (FAILED|CONFLICT|NEEDS_INPUT|CANCELLED)/.test(input.text)
        ? [{ type: "ask", question: "A demo task did not finish. Please inspect its result before continuing." }]
        : [{ type: "done", summary: "Demo changes delivered. Test output was simulated; run npm test to verify." }];
    } else {
      const workers = [...(input.briefing ?? "").matchAll(/^- "([^"]+)" — /gm)].map(match => match[1]!);
      if (!workers.length) return "No demo workers available.";
      const goal = (input.briefing ?? "").split("The goal: ").at(-1) ?? "";
      const filter = /filter/i.test(goal);
      actions = [
        { type: "spawn", id: "t1", title: filter ? "Todo filter" : "Dark mode", agent: workers[0], prompt: filter ? "add a todo filter" : "add dark mode", touches: [filter ? "filter.js" : "styles.css"] },
        { type: "spawn", id: "t2", title: "Demo tests", agent: workers[1] ?? workers[0], prompt: "write tests", touches: ["test.mjs"] },
      ];
    }
    return `A small scripted demo plan.\n\n\`\`\`loom\n${JSON.stringify({ actions })}\n\`\`\``;
  }
}
