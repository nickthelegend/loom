import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Above waitUntil's 20s default (see test/helpers.ts) — a test that hits
    // that budget should fail on the wait, with its message, not get cut off
    // mid-poll by the runner and report a bare timeout instead.
    testTimeout: 40_000,
    hookTimeout: 20_000,
  },
});
