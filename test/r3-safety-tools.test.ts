import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { setApprovalBroker } from "../src/core/approvals.js";
import { ModelAdapter } from "../src/adapters/model.js";
import { registerAutoPolicy } from "../src/core/auto-policy.js";
import { parseSafety } from "../src/core/safety.js";
import { setProvider } from "../src/core/providers.js";
import { RedactedStream } from "../src/core/redact.js";
import { permissionIndicator } from "../src/core/permissions.js";
import type { AdapterEvent } from "../src/types.js";
import { tmpDir } from "./helpers.js";

let server: http.Server | undefined;
afterEach(async () => { setApprovalBroker(null); server?.closeAllConnections(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined; });

async function provider(name: string, args: object) {
  server = http.createServer((req, res) => {
    let raw = ""; req.on("data", chunk => raw += chunk); req.on("end", () => {
      const body = JSON.parse(raw);
      const hasResult = body.messages.some((m: { role: string }) => m.role === "tool");
      const delta = hasResult ? { content: "done" } : { tool_calls: [{ index: 0, id: "one", function: { name, arguments: JSON.stringify(args) } }] };
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port, id = `r3-${port}`;
  setProvider(id, { baseUrl: `http://127.0.0.1:${port}`, key: "test", label: "Test" }); return id;
}

it.each(["bypass", "auto", "ask"] as const)("prevents real model writes to protected paths in %s before any approval", async permissions => {
  process.env.LOOM_HOME = tmpDir("r3-model-home");
  const dir = tmpDir("r3-model"); fs.writeFileSync(path.join(dir, "keep.txt"), "original");
  const unregister = registerAutoPolicy("r3", () => ({ projectDir: dir, readPaths: [], allow: ["*"], safety: parseSafety({ preset: "trusting", protectedPaths: ["keep.txt"] }) }));
  const id = await provider("write_file", { path: "keep.txt", content: "changed", why: "test" });
  const agent = new ModelAdapter("test", dir, { provider: id, model: "test", tools: true, write: true, permissions, loomProject: "r3" });
  const events: AdapterEvent[] = []; agent.onEvent(e => events.push(e));
  try {
    await agent.send({ text: "write the file" });
    expect(fs.readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("original");
    expect(events.some(e => e.payload.state === "safety_denied")).toBe(true);
  } finally { unregister(); await agent.stop(); }
});

it("prevents denylisted model shell commands before they execute in bypass", async () => {
  process.env.LOOM_HOME = tmpDir("r3-run-home"); const dir = tmpDir("r3-run");
  const unregister = registerAutoPolicy("r3", () => ({ projectDir: dir, readPaths: [], allow: [], safety: parseSafety({ preset: "trusting", shellDeny: ["node *"] }) }));
  const command = `node -e "require('fs').writeFileSync('created.txt','bad')"`;
  const id = await provider("run", { command });
  const agent = new ModelAdapter("test", dir, { provider: id, model: "test", tools: true, run: ["node"], permissions: "bypass", loomProject: "r3" });
  try { await agent.send({ text: "run it" }); expect(fs.existsSync(path.join(dir, "created.txt"))).toBe(false); }
  finally { unregister(); await agent.stop(); }
});

it("shows the effective sandbox including explicit overrides", () => {
  expect(permissionIndicator("codex", { permissions: "auto", sandbox: "danger-full-access" })).toBe("Auto · no sandbox");
  expect(permissionIndicator("codex", { permissions: "auto" })).toBe("Auto · workspace sandbox");
  expect(permissionIndicator("model", { permissions: "bypass" })).toBe("Bypass · no approvals");
});

it("holds split credentials and multiline private keys until they can be redacted", () => {
  const stream = new RedactedStream();
  expect(stream.push("hello\nghp_" + "A".repeat(12))).toBe("hello\n");
  expect(stream.push("A".repeat(24) + "\n")).toBe("[REDACTED]\n");
  expect(stream.push("-----BEGIN PRIVATE KEY-----\nsecret\n")).toBe("");
  expect(stream.push("bytes\n-----END PRIVATE KEY-----\n")).toBe("[REDACTED PRIVATE KEY]\n");
});

it("redacts completed and interrupted credential assignments", () => {
  const stream = new RedactedStream();
  expect(stream.push('token="abc')).toBe("");
  expect(stream.finish()).not.toContain("abc");
  expect(stream.push("ordinary prose")).toBe("ordinary prose");
});


it("rechecks protected targets after a human approval wait", async () => {
  process.env.LOOM_HOME = tmpDir("r3-wait-home"); const dir = tmpDir("r3-wait");
  fs.writeFileSync(path.join(dir, "keep.txt"), "original");
  const unregister = registerAutoPolicy("r3", () => ({ projectDir: dir, readPaths: [], allow: [], safety: parseSafety({ preset: "normal", protectedPaths: ["keep.txt"] }) }));
  const id = await provider("write_file", { path: "new.txt", content: "changed", why: "test" });
  setApprovalBroker(async () => { fs.symlinkSync("keep.txt", path.join(dir, "new.txt")); return { behavior: "allow" }; });
  const agent = new ModelAdapter("test", dir, { provider: id, model: "test", tools: true, write: true, permissions: "ask", loomProject: "r3" });
  try { await agent.send({ text: "write it" }); expect(fs.readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("original"); }
  finally { unregister(); await agent.stop(); }
});
