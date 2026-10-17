/**
 * loom doctor, beyond this shell: the daemon is often the desktop app's,
 * started without the shell's PATH or keys — doctor says where the two
 * differ — and it checks each provider answers and that a pinned free model
 * isn't being refused all day.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareWithDaemon, envFacts, freeModelTrouble, providerChecks, type Check, type EnvFacts } from "../src/cli/doctor.js";
import type { AgentConfig, LoomEvent } from "../src/types.js";

const facts = (p: string[], keys: string[] = [], node = "26.5.0"): EnvFacts => ({ node, path: p, keys });
const c = (name: string, status: Check["status"], detail: string): Check => ({ name, status, detail });

describe("the daemon's view vs this shell's", () => {
  it("names key variables, never their values", () => {
    const f = envFacts({ PATH: ["/a", "/b"].join(path.delimiter), OPENROUTER_API_KEY: "sk-secret", GROQ_API_KEY: "", HOME: "/h", GH_AUTH_TOKEN: "x" });
    expect(f.path).toEqual(["/a", "/b"]);
    expect(f.keys).toEqual(["GH_AUTH_TOKEN", "OPENROUTER_API_KEY"]);
    expect(JSON.stringify(f)).not.toContain("sk-secret");
  });

  it("an agent this shell finds but the daemon can't is a failure, with the missing PATH dirs and the fix", () => {
    const out = compareWithDaemon(
      { checks: [c("codex", "ok", "Codex · signed in"), c("opencode", "warn", "not found — install it")], facts: facts(["/usr/bin", "/opt/homebrew/bin"]) },
      { checks: [c("codex", "warn", "not found — install Codex"), c("opencode", "warn", "not found — install it")], facts: facts(["/usr/bin"]) },
    );
    expect(out).toEqual([c("daemon:codex", "fail", expect.stringMatching(/daemon can't find it.*missing \/opt\/homebrew\/bin.*loom up --restart/) as unknown as string)]);
  });

  it("names the dir the agent's command is in, not every dir the daemon lacks", () => {
    const shellPath = ["/proj/node_modules/.bin", "/home/me/.opencode/bin", "/home/me/.cargo/bin", "/usr/bin"];
    const out = compareWithDaemon(
      { checks: [c("opencode", "ok", "OpenCode · signed in")], facts: facts(shellPath) },
      { checks: [c("opencode", "warn", "not found — install it")], facts: facts(["/usr/bin"]) },
      (f) => f === path.join("/home/me/.opencode/bin", "opencode"),
    );
    expect(out[0]!.detail).toMatch(/\(missing \/home\/me\/\.opencode\/bin\);/);
    const unknown = compareWithDaemon(
      { checks: [c("opencode", "ok", "x")], facts: facts(shellPath) }, { checks: [c("opencode", "warn", "not found")], facts: facts(["/usr/bin"]) }, () => false);
    expect(unknown[0]!.detail).toMatch(/\(missing \/home\/me\/\.opencode\/bin, \/home\/me\/\.cargo\/bin\)/);
  });

  it("signed in here but signed out for the daemon; a key only this shell has", () => {
    const out = compareWithDaemon(
      { checks: [c("grok-code", "ok", "Grok · signed in")], facts: facts(["/x"], ["OPENROUTER_API_KEY"]) },
      { checks: [c("grok-code", "fail", "Grok is signed out — grok login")], facts: facts(["/x"], []) },
    );
    expect(out.map((x) => [x.name, x.status])).toEqual([["daemon:grok-code", "fail"], ["daemon:keys", "warn"]]);
    expect(out[1]!.detail).toMatch(/OPENROUTER_API_KEY is set in this shell but not in the daemon — loom providers:set openrouter --key/);
  });

  it("says so plainly when they agree", () => {
    const same = { checks: [c("codex", "ok", "signed in")], facts: facts(["/x", "/y"], ["OPENROUTER_API_KEY"]) };
    expect(compareWithDaemon(same, same)).toEqual([c("daemon:env", "ok", "same PATH and keys as this shell")]);
    expect(compareWithDaemon(same, { ...same, facts: facts(["/x"], ["OPENROUTER_API_KEY"]) })[0]!.detail).toMatch(/PATH lacks 1 of your dirs, none an agent needs/);
  });
});

describe("providers answer", () => {
  const env = { OPENROUTER_API_KEY: "sk-test", GROQ_API_KEY: "gsk-test", LOOM_HOME: "/nonexistent-loom-home" } as NodeJS.ProcessEnv;
  const respond = (byHost: Record<string, number | object>) => (async (url: string) => {
    const hit = Object.entries(byHost).find(([k]) => String(url).includes(k));
    const v = hit?.[1] ?? 404;
    return typeof v === "number" ? new Response("{}", { status: v }) : new Response(JSON.stringify(v));
  }) as unknown as typeof fetch;

  it("ok, a refused key, rate-limited, and OpenRouter's free tier said out loud", async () => {
    const checks = await providerChecks({ env, fetchImpl: respond({ "openrouter.ai/api/v1/models": { data: [] }, "openrouter.ai/api/v1/key": { data: { is_free_tier: true } }, "groq.com": 401 }) });
    const by = Object.fromEntries(checks.map((x) => [x.name, x]));
    expect(by["provider:openrouter"]).toMatchObject({ status: "ok", detail: expect.stringMatching(/free tier/) });
    expect(by["provider:groq"]).toMatchObject({ status: "fail", detail: expect.stringMatching(/refused the key \(401\).*providers:set groq/) });
    const limited = await providerChecks({ env: { OPENROUTER_API_KEY: "k" } as NodeJS.ProcessEnv, fetchImpl: respond({ "openrouter.ai": 429 }) });
    expect(limited.find((x) => x.name === "provider:openrouter")).toMatchObject({ status: "warn" });
  });
});

describe("a free model refused all day", () => {
  const agents = [{ id: "cheap", kind: "model", model: "meta-llama/llama-3.3-70b:free" }, { id: "pooled", kind: "model", model: "pool:free" }] as unknown as AgentConfig[];
  let n = 0;
  const err = (agentId: string, message: string, ts = Date.now()): LoomEvent => ({ id: ++n, ts, kind: "error", agentId, payload: { message } }) as LoomEvent;

  it("suggests pool:free for 429/503s, names the daily cap for what it is, and ignores old or pooled trouble", () => {
    expect(freeModelTrouble([err("cheap", "OpenRouter 429: rate-limited upstream"), err("cheap", "503 no capacity")], agents))
      .toEqual([c("model:cheap", "warn", expect.stringMatching(/refused \(429\/503\) 2× in 24h — set this agent's model to pool:free/) as unknown as string)]);
    expect(freeModelTrouble([err("cheap", "429 free-models-per-day")], agents)[0]!.detail).toMatch(/daily free-request cap/);
    expect(freeModelTrouble([err("cheap", "429", Date.now() - 2 * 86_400_000), err("pooled", "429")], agents)).toEqual([]);
  });
});
