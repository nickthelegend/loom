/**
 * One short completion from a configured provider (ollama, OpenRouter, …) —
 * the non-Claude twin of claude-cli.ts's claudeText, for Loom's own small
 * jobs (the memory extractor). `pool:free` takes the next few free models in
 * the rotation, so a busy one doesn't fail the job, and stops at the daily cap.
 */

import { countFreeRequest, freeModels, isDailyCap, isPool, noteCapped, resetAt, rest, rotation } from "./free-pool.js";
import { chatUrl, explainStatus, requestHeaders, resolveProvider } from "./providers.js";

/** "ollama/qwen3:4b" → provider "ollama", model "qwen3:4b"; null when the prefix isn't a provider. */
export function providerModel(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0) return null;
  const provider = ref.slice(0, i), model = ref.slice(i + 1);
  return model && resolveProvider(provider) ? { provider, model } : null;
}

export async function providerText(ref: string, prompt: string, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<string> {
  const pm = providerModel(ref);
  if (!pm) throw new Error(`${ref} isn't a configured provider/model`);
  const p = resolveProvider(pm.provider)!;
  const doFetch = opts.fetchImpl ?? fetch;
  const candidates = isPool(pm.model) ? rotation(await freeModels(p, { fetchImpl: doFetch }), 3) : [pm.model];
  if (!candidates.length) throw new Error(`${p.label} has no free models to use`);
  let last = "";
  for (const model of candidates) {
    const res = await doFetch(chatUrl(p), {
      method: "POST",
      headers: requestHeaders(p),
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false, temperature: 0 }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    if (p.free(model) || isPool(pm.model)) countFreeRequest();
    if (res.ok) {
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content ?? "";
      if (text.trim()) return text;
      last = `${model} returned nothing`;
      continue;
    }
    const raw = await res.text().catch(() => "");
    if (isDailyCap(res.status, raw)) {
      noteCapped(resetAt(res.headers));
      throw new Error(explainStatus(res.status, raw, p));
    }
    last = explainStatus(res.status, raw, p);
    if (res.status === 429) rest(model);
    if (!isPool(pm.model)) break;
  }
  throw new Error(last || `${p.label} didn't answer`);
}
