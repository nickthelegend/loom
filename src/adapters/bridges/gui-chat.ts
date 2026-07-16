/**
 * Driving a GUI agent's chat box over CDP.
 *
 * Shared by the Antigravity and Kiro bridges, because the problem is identical:
 * an Electron app with a chat panel, no API, and a DOM we can reach.
 *
 * The approach — and most of the hard-won detail — comes from two projects that
 * do this for real every day: krishnakanthb13/antigravity_phone_chat for the
 * shape of the chat, yazanbaker94/AntiGravity-AutoAccept for how to attach.
 * Both MIT. Connect over CDP, find the composer inside the chat panel, type
 * through the browser's own input pipeline, click the app's own submit button.
 * Never touch the provider APIs, never lift a token: drive the app that's
 * already signed in, the way a person would.
 *
 * ## Why Input.insertText and not `el.textContent = …`
 *
 * Antigravity's composer is a Lexical editor; Kiro's is React. Both keep their
 * own model of the text and only update it when the browser tells them about an
 * edit. Assigning to the DOM changes what you see and nothing else — the app
 * still believes the box is empty and submits nothing.
 *
 * CDP's `Input.insertText` is what's used, and the choice was measured rather
 * than assumed. In a real Chromium:
 *
 *   document.execCommand("insertText")  → fires `input` only
 *   Input.insertText (CDP)              → fires `beforeinput` AND `input`
 *
 * `beforeinput` is the one an editor builds its model from, so execCommand is
 * the worse tool despite being the obvious one — it fills the box while leaving
 * the app convinced it's empty, which then looks like a send bug. It survives
 * only as a fallback, after synthesising the events by hand.
 *
 * ## Why it refuses
 *
 * Both apps are VS Code family, and Monaco — the editor holding YOUR SOURCE
 * FILE — is a `contenteditable`. A driver that hunts the document for something
 * editable will eventually find that one, type a prompt into your code and press
 * Enter. No error message repairs that afterwards.
 *
 * So the composer is only ever looked for *inside* the chat panel
 * (profiles.ts), never in the document at large; anything under `.monaco-editor`
 * is excluded even then; and no match, or an ambiguous one, is a refusal that
 * names the fix. Not sending is a bad outcome. Sending into the wrong box is a
 * worse one.
 */

import { CdpSession, cdpTargets, cdpUp, chatTargets } from "./cdp.js";
import { CHATTY, FORBIDDEN_ANCESTORS, GENERIC, profileFor, type AppProfile } from "./profiles.js";

export interface GuiChatSelectors {
  /** CSS selector for the chat input. Set this when discovery can't. */
  composer?: string;
  /** CSS selector for the submit button. Falls back to pressing Enter. */
  send?: string;
  /** CSS selector for the transcript container, to read replies from. */
  transcript?: string;
}

export interface GuiChatOptions {
  host?: string;
  debugPort?: number;
  selectors?: GuiChatSelectors;
  /** How long a reply may take before we stop waiting. */
  replyTimeoutMs?: number;
  /** Quiet time that means "it stopped typing". */
  settleMs?: number;
}

const MARK = "data-loom-composer";

/**
 * Every document this target can reach: its own, plus any same-origin child
 * frame's.
 *
 * Kiro is why. Its chat panel is a `vscode-webview` target whose top document
 * holds eight nodes and an iframe — VS Code nests the extension's real HTML one
 * frame deeper, and that inner frame is not a CDP target of its own. Searching
 * only the top document found nothing and reported "the chat panel has no input
 * in it", which was true of the document I was looking at and false about Kiro.
 *
 * Cross-origin frames throw on contentDocument; they're skipped rather than
 * fataled, because one unreachable ad frame shouldn't hide a chat box.
 */
