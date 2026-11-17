import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cheapestTitleModel, generateChatTitle, localChatTitle } from "../src/core/chat-titles.js";
import { ConversationStore } from "../src/core/conversations.js";
import { setProvider } from "../src/core/providers.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

beforeEach(() => {
  vi.stubEnv("LOOM_HOME", tmpDir("titles"));
  for (const key of Object.keys(process.env)) if (/_API_KEY$/.test(key)) vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("local chat titles", () => {
  it.each([
    ["Please can you help me fix the login redirect bug?", "Fix Login Redirect Bug"],
    ["I would like to add dark mode to the settings page", "Add Dark Mode Settings Page"],
    ["hey, could you please explain how database migrations work", "Explain How Database Migrations Work"],
    ["fix API errors", "Fix Api Errors"],
    ["Hello! Please help me", "New Chat Discussion"],
    ["", "New Chat Discussion"],
    ["🚀", "New Chat Discussion"],
    ["cache", "Cache Discussion Details"],
    ["fix bug", "Fix Bug Discussion"],
    ["更新 用户 登录 页面", "更新 用户 登录 页面"],
    ["Investigate https://example.com/token error handling now", "Investigate Error Handling Now"],
  ])("summarises %j", (input, expected) => expect(localChatTitle(input)).toBe(expected));

  it("bounds long messages and identifiers deterministically", () => {
    for (const input of ["x".repeat(100), "investigate extraordinarilycomplicated race conditions in authentication services", "word ".repeat(10000)]) {
      const title = localChatTitle(input);
      expect(title).toBe(localChatTitle(input));
      expect(title.length).toBeLessThanOrEqual(48);
      expect(title.split(" ").length).toBeGreaterThanOrEqual(3);
      expect(title.split(" ").length).toBeLessThanOrEqual(6);
    }
  });

  it("persists provenance and never overwrites explicit names, including Chat N", () => {
    const dir = makeProjectDir();
    const store = new ConversationStore(dir);
    const user = store.createChat("Chat 2");
    expect(store.renameChat(user.id, "Generated Chat Title", true)).toBeNull();
    const auto = store.createChat("");
    store.renameChat(auto.id, auto.title);
    expect(new ConversationStore(dir).hasDefaultTitle(auto.id)).toBe(false);
    expect(store.renameChat(auto.id, "Generated Chat Title", true)).toBeNull();
    const normal = store.createChat("");
    expect(store.renameChat(normal.id, "Fix Login Bug", true)?.titleSource).toBe("auto");
    expect(store.renameChat(normal.id, "Second Auto Title", true)).toBeNull();
    expect(store.renameChat("main", "Main New Name", true)).toBeNull();
  });
});

it("chooses free then the lowest known cost, never guessing unknown prices", () => {
  const models = [
    { id: "unknown", provider: "p", free: false },
    { id: "expensive", provider: "p", free: false, inputCost: 1, outputCost: 1 },
    { id: "cheap", provider: "p", free: false, inputCost: 0.1, outputCost: 0.1 },
  ];
  expect(cheapestTitleModel(models)?.id).toBe("cheap");
  expect(cheapestTitleModel([...models, { id: "free", provider: "p", free: true }])?.id).toBe("free");
  expect(cheapestTitleModel(models.slice(0, 1))).toBeUndefined();
});

it("uses real provider HTTP, caps generation at eight tokens, and falls back on bad replies and timeout", async () => {
  let response = "Fix Login Redirect";
  let hang = false;
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith("/ollama")) return res.end(JSON.stringify({ data: [] }));
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: [
        { id: "expensive", pricing: { prompt: "1", completion: "2" } },
        { id: "cheap", pricing: { prompt: "0.001", completion: "0.002" } },
      ] }));
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (hang) return;
    res.end(JSON.stringify({ choices: [{ message: { content: response } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    setProvider("ollama", { baseUrl: `http://127.0.0.1:${port}/ollama` });
    setProvider("title-test", { baseUrl: `http://127.0.0.1:${port}`, key: "test" });
    expect(await generateChatTitle("please fix login redirect", "local")).toBe("Fix Login Redirect");
    expect(requests).toHaveLength(0);
    expect(await generateChatTitle("please fix login redirect", "model")).toBe("Fix Login Redirect");
    expect(requests[0]).toMatchObject({ model: "cheap", max_tokens: 8, stream: false });
    response = "A reply that has far too many words to qualify as a title";
    expect(await generateChatTitle("fix login bug", "model")).toBe("Fix Login Bug");
    hang = true;
    const start = Date.now();
    expect(await generateChatTitle("fix login bug", "model")).toBe("Fix Login Bug");
    expect(Date.now() - start).toBeLessThan(6500);
    expect(fs.existsSync(path.join(process.env.LOOM_HOME!, "models-cache.json"))).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15000);
