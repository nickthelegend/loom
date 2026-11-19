import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { readSettings } from "./state.js";
import type { ProjectRuntime } from "../../daemon/runtime.js";
import type { LoomEvent } from "../../types.js";
import { logbook } from "../logbook.js";

export const HOOK_EVENTS = ["turn-finished", "needs-you", "run-completed"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
function hookFile(dir: string, event: string) {
  if (!HOOK_EVENTS.includes(event as HookEvent)) throw new Error("unknown hook event");
  const root = fs.realpathSync(dir), file = path.join(root, ".loom", "hooks", event);
  const real = fs.realpathSync(file);
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw new Error("hook must be a file inside the project");
  fs.accessSync(real, fs.constants.X_OK);
  return real;
}
export function listHooks(project: string, dir: string) {
  return { enabled: readSettings(project).hooks, hooks: HOOK_EVENTS.map(event => {
    try { return { event, executable: true, file: hookFile(dir, event) }; }
    catch { return { event, executable: false, file: path.join(dir, ".loom", "hooks", event) }; }
  }) };
}
export async function runHook(project: string, dir: string, event: string, payload: unknown, timeoutMs = 10_000) {
  if (!readSettings(project).hooks) throw new Error("project hooks are disabled");
  const file = hookFile(dir, event);
  return new Promise<{ code: number | null; timedOut: boolean; output: string }>((resolve, reject) => {
    const child = spawn(file, [], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "", timedOut = false;
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_000); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ event, project, payload }) + "\n");
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      logbook.add(code === 0 ? "info" : "warn", "hooks", `${event}: ${timedOut ? "timed out" : `exit ${code}`}`, output, project);
      resolve({ code, timedOut, output });
    });
  });
}
const attached = new WeakSet<ProjectRuntime>();
export function attachHooks(rt: ProjectRuntime) {
  if (attached.has(rt)) return;
  attached.add(rt);
  let pending = Promise.resolve();
  rt.log.onEvent((event: LoomEvent) => {
    const name = event.kind === "run_complete" ? "turn-finished" : (event.kind === "needs_input" || (event.kind === "approval" && event.payload.phase === "requested") || (event.kind === "orchestra" && event.payload.phase === "waiting")) ? "needs-you"
      : event.kind === "orchestra" && ["completed", "failed", "aborted"].includes(String(event.payload.phase)) ? "run-completed" : undefined;
    if (!name || !readSettings(rt.info.id).hooks || !listHooks(rt.info.id, rt.info.dir).hooks.find(h => h.event === name)?.executable) return;
    pending = pending.then(() => runHook(rt.info.id, rt.info.dir, name, event)).then(result => {
      rt.log.append({ kind: "status", chat: event.chat, payload: { state: "hook_result", hook: name, eventId: event.id, ...result } });
    }).catch(error => { logbook.warn("hooks", String(error), undefined, rt.info.id); });
  });
}