const DOCS = `
  const docs = [document];
  for (const f of document.querySelectorAll("iframe, frame")) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) { /* cross-origin */ }
  }
  const findIn = (sel) => {
    for (const d of docs) {
      let el = null;
      try { el = d.querySelector(sel); } catch (e) {}
      if (el) return el;
    }
    return null;
  };
  const allIn = (sel) => {
    const out = [];
    for (const d of docs) {
      try { out.push(...d.querySelectorAll(sel)); } catch (e) {}
    }
    return out;
  };
`;

/**
 * Find the composer and stamp it.
 *
 * Returns a marker attribute rather than an element handle: the page is a live
 * React/Lexical tree that re-renders between calls, so a handle goes stale while
 * an attribute we wrote survives.
 */
function discoverExpr(p: AppProfile, explicit: string | undefined): string {
  return `(() => {
  ${DOCS}
  const MARK = ${JSON.stringify(MARK)};
  const forbidden = ${JSON.stringify(FORBIDDEN_ANCESTORS)};
  const vis = (el) => !!(el.offsetParent || el.getClientRects().length);
  const banned = (el) => forbidden.some((sel) => el.closest(sel));
  allIn('[' + MARK + ']').forEach((el) => el.removeAttribute(MARK));

  const explicit = ${explicit ? JSON.stringify(explicit) : "null"};
  if (explicit) {
    const el = findIn(explicit);
    if (!el) return { ok: false, reason: "nothing matches the selector you set: " + explicit };
    if (banned(el)) return { ok: false, reason: "that selector points inside the code editor" };
    el.setAttribute(MARK, "1");
    return { ok: true, how: "your selector" };
  }

  // The composer is only ever looked for inside the chat panel. This is what
  // keeps the source editor out of reach — it isn't in here.
  const roots = ${JSON.stringify(p.chatRoots)};
  let root = null;
  for (const sel of roots) {
    root = findIn(sel);
    if (root) break;
  }
  // No named panel anywhere? A webview whose whole document IS the chat has
  // nothing to scope to — fall back to its body, which is still not the
  // workbench and so still can't reach Monaco.
  if (!root && docs.length > 1) root = docs[docs.length - 1].body;
  if (!root) {
    return { ok: false, reason: ${JSON.stringify(`no chat panel in ${p.name} — sign in, and open a chat`)} };
  }

  ${p.signedOut ? `
  // A signed-out app is the cruellest failure here: the chat renders, the box
  // takes text, and the send button is disabled forever. Say so plainly.
  const panel = (root.innerText || "").replace(/\\s+/g, " ");
  if (new RegExp(${JSON.stringify(p.signedOut.source)}, "i").test(panel)) {
    return { ok: false, reason: ${JSON.stringify(`${p.name} is signed out — log in from its window, then try again`)} };
  }` : ""}

  const found = [...root.querySelectorAll(${JSON.stringify(p.composer)})].filter((el) => vis(el) && !banned(el));
  if (!found.length) {
    return { ok: false, reason: "the chat panel has no input in it — is a conversation open?" };
  }

  // Last visible wins: when a page has several, the live composer is the one at
  // the bottom of the panel. (antigravity_phone_chat takes .at(-1) too.)
  let pick = found.at(-1);

  // Generic profile only: with no real chat panel to scope to, the box has to
  // look like a chat box before we'll type in it.
  const generic = ${JSON.stringify(p.chatRoots)}.length === 1 && ${JSON.stringify(p.chatRoots[0])} === "body";
  if (generic) {
    const chatty = new RegExp(${JSON.stringify(CHATTY.source)}, "i");
    const labelled = found.filter((el) => chatty.test([
      el.getAttribute("placeholder"),
      el.getAttribute("data-placeholder"),
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
    ].filter(Boolean).join(" ")));
    if (labelled.length !== 1) {
      return {
        ok: false,
        reason: labelled.length
          ? labelled.length + " things look like a chat box; name one with options.selectors.composer"
          : found.length + " editable areas, none labelled like a chat box; name one with options.selectors.composer",
      };
    }
    pick = labelled[0];
  }

  pick.setAttribute(MARK, "1");
  return { ok: true, how: "profile" };
})()`;
}

