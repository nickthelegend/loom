const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

// SDK 52 doesn't pass a group to Android's notification builder. Keep this
// small backport until the app upgrades to an Expo version that does.
function groupNotifications(source) {
  if (source.includes("// Loom project notification groups")) return source;
  const anchor = "    return builder.build()";
  if (!source.includes(anchor)) throw new Error("Expo notification builder changed; review Loom's grouping backport.");
  return source.replace(anchor, `    // Loom project notification groups
    val projectGroup = content.body?.optString("projectGroup")
    if (!projectGroup.isNullOrBlank()) {
      builder.setGroup(projectGroup)
      val summary = createBuilder()
        .setSmallIcon(icon)
        .setContentTitle(content.title)
        .setContentText("Project notifications")
        .setContentIntent(createNotificationResponseIntent(context, notification, defaultAction))
        .setGroup(projectGroup)
        .setGroupSummary(true)
        .setOnlyAlertOnce(true)
        .setAutoCancel(true)
        .setSilent(true)
        .build()
      androidx.core.app.NotificationManagerCompat.from(context).notify(projectGroup, 0, summary)
    }
${anchor}`);
}
function dataNotificationContent(source) {
  if (source.includes('optString("loomTitle")')) return source;
  const title = "override val title = remoteMessage.notification?.title ?: notificationData.title";
  const body = "override val text = remoteMessage.notification?.body ?: notificationData.message";
  if (!source.includes(title) || !source.includes(body)) throw new Error("Expo notification content changed; review Loom's data payload backport.");
  return source.replace(title, title + ' ?: notificationData.body?.optString("loomTitle")')
    .replace(body, body + ' ?: notificationData.body?.optString("loomBody")');
}
module.exports = config => withDangerousMod(config, ["android", async mod => {
  const root = path.dirname(require.resolve("expo-notifications/package.json", { paths: [mod.modRequest.projectRoot] }));
  const file = path.join(root, "android/src/main/java/expo/modules/notifications/notifications/presentation/builders/ExpoNotificationBuilder.kt");
  fs.writeFileSync(file, groupNotifications(fs.readFileSync(file, "utf8")));
  const content = path.join(root, "android/src/main/java/expo/modules/notifications/notifications/model/RemoteNotificationContent.kt");
  fs.writeFileSync(content, dataNotificationContent(fs.readFileSync(content, "utf8")));
  return mod;
}]);
module.exports.groupNotifications = groupNotifications;
module.exports.dataNotificationContent = dataNotificationContent;
