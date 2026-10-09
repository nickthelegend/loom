/**
 * app.json, plus what only exists on the machine that builds a store release:
 *
 *   google-services.json   Firebase's file for this app (dev.loom.app) — Android
 *                          push in a Play build goes through FCM. Not committed.
 *   EAS_PROJECT_ID         the Expo project id (`eas init` prints it) — a store
 *                          build needs it to get an Expo push token.
 *
 * Without either, the app builds and runs; the account sheet just says push
 * isn't available on that build.
 */
const fs = require("node:fs");
const path = require("node:path");

module.exports = ({ config }) => {
  const services = path.join(__dirname, "google-services.json");
  const projectId = process.env.EAS_PROJECT_ID;
  return {
    ...config,
    android: { ...config.android, ...(fs.existsSync(services) ? { googleServicesFile: "./google-services.json" } : {}) },
    extra: { ...config.extra, ...(projectId ? { eas: { projectId } } : {}) },
  };
};
