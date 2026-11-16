import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, accountKey, type Account } from "../src/core/accounts.js";
import { NativeUsage } from "../src/daemon/runtime/native-usage.js";
import { QuotaRelay, type RelayHost } from "../src/daemon/runtime/relay.js";
import type { AgentConfig, LoomEvent } from "../src/types.js";
import { tmpDir, waitUntil } from "./helpers.js";

let relay: QuotaRelay;
beforeEach(() => { process.env.LOOM_HOME = tmpDir("account-relay"); });
afterEach(() => relay?.stop());

/** Only the host ports are supplied: quota detection, caps and selection are the real relay. */
function harness(agents: AgentConfig[], opts: { order?: string[]; busy?: string[]; unavailable?: string[]; clone?: boolean; auto?: boolean } = {}) {
  const events: LoomEvent[] = [];
  const clones: AgentConfig[] = [];
  const sent: string[] = [];
  let holder = agents[0]!.id;
  const append: RelayHost["append"] = e => {
    const event = { ...e, id: events.length + 1, ts: Date.now() };
    events.push(event);
    return event;
  };
  const host: RelayHost = {
    config: () => ({ agents, relay: { to: opts.order, auto: opts.auto } }),
    busy: id => opts.busy?.includes(id) ?? false,
    available: async id => !opts.unavailable?.includes(id),
    turnChat: () => "main", interrupt: async () => {},
    handoff: async id => { holder = id; }, holder: () => holder,
    setBriefing: () => {}, send: async (_text, id) => { sent.push(id); },
    enqueue: () => {}, list: () => events, append, warn: message => { throw new Error(message); },
    ...(opts.clone ? { addAccountAgent: (source: AgentConfig, account: Account) => {
      const clone = { ...source, id: `${source.id}-relay-${clones.length}`, account: account.id, options: { ...source.options, configDir: account.configDir } };
      agents.push(clone); clones.push(clone); return clone;
    } } : {}),
  };
  relay = new QuotaRelay(host);
  const cap = async (id: string, request = false) => {
    if (request) append({ kind: "message", payload: { text: "continue the task" } });
    const event = append({ kind: "error", agentId: id, payload: { message: "Usage limit reached, resets in 1 hour" } });
    relay.observe(event);
    await waitUntil(() => relay.cappedUntil(id) !== null);
    if (request) await waitUntil(() => sent.length > 0);
  };
  return { cap, clones, sent };
}
const cfg = (id: string, dir: string, extra: Partial<AgentConfig> = {}): AgentConfig => ({ id, kind: "codex", role: "worker", options: { configDir: dir }, ...extra });

describe("relay account selection", () => {
  it("hands a capped request to another account before the explicit cross-CLI order", async () => {
    const a = addAccount({ kind: "codex", label: "personal" });
    const b = addAccount({ kind: "codex", label: "work" });
    const h = harness([cfg("c", a.configDir), { id: "fallback", kind: "echo", role: "worker" }, cfg("same-login", a.configDir), cfg("other-login", b.configDir)], { order: ["fallback"] });
    await h.cap("c", true);
    expect(h.sent).toEqual(["other-login"]);
    expect(relay.cappedUntil("same-login")).toBeGreaterThan(Date.now());
    expect(relay.caps()).toHaveProperty("same-login");
    await h.cap("other-login");
    expect(await relay.route("c")).toBe("fallback");
  });

  it("clones only an unrepresented account and preserves the capped instance's choices", async () => {
    const a = addAccount({ kind: "codex", label: "personal" });
    const b = addAccount({ kind: "codex", label: "work" });
    const source = cfg("c", a.configDir, { account: a.id, instructions: "keep tests", options: { configDir: a.configDir, model: "test-model", permissions: "ask" } });
    const h = harness([source, { id: "fallback", kind: "echo", role: "worker" }], { clone: true });
    await h.cap("c");
    expect(await relay.route("c")).toBe("c-relay-0");
    expect(h.clones).toEqual([{ ...source, id: "c-relay-0", account: b.id, options: { ...source.options, configDir: b.configDir } }]);
    expect(accountKey(h.clones[0]!)).not.toBe(accountKey(source));
    expect(await relay.route("c")).toBe("c-relay-0");
    expect(h.clones).toHaveLength(1);
    await h.cap("c-relay-0");
    expect(await relay.route("c")).toBe("fallback");
    expect(h.clones).toHaveLength(1);
  });

  it("does not clone around disabled, busy or unavailable accounts", async () => {
    const accounts = ["source", "off", "busy", "missing"].map(label => addAccount({ kind: "codex", label }));
    const agents = accounts.map(a => cfg(a.label, a.configDir, { account: a.id, ...(a.label === "off" ? { enabled: false } : {}) }));
    agents.push({ id: "fallback", kind: "echo", role: "worker" });
    const h = harness(agents, { clone: true, busy: ["busy"], unavailable: ["missing"] });
    await h.cap("source");
    expect(await relay.route("source")).toBe("fallback");
    expect(h.clones).toEqual([]);
  });

  it("leaves work on the original account when relay is disabled", async () => {
    const a = addAccount({ kind: "codex", label: "personal" });
    addAccount({ kind: "codex", label: "work" });
    const h = harness([cfg("c", a.configDir)], { clone: true, auto: false });
    await h.cap("c");
    expect(await relay.route("c")).toBe("c");
    expect(h.clones).toEqual([]);
  });
});

it("keeps usage-limit readings separate by account while sharing them between sibling instances", () => {
  const a = addAccount({ kind: "codex", label: "personal" });
  const b = addAccount({ kind: "codex", label: "work" });
  const agents = [cfg("a", a.configDir), cfg("sibling", a.configDir), cfg("b", b.configDir)];
  const usage = new NativeUsage(id => accountKey(agents.find(a => a.id === id)!));
  for (const [agentId, usedPercent] of [["a", 100], ["b", 10]] as const) usage.observe({ kind: "status", agentId, ts: 123,
    payload: { state: "usage_limits", provider: "codex", windows: [{ id: "primary", usedPercent }] } });
  expect(usage.limitsFor("codex", "a")?.windows[0]?.usedPercent).toBe(100);
  expect(usage.limitsFor("codex", "sibling")).toEqual(usage.limitsFor("codex", "a"));
  expect(usage.limitsFor("codex", "b")?.windows[0]?.usedPercent).toBe(10);
});
