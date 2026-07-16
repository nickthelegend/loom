/**
 * Antigravity bridge — presence, and now a way in.
 *
 * Antigravity is an Electron app with no API, no headless mode and no way to
 * talk to it but the DevTools port it opens when you ask for one. Launched with
 * --remote-debugging-port it speaks CDP, and CDP is enough to see it, type into
 * its chat and read what comes back. The approach is the one
 * krishnakanthb13/antigravity_phone_chat takes to put Antigravity on a phone:
 * don't touch the provider APIs, don't lift the tokens — drive the app that's
 * already signed in, exactly as a person would.
 *
 * It stays a BRIDGE rather than becoming an adapter, and that isn't timidity:
 *
 *   - Antigravity edits the tree on its own schedule and knows nothing about
 *     Loom's baton. Handing it the baton would be a promise Loom can't keep,
 *     because nothing stops Antigravity from writing while another agent holds
 *     it. A bridge never holds the baton, so the lock keeps meaning something.
 *   - What comes back is the chat panel's text, not the model's response. Good
 *     enough to read; not something to hand to a router as a result.
 *
 * So: send with your own hands, read with your own eyes, from anywhere. What
 * Loom adds is that the thread and the memory projection stay in one place.
 */

import { GuiChatDriver, type GuiChatOptions } from "./gui-chat.js";
import { BridgeBase } from "../base.js";
import { cdpTargets } from "./cdp.js";

export class AntigravityBridge extends BridgeBase {
  /**
   * Sending is real here, unlike a plain bridge. The baton stays out of reach:
   * tier is what decides that, and it's still "bridge".
   */
  override readonly capabilities = {
    tier: "bridge" as const,
    send: true,
    stream: true,
    injectMemory: true,
    interrupt: false,
    diff: false,
  };

  protected driver: GuiChatDriver;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(id: string, projectDir: string, options: Record<string, unknown> = {}, kind = "antigravity", appName = "Antigravity") {
    super(id, kind, projectDir);
    this.driver = new GuiChatDriver(appName, options as GuiChatOptions);
  }

  async available(): Promise<boolean> {
    return this.driver.reachable();
  }

  async start(): Promise<void> {
    if (!(await this.driver.reachable())) {
      this.emit({ kind: "status", payload: { state: "unreachable", hint: this.driver.launchHint } });
      return;
    }
    const targets = await cdpTargets(this.driver.endpoint);
    // Reachable and driveable are different questions: a signed-out Antigravity
    // answers CDP cheerfully and has no chat box in it. Say which one it is.
    const drive = await this.driver.driveable();
    this.emit({
      kind: "status",
      payload: {
        state: drive.ok ? "ready" : "observed",
        canSend: drive.ok,
        ...(drive.ok ? {} : { hint: drive.reason }),
        targets: targets.filter((t) => t.type === "page").slice(0, 10).map((t) => ({ title: t.title, type: t.type })),
      },
    });
    this.pollTimer = setInterval(() => {
      void this.driver.reachable().then((ok) => {
        if (!ok) this.emit({ kind: "status", payload: { state: "unreachable" } });
      });
    }, 60_000);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * Type into the app's chat and report what the panel gained.
   *
   * Not part of the Bridge interface — the runtime won't route turns here, and
   * that's deliberate. It's reachable through the daemon's bridge endpoint for
   * a human who wants to drive Antigravity from their phone.
   */
  async ask(text: string): Promise<string> {
    const started = Date.now();
    this.emit({ kind: "status", payload: { state: "turn_started", session: null } });
    try {
      const reply = await this.driver.ask(text);
      if (reply.trim()) this.emit({ kind: "message", payload: { text: reply } });
      this.emit({ kind: "run_complete", payload: { durationMs: Date.now() - started } });
      return reply;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ kind: "error", payload: { message } });
      throw err;
    }
  }
}
