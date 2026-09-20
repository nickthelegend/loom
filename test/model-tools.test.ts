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
