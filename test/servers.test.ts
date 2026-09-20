/**
 * Dev servers Loom runs, with real processes and real ports.
 *
 * Nothing is faked here: the "servers" are small node one-liners that listen,
 * or exit, or print. That's the only way to test the distinction the whole
 * feature rests on — a process existing is not a server running, and a server
 * that went away on its own is not one you stopped.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  Servers,
  portFromScript,
  portListening,
  suggestServers,
  urlFor,
  type LogLine,
  type ServerConfig,
  type ServerStatus,
} from "../src/core/servers.js";
import { tmpDir, waitUntil } from "./helpers.js";

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

let live: Servers | null = null;
afterEach(async () => {
  await live?.closeAll();
  live = null;
});

function make(dir: string, configs: ServerConfig[]) {
  const changes: ServerStatus[] = [];
  const lines: Array<{ name: string; line: LogLine }> = [];
  const servers = new Servers({
    projectDir: dir,
    configs: () => configs,
    onChange: (_name, status) => changes.push(status),
    onLine: (name, line) => lines.push({ name, line }),
  });
  live = servers;
  return { servers, changes, lines };
}

describe("reading a project", () => {
  it("suggests the scripts that are servers, with a port only when the script says one", () => {
    const dir = tmpDir("suggest");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        scripts: { dev: "vite --port 5173", build: "tsc", start: "node server.js", test: "vitest", preview: "vite preview" },
      }),
    );
    const found = suggestServers(dir);
    expect(found.map((s) => s.name)).toEqual(["dev", "start", "preview"]); // not build, not test
    expect(found[0]).toMatchObject({ command: "npm run dev", port: 5173 });
    expect(found[1]!.port).toBeUndefined(); // `node server.js` names no port — don't invent one
  });

  it("finds a port where a script states it, and nowhere else", () => {
    expect(portFromScript("vite --port 5173")).toBe(5173);
    expect(portFromScript("next dev -p 3001")).toBe(3001);
    expect(portFromScript("PORT=8080 node server.js")).toBe(8080);
    expect(portFromScript("vite --port=4000")).toBe(4000);
    expect(portFromScript("node server.js")).toBeUndefined();
    expect(portFromScript("echo 1999 things")).toBeUndefined(); // a number isn't a port
  });

  it("says nothing at all about a project with no package.json", () => {
    expect(suggestServers(tmpDir("empty"))).toEqual([]);
  });

  it("points the preview at the url, or builds one from the port", () => {
    expect(urlFor({ name: "a", command: "x", port: 3000 })).toBe("http://localhost:3000");
    expect(urlFor({ name: "a", command: "x", port: 3000, url: "https://app.localhost:8443" })).toBe("https://app.localhost:8443");
    expect(urlFor({ name: "a", command: "x" })).toBeNull();
  });
});

describe("running one", () => {
  it("is 'starting' until the port answers, then 'running'", async () => {
    const port = await freePort();
    const dir = tmpDir("srv-run");
    // listens only after a beat: the gap between "process exists" and "serving"
    const { servers, changes } = make(dir, [
      { name: "web", command: `node -e "setTimeout(()=>require('net').createServer().listen(${port}),600); setInterval(()=>{},1000)"`, port },
    ]);

    const started = await servers.start("web");
    expect(started.state).toBe("starting");
    expect(started.pid).toBeGreaterThan(0);
    await waitUntil(() => servers.status(servers.mustConfig("web")).state === "running", { timeoutMs: 20_000 });
    expect(changes.map((c) => c.state)).toEqual(["starting", "running"]);
    expect(await portListening(port)).toBe(true);

    const stopped = await servers.stop("web");
    expect(stopped.state).toBe("stopped");
    expect(stopped.pid).toBeNull();
    await waitUntil(async () => !(await portListening(port)), { timeoutMs: 20_000 });
  }, 40_000);

  it("keeps what it printed, both streams, and the command that started it", async () => {
    const dir = tmpDir("srv-log");
    const { servers, lines } = make(dir, [
      { name: "noisy", command: `node -e "console.log('listening on 1234'); console.error('a warning'); setInterval(()=>{},1000)"` },
    ]);
    await servers.start("noisy");
    // both streams, not whichever flushed first
    await waitUntil(
      () => servers.log("noisy").some((l) => l.stream === "out") && servers.log("noisy").some((l) => l.stream === "err"),
      { timeoutMs: 20_000 },
    );
    const log = servers.log("noisy");
    expect(log[0]).toMatchObject({ stream: "loom" }); // the command itself, first
    expect(log[0]!.text).toContain("node -e");
    expect(log.find((l) => l.stream === "out")?.text).toContain("listening on 1234");
    expect(log.find((l) => l.stream === "err")?.text).toContain("a warning");
    expect(lines.every((l) => l.name === "noisy")).toBe(true);
  }, 40_000);

  it("tells a crash from a stop, and keeps the exit code", async () => {
    const dir = tmpDir("srv-crash");
    const { servers, changes } = make(dir, [{ name: "doomed", command: `node -e "process.exit(3)"` }]);
    await servers.start("doomed");
    await waitUntil(() => servers.status(servers.mustConfig("doomed")).state === "crashed", { timeoutMs: 20_000 });
    const s = servers.status(servers.mustConfig("doomed"));
    expect(s.exitCode).toBe(3);
    expect(s.pid).toBeNull();
    expect(changes.at(-1)).toMatchObject({ state: "crashed", exitCode: 3 });
    expect(servers.log("doomed").at(-1)!.text).toContain("code 3");
  }, 40_000);

  it("a restart is the same server again, and stopping twice is not an error", async () => {
    const port = await freePort();
    const dir = tmpDir("srv-restart");
    const { servers } = make(dir, [
      { name: "web", command: `node -e "require('net').createServer().listen(${port}); setInterval(()=>{},1000)"`, port },
    ]);
    await servers.start("web");
    await waitUntil(() => servers.status(servers.mustConfig("web")).state === "running", { timeoutMs: 20_000 });
    const first = servers.status(servers.mustConfig("web")).pid;
    await servers.restart("web");
    await waitUntil(() => servers.status(servers.mustConfig("web")).state === "running", { timeoutMs: 20_000 });
    expect(servers.status(servers.mustConfig("web")).pid).not.toBe(first);
    await servers.stop("web");
    await expect(servers.stop("web")).resolves.toMatchObject({ state: "stopped" });
  }, 60_000);

  it("refuses a name this project doesn't have, rather than running something", async () => {
    const { servers } = make(tmpDir("srv-none"), []);
    await expect(servers.start("ghost")).rejects.toThrow(/no server "ghost"/);
  });

  it("starting one that's already up doesn't start a second", async () => {
    const dir = tmpDir("srv-twice");
    const { servers } = make(dir, [{ name: "web", command: `node -e "setInterval(()=>{},1000)"` }]);
    const a = await servers.start("web");
    const b = await servers.start("web");
    expect(b.pid).toBe(a.pid);
  }, 30_000);
});
