import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loomHome } from "../registry.js";
import { fetchModels, resolveProvider, setProvider } from "../providers.js";
import { readModelRouting, writeModelRouting } from "../model-routing-settings.js";

interface GuideState { fingerprint: string; models: string[]; model?: string }
const file = () => path.join(loomHome(), "provider-guide.json");
function read(): Record<string, GuideState> { try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return {}; } }
function write(id: string, value?: GuideState) {
  const state = read();
  if (value) state[id] = value; else delete state[id];
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(file() + ".tmp", JSON.stringify(state), { mode: 0o600 }); fs.renameSync(file() + ".tmp", file());
}
function provider(id: string) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("invalid provider id");
  return resolveProvider(id);
}
function fingerprint(id: string) { return createHash("sha256").update(JSON.stringify(provider(id))).digest("hex"); }
export function testedProvider(id: string) {
  provider(id);
  const state = read()[id];
  if (!state || state.fingerprint !== fingerprint(id)) throw new Error("test this provider's current credentials first");
  return state;
}
export async function providerGuideStep(step: string, input: { provider?: unknown; key?: unknown; baseUrl?: unknown; model?: unknown }) {
  if (typeof input.provider !== "string") throw new Error("provider is required");
  const id = input.provider; provider(id);
  if (step === "key") {
    if (typeof input.key !== "string" || !input.key.trim()) throw new Error("key is required");
    setProvider(id, { key: input.key, ...(typeof input.baseUrl === "string" && input.baseUrl ? { baseUrl: input.baseUrl } : {}) });
    write(id); return { step: "test", provider: id };
  }
  if (step === "test") {
    const p = provider(id); if (!p) throw new Error("add a provider key first");
    const before = fingerprint(id);
    const result = await fetchModels(p, { refresh: true, signal: AbortSignal.timeout(20_000) });
    if (before !== fingerprint(id)) throw new Error("provider changed during the test; test again");
    if (result.error) throw new Error(result.error);
    if (!result.models.length) throw new Error("provider returned no models");
    const models = result.models.map(m => m.id);
    write(id, { fingerprint: fingerprint(id), models });
    return { step: "default", provider: id, models };
  }
  if (step === "default") {
    const state = testedProvider(id);
    if (typeof input.model !== "string" || !state.models.includes(input.model)) throw new Error("choose a model returned by the provider test");
    const model = `${id}/${input.model}`;
    const routing = readModelRouting(); routing.aliases.default = model; writeModelRouting(routing);
    write(id, { ...state, model }); return { step: "agent", provider: id, model };
  }
  throw new Error("step must be key, test or default");
}
