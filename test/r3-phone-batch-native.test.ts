import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

vi.mock("../app/node_modules/react-native/index.js", () => ({ Platform: { OS: "ios", select: (v: Record<string, unknown>) => v.ios ?? v.default } }));

// These load the phone app's own modules, which need its dependencies (expo, react-native):
// installed for the app's job and locally, not for the daemon's test matrix.
const appDeps = fs.existsSync(path.resolve("app/node_modules/expo/package.json"));

describe.skipIf(!appDeps)("phone native entry points", () => {
it("keeps the theme palette stable while switching preferences and following system changes", async () => {
  const { T, pickTheme, onThemePref, setScheme } = await import("../app/src/theme.js");
  const original = T.bg, palette = T; const preferences: string[] = [];
  const off = onThemePref(p => preferences.push(p));
  pickTheme("system"); setScheme("light"); expect(T).toBe(palette); expect(T.bg).not.toBe(original);
  setScheme("dark"); expect(T.bg).toBe(original); expect(preferences).toEqual(["system"]);
  off(); pickTheme("light"); expect(preferences).toEqual(["system"]);
});

it("configures all native entry points and backports Android grouping idempotently", () => {
  const require = createRequire(import.meta.url);
  const { groupNotifications, dataNotificationContent } = require("../app/plugins/with-project-notifications.cjs");
  const expoRequire = createRequire(path.resolve("app/package.json"));
  const root = path.dirname(expoRequire.resolve("expo-notifications/package.json"));
  const source = fs.readFileSync(path.join(root, "android/src/main/java/expo/modules/notifications/notifications/presentation/builders/ExpoNotificationBuilder.kt"), "utf8");
  const grouped = groupNotifications(source);
  expect(grouped).toContain('content.body?.optString("projectGroup")');
  expect(grouped).toContain("builder.setGroup(projectGroup)"); expect(grouped).toContain(".setGroupSummary(true)");
  expect(groupNotifications(grouped)).toBe(grouped);
  expect(() => groupNotifications("upstream changed")).toThrow("changed");
  const content = fs.readFileSync(path.join(root, "android/src/main/java/expo/modules/notifications/notifications/model/RemoteNotificationContent.kt"), "utf8");
  const data = dataNotificationContent(content);
  expect(data).toContain('notificationData.body?.optString("loomTitle")');
  expect(data).toContain('notificationData.body?.optString("loomBody")');
  expect(dataNotificationContent(data)).toBe(data);
  expect(() => dataNotificationContent("upstream changed")).toThrow("changed");
  const config = JSON.parse(fs.readFileSync("app/app.json", "utf8")).expo;
  expect(config.plugins).toContain("expo-quick-actions");
  expect(config.plugins).toContainEqual(["expo-local-authentication", { faceIDPermission: "Unlock Loom with Face ID." }]);
  expect(config.plugins.find((p: unknown[]) => Array.isArray(p) && p[0] === "expo-share-intent")[1]).toEqual({
    iosActivationRules: { NSExtensionActivationSupportsText: true, NSExtensionActivationSupportsWebURLWithMaxCount: 1 }, androidIntentFilters: ["text/*"],
  });
});
});
