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
  }
}
