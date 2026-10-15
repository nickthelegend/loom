/** Windows native containment. The daemon alone owns the lasting job handle.
 * A trusted Node bootstrap joins the job and closes its temporary handle before
 * the daemon acknowledges launch. No harness or tool runs outside the job.
 * Closing the daemon (including a crash) kills every contained descendant.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { NativeQuiescenceUnknown } from "./continuity/contracts.js";

const require = createRequire(import.meta.url);
let api: ReturnType<typeof loadApi> | undefined;
function loadApi() {
  const koffi = require("koffi") as typeof import("koffi");
  const kernel = koffi.load("kernel32.dll");
  const basic = koffi.struct({
    PerProcessUserTimeLimit: "int64", PerJobUserTimeLimit: "int64", LimitFlags: "uint32",
    MinimumWorkingSetSize: "uintptr", MaximumWorkingSetSize: "uintptr", ActiveProcessLimit: "uint32",
    Affinity: "uintptr", PriorityClass: "uint32", SchedulingClass: "uint32",
  });
  const io = koffi.struct({ ReadOperationCount: "uint64", WriteOperationCount: "uint64", OtherOperationCount: "uint64",
    ReadTransferCount: "uint64", WriteTransferCount: "uint64", OtherTransferCount: "uint64" });
  const limits = koffi.struct({ BasicLimitInformation: basic, IoInfo: io, ProcessMemoryLimit: "uintptr",
    JobMemoryLimit: "uintptr", PeakProcessMemoryUsed: "uintptr", PeakJobMemoryUsed: "uintptr" });
  return {
    create: kernel.func("void * __stdcall CreateJobObjectW(void *attributes, const char16_t *name)"),
    set: kernel.func("int __stdcall SetInformationJobObject(void *job, int kind, const void *info, uint32_t size)"),
    query: kernel.func("int __stdcall QueryInformationJobObject(void *job, int kind, _Out_ void *info, uint32_t size, void *returned)"),
    terminate: kernel.func("int __stdcall TerminateJobObject(void *job, uint32_t code)"),
    close: kernel.func("int __stdcall CloseHandle(void *handle)"),
    error: kernel.func("uint32_t __stdcall GetLastError()"),
    limits, koffi,
  };
}
function windows() { return api ??= loadApi(); }

interface Job { handle: unknown; ready: Promise<void>; stopped?: Promise<void> }
const jobs = new WeakMap<ChildProcess, Job>();

// The bootstrap inherits only the harness's standard streams. IPC is private
// to Loom, and is disconnected before launch so it cannot leak into tools.
const bootstrap = String.raw`
const { spawn } = require('node:child_process');
let launching = false;
const fail = error => { process.stderr.write('Windows Job Object launch failed: ' + error.message + '\n'); process.exit(125); };
process.once('message', spec => {
  try {
    const k = require(spec.koffi).load('kernel32.dll');
    const open = k.func('void * __stdcall OpenJobObjectW(uint32_t access, int inherit, const char16_t *name)');
    const assign = k.func('int __stdcall AssignProcessToJobObject(void *job, void *process)');
    const current = k.func('void * __stdcall GetCurrentProcess()');
    const close = k.func('int __stdcall CloseHandle(void *handle)');
    const error = k.func('uint32_t __stdcall GetLastError()');
    const job = open(1, 0, spec.name);
    if (!job) throw new Error('OpenJobObjectW: ' + error());
    const joined = assign(job, current()), code = joined ? 0 : error();
    if (!close(job)) throw new Error('CloseHandle: ' + error());
    if (!joined) throw new Error('AssignProcessToJobObject: ' + code);
    process.once('message', message => {
      if (message !== 'launch') return fail(new Error('invalid launch acknowledgement'));
      launching = true;
      process.disconnect();
      const child = spawn(spec.command, spec.args, { env: spec.env, windowsVerbatimArguments: spec.windowsVerbatimArguments,
        stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
      child.once('error', fail);
      child.once('exit', (code, signal) => process.exit(code === null ? 1 : code));
    });
    process.send('contained');
  } catch (error) { fail(error); }
});
process.on('disconnect', () => { if (!launching) process.exit(125); });
`;

export function spawnWindowsJob(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const w = windows(), name = `Local\\Loom-${randomUUID()}`;
  const handle = w.create(null, name);
  if (!handle) throw new Error(`CreateJobObjectW failed (${w.error()})`);
  const data = Buffer.alloc(w.koffi.sizeof(w.limits));
  // No BREAKAWAY flags: tools, including detached tools, stay in this job.
  w.koffi.encode(data, w.limits, { BasicLimitInformation: { LimitFlags: 0x2000 } });
  if (!w.set(handle, 9, data, data.length)) {
    const code = w.error(); w.close(handle);
    throw new Error(`SetInformationJobObject failed (${code})`);
  }
  let child: ChildProcess;
  try {
    const stdio = Array.isArray(options.stdio) ? options.stdio.slice(0, 3)
      : Array(3).fill(options.stdio ?? "pipe");
    // User preload hooks belong to the contained target, never the bootstrap.
    const env = { ...(options.env ?? process.env), NODE_OPTIONS: undefined };
    child = spawn(process.execPath, ["-e", bootstrap], { ...options, env, detached: false, windowsHide: true, windowsVerbatimArguments: false,
      stdio: [...stdio, "ipc"] as SpawnOptions["stdio"] });
  } catch (error) { w.close(handle); throw error; }
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("Windows Job Object launch timed out")); void quiesceWindowsJob(child).catch(() => {}); child.kill(); }, 15_000);
    const failed = () => { clearTimeout(timer); reject(new Error("Windows Job Object bootstrap exited before containment")); };
    child.once("exit", failed);
    child.once("error", failed);
    child.once("message", message => {
      if (message !== "contained") return failed();
      if (jobs.get(child)?.stopped) { child.kill(); return failed(); }
      clearTimeout(timer); child.off("exit", failed); child.off("error", failed);
      child.send("launch", error => error ? reject(error) : resolve());
    });
    child.once("spawn", () => child.send({ name, command, args, env: options.env ?? process.env,
      windowsVerbatimArguments: options.windowsVerbatimArguments ?? false, koffi: require.resolve("koffi") }, error => { if (error) failed(); }));
  });
  void ready.catch(() => {});
  jobs.set(child, { handle, ready });
  // Natural parent exit also cleans inherited/detached descendants. Keep any
  // failure on the record; callers must observe it before releasing a writer.
  child.once("exit", () => { void quiesceWindowsJob(child).catch(() => {}); });
  child.once("error", () => { void quiesceWindowsJob(child).catch(() => {}); });
  return child;
}

export function windowsJobReady(child: ChildProcess): Promise<void> | undefined { return jobs.get(child)?.ready; }
export function hasWindowsJob(child: ChildProcess): boolean { return jobs.has(child); }

/** A closed parent is insufficient. Wait until Windows reports zero job members.
 * Unknown inspection/termination keeps the handle and fails closed for Brain.
 */
