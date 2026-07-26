import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Above waitUntil's 20s default (see test/helpers.ts) — a test that hits
    // that budget should fail on the wait, with its message, not get cut off
    // mid-poll by the runner and report a bare timeout instead.
    testTimeout: 40_000,
    hookTimeout: 20_000,
    env: {
      // Telemetry defaults to enabled against http://localhost:4318, so the
      // suite would ship spans, metrics and logs to a real collector whenever
      // the developer happened to have one up — and then wait on it. That is
      // how a passing suite turns into `waitUntil: condition not met` in
      // app-dom: nothing about the test changed, the collector was just busy on
      // the same machine, and an echo turn no longer finished inside budget. A
      // test's result must not depend on what else is running. The export tests
      // delete this var in their own setup and point the endpoint at a fake
      // collector they control.
      LOOM_TELEMETRY_DISABLED: "1",
    },
  },
});
