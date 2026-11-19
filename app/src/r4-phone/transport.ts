import type { Creds } from "../api";
interface Connection {
  routeFor(creds: Creds): Promise<string>;
  sawDirect(creds: Creds): void;
  directFailed(creds: Creds): Promise<string>;
  relayClient(): Promise<{ request(method: string, path: string, options: { auth: string; body?: unknown; timeoutMs?: number }): Promise<{ status: number; body: unknown }> }>;
}
/** A background request must never bind or reset the foreground chat's connection. */
export function pairedApi(create: () => Connection, settle: <T>(creds: Creds, status: number, body: Record<string, unknown>) => Promise<T>) {
  const connections = new Map<string, Connection>();
  return async function request<T>(creds: Creds, path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
    const key = JSON.stringify([creds.url, creds.token, creds.relay]);
    let connection = connections.get(key);
    if (!connection) { connection = create(); connections.set(key, connection); }
    const manager = connection;
    const relay = async () => {
      const client = await manager.relayClient();
      const result = await client.request(init?.method ?? "GET", path, { auth: `Bearer ${creds.token}`, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}), timeoutMs });
      return settle<T>(creds, result.status, result.body as Record<string, unknown>);
    };
    if (creds.relay && await manager.routeFor(creds) === "cloud") return relay();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try { response = await fetch(creds.url + path, { ...init, signal: controller.signal, headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json", ...init?.headers } }); }
      catch (e) { if (creds.relay && await manager.directFailed(creds) === "cloud") return relay(); throw e; }
      manager.sawDirect(creds);
      const result = await response.json() as Record<string, unknown>;
      return settle<T>(creds, response.status, result);
    } finally { clearTimeout(timer); }
  };
}
