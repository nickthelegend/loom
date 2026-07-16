/**
 * Driving a GUI agent's chat box over CDP.
 *
 * Shared by the Antigravity and Kiro bridges, because the problem is identical:
 * an Electron app with a chat panel, no API, and a DOM we can reach.
 *
 * ## Why this refuses to guess
 *
 * Both apps are VS Code-family, and Monaco — the code editor holding YOUR
 * SOURCE FILE — is itself a `contenteditable`. A cheerful "find the editable
 * box" heuristic will eventually find that one, and then Loom types your prompt
 * into your code and presses Enter. There is no error message that makes up for
 * that.
 *
 * So the search is deliberately narrow, and refuses when it isn't sure:
 *
 *   - anything inside .monaco-editor, .editor-instance or [role="code"] is
 *     never a candidate, full stop;
 *   - a candidate must look like a chat box — a placeholder or aria-label that
 *     says ask/message/chat/prompt/plan/type;
 *   - if nothing matches, or several do, it fails and tells you to name the
 *     selector yourself.
 *
 * Refusing to send is a bad outcome. Sending into the wrong box is a worse one.
 *
 * ## What is and isn't verified
 *
 * The mechanism — connect, find, focus, type, submit, read back — is tested
 * against a real Chromium page in test/gui-chat.test.ts.
 *
 * The selectors inside Antigravity and Kiro are NOT verified. Neither app will
 * show a composer until you sign in (Antigravity) or open the chat panel
 * (Kiro), so there was nothing to read them from. That's why discovery is a
 * heuristic with an override rather than a hardcoded string copied off a
 * screenshot: when it misses, `options.selectors.composer` is the fix, and the
 * error says so.
 */

import { CdpSession, cdpTargets, cdpUp, workbenchTarget } from "./cdp.js";

export interface GuiChatSelectors {
  /** CSS selector for the chat input. Set this when discovery can't. */
  composer?: string;
  /** CSS selector for the submit button. Falls back to pressing Enter. */
  send?: string;
  /** CSS selector for the transcript container, to read replies from. */
  transcript?: string;
}

/** Places a prompt must never be typed. */
const FORBIDDEN_ANCESTORS = [".monaco-editor", ".editor-instance", '[role="code"]'];

/** What a chat box tends to call itself. */
const CHATTY = /ask|message|chat|prompt|plan|type .*here|what.*build|reply/i;

/**
 * Find the composer, in the page.
 *
 * Returns a marker attribute rather than an element handle: the page is React
 * and re-renders between calls, so a handle goes stale while an attribute we
 * stamped ourselves survives.
 */
const DISCOVER = (explicit: string | undefined, forbidden: string[], chatty: string): string => `
(() => {
  const MARK = "data-loom-composer";
  const forbidden = ${JSON.stringify(forbidden)};
  const chatty = new RegExp(${JSON.stringify(chatty)}, "i");
  const visible = (el) => !!(el.offsetParent || el.getClientRects().length);
  const inForbidden = (el) => forbidden.some((sel) => el.closest(sel));

  const explicit = ${explicit ? JSON.stringify(explicit) : "null"};
  if (explicit) {
    const el = document.querySelector(explicit);
    if (!el) return { ok: false, reason: "no element matches the selector you set: " + explicit };
    if (inForbidden(el)) return { ok: false, reason: "that selector points inside the code editor" };
    el.setAttribute(MARK, "1");
    return { ok: true, how: "selector" };
  }

  const all = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')];
  const candidates = all.filter((el) => visible(el) && !inForbidden(el));
  if (!candidates.length) {
    return {
      ok: false,
      reason: all.length
        ? "the only editable areas are inside the code editor — is the chat panel open?"
        : "no chat box on screen — sign in and open a chat",
    };
  }
  const labelled = candidates.filter((el) => {
    const hay = [
      el.getAttribute("placeholder"),
      el.getAttribute("data-placeholder"),
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
    ].filter(Boolean).join(" ");
    return chatty.test(hay);
  });
  const pick = labelled.length === 1 ? labelled[0] : null;
  if (!pick) {
    return {
      ok: false,
      reason: labelled.length
        ? "found " + labelled.length + " things that look like a chat box; name one with options.selectors.composer"
        : "found " + candidates.length + " editable areas, none labelled like a chat box; name one with options.selectors.composer",
    };
  }
  pick.setAttribute(MARK, "1");
  return { ok: true, how: "heuristic" };
})()`;

/** Focus the marked composer and clear whatever was in it. */
const FOCUS = `
(() => {
  const el = document.querySelector('[data-loom-composer]');
  if (!el) return { ok: false, reason: "composer vanished" };
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (document.activeElement !== el && el.querySelector('[contenteditable]')) {
    el.querySelector('[contenteditable]').focus();
  }
  // Clear via the app's own pipeline: select-all, and let insertText replace.
  document.execCommand && document.execCommand("selectAll", false, undefined);
  return { ok: true };
})()`;

const readTranscript = (selector: string | undefined): string => `
(() => {
  const sel = ${selector ? JSON.stringify(selector) : "null"};
  const el = sel ? document.querySelector(sel) : null;
  const root = el || document.body;
  return (root.innerText || "").slice(-20000);
})()`;

