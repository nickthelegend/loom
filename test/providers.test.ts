/**
 * Where a model agent's key lives, and what Loom will say about it.
 *
 * One rule runs through all of this: the key is never in the repository, never
 * in a response, never in a log. What a person gets back is whether a provider
 * is usable and four characters to tell two keys apart.
 */

import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  BUILTIN_PROVIDERS,
  chatUrl,
  explainStatus,
  forgetProvider,
  isExhausted,
  listProviders,
  maskKey,
  modelsUrl,
  providersFile,
  requestHeaders,
  resolveProvider,
  setProvider,
} from "../src/core/providers.js";
import { tmpDir } from "./helpers.js";

beforeEach(() => {
  process.env.LOOM_HOME = tmpDir("home-prov");
});

describe("knowing a provider", () => {
  it("knows the usual ones without being told", () => {
    const ids = BUILTIN_PROVIDERS.map((p) => p.id);
    expect(ids).toContain("openrouter");
    expect(ids).toContain("agentrouter");
    expect(resolveProvider("openrouter", {})!.baseUrl).toBe("https://openrouter.ai/api");
    expect(resolveProvider("nowhere", {})).toBeNull();
  });

  it("builds the two URLs the protocol needs", () => {
    const p = resolveProvider("openrouter", {})!;
    expect(chatUrl(p)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(modelsUrl(p)).toBe("https://openrouter.ai/api/v1/models");
    // A base URL given with a trailing slash mustn't produce a double one.
    setProvider("slashy", { baseUrl: "http://example.com/api/" });
    expect(chatUrl(resolveProvider("slashy", {})!)).toBe("http://example.com/api/v1/chat/completions");
  });

  it("takes a custom provider on nothing but a base URL", () => {
    setProvider("mine", { baseUrl: "http://127.0.0.1:1234", key: "k", label: "Mine" });
    const p = resolveProvider("mine", {})!;
    expect(p.label).toBe("Mine");
    expect(p.key).toBe("k");
    // …but won't invent one out of thin air.
    expect(() => setProvider("ghost", { key: "k" })).toThrow(/isn't a provider Loom knows/);
  });
});

describe("the key", () => {
  it("comes from the environment first, then the file", () => {
    setProvider("openrouter", { key: "file-key" });
    expect(resolveProvider("openrouter", {})!.key).toBe("file-key");
    expect(resolveProvider("openrouter", { OPENROUTER_API_KEY: "env-key" })!.key).toBe("env-key");
  });

  it("is stored where only you can read it", () => {
    setProvider("openrouter", { key: "secret-value" });
    const mode = fs.statSync(providersFile()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("is never in what gets shown", () => {
    setProvider("openrouter", { key: "sk-abcdefghijklmnop" });
    const shown = listProviders({});
    const row = shown.find((p) => p.id === "openrouter")!;
    expect(row.configured).toBe(true);
    expect(row.hint).toBe("…mnop");
    expect(row.source).toBe("file");
    expect(JSON.stringify(shown)).not.toContain("sk-abcdefghijklmnop");
    expect(maskKey("sk-abcdefghijklmnop")).toBe("…mnop");
    expect(maskKey(null)).toBe("");
  });

  it("says where it came from, so a stale one is explainable", () => {
    setProvider("openrouter", { key: "file-key" });
    expect(listProviders({ OPENROUTER_API_KEY: "env" }).find((p) => p.id === "openrouter")!.source).toBe("env");
  });

  it("can be forgotten", () => {
    setProvider("openrouter", { key: "k" });
    expect(forgetProvider("openrouter")).toBe(true);
    expect(resolveProvider("openrouter", {})!.key).toBeNull();
    expect(forgetProvider("openrouter")).toBe(false);
  });

  it("isn't sent at all when there isn't one", () => {
    // `Authorization: Bearer null` is a 401 that reads like a bad key rather
    // than like no key, and a local server doesn't want a header anyway.
    const headers = requestHeaders(resolveProvider("ollama", {})!);
    expect(headers.authorization).toBeUndefined();
    setProvider("ollama", { key: "k" });
    expect(requestHeaders(resolveProvider("ollama", {})!).authorization).toBe("Bearer k");
  });

  it("carries the headers a provider needs, and lets you add your own", () => {
    expect(requestHeaders(resolveProvider("openrouter", {})!)["X-Title"]).toBe("Loom");
    setProvider("openrouter", { headers: { "user-agent": "something-they-accept" } });
    expect(requestHeaders(resolveProvider("openrouter", {})!)["user-agent"]).toBe("something-they-accept");
  });
});

describe("free", () => {
  it("knows each provider's own convention, and guesses at none", () => {
    expect(resolveProvider("openrouter", {})!.free("meta/llama-3:free")).toBe(true);
    expect(resolveProvider("openrouter", {})!.free("openai/gpt-4o")).toBe(false);
    expect(resolveProvider("agentrouter", {})!.free("anything")).toBe(true);
    expect(resolveProvider("openai", {})!.free("gpt-4o")).toBe(false);
  });
});

describe("what a refusal means", () => {
  const p = resolveProvider("agentrouter", {})!;

  it("separates a rejected key from a rejected client", () => {
    const client = explainStatus(401, '{"type":"unauthorized_client_error"}', p);
    expect(client).toMatch(/refused Loom as a client, not your key/);
    expect(explainStatus(401, "bad key", p)).toMatch(/rejected the key/);
  });

  it("separates an empty pool from a wrong model name", () => {
    expect(explainStatus(402, "Budget pool quota has been exhausted", p)).toMatch(/no quota left/);
    expect(explainStatus(503, "no available channel", p)).toMatch(/no channel/);
    // Only one of those is worth trying a different model for.
    expect(isExhausted(402)).toBe(true);
    expect(isExhausted(429)).toBe(true);
    expect(isExhausted(503)).toBe(false);
    expect(isExhausted(401)).toBe(false);
  });
});
