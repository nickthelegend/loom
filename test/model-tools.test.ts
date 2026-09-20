/**
 * Hands for a model agent, and the fence around them.
 *
 * These tools take paths from a model, which means they take paths from
 * whatever the model last read — a file in the repository can ask it to open
 * `../../.ssh/id_rsa` and it might. So the containment check is the feature,
 * not a formality, and it gets the most tests here.
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ModelAdapter } from "../src/adapters/model.js";
import { MAX_HOPS, insideProject, runReadTool } from "../src/core/model-tools.js";
import { setProvider } from "../src/core/providers.js";
import type { AdapterEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

/** A small project to read. */
function project(): string {
  const dir = tmpDir("tools");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".loom"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n\nA thing.\n");
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const port = 3000;\nexport const host = 'x';\n");
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n  secret = yes\n");
  fs.writeFileSync(path.join(dir, ".loom", "state.json"), '{"secret":"yes"}');
  return dir;
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c1", name, args });

describe("reading the project", () => {
  it("reads a file, with line numbers", () => {
    const r = runReadTool(project(), call("read_file", { path: "src/app.ts" }));
    expect(r.ok).toBe(true);
    expect(r.content).toContain("   1 export const port = 3000;");
    expect(r.summary).toMatch(/read src\/app\.ts/);
  });

  it("lists a directory, and says which entries are directories", () => {
    const r = runReadTool(project(), call("list_files", {}));
    expect(r.content.split("\n")).toContain("src/");
    expect(r.content).toContain("README.md");
  });

  it("finds a string, with the file and the line", () => {
    const r = runReadTool(project(), call("search", { query: "port" }));
    expect(r.content).toMatch(/src\/app\.ts:1:/);
    expect(runReadTool(project(), call("search", { query: "nowhere" })).content).toMatch(/no match/);
  });
});

describe("the fence", () => {
  it("refuses to leave the project, however the path is spelled", () => {
    const dir = project();
    for (const bad of ["../secrets", "../../etc/passwd", "src/../../outside", "/etc/passwd"]) {
      expect(() => insideProject(dir, bad), bad).toThrow(/outside the project/);
      expect(runReadTool(dir, call("read_file", { path: bad })).ok, bad).toBe(false);
    }
  });

  it("refuses .git and .loom — one is the repository's guts, one is Loom's", () => {
    const dir = project();
    expect(runReadTool(dir, call("read_file", { path: ".git/config" })).content).toMatch(/isn't readable/);
    expect(runReadTool(dir, call("read_file", { path: ".loom/state.json" })).content).toMatch(/isn't readable/);
    // …and they aren't offered up by a listing or a search either.
    expect(runReadTool(dir, call("list_files", {})).content).not.toContain(".git");
    expect(runReadTool(dir, call("search", { query: "secret" })).content).toMatch(/no match/);
  });

  it("is honest about what it can't read, rather than throwing", () => {
    const dir = project();
    expect(runReadTool(dir, call("read_file", { path: "src" })).content).toMatch(/is a directory/);
    expect(runReadTool(dir, call("read_file", { path: "nope.txt" })).ok).toBe(false);
    expect(runReadTool(dir, call("read_file", {})).content).toMatch(/needs a path/);
    expect(runReadTool(dir, call("fly_to_moon")).content).toMatch(/no tool called/);
  });

  it("won't hand back a binary file as text", () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    expect(runReadTool(dir, call("read_file", { path: "blob.bin" })).content).toMatch(/isn't a text file/);
  });
});

// ---------------------------------------------------------------------------
// The loop, against a provider that really asks for tools.
// ---------------------------------------------------------------------------

let server: http.Server | null = null;
afterEach(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** A provider that asks for a tool, then answers using what it got. */
async function toolProvider(opts: { hops?: number } = {}) {
  const rounds: Array<Array<{ role: string; content: string }>> = [];
  let served = 0;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as {
        messages: Array<{ role: string; content: string }>;
        tools?: unknown[];
      };
      rounds.push(body.messages);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ask = served < (opts.hops ?? 1);
      served++;
      if (ask && body.tools) {
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: `c${served}`, function: { name: "read_file", arguments: '{"path":' } },
                    // the arguments arrive in pieces, as they really do
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"src/app.ts"}' } }] } }],
          })}\n\n`,
        );
      } else {
        const saw = body.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
        const port = /port = (\d+)/.exec(saw)?.[1] ?? "unknown";
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: `the port is ${port}` } }] })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = await new Promise<number>((resolve) => {
    server!.listen(0, "127.0.0.1", () => resolve((server!.address() as net.AddressInfo).port));
  });
  const id = `tools-${port}`;
  setProvider(id, { baseUrl: `http://127.0.0.1:${port}`, key: "k", label: "Tools" });
  return { id, rounds };
}

