/**
 * Kiro bridge — the same shape as Antigravity, because the situation is the
 * same shape: an Electron app (a VS Code fork) whose agent lives in a panel and
 * offers nothing to talk to but its DevTools port.
 *
 * The `code` CLI inside Kiro.app is VS Code's, not an agent interface — it
 * opens files and installs extensions. It cannot ask Kiro anything, so it isn't
 * used here.
 *
 * The Monaco hazard is at its sharpest in this one. Kiro's window is a code
 * editor first: on launch its only contenteditable IS your source file. The
 * driver refuses to type into anything under .monaco-editor for exactly this
 * reason — see gui-chat.ts. Open the Kiro chat panel before expecting this to
 * find anything.
 */

import { AntigravityBridge } from "./antigravity.js";

export class KiroBridge extends AntigravityBridge {
  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}) {
    super(id, projectDir, options, "kiro", "Kiro");
  }
}