export function quiesceWindowsJob(child: ChildProcess): Promise<void> {
  const job = jobs.get(child);
  if (!job) return Promise.reject(new NativeQuiescenceUnknown("process has no verified Windows Job Object"));
  return job.stopped ??= (async () => {
    const w = windows();
    if (!w.terminate(job.handle, 1)) throw new NativeQuiescenceUnknown(`TerminateJobObject failed (${w.error()}); quiescence unknown`);
    // During bootstrap the wrapper may not have joined yet. It owns no tool
    // process and must never receive launch permission after cancellation.
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const started = performance.now();
    for (;;) {
      const accounting = Buffer.alloc(48);
      if (!w.query(job.handle, 1, accounting, accounting.length, null))
        throw new NativeQuiescenceUnknown(`QueryInformationJobObject failed (${w.error()}); quiescence unknown`);
      if (accounting.readUInt32LE(40) === 0) {
        if (!w.close(job.handle)) throw new NativeQuiescenceUnknown(`CloseHandle failed (${w.error()})`);
        return;
      }
      if (performance.now() - started > 6000) throw new NativeQuiescenceUnknown("Windows Job Object still has active processes; quiescence unknown");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })();
}

let probe: Promise<void> | undefined;
/** Exercise assignment in this host's enclosing jobs, not just DLL loading. */
export function probeWindowsJobs(): Promise<void> {
  return probe ??= (async () => {
    const child = spawnWindowsJob(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    await windowsJobReady(child);
    const code = await closed;
    await quiesceWindowsJob(child);
    if (code !== 0) throw new Error(`Windows Job Object containment probe exited ${code}`);
  })().catch(error => { probe = undefined; throw error; });
}
