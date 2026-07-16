/**
 * What each GUI agent's chat is made of.
 *
 * Read off the running apps, with two projects' work behind them:
 * krishnakanthb13/antigravity_phone_chat for the shape of Antigravity's chat,
 * and yazanbaker94/AntiGravity-AutoAccept for how to attach to it at all. Both
 * MIT, both doing this daily against real installs.
 *
 * Everything here was then checked against Antigravity IDE 1.107.0 on this
 * machine, and the checking mattered — two of the borrowed selectors are gone
 * in this build, and the app that matters isn't the one with the obvious name.
 *
 * The scoping is the important idea, and it's from the phone-chat project. The
 * composer is looked for *inside* `#conversation` — never in the document at
 * large. These are VS Code-family apps and Monaco, the editor holding your
 * source file, is a `contenteditable`. Hunt the document and you will
 * eventually find it and type a prompt into someone's code. Search inside the
 * chat panel and you cannot.
 *
 * Selectors rot; two already did. When they stop matching, the bridge says so
 * rather than improvising, and `options.selectors` overrides any of it without
 * waiting for a release.
 */

export interface AppProfile {
  /** For messages. */
  name: string;
  /**
   * The debugging port to expect by default.
   *
   * 9333 for Antigravity, not the usual 9222: Antigravity's own Browser Control
   * (the Chrome button in its toolbar) already uses 9222, and asking for it
   * gives you EADDRINUSE and an IDE with no debugger. That's the AutoAccept
   * extension's finding, and it's worth every word of this comment — it cost an
   * hour here, launching an IDE that silently never got a port while a stale
   * process held it.
   */
  defaultPort: number;
  /** How to start it with a debugger, per platform. */
  launch: { darwin: string; win32: string; linux: string };
  /**
   * The chat panel. The composer is only ever looked for inside one of these,
   * which is what keeps Monaco out of reach.
   */
  chatRoots: string[];
  /** The composer, within the root. */
  composer: string;
  /**
   * The submit control, tried in order. Each is matched then walked up to its
   * closest button — Antigravity's arrow is an svg inside one.
   */
  send: string[];
  /** Visible ⇒ a turn is already running and the composer isn't yours. */
  busy?: string;
  /** Where the conversation is rendered, for reading replies back. */
  transcript: string[];
  /**
   * Text the panel shows when the app is signed out.
   *
   * Worth a field of its own, because a signed-out app fails in a way that
   * mimics a broken driver: the chat renders, the composer takes text happily,
   * and the send button is simply disabled forever. Without this, the honest
   * report is "we typed and nothing happened", which sends you debugging the
   * wrong thing — as it did here for an hour. With it, the report is "log in".
   */
  signedOut?: RegExp;
}

/** Anything under one of these is never a composer, whatever else it looks like. */
export const FORBIDDEN_ANCESTORS = [".monaco-editor", ".editor-instance", '[role="code"]'];

export const PROFILES: Record<string, AppProfile> = {
  /**
   * Antigravity IDE — a Lexical composer inside a `#conversation` panel.
   *
   * Read off the real thing: Antigravity IDE 1.107.0, signed in, workbench
   * open. The composer is `<div data-lexical-editor="true" aria-label="Message
   * input">` and the submit is:
   *
   *   <button aria-label="Send message" data-testid="send-button"
   *           data-tooltip-id="input-send-button-send-tooltip">
   *
   * `data-testid` leads because a testid is a promise to a test suite, and
   * things people test against get renamed less often than classes do. The
   * tooltip id is the same control by another name, and it's what
   * antigravity_phone_chat matches on. `svg.lucide-arrow-right` is that
   * project's selector and finds nothing in this build — kept last so older
   * installs still work.
   *
   * Note WHICH app this is. `Antigravity.app` and `Antigravity IDE.app` are two
   * different programs: the first is the Manager (a plain https:// page behind
   * a Google sign-in, no chat DOM at all), the second is the VS Code fork with
   * the agent in it. Probing the Manager for a composer finds nothing and
   * tells you Antigravity has no chat, which is wrong and wasted an afternoon.
   */
  antigravity: {
    name: "Antigravity IDE",
    defaultPort: 9333,
    launch: {
      darwin: 'open -a "Antigravity IDE" --args --remote-debugging-port=9333',
      win32: "right-click the Antigravity IDE shortcut → Properties → append --remote-debugging-port=9333 to Target",
      linux: "antigravity --remote-debugging-port=9333  (or add it to the Exec line of its .desktop file)",
    },
    chatRoots: ["#conversation", "#chat", ".cascade"],
    composer: '[data-lexical-editor="true"], [contenteditable="true"]',
    send: [
      '[data-testid="send-button"]',
      '[data-tooltip-id="input-send-button-send-tooltip"]',
      "svg.lucide-arrow-right",
    ],
    busy: '[data-tooltip-id="input-send-button-cancel-tooltip"]',
    transcript: ["#conversation", "#chat", ".cascade", "[data-scroll-area]"],
    // Observed verbatim in 1.107.0: "There was an error with your
    // authentication. To log in, click here".
    signedOut: /error with your authentication|to log in, click here|^log in$/i,
  },

  /**
   * Kiro — a VS Code fork whose chat lives in a workbench panel.
   *
   * Nobody has published working selectors for it and this machine can't
   * produce them either: Kiro opens on a Getting Started tab with no chat panel,
   * so there was nothing to read. These are the VS Code conventions its panel
   * most likely follows, and if they miss, the bridge reports that rather than
   * falling back to the document — which is where Monaco lives.
   *
   * Unverified. Set options.selectors.composer and it stops mattering.
   */
  kiro: {
    name: "Kiro",
    defaultPort: 9334,
    launch: {
      darwin: 'open -a "Kiro" --args --remote-debugging-port=9334',
      win32: "right-click the Kiro shortcut → Properties → append --remote-debugging-port=9334 to Target",
      linux: "kiro --remote-debugging-port=9334",
    },
    chatRoots: [
      "#workbench\\.parts\\.sidebar",
      "#workbench\\.parts\\.auxiliarybar",
      "#workbench\\.parts\\.panel",
      ".chat-container",
      "[id*='chat']",
    ],
    composer: '.chat-input-container [contenteditable="true"], textarea, [contenteditable="true"]',
    send: [".codicon-send", "[aria-label*='Send' i]"],
    transcript: [".chat-container", ".interactive-list", "[id*='chat']"],
  },
};

/**
 * When we don't know the app: no chat root to scope to, so the composer has to
 * earn it by being labelled like one, and Monaco is excluded explicitly rather
 * than structurally. Strictly worse than a profile — that's why profiles exist.
 */
export const GENERIC: AppProfile = {
  name: "the app",
  defaultPort: 9222,
  launch: {
    darwin: "launch it with --remote-debugging-port=9222",
    win32: "launch it with --remote-debugging-port=9222",
    linux: "launch it with --remote-debugging-port=9222",
  },
  chatRoots: ["body"],
  composer: 'textarea, [contenteditable="true"]',
  send: ["[aria-label='Send' i]", "button"],
  transcript: ["body"],
};

/** What a chat box calls itself, for the generic path only. */
export const CHATTY = /ask|message|chat|prompt|plan|type .*here|what.*build|reply/i;

export function profileFor(kind: string): AppProfile {
  return PROFILES[kind] ?? GENERIC;
}