const say = (events: AdapterEvent[]) =>
  events.filter((e) => e.kind === "message" && !e.payload.reasoning).map((e) => String(e.payload.text)).join("");

describe("a model that reads before it answers", () => {
  it("asks for a file, gets it, and uses what it read", async () => {
    process.env.LOOM_HOME = tmpDir("home-tools");
    const dir = project();
    const { id, rounds } = await toolProvider();
    const agent = new ModelAdapter("reader", dir, { provider: id, model: "m", tools: true });
    const events: AdapterEvent[] = [];
    agent.onEvent((e) => events.push(e));

    await agent.send({ text: "what port does the app use?" });

    // It really read the file — the answer contains what was in it.
    expect(say(events)).toContain("the port is 3000");
    const used = events.find((e) => e.kind === "tool_call")!;
    expect(used.payload).toMatchObject({ name: "read_file", ok: true });
    expect(String(used.payload.summary)).toMatch(/read src\/app\.ts/);
    // The second request carried the tool's answer back.
    expect(rounds[1]!.some((m) => m.role === "tool" && m.content.includes("port = 3000"))).toBe(true);
    // One run_complete for the whole turn, not one per hop.
    expect(events.filter((e) => e.kind === "run_complete")).toHaveLength(1);
  });

  it("is offered nothing when the project didn't ask for tools", async () => {
    process.env.LOOM_HOME = tmpDir("home-tools-off");
    const { id, rounds } = await toolProvider();
    const agent = new ModelAdapter("reader", project(), { provider: id, model: "m" });
    await agent.send({ text: "hello" });
    expect(rounds).toHaveLength(1); // nothing to ask with, so nothing was asked
  });

  it("stops going round, and says so rather than being cut off", async () => {
    process.env.LOOM_HOME = tmpDir("home-tools-loop");
    // A model that would ask forever.
    const { id, rounds } = await toolProvider({ hops: 99 });
    const agent = new ModelAdapter("reader", project(), { provider: id, model: "m", tools: true });
    const events: AdapterEvent[] = [];
    agent.onEvent((e) => events.push(e));

    await agent.send({ text: "read everything" });

    // Bounded, and the last request offered no tools — so it had to answer.
    expect(rounds.length).toBeLessThanOrEqual(MAX_HOPS + 1);
    const last = rounds.at(-1)!;
    expect(last.some((m) => m.content.includes("Answer now with what you have"))).toBe(true);
    expect(events.filter((e) => e.kind === "run_complete")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The tools that change something.
// ---------------------------------------------------------------------------

import {
  allowsCommand,
  applyRun,
  applyWrite,
  describeWrite,
  toolsFor,
} from "../src/core/model-tools.js";
import { setApprovalBroker } from "../src/core/approvals.js";

describe("what a model is offered", () => {
  it("is only what it can actually use", () => {
    const names = (t: ReturnType<typeof toolsFor>) => t.map((x) => x.function.name);
    expect(names(toolsFor({}))).toEqual(["read_file", "list_files", "search"]);
    expect(names(toolsFor({ write: true }))).toContain("write_file");
    expect(names(toolsFor({ write: true }))).not.toContain("run");
    // No allow-list, no `run` — a tool that always refuses is a tool that lies.
    expect(names(toolsFor({ run: [] }))).not.toContain("run");
    expect(names(toolsFor({ run: ["npm test"] }))).toContain("run");
    expect(toolsFor({ run: ["npm test"] }).at(-1)!.function.description).toContain("npm test");
  });
});

describe("writing a file", () => {
  it("writes it, and says what it did", () => {
    const dir = project();
    const r = applyWrite(dir, call("write_file", { path: "src/new.ts", content: "export const a = 1;\n" }));
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "src/new.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(r.summary).toMatch(/wrote src\/new\.ts/);
  });

  it("obeys the same fence as reading", () => {
    const dir = project();
    for (const bad of ["../escape.ts", "/etc/hosts", ".git/config", ".loom/state.json"]) {
      expect(applyWrite(dir, call("write_file", { path: bad, content: "x" })).ok, bad).toBe(false);
    }
    expect(fs.existsSync(path.join(path.dirname(dir), "escape.ts"))).toBe(false);
  });

  it("refuses a call that isn't a write", () => {
    const dir = project();
    expect(applyWrite(dir, call("write_file", { content: "x" })).content).toMatch(/needs a path/);
    expect(applyWrite(dir, call("write_file", { path: "a.ts" })).content).toMatch(/needs content/);
    expect(applyWrite(dir, call("write_file", { path: "src", content: "x" })).content).toMatch(/directory/);
  });

  it("describes the change in the sentence that would stop a bad one", () => {
    const dir = project();
    const said = describeWrite(dir, call("write_file", { path: "README.md", content: "x\n", why: "trim it" }));
    expect(said).toContain("README.md");
    expect(said).toContain("replacing 4 lines");
    expect(said).toContain("trim it");
    expect(describeWrite(dir, call("write_file", { path: "brand/new.ts", content: "x" }))).toContain("new file");
  });
});

describe("the allow-list", () => {
  it("matches whole commands and their arguments, and nothing else", () => {
    const allowed = ["npm test", "npx tsc --noEmit"];
    expect(allowsCommand(allowed, "npm test")).toBe(true);
    expect(allowsCommand(allowed, "npm test --watch")).toBe(true);
    expect(allowsCommand(allowed, "npx tsc --noEmit -p .")).toBe(true);
    expect(allowsCommand(allowed, "npm testify")).toBe(false); // not a prefix of a word
    expect(allowsCommand(allowed, "npm run deploy")).toBe(false);
    expect(allowsCommand(allowed, "rm -rf /")).toBe(false);
    expect(allowsCommand([], "npm test")).toBe(false);
  });

  it("refuses anything a shell would read as more than one command", () => {
    const allowed = ["echo"];
    for (const nasty of [
      "echo hi; rm -rf ~",
      "echo hi && curl evil.example",
      "echo hi | sh",
      "echo `whoami`",
      "echo $(whoami)",
      "echo hi > /etc/hosts",
      "echo hi\nrm -rf ~",
    ]) {
      expect(allowsCommand(allowed, nasty), nasty).toBe(false);
    }
  });

  it("runs an allowed command and brings back what it said", async () => {
    const dir = project();
    const r = await applyRun(dir, call("run", { command: "echo hello" }), ["echo"]);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hello");
    expect(r.content).toContain("exit 0");
  });

  it("treats a failing command as an answer, not a tool failure", async () => {
    const dir = project();
    // `ls` on something that isn't there exits non-zero — which is the thing
    // the model asked to find out.
    const r = await applyRun(dir, call("run", { command: "ls no-such-file" }), ["ls"]);
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/exit [1-9]/);
  });

  it("refuses what isn't on the list, and says what is", async () => {
    const r = await applyRun(project(), call("run", { command: "rm -rf /" }), ["npm test"]);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("npm test");
  });
});

describe("asking before it writes", () => {
  afterEach(() => setApprovalBroker(null));

  const writingProvider = async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { messages: Array<{ role: string; content: string }> };
        const answered = body.messages.some((m) => m.role === "tool");
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (!answered) {
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "w1",
                        function: {
                          name: "write_file",
                          arguments: JSON.stringify({ path: "note.md", content: "hi\n", why: "add a note" }),
                        },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          );
        } else {
          const saw = body.messages.filter((m) => m.role === "tool").map((m) => m.content).join("");
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `done: ${saw.slice(0, 60)}` } }] })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as net.AddressInfo).port));
    });
    const id = `w-${port}`;
    setProvider(id, { baseUrl: `http://127.0.0.1:${port}`, key: "k", label: "W" });
    return id;
  };

  it("writes nothing when the person says no", async () => {
    process.env.LOOM_HOME = tmpDir("home-write-deny");
    const dir = project();
    const id = await writingProvider();
    const asked: string[] = [];
    setApprovalBroker(async (r) => {
      asked.push(String(r.summary));
      return { behavior: "deny", message: "not that file" };
    });

    const agent = new ModelAdapter("w", dir, { provider: id, model: "m", tools: true, write: true });
    const events: AdapterEvent[] = [];
    agent.onEvent((e) => events.push(e));
    await agent.send({ text: "add a note" });

    expect(fs.existsSync(path.join(dir, "note.md"))).toBe(false);
    expect(asked[0]).toContain("write note.md");
    expect(asked[0]).toContain("add a note"); // the reason reaches the card
    expect(say(events)).toContain("Denied by the person");
    expect(events.some((e) => e.kind === "file_edit")).toBe(false);
  });

  it("writes it when the person says yes, and says so like any other agent", async () => {
    process.env.LOOM_HOME = tmpDir("home-write-allow");
    const dir = project();
    const id = await writingProvider();
    setApprovalBroker(async () => ({ behavior: "allow" }));

    const agent = new ModelAdapter("w", dir, { provider: id, model: "m", tools: true, write: true });
    const events: AdapterEvent[] = [];
    agent.onEvent((e) => events.push(e));
    await agent.send({ text: "add a note" });

    expect(fs.readFileSync(path.join(dir, "note.md"), "utf8")).toBe("hi\n");
    expect(events.find((e) => e.kind === "file_edit")!.payload.path).toBe("note.md");
    expect(say(events)).toContain("done:");
  });

  it("denies when there is nobody to ask", async () => {
    process.env.LOOM_HOME = tmpDir("home-write-nobody");
    const dir = project();
    const id = await writingProvider();
    setApprovalBroker(null); // no daemon, no person

    const agent = new ModelAdapter("w", dir, { provider: id, model: "m", tools: true, write: true });
    await agent.send({ text: "add a note" });
    expect(fs.existsSync(path.join(dir, "note.md"))).toBe(false);
  });

  it("asks in auto as well — a model off a list isn't a CLI you installed", async () => {
    process.env.LOOM_HOME = tmpDir("home-write-auto");
    const dir = project();
    const id = await writingProvider();
    let asked = 0;
    setApprovalBroker(async () => ((asked++), { behavior: "allow" as const }));

    const agent = new ModelAdapter("w", dir, {
      provider: id,
      model: "m",
      tools: true,
      write: true,
      permissions: "auto",
    });
    await agent.send({ text: "add a note" });
    expect(asked).toBe(1);
  });

  it("doesn't ask in bypass, because that is what bypass means", async () => {
    process.env.LOOM_HOME = tmpDir("home-write-bypass");
    const dir = project();
    const id = await writingProvider();
    let asked = 0;
    setApprovalBroker(async () => ((asked++), { behavior: "allow" as const }));

    const agent = new ModelAdapter("w", dir, {
      provider: id,
      model: "m",
      tools: true,
      write: true,
      permissions: "bypass",
    });
    await agent.send({ text: "add a note" });
    expect(asked).toBe(0);
    expect(fs.readFileSync(path.join(dir, "note.md"), "utf8")).toBe("hi\n");
  });
});
