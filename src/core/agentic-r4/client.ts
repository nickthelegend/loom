import { DaemonError } from "../../daemon/client.js";

/** A literal JSON request for scripts and extension modules; credentials stay on the daemon origin. */
export async function daemonApi<T>(baseUrl: string, token: string, method: string, route: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  if (!route.startsWith("/") || route.startsWith("//") || /[\\#]/.test(route)) throw new Error("path must be relative to the daemon");
  const response = await fetch(baseUrl + route, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
  const data = await response.json().catch(() => ({}));
  const fields = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  if (!response.ok) throw new DaemonError(String(fields.message ?? fields.error ?? `${method} ${route} → ${response.status}`), response.status, data as Record<string, unknown>);
  return data as T;
}
