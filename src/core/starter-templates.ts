import fs from "node:fs";
import path from "node:path";
import { ProjectCreationError } from "./project-creation.js";

const starters = [
  { name: "web", description: "A dependency-free HTML and JavaScript page", files: {
    "index.html": '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>My app</title><body><h1>Hello, Loom</h1><button id="hello">Say hello</button><script type="module" src="./main.js"></script></body></html>\n',
    "main.js": 'document.querySelector("#hello").onclick = () => { document.querySelector("h1").textContent = "Ready to build"; };\n',
  } },
  { name: "node", description: "A Node HTTP server with a health endpoint", files: {
    "package.json": '{"private":true,"type":"module","scripts":{"start":"node server.js","test":"node --test"},"engines":{"node":">=22"}}\n',
    "server.js": 'import { createServer } from "node:http";\ncreateServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true })); }).listen(Number(process.env.PORT || 3000), "127.0.0.1");\n',
  } },
  { name: "library", description: "An ES module library with a Node test", files: {
    "package.json": '{"private":true,"type":"module","exports":"./index.js","scripts":{"test":"node --test"},"engines":{"node":">=22"}}\n',
    "index.js": 'export const greet = (name) => `Hello, ${name}`;\n',
    "index.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "./index.js";\ntest("greets by name", () => assert.equal(greet("Loom"), "Hello, Loom"));\n',
  } },
];

export const starterTemplates = () => starters.map(({ name, description }) => ({ name, description }));
export function starterTemplate(name: unknown) {
  const found = starters.find(t => t.name === name);
  if (!found) throw new ProjectCreationError(`unknown template "${String(name)}"; choose ${starters.map(t => t.name).join(", ")}`);
  return found;
}

/** Reserve every destination before writing so an existing project is never partially overwritten. */
export function applyStarterTemplate(dir: string, name: unknown): void {
  const entries = Object.entries(starterTemplate(name).files) as Array<[string, string]>;
  const files: Array<{ file: string; fd: number; text: string }> = [];
  try {
    for (const [relative, text] of entries) {
      const file = path.join(dir, relative);
      files.push({ file, fd: fs.openSync(file, "wx"), text });
    }
    for (const { fd, text } of files) fs.writeFileSync(fd, text);
  } catch (error) {
    for (const { file } of files) fs.unlinkSync(file);
    throw new ProjectCreationError(`template could not be written: ${(error as Error).message}`, 409);
  } finally { for (const { fd } of files) fs.closeSync(fd); }
}
