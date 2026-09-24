/** How the phone grades its link to the daemon. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeLink, linkQuality, pushSample, sparkBars } from "../src/link-model.ts";

describe("link quality", () => {
  it("knows nothing before the first ping", () => {
    assert.equal(linkQuality([]).grade, "unknown");
    assert.equal(describeLink(linkQuality([])), "measuring…");
  });

  it("grades a steady, fast link good, and says its median and wobble", () => {
    const q = linkQuality([40, 42, 38, 41, 44]);
    assert.equal(q.grade, "good");
    assert.equal(q.medianMs, 41);
    assert.equal(q.lossPct, 0);
    assert.equal(describeLink(q), "good · 41 ms ±3");
  });

  it("marks it fair or poor as pings slow down or go missing", () => {
    assert.equal(linkQuality([300, 320, 310, 290]).grade, "fair");
    assert.equal(linkQuality([40, null, 42, 41, 40, 43, 39, 41, 40, 42]).grade, "fair"); // 10% lost
    assert.equal(linkQuality([40, null, null, 41, 40]).grade, "poor"); // 40% lost
    assert.equal(linkQuality([900, 1000, 950]).grade, "poor");
  });

  it("calls it down when the last three never came back, whatever came before", () => {
    const q = linkQuality([40, 41, 42, null, null, null]);
    assert.equal(q.grade, "down");
    assert.equal(describeLink(q), "not answering");
  });

  it("keeps a bounded window, and draws lost pings as their own mark", () => {
    let w: (number | null)[] = [];
    for (let i = 0; i < 30; i++) w = pushSample(w, i, 24);
    assert.equal(w.length, 24);
    assert.equal(w[0], 6);
    const bars = sparkBars([50, null, 200]);
    assert.equal(bars[1], -1);
    assert.equal(bars[2], 1);
    assert.ok(bars[0]! > 0 && bars[0]! < 1);
  });
});
