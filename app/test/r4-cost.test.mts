import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { costMoney, costBudgetLabel, cacheSavingsLabel } from "../src/model-routing-model.ts";

describe("phone cost models", () => {
  it("distinguishes free pricing and unknown savings", () => {
    assert.equal(costMoney(null), "unknown"); assert.equal(costMoney(0), "$0.0000");
    assert.equal(cacheSavingsLabel({ tokensIn: 100, cachedIn: 50, cacheSavedUsd: 0.2 }), "50% cached · $0.2000 saved at API prices");
    assert.match(cacheSavingsLabel({ tokensIn: 0, cachedIn: 0 }), /0% cached · unknown/);
    assert.match(cacheSavingsLabel({ tokensIn: 100, cachedIn: 200 }), /100% cached/);
  });
  it("shows monthly projection, warning and Raise state from the API", () => {
    const row = { capUsd: 10, spentUsd: 8, projectedUsd: 16, warning: true, stopped: false };
    assert.match(costBudgetLabel(row), /projected \$16.0000 · 80% used/);
    assert.match(costBudgetLabel({ ...row, spentUsd: 10, stopped: true }), /Needs you: raise cap/);
    assert.match(costBudgetLabel({ ...row, capUsd: 0, warning: false }), /no cap/);
  });
});

// Exercise the real sheet component with a tiny hook host; native rendering is not
// needed to verify which network responses are allowed to write its form state.
it("polls spend without resetting edits, and reseeds on open, context change and save", async () => {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const source = readFileSync(new URL("../src/r4-cost.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const states: any[] = [], effects: any[] = [], pending: Array<() => void> = [], timers = new Set<() => void>();
  let cursor = 0, effectCursor = 0;
  let snapshot = { chats: { main: { capUsd: 1 }, other: { capUsd: 4 } }, monthly: {}, daily: {}, settings: { monthlyUsd: 10, dailyUsd: 2, alerts: ["push"], saver: { alias: "cheap", share: 0.8, period: "month" } } };
  const writes: any[] = [];
  const hooks = {
    useState(initial: any) { const at = cursor++; if (!(at in states)) states[at] = initial; return [states[at], (v: any) => { states[at] = v; }]; },
    useEffect(run: () => (() => void), deps: any[]) {
      const at = effectCursor++, prev = effects[at];
      if (!prev || deps.some((d, i) => d !== prev.deps[i])) {
        pending.push(() => { prev?.cleanup?.(); effects[at] = { deps, cleanup: run() }; });
      }
    },
  };
  const jsx = (type: any, props: any) => ({ type, props });
  const api = async (_creds: any, _url: string, opts?: any) => {
    if (opts?.method === "PUT") {
      const body = JSON.parse(opts.body); writes.push(body);
      if (body.usd) snapshot = { ...snapshot, chats: { ...snapshot.chats, main: { capUsd: body.usd } } };
    }
    return snapshot;
  };
  const module = { exports: {} as any };
  const mockRequire = (id: string) => {
    if (id === "react") return hooks;
    if (id === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (id === "react-native") return { View: "View", Text: "Text", TextInput: "TextInput", TouchableOpacity: "Button", Share: {} };
    if (id === "./api") return { api };
    if (id === "./observatory") return { Sheet: "Sheet" };
    if (id === "./theme") return { T: {}, radii: {} };
    if (id === "./model-routing-model") return { costMoney, costBudgetLabel, cacheSavingsLabel };
    throw new Error(id);
  };
  new Function("require", "exports", "setInterval", "clearInterval", js)(mockRequire, module.exports, (f: () => void) => { timers.add(f); return f; }, (f: () => void) => timers.delete(f));
  const creds = {};
  let props = { creds, projectId: "p", chat: "main" };
  const render = () => { cursor = effectCursor = 0; const tree = module.exports.R4CostMenu(props); pending.splice(0).forEach(f => f()); return tree; };
  const find = (tree: any, label: string): any => {
    if (!tree || typeof tree !== "object") return;
    if (tree.props?.label === label) return tree.props;
    for (const child of [tree.props?.children].flat(Infinity)) { const hit = find(child, label); if (hit) return hit; }
  };
  const settle = async () => { await new Promise(r => setImmediate(r)); return render(); };
  let tree = render(); tree = await settle();
  find(tree, "Chat budget & costs").run(); tree = render(); tree = await settle();
  assert.equal(find(tree, "Chat budget USD (0 clears)").value, "1");
  const edits: Record<string, string> = { "Chat budget USD (0 clears)": "7", "Monthly budget USD (0 clears)": "20", "Daily budget USD (0 clears)": "3", "Alert channels: slack,discord,email,push": "email", "Saver alias (blank disables)": "fast", "Saver share (0–1)": "0.9", "Saver period: day or month": "day" };
  for (const [label, value] of Object.entries(edits)) find(tree, label).set(value);
  tree = render(); timers.forEach(f => f()); tree = await settle();
  for (const [label, value] of Object.entries(edits)) assert.equal(find(tree, label).value, value, label);
  find(tree, "Raise / save chat budget").run(); tree = await settle();
  assert.equal(writes[0].usd, 7); assert.equal(find(tree, "Monthly budget USD (0 clears)").value, "10");
  props = { ...props, chat: "other" }; tree = render(); tree = await settle();
  assert.equal(find(tree, "Chat budget USD (0 clears)").value, "4");
  effects.forEach(e => e.cleanup?.());
});
