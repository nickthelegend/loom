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
      // The decision extractor and triage both drive a real local agent CLI
      // (`claude -p`, `agy --print`) when no ANTHROPIC_API_KEY is set. A test
      // suite must not: it spends tokens, it passes only on a machine that
      // happens to be signed in, and it is slow — one triage call took 14s of
      // an otherwise sub-second file. Off everywhere; the tests that exercise
      // those paths turn them back on and inject a fake CLI.
      LOOM_DECISIONS_NO_CLI: "1",
      LOOM_TRIAGE_NO_LLM: "1",
      // Skill discovery reads the user's real ~/.claude (skills and plugin
      // caches) — which is the point in production and poison in a test: the
      // suite's answers would depend on which plugins the developer happens to
      // have installed. CLAUDE_CONFIG_DIR is Claude Code's own override, so
      // pointing it at nothing makes discovery hermetic without a test-only
      // code path. The discovery tests point it at a fixture of their own.
      CLAUDE_CONFIG_DIR: "/nonexistent/loom-test-claude-home",
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
