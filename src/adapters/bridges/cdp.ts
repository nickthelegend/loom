/**
 * A small Chrome DevTools Protocol client — enough to drive an Electron agent
 * app, and nothing more.
 *
 * Antigravity and Kiro are Electron apps. Launched with a debugging port they
 * speak CDP, which is the only interface either of them offers: no API, no
 * headless mode, no way in but the one the browser gives us. The approach is
 * the same one krishnakanthb13/antigravity_phone_chat uses to put Antigravity
 * on a phone — connect over CDP, read the DOM, drive the real widgets.
 *
 * Typing goes through Input.insertText rather than assigning to `.value`.
 * These UIs are React and Monaco: an assignment updates the DOM and the
 * framework never hears about it, so the app still believes its composer is
 * empty and sends nothing. insertText enters through the same pipeline a
 * keyboard does, so the app cannot tell the difference.
 */

import WebSocket from "ws";
import { fetchJson } from "../base.js";

export interface CdpTarget {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/** Is anything listening for CDP at host:port? */
export async function cdpUp(endpoint: string, timeoutMs = 2000): Promise<boolean> {
  try {
    await fetchJson(`${endpoint}/json/version`, undefined, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export async function cdpTargets(endpoint: string, timeoutMs = 3000): Promise<CdpTarget[]> {
  return fetchJson<CdpTarget[]>(`${endpoint}/json`, undefined, timeoutMs).catch(() => []);
}

/**
 * The window that holds the app, not its splash screen.
 *
 * Antigravity shows a `data:` URL loader for the first seconds after launch and
 * the workbench arrives later on a different target; picking the first page
 * gets you an animated ellipsis with no chat in it.
 */
export function workbenchTarget(targets: CdpTarget[]): CdpTarget | null {
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  return pages.find((t) => !String(t.url ?? "").startsWith("data:")) ?? pages[0] ?? null;
}

/** One CDP session against one target. */
export class CdpSession {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(private readonly url: string) {}

  static async open(target: CdpTarget, timeoutMs = 5000): Promise<CdpSession> {
    if (!target.webSocketDebuggerUrl) throw new Error("target has no debugger url");
    const session = new CdpSession(target.webSocketDebuggerUrl);
    await session.connect(timeoutMs);
    return session;
  }

  private connect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024 });
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("timed out connecting to the app's debugger"));
      }, timeoutMs);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on("message", (raw) => this.onMessage(String(raw)));
      ws.on("close", () => {
        // Nothing else is coming; don't leave callers hanging forever.
        for (const [, p] of this.pending) p.reject(new Error("debugger connection closed"));
        this.pending.clear();
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return; // an event, not our reply
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "cdp error"));
    else p.resolve(msg.result);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("debugger not connected"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page and return it by value. */
  async evaluate<T>(expression: string, timeoutMs = 15_000): Promise<T> {
    const res = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
      throw new Error(`page threw: ${String(detail).slice(0, 300)}`);
    }
    return res.result?.value as T;
  }

  /** Type text into whatever currently has focus, the way a keyboard would. */
  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async pressEnter(): Promise<void> {
    for (const type of ["keyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: type === "keyDown" ? "\r" : undefined,
      });
    }
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
    } catch {
      /* already gone */
    }
  }
}
