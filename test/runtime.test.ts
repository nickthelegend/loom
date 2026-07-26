import { describe, expect, it, vi } from "vitest";
import {
  LOOM_ASK_TIMEOUT_MESSAGE,
  LOOM_ASK_TIMEOUT_MS,
  LoomAskTimeoutError,
  withLoomAskTimeout,
} from "../src/daemon/runtime.js";

describe("loom ask timeout", () => {
  it("returns a friendly error after 15 seconds without a reply", async () => {
    vi.useFakeTimers();
    try {
      const reply = withLoomAskTimeout(new Promise<never>(() => {}));
      const assertion = expect(reply).rejects.toMatchObject({
        name: "LoomAskTimeoutError",
        message: LOOM_ASK_TIMEOUT_MESSAGE,
      } satisfies Partial<LoomAskTimeoutError>);
      await vi.advanceTimersByTimeAsync(LOOM_ASK_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
