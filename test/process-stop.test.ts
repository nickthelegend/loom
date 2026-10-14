import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async importOriginal => {
  // execFile's native promise form returns both streams, unlike generic
  // promisify, which resolves only the callback's first success argument.
  Object.defineProperty(execFileMock, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) => new Promise((resolve, reject) => {
      execFileMock(...args, (error: Error | null, stdout: string, stderr: string) =>
        error ? reject(error) : resolve({ stdout, stderr }));
    }),
  });
  return { ...await importOriginal<typeof import("node:child_process")>(), execFile: execFileMock };
});
import { stopWindowsTree } from "../src/core/process.js";

beforeEach(() => { execFileMock.mockReset(); });

describe("Windows shutdown snapshots", () => {
  const rows: Array<{ ProcessId: number; ParentProcessId: number; Name: string; Created: string | null }> = [
    { ProcessId: 123, ParentProcessId: 1, Name: "node.exe", Created: "2026-10-15T10:00:00.0000000Z" },
    { ProcessId: 456, ParentProcessId: 123, Name: "git.exe", Created: "2026-10-15T10:00:01.0000000Z" },
    { ProcessId: 789, ParentProcessId: 123, Name: "conhost.exe", Created: "2026-10-15T10:00:02.0000000Z" },
  ];
  function child() {
    return { pid: 123, exitCode: null, signalCode: null, kill: vi.fn() } as unknown as ChildProcess;
  }
  function snapshot(onSnapshot = () => {}, processes = rows) {
    execFileMock.mockImplementation((command, _args, _options, callback) => {
      queueMicrotask(() => {
        if (command === "powershell.exe") {
          onSnapshot();
          callback(null, JSON.stringify(processes), "");
        } else callback(null, "", "");
      });
      return {};
    });
  }
  it("does not terminate a PID after its child exited during enumeration", async () => {
    const proc = child();
    snapshot(() => { proc.exitCode = 0; });
    await stopWindowsTree(proc);
    expect(execFileMock.mock.calls.map(call => call[0])).toEqual(["powershell.exe"]);
  });
  it("does not terminate a root missing from the snapshot", async () => {
    snapshot(() => {}, rows.slice(1));
    await stopWindowsTree(child());
    expect(execFileMock.mock.calls.map(call => call[0])).toEqual(["powershell.exe"]);
  });
  it("terminates a live child tree while preserving shared console hosts", async () => {
    snapshot();
    await stopWindowsTree(child());
    expect(execFileMock.mock.calls[1]?.slice(0, 2)).toEqual([
      "taskkill.exe", ["/pid", "456", "/pid", "123", "/F"],
    ]);
  });
  it("preserves an older process whose parent PID has been reused", async () => {
    snapshot(() => {}, [...rows,
      { ProcessId: 900, ParentProcessId: 123, Name: "node.exe", Created: "2026-10-15T09:59:59.0000000Z" },
      { ProcessId: 901, ParentProcessId: 900, Name: "git.exe", Created: "2026-10-15T10:00:03.0000000Z" },
    ]);
    await stopWindowsTree(child());
    expect(execFileMock.mock.calls[1]?.[1]).toEqual(["/pid", "456", "/pid", "123", "/F"]);
  });
  it("preserves a process whose creation time cannot establish ancestry", async () => {
    snapshot(() => {}, rows.map(row => ({ ...row, Created: null })));
    await stopWindowsTree(child());
    expect(execFileMock.mock.calls[1]?.[1]).toEqual(["/pid", "123", "/F"]);
  });
});
