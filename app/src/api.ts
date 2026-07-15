/**
 * Thin client over the loom daemon API (same endpoints as the CLI/web app).
 * Credentials (daemon URL + client token) live in the device keychain.
 */

import * as SecureStore from "expo-secure-store";

export interface Creds {
  url: string; // e.g. http://100.x.y.z:7420
  token: string;
}

export interface AgentStatus {
  id: string;
  kind: string;
  role: string;
  tier: "adapter" | "bridge";
  available: boolean;
  busy: boolean;
  holdsBaton: boolean;
}

export interface RouteState {
  name?: string;
  status: string;
  steps: string[];
  current: number;
  maxHops?: number;
  mode?: string;
  reason?: string;
  pendingQuestion?: string;
  costUsd?: number;
}

export interface Project {
  id: string;
  name: string;
  holder: string | null;
  agents: AgentStatus[];
  needsInput: boolean;
  route?: RouteState | null;
  routeNames?: string[];
  costUsd?: number;
}

export interface LoomEvent {
  id: number;
  ts: number;
  kind: string;
  agentId?: string;
  payload: Record<string, unknown>;
}

export interface WorkingTree {
  git: boolean;
  branch?: string;
  files: Array<{ status: string; path: string }>;
  patch: string;
  truncated: boolean;
}

const URL_KEY = "loomUrl";
const TOKEN_KEY = "loomToken";

export async function loadCreds(): Promise<Creds | null> {
  const [url, token] = await Promise.all([
    SecureStore.getItemAsync(URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  return url && token ? { url, token } : null;
}

export async function saveCreds(creds: Creds): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(URL_KEY, creds.url),
    SecureStore.setItemAsync(TOKEN_KEY, creds.token),
  ]);
}

export async function clearCreds(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(URL_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY),
  ]);
}

/** Exchange a single-use pairing token (from `loom pair`) for a client token. */
export async function claim(url: string, pairToken: string): Promise<Creds> {
  const base = url.replace(/\/+$/, "").replace(/\/app.*$/, "");
  const res = await fetch(`${base}/api/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: pairToken, name: "loom-app" }),
  });
  const json = (await res.json()) as { clientToken?: string; error?: string };
  if (!res.ok || !json.clientToken) throw new Error(json.error ?? "pairing failed");
  return { url: base, token: json.clientToken };
}

/**
 * Registered by App.tsx: called when any request 401s (token revoked or
 * expired) so the app can clear creds and return to the pair screen — the
 * same behavior the web app gets from logout().
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export async function api<T>(creds: Creds, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${creds.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) {
    await clearCreds();
    onUnauthorized?.();
    throw new Error("unauthorized — pair again");
  }
  if (!res.ok) throw new Error(String(json.message ?? json.error ?? `HTTP ${res.status}`));
  return json as T;
}

export const getProjects = (c: Creds) => api<{ projects: Project[] }>(c, "/api/projects");
export const getProject = (c: Creds, id: string) =>
  api<{ project: Project }>(c, `/api/projects/${id}`);
export const getEvents = (c: Creds, id: string, limit = 60) =>
  api<{ events: LoomEvent[] }>(c, `/api/projects/${id}/events?limit=${limit}`);
export const getTree = (c: Creds, id: string) =>
  api<{ tree: WorkingTree }>(c, `/api/projects/${id}/tree`);
export const sendMessage = (c: Creds, id: string, text: string, agentId?: string) =>
  api(c, `/api/projects/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, ...(agentId ? { agentId } : {}) }),
  });
export const handoff = (c: Creds, id: string, to: string) =>
  api(c, `/api/projects/${id}/handoff`, { method: "POST", body: JSON.stringify({ to }) });
export const interrupt = (c: Creds, id: string) =>
  api(c, `/api/projects/${id}/interrupt`, { method: "POST", body: "{}" });
export const startRoute = (c: Creds, id: string, task: string, spec: string) =>
  api(c, `/api/projects/${id}/route`, { method: "POST", body: JSON.stringify({ task, spec }) });
export const abortRoute = (c: Creds, id: string) =>
  api(c, `/api/projects/${id}/route`, { method: "DELETE" });

export function wsUrl(creds: Creds, projectId: string): string {
  const proto = creds.url.startsWith("https") ? "wss" : "ws";
  const host = creds.url.replace(/^https?:\/\//, "");
  return `${proto}://${host}/ws?token=${encodeURIComponent(creds.token)}&project=${encodeURIComponent(projectId)}`;
}
