/**
 * `loom hub` — a self-hosted Team Hub with no Supabase (D1).
 *
 * The same rules as the hosted hub, because it runs the reference
 * implementation (core/team-hub.ts#MemoryHub) behind HTTP + WebSocket:
 *
 *   POST /hub/signin            {github, name?, secret?} → {token, user}
 *   POST /hub/rpc/:method       bearer token, body {args: [...]} → {result} | {error}
 *   WS   /hub/subscribe?team=   bearer via subprotocol "loom.hub.<token>" → HubEvent frames
 *   GET  /hub/health
 *
 * Sign-in trusts the claimed GitHub login, which is fine on a hub you run for
 * your own team — so it is gated: set a join secret (LOOM_HUB_SECRET / --secret)
 * and every sign-in must present it. The hosted hub uses real GitHub OAuth.
 * State is in memory; `--data <file>` persistence is Phase 2 — a restart today
 * means members re-join, which the daemons' Team Link does on its own.
 */

import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";

import { HubError, MemoryHub, type HubClient } from "../core/team-hub.js";

const METHODS = new Set<keyof HubClient>([
  "me",
  "createTeam",
  "teams",
  "registerDevice",
  "createInvite",
  "redeemInvite",
  "members",
  "removeMember",
  "putKeyEnvelopes",
  "keyEnvelopes",
  "shareRepo",
  "repos",
  "heartbeat",
  "clearPresence",
  "presence",
  "appendFeed",
  "feed",
  "claimLease",
  "extendLease",
  "renewLeases",
  "setRunLeaseState",
  "releaseLeases",
  "leases",
  "publishMemory",
  "updateTeamMemory",
  "forgetTeamMemory",
  "resolveMemories",
  "teamMemories",
  "registerRunner",
  "runners",
  "revokeDevice",
  "createJob",
  "claimJob",
  "heartbeatJob",
  "finishJob",
  "cancelJob",
  "jobs",
]);

export interface HubServerOptions {
  port?: number;
  host?: string;
  /** Required on sign-in when set. Leave unset only for tests / a trusted LAN. */
  secret?: string;
  hub?: MemoryHub;
}

export async function startHubServer(opts: HubServerOptions = {}): Promise<{
  url: string;
  hub: MemoryHub;
  close: () => Promise<void>;
}> {
  const hub = opts.hub ?? new MemoryHub();
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/hub/health", (_req, res) => void res.json({ ok: true, name: "loom-hub", version: 1 }));

  app.post("/hub/signin", (req, res) => {
    const b = (req.body ?? {}) as { github?: string; name?: string; secret?: string };
    if (opts.secret) {
      const given = Buffer.from(String(b.secret ?? ""));
      const want = Buffer.from(opts.secret);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        return void res.status(403).json({ error: "this hub needs its join secret" });
      }
    }
    try {
      res.json(hub.signIn(String(b.github ?? ""), b.name));
    } catch (err) {
      res.status(err instanceof HubError ? err.status : 400).json({ error: (err as Error).message });
    }
  });

  app.post("/hub/rpc/:method", (req, res) => {
    const method = String(req.params.method) as keyof HubClient;
    if (!METHODS.has(method)) return void res.status(404).json({ error: `no hub method "${method}"` });
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    void (async () => {
      try {
        const client = hub.client(token);
        const args = Array.isArray((req.body as { args?: unknown[] })?.args) ? (req.body as { args: unknown[] }).args : [];
        const fn = client[method] as unknown as (...a: unknown[]) => Promise<unknown>;
        const result = await fn.apply(client, args);
        res.json({ result: result ?? null });
      } catch (err) {
        res.status(err instanceof HubError ? err.status : 400).json({ error: (err as Error).message });
      }
    })();
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/hub/subscribe" });
  wss.on("connection", (ws: WebSocket, req) => {
    const proto = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .find((s) => s.startsWith("loom.hub."));
    const token = proto?.slice("loom.hub.".length) ?? "";
    const team = new URL(req.url ?? "", "http://x").searchParams.get("team") ?? "";
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      try {
        unsubscribe = await hub.client(token).subscribe(team, (e) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
        });
        ws.send(JSON.stringify({ type: "ready", teamId: team }));
      } catch (err) {
        ws.close(err instanceof HubError && err.status === 401 ? 4401 : 4403, (err as Error).message.slice(0, 100));
      }
    })();
    ws.on("close", () => unsubscribe?.());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 7430, opts.host ?? "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 7430;
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    hub,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
