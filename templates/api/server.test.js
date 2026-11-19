import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { handler } from "./server.js";
test("health and unknown routes", async () => {
  const server = createServer(handler);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await (await fetch(base + "/health")).json(), { ok: true });
    assert.equal((await fetch(base + "/missing")).status, 404);
  } finally { await new Promise(r => server.close(r)); }
});