/**
 * Focus the composer and select whatever is in it, so the next keystroke
 * replaces it.
 *
 * Selecting the node's *contents* rather than calling execCommand("selectAll")
 * is deliberate: selectAll acts on whatever the document considers selected,
 * and if that isn't scoped to the box it's scoped to the page. A range over the
 * editor's contents can only ever affect the editor. It doubles as the clear —
 * inserting replaces a selection, so there's nothing to delete first.
 */
function focusExpr(p: AppProfile): string {
  return `(() => {
  ${DOCS}
  const MARK = ${JSON.stringify(MARK)};
  const vis = (el) => !!(el && (el.offsetParent || el.getClientRects().length));

  ${p.busy ? `const busy = findIn(${JSON.stringify(p.busy)});
  if (vis(busy)) return { ok: false, reason: "busy" };` : ""}

  const editor = findIn('[' + MARK + ']');
  if (!editor) return { ok: false, reason: "the composer went away" };

  editor.scrollIntoView({ block: "center" });
  editor.focus();
  try {
    const range = document.createRange();
    range.selectNodeContents(editor);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {}

  // Hand back where it is, so a caller that finds focus didn't take can click
  // it like a person would.
  const r = editor.getBoundingClientRect();
  return {
    ok: true,
    focused: document.activeElement === editor || editor.contains(document.activeElement),
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
  };
})()`;
}

/**
 * Submit, having typed.
 *
 * Also the fallback path: if CDP's typing didn't land (the box is still empty),
 * try the page's own editing command, and failing that assign and synthesise
 * the events by hand. Each rung down is less like real typing and less likely
 * to convince a framework, which is why they're in this order.
 */
function submitExpr(p: AppProfile, text: string, sendSel: string | undefined): string {
  // JSON.stringify handles quotes, newlines, backslashes and unicode. This is a
  // string being pasted into a program being pasted into a browser; nothing else
  // is safe enough.
  const safe = JSON.stringify(text);
  // Deliberately NOT async, and with no requestAnimationFrame in it.
  //
  // This used to await two rAFs to let the framework commit the edit before
  // clicking submit. rAF does not fire in a window that is occluded or
  // backgrounded — so against a real Antigravity sitting behind other windows
  // the promise never settled and Runtime.evaluate hung until it timed out.
  // Which is the whole use case: the app is in the background and you're on
  // your phone. The settle wait happens on the Node side now, where a timer is
  // a timer.
  return `(() => {
  ${DOCS}
  const MARK = ${JSON.stringify(MARK)};
  const editor = findIn('[' + MARK + ']');
  if (!editor) return { ok: false, reason: "the composer went away" };
  const text = ${safe};

  // If the typing didn't land, synthesise the same events by hand — including
  // beforeinput, which is the one that matters. execCommand("insertText") is
  // deliberately NOT the fallback: measured here, it fires only \`input\`, so it
  // fills the box while leaving a beforeinput-driven editor (Lexical, and this
  // is what Antigravity uses) still believing it's empty. That's worse than
  // failing, because the box then LOOKS full and every check downstream passes
  // while the send button quietly does nothing.
  let how = "typed";
  if (!(editor.innerText || editor.value || "").trim()) {
    how = "synthesised";
    if ("value" in editor) editor.value = text; else editor.textContent = text;
    editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text }));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  const explicit = ${sendSel ? JSON.stringify(sendSel) : "null"};
  const candidates = explicit ? [explicit] : ${JSON.stringify(p.send)};
  let sawDisabled = false;
  for (const sel of candidates) {
    const el = findIn(sel);
    if (!el) continue;
    const btn = el.closest("button") || (el.tagName === "BUTTON" ? el : null) || el;
    if (btn.disabled) { sawDisabled = true; continue; }
    btn.click();
    return { ok: true, how: how + " → clicked " + sel };
  }

  // The app's own send button, disabled with text in the box, is the app
  // telling us it won't send — a dead account, a missing model, a turn already
  // running. Pressing Enter at that point pretends we didn't hear.
  if (sawDisabled) {
    return { ok: false, reason: "the send button is disabled — is it signed in, with a model selected?" };
  }

  // Most of them submit on Enter anyway.
  editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
  editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
  return { ok: true, how: how + " → enter" };
})()`;
}

