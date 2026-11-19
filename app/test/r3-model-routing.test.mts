import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateLabel, parseAgentRouting } from "../src/model-routing-model.ts";

describe("r3 model routing", () => {
  it("labels unknown prices, free models, warnings and hard stops", () => {
    const e = { model: "fast", inputTokens: 123, outputTokens: 1024, usd: null, usage: null };
    assert.match(estimateLabel(e), /price unavailable/);
    assert.match(estimateLabel({ ...e, usd: 0 }), /~\$0.0000/);
    assert.match(estimateLabel({ ...e, usage: { warning: true, stopped: false } }), /80%/);
    assert.match(estimateLabel({ ...e, usage: { warning: true, stopped: true } }), /cap reached/);
  });
  it("parses argument boundaries and aliases without shell splitting", () => {
    assert.deepEqual(parseAgentRouting('["--name","two words"]', '["cheap"]', "high"), { extraArgs: ["--name", "two words"], fallbacks: ["cheap"], effort: "high" });
    assert.throws(() => parseAgentRouting('"--flag"', "[]", ""), /array/);
    assert.throws(() => parseAgentRouting('[42]', "[]", ""), /array/);
    assert.throws(() => parseAgentRouting('["a\\n"]', "[]", ""), /newlines/);
  });
});