const clickSend = (selector: string | undefined): string => `
(() => {
  const sel = ${selector ? JSON.stringify(selector) : "null"};
  if (sel) {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, reason: "no send button matches " + sel };
    el.click();
    return { ok: true };
  }
  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(
    (b) => !!(b.offsetParent || b.getClientRects().length) && !b.disabled,
  );
  const send = buttons.find((b) => /^(send|submit)$/i.test((b.getAttribute("aria-label") || b.innerText || "").trim()));
  if (!send) return { ok: false, reason: "no send button found" };
  send.click();
  return { ok: true };
})()`;

export interface GuiChatOptions {
  host?: string;
  debugPort?: number;
  selectors?: GuiChatSelectors;
  /** How long a reply may take before we stop waiting. */
  replyTimeoutMs?: number;
  /** Quiet time that means "it stopped typing". */
  settleMs?: number;
}

export class GuiChatDriver {
  constructor(
    private readonly appName: string,
    private readonly options: GuiChatOptions,
  ) {}

  get endpoint(): string {
    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.debugPort ?? 9222;
    return `http://${host}:${port}`;
  }

  get launchHint(): string {
    return `launch ${this.appName} with --remote-debugging-port=${this.options.debugPort ?? 9222}`;
  }

  reachable(): Promise<boolean> {
    return cdpUp(this.endpoint);
  }

  private async session(): Promise<CdpSession> {
    const targets = await cdpTargets(this.endpoint);
    const target = workbenchTarget(targets);
    if (!target) throw new Error(`${this.appName} is running but has no window to talk to`);
    return CdpSession.open(target);
  }

  /**
   * Can we actually drive it right now? Reachable is not enough: a signed-out
   * Antigravity answers CDP happily and has no chat in it.
   */
  async driveable(): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.reachable())) return { ok: false, reason: this.launchHint };
    let session: CdpSession | null = null;
    try {
      session = await this.session();
      const found = await session.evaluate<{ ok: boolean; reason?: string }>(
        DISCOVER(this.options.selectors?.composer, FORBIDDEN_ANCESTORS, CHATTY.source),
      );
      return found.ok ? { ok: true } : { ok: false, reason: found.reason };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      session?.close();
    }
  }

  /**
   * Type a prompt into the app and submit it, then wait for the transcript to
   * stop growing and return what was added.
   *
   * The reply is a diff of the panel's text, not a structured message: these
   * apps don't hand out their conversation, they render it. It's the same trade
   * the phone-chat project makes — mirror what's on screen, don't pretend to
   * have the model's actual response object.
   */
  async ask(text: string, onProgress?: (partial: string) => void): Promise<string> {
    const session = await this.session();
    try {
      const found = await session.evaluate<{ ok: boolean; reason?: string }>(
        DISCOVER(this.options.selectors?.composer, FORBIDDEN_ANCESTORS, CHATTY.source),
      );
      if (!found.ok) throw new Error(`can't reach ${this.appName}'s chat box: ${found.reason}`);

      const before = await session.evaluate<string>(readTranscript(this.options.selectors?.transcript));

      const focused = await session.evaluate<{ ok: boolean; reason?: string }>(FOCUS);
      if (!focused.ok) throw new Error(`can't focus ${this.appName}'s chat box: ${focused.reason}`);

      await session.insertText(text);

      const clicked = await session.evaluate<{ ok: boolean; reason?: string }>(
        clickSend(this.options.selectors?.send),
      );
      // No send button is normal — most of these submit on Enter.
      if (!clicked.ok) await session.pressEnter();

      return await this.waitForReply(session, before, onProgress);
    } finally {
      session.close();
    }
  }

  /** Poll until the transcript stops changing, or we run out of patience. */
  private async waitForReply(
    session: CdpSession,
    before: string,
    onProgress?: (partial: string) => void,
  ): Promise<string> {
    const timeout = this.options.replyTimeoutMs ?? 300_000;
    const settle = this.options.settleMs ?? 2500;
    const deadline = Date.now() + timeout;
    let last = before;
    let lastChange = Date.now();

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      let now: string;
      try {
        now = await session.evaluate<string>(readTranscript(this.options.selectors?.transcript));
      } catch {
        break; // the window went away mid-answer
      }
      if (now !== last) {
        last = now;
        lastChange = Date.now();
        onProgress?.(delta(before, now));
      } else if (last !== before && Date.now() - lastChange > settle) {
        return delta(before, last);
      }
    }
    const out = delta(before, last);
    if (out) return out;
    throw new Error(`${this.appName} didn't answer within ${Math.round(timeout / 1000)}s`);
  }
}

/**
 * What the panel gained.
 *
 * Not a real diff: the transcript is a rendered panel, and it scrolls, collapses
 * and reflows. When `after` simply grew, the tail is the new part; when it
 * changed shape, we can only hand back what's there now.
 */
export function delta(before: string, after: string): string {
  if (after.startsWith(before)) return after.slice(before.length).trim();
  // Fall back to the longest common prefix, which handles a scrolled-off head.
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  return after.slice(i).trim();
}
