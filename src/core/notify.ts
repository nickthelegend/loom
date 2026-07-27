/**
 * Fire-and-notify — when a background agent needs input or finishes, tell
 * the human. This is the local half: a desktop notification (macOS osascript /
 * linux notify-send). The phone half rides the same event feed through Expo
 * push — see daemon/push.ts.
 */

import { spawn } from "node:child_process";

export interface Notification {
  title: string;
  body: string;
}

function run(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
    child.on("error", () => {});
  } catch {
    // Notifications are best-effort by design.
  }
}

export function notify(n: Notification): void {
  if (process.env.LOOM_NO_NOTIFY) return;
  const body = n.body.replace(/"/g, "'").slice(0, 200);
  const title = n.title.replace(/"/g, "'").slice(0, 60);
  if (process.platform === "darwin") {
    run("osascript", ["-e", `display notification "${body}" with title "${title}"`]);
  } else if (process.platform === "linux") {
    run("notify-send", [title, body]);
  } else if (process.platform === "win32") {
    // Windows had no branch at all, so notify() returned having done nothing —
    // while the Setup panel shipped a Windows row telling people where to enable
    // notifications and the CLI said "you'll be notified at each pause/finish".
    // A promise with no implementation is worse than no promise.
    //
    // Toast XML via PowerShell rather than a native module: this daemon runs
    // from a plain `npm i -g`, and a prebuilt binary dependency would break that
    // for the one platform this is meant to fix.
    const esc = (v: string): string =>
      v.replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
      );
    const ps = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;",
      "$x = New-Object Windows.Data.Xml.Dom.XmlDocument;",
      `$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual></toast>');`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Loom').Show([Windows.UI.Notifications.ToastNotification]::new($x));",
    ].join(" ");
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
}
