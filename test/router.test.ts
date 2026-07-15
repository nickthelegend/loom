import { describe, expect, it } from "vitest";
import { rulesRouter, type RouterContext } from "../src/core/router.js";

const AGENTS = [
  { id: "plannerbot", role: "planner" as const },
  { id: "execbot", role: "executor" as const },
  { id: "reviewbot", role: "reviewer" as const },
];

function ctx(over: Partial<RouterContext>): RouterContext {
  return { task: "build the widget", hops: [], agents: AGENTS, recent: [], ...over };
}

describe("rules router", () => {
  it("starts with the planner", () => {
    expect(rulesRouter(ctx({}))).toMatchObject({ next: "plannerbot", by: "rules" });
  });

  it("planner → executor → reviewer", () => {
    expect(rulesRouter(ctx({ hops: ["plannerbot"] })).next).toBe("execbot");
    expect(rulesRouter(ctx({ hops: ["plannerbot", "execbot"] })).next).toBe("reviewbot");
  });

  it("clean review → done; harsh review → back to executor", () => {
    const clean = rulesRouter(
      ctx({
        hops: ["plannerbot", "execbot", "reviewbot"],
        recent: [{ author: "reviewbot", text: "Looks solid, verdict: approved." }],
      }),
    );
    expect(clean.next).toBe("done");

    const harsh = rulesRouter(
      ctx({
        hops: ["plannerbot", "execbot", "reviewbot"],
        recent: [{ author: "reviewbot", text: "Found issues in the parser, must fix the loop." }],
      }),
    );
    expect(harsh.next).toBe("execbot");
  });

  it("fix loop is capped at three review rounds", () => {
    const looped = rulesRouter(
      ctx({
        hops: [
          "plannerbot",
          "execbot",
          "reviewbot",
          "execbot",
          "reviewbot",
          "execbot",
          "reviewbot",
        ],
        recent: [{ author: "reviewbot", text: "still found issues, must fix" }],
      }),
    );
    expect(looped.next).toBe("done");
  });

  it("degrades gracefully without planner/reviewer roles", () => {
    const execOnly = [{ id: "solo", role: "executor" as const }];
    expect(rulesRouter(ctx({ agents: execOnly })).next).toBe("solo");
    expect(rulesRouter(ctx({ agents: execOnly, hops: ["solo"] })).next).toBe("done");
    expect(rulesRouter(ctx({ agents: [] })).next).toBe("done");
  });
});
