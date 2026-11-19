import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Compile the actual exported models without booting React Native in Node.
const file = new URL("../src/r4-agentic.tsx", import.meta.url);
const source = ts.createSourceFile("r4-agentic.tsx", fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const selected = source.statements.filter(s => ts.isFunctionDeclaration(s) && ["disabledAfterToggle", "validSkillName"].includes(s.name?.text ?? ""));
const code = ts.transpileModule(selected.map(s => s.getText(source)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports: Record<string, (...args: any[]) => any> = {};
vm.runInNewContext(code, { exports });

test("phone toggles one tool while preserving every other switch", () => {
  const tools = [{ name: "loom_send", enabled: true }, { name: "loom_costs", enabled: false }, { name: "loom_consult", enabled: true }];
  assert.deepEqual(Array.from(exports.disabledAfterToggle!(tools, "loom_send", false)), ["loom_send", "loom_costs"]);
  assert.deepEqual(Array.from(exports.disabledAfterToggle!(tools, "loom_costs", true)), []);
  assert.equal(tools[0]!.enabled, true);
});
test("phone rejects invalid skill paths before submission", () => {
  for (const name of ["", "../escape", "Upper Case", "a/b", "x".repeat(65)]) assert.equal(exports.validSkillName!(name), false);
  for (const name of ["saved-workflow", "fix-123"]) assert.equal(exports.validSkillName!(name), true);
});
