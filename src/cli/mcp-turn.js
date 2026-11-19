// @ts-check
/** Transport-only entry point for a turn's MCP child. Do not import the CLI,
 * DaemonClient or tool implementations here: the listening daemon owns them.
 * Its authentication wall checks the original credential on every request.
 */
import { createInterface } from "node:readline";

const api = process.env.LOOM_MCP_API, token = process.env.LOOM_MCP_TOKEN;
if (!api || !token) throw new Error("LOOM_MCP_API and LOOM_MCP_TOKEN must be supplied together");
const url = new URL(api);
if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
  throw new Error("LOOM_MCP_API must be a daemon HTTP origin");

const instructions = `Use project ${process.env.LOOM_PROJECT_ID ?? "from loom_projects"}.` +
  (process.env.LOOM_RUN_ID ? ` For loom_report use run ${process.env.LOOM_RUN_ID} and task ${process.env.LOOM_TASK_ID}.` : "");
/** @param {unknown} reply */
const write = (reply) => { process.stdout.write(JSON.stringify(reply) + "\n"); };
/** @param {string | number | null} id @param {number} code @param {string} message */
const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** @param {string} line */
async function forward(line) {
  let request;
  try {
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error("request too large");
    request = JSON.parse(line);
  } catch { write(error(null, -32700, "Parse error")); return; }
  const id = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : null;
  try {
    const response = await fetch(new URL("/mcp", url), {
      method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: line,
    });
    if (response.status === 202) return;
    const reply = /** @type {{ error?: string | { message?: string }; result?: Record<string, unknown> }} */ (await response.json());
    if (!response.ok) throw new Error(typeof reply.error === "string" ? reply.error : reply.error?.message ?? `MCP HTTP ${response.status}`);
    if (request?.method === "initialize" && reply.result) reply.result.instructions = instructions;
    write(reply);
  } catch (cause) {
    // Notifications never receive a reply, including when a turn has ended.
    if (id !== null) write(error(id, -32603, cause instanceof Error ? cause.message : String(cause)));
  }
}

/** @type {Set<Promise<void>>} */
const pending = new Set();
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const work = forward(line);
  pending.add(work);
  void work.finally(() => pending.delete(work));
}
// SDKs may close stdin immediately after their last request. Drain it before exit.
await Promise.all(pending);