/**
 * Read the conversation, minus the box you type into.
 *
 * The composer lives *inside* the transcript container in Antigravity
 * (`#conversation` holds both), so a naive innerText includes whatever is
 * currently typed. The reply is computed as a diff of this text, which meant
 * the "reply" was your own prompt sitting in the box — every ask returned what
 * you just said. The composer is cloned out before reading.
 */
function transcriptExpr(p: AppProfile, explicit: string | undefined): string {
  const roots = explicit ? [explicit] : p.transcript;
  return `(() => {
  ${DOCS}
  const roots = ${JSON.stringify(roots)};
  const composerish = ['[data-lexical-editor]', '[contenteditable="true"]', 'textarea', '[data-loom-composer]'];
  for (const sel of roots) {
    const el = findIn(sel);
    if (!el) continue;
    const doc = el.ownerDocument;
    const clone = el.cloneNode(true);
    composerish.forEach((c) => clone.querySelectorAll(c).forEach((n) => n.remove()));
    // innerText needs layout, which a detached node has none of; attach it
    // offscreen for the read rather than settling for textContent, which would
    // glue every word together and make the diff meaningless.
    clone.style.position = 'fixed';
    clone.style.left = '-99999px';
    clone.style.top = '0';
    doc.body.appendChild(clone);
    const text = (clone.innerText || "").slice(-20000);
    clone.remove();
    return text;
  }
  const last = docs[docs.length - 1];
  return (last.body ? last.body.innerText || "" : "").slice(-20000);
})()`;
}

export class GuiChatDriver {
  private profile: AppProfile;
  private readonly appName: string;
  /** The target that had the chat last time; tried first, never trusted. */
  private lastTargetId: string | null = null;

  constructor(appName: string, private readonly options: GuiChatOptions, kind?: string) {
    this.profile = profileFor(kind ?? appName.toLowerCase());
    // The profile knows the app's real name; "Antigravity" is the other program.
    this.appName = this.profile === GENERIC ? appName : this.profile.name;
  }

  get endpoint(): string {
    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.debugPort ?? this.profile.defaultPort;
    return `http://${host}:${port}`;
  }

  /** How to start this app with a debugger, on this OS. */
  get launchHint(): string {
    const os = process.platform;
    const how =
      this.profile.launch[os === "win32" ? "win32" : os === "darwin" ? "darwin" : "linux"];
    return `${this.appName} isn't listening — ${how}`;
  }

  reachable(): Promise<boolean> {
    return cdpUp(this.endpoint);
  }

  /**
   * A session on the target that actually has the chat in it.
   *
   * There is usually more than one candidate and the right one isn't
   * predictable from the app: Antigravity's chat is in its page, Kiro's is in a
   * webview target. So every candidate is asked "is there a composer here?" and
   * the first that says yes wins. The answer is remembered — the targets don't
   * move around between two calls a second apart — but it's re-derived whenever
   * that target has gone.
   */
  private async session(): Promise<{ session: CdpSession; found: { ok: boolean; reason?: string } }> {
    const targets = chatTargets(await cdpTargets(this.endpoint));
    if (!targets.length) throw new Error(`${this.appName} is running but has no window to talk to`);

    const ordered = this.lastTargetId
      ? [...targets].sort((a, b) => (a.id === this.lastTargetId ? -1 : b.id === this.lastTargetId ? 1 : 0))
      : targets;

    let firstReason: string | undefined;
    for (const target of ordered) {
      let session: CdpSession;
      try {
        session = await CdpSession.open(target, 4000);
      } catch {
        continue; // a target that won't attach isn't the one
      }
      try {
        const found = await session.evaluate<{ ok: boolean; reason?: string }>(
          discoverExpr(this.profile, this.options.selectors?.composer),
          8000,
        );
        if (found.ok) {
          this.lastTargetId = target.id;
          return { session, found };
        }
        firstReason ??= found.reason;
      } catch {
        /* this target can't answer; try the next */
      }
      session.close();
    }
    throw new Error(firstReason ?? `no chat panel in ${this.appName}`);
  }

