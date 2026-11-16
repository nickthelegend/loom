import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

// @ts-expect-error — the desktop shell uses plain ESM JavaScript
import { allowWebviewUrl, attachGuard, BROWSER_PARTITION, guardBrowserSession, guardWebview } from "../desktop/webview-guard.js";

function navigation() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

describe("desktop Browser isolation", () => {
  it("allows only absolute HTTP and HTTPS URLs", () => {
    for (const url of ["https://example.com/docs?q=1#top", "http://localhost:3000", "HTTPS://example.com", "http://[::1]:3000"]) {
      expect(allowWebviewUrl(url), url).toBe(true);
    }
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "blob:https://example.com/id", "about:blank", "mailto:a@b.com", "loom://open", "//example.com", "https://", "", null, {}]) {
      expect(allowWebviewUrl(url), String(url)).toBe(false);
    }
  });

  it("strips preloads and overrides unsafe renderer preferences before attaching", () => {
    const preferences: Record<string, unknown> = {
      preload: "/tmp/evil.js", preloadURL: "file:///tmp/evil.js", nodeIntegration: true,
      nodeIntegrationInSubFrames: true, nodeIntegrationInWorker: true,
      contextIsolation: false, sandbox: false, webSecurity: false, webviewTag: true,
      allowRunningInsecureContent: true, navigateOnDragDrop: true,
    };
    const event = navigation();
    attachGuard(event, preferences, { partition: BROWSER_PARTITION, src: "https://example.com" });
    expect(event.prevented).toBe(false);
    expect(preferences).toEqual({
      nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
      allowRunningInsecureContent: false, navigateOnDragDrop: false,
    });
  });

  it("rejects another partition or an unsafe initial URL", () => {
    for (const params of [
      {}, { partition: "", src: "https://example.com" },
      { partition: "persist:other", src: "https://example.com" },
      { partition: BROWSER_PARTITION, src: "file:///tmp/page.html" },
      { partition: BROWSER_PARTITION, src: "javascript:alert(1)" },
    ]) {
      const event = navigation();
      attachGuard(event, {}, params);
      expect(event.prevented).toBe(true);
    }
  });

  it("denies permission requests, permission checks, and downloads", () => {
    // Only the Electron API boundary is represented here; the guard is real.
    class Session extends EventEmitter {
      request!: (...args: unknown[]) => void;
      check!: () => boolean;
      setPermissionRequestHandler(handler: typeof this.request) { this.request = handler; }
      setPermissionCheckHandler(handler: typeof this.check) { this.check = handler; }
    }
    const session = new Session();
    guardBrowserSession(session);
    for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "unknown"]) {
      let allowed: unknown;
      session.request(null, permission, (value: boolean) => { allowed = value; });
      expect(allowed).toBe(false);
      expect(session.check()).toBe(false);
    }
    const event = navigation();
    session.emit("will-download", event);
    expect(event.prevented).toBe(true);
  });

  it("blocks unsafe navigation and redirects and denies all popup windows", () => {
    class Contents extends EventEmitter {
      open!: (details: { url: string }) => { action: string };
      setWindowOpenHandler(handler: typeof this.open) { this.open = handler; }
    }
    const contents = new Contents();
    guardWebview(contents);
    for (const kind of ["will-navigate", "will-redirect"]) {
      for (const url of ["https://example.com", "http://localhost:3000", "file:///tmp/secret", "javascript:alert(1)", "data:text/html,hi", "custom:open"]) {
        const event = navigation();
        contents.emit(kind, event, url);
        expect(event.prevented).toBe(!allowWebviewUrl(url));
        expect(contents.open({ url })).toEqual({ action: "deny" });
      }
    }
  });
});
