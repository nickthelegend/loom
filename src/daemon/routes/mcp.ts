import type { Express } from "express";
import { DaemonClient } from "../client.js";
import { bearerToken } from "../auth.js";
import { MCP_PROTOCOL, mcpRequest } from "../../core/mcp-server.js";

/** Stateless Streamable HTTP: JSON responses, 202 for notifications, no GET stream. */
export function registerMcpRoutes(app: Express, address: () => { host: string; port: number }): void {
  app.all("/mcp", async (req, res) => {
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) return void res.status(403).json({ error: "origin refused" });
      } catch { return void res.status(403).json({ error: "origin refused" }); }
    }
    const version = req.headers["mcp-protocol-version"];
    if (version && version !== MCP_PROTOCOL && version !== "2025-03-26") return void res.status(400).json({ error: "unsupported MCP protocol version" });
    if (req.method !== "POST") return void res.setHeader("Allow", "POST").status(405).end();
    const accept = req.headers.accept ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return void res.status(406).json({ error: "accept application/json and text/event-stream" });
    if (!req.is("application/json")) return void res.status(415).json({ error: "expected application/json" });
    // Forward the original credential. Substituting admin here would bypass project scope.
    const client = new DaemonClient({ clients: [], ...address(), adminToken: bearerToken(req.headers.authorization)! });
    const reply = await mcpRequest(client, req.body);
    if (reply === null) res.status(202).end();
    else res.json(reply);
  });
}