  /**
   * Can we actually drive it right now? Reachable is not enough: a signed-out
   * Antigravity answers CDP happily and has no chat in it at all.
   */
  async driveable(): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.reachable())) return { ok: false, reason: this.launchHint };
    let session: CdpSession | null = null;
    try {
      ({ session } = await this.session());
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      session?.close();
    }
  }

  /**
   * Type a prompt into the app, submit it, and wait for the panel to stop
   * growing.
   *
   * What comes back is the panel's text, not the model's response object —
   * these apps render their conversation, they don't hand it out. Same trade
   * the phone-chat project makes: mirror what's on screen rather than pretend
   * to have something structured.
   */
  async ask(text: string, onProgress?: (partial: string) => void): Promise<string> {
    // session() finds the target whose chat exists and marks the composer in it
    const { session } = await this.session();
    try {
      const before = await session.evaluate<string>(
        transcriptExpr(this.profile, this.options.selectors?.transcript),
      );

      const focused = await session.evaluate<{
        ok: boolean;
        reason?: string;
        focused?: boolean;
        x?: number;
        y?: number;
      }>(focusExpr(this.profile));
      if (!focused.ok) {
        throw new Error(
          focused.reason === "busy"
            ? `${this.appName} is already working on something — let it finish or stop it there`
            : `can't focus ${this.appName}'s chat box: ${focused.reason}`,
        );
      }

      // focus() is a request, and sometimes the page says no — a re-render, a
      // framework that owns focus. When it does, click the box like a person
      // and re-select. This is what made the second ask in a session flaky:
      // typing went somewhere else, silently.
      if (!focused.focused && focused.x !== undefined && focused.y !== undefined) {
        await session.clickAt(focused.x, focused.y);
        await session.evaluate(focusExpr(this.profile));
      }

      // Type through the browser's own input pipeline. This matters more than
      // it looks: measured in a real Chromium, execCommand("insertText") fires
      // only `input`, while Input.insertText fires `beforeinput` AND `input` —
      // which is what a keyboard does, and what an editor like Lexical builds
      // its model from. Typing with execCommand filled the box visually and
      // left the app believing it was empty, so the send button did nothing.
      await session.insertText(text);

      // Let the framework commit the edit before asking it to submit; without
      // this the send button is still disabled from when the box was empty.
      // The wait lives here rather than inside the page because the page may be
      // in a background window, where rAF never fires and an awaited evaluate
      // hangs forever. A setTimeout out here always fires.
      await new Promise((r) => setTimeout(r, 120));

      const sent = await session.evaluate<{ ok: boolean; reason?: string; how?: string }>(
        submitExpr(this.profile, text, this.options.selectors?.send),
      );
      if (!sent.ok) throw new Error(`couldn't send to ${this.appName}: ${sent.reason}`);

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
    const expr = transcriptExpr(this.profile, this.options.selectors?.transcript);
    let last = before;
    let lastChange = Date.now();

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      let now: string;
      try {
        now = await session.evaluate<string>(expr);
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
 * Not a real diff: the transcript is a rendered panel that scrolls, collapses
 * and reflows. When `after` simply grew, the tail is the new part; when it
 * changed shape, the common prefix is the best we can honestly do.
 */
export function delta(before: string, after: string): string {
  if (after.startsWith(before)) return after.slice(before.length).trim();
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  return after.slice(i).trim();
}
