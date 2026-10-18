/**
 * Fourth field round (1.2.2): a crew's lease against an agent's absolute paths,
 * where crew checkouts live. Memory repair (#325, #326) is in round3.test.ts.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { crewWorktreeRoot } from "../src/core/crew.js";
import { loomHome } from "../src/core/registry.js";
import { covered, repoRelative } from "../src/core/team-leases.js";

describe("#327 a crew lease and an agent's absolute paths", () => {
  const wt = "/Users/me/.loom/crews/b4a6b63efa3d/bb2/cards-gmvdk2uszqec/1adf0205";

  it("an edit inside the card's worktree is matched as the repo path it is", () => {
    const p = repoRelative(`${wt}/blackbox/checks.py`, [wt, "/Volumes/SSD/blackbox"]);
    expect(p).toBe("blackbox/checks.py");
    expect(covered(p, ["blackbox/checks.py", "tests/**"])).toBe(true);
    expect(covered(p, ["blackbox/agent.py"])).toBe(false);
    // the raw absolute path never matched a repo-relative glob: the loop the field hit
    expect(covered(`${wt}/blackbox/checks.py`, ["blackbox/checks.py"])).toBe(false);
  });

  it("the project's own root, relative paths and Windows paths all come out repo-relative", () => {
    expect(repoRelative("/Volumes/SSD/blackbox/tests/test_x.py", [undefined, "/Volumes/SSD/blackbox/"])).toBe("tests/test_x.py");
    expect(repoRelative("./blackbox/agent.py", [wt])).toBe("blackbox/agent.py");
    expect(repoRelative("D:\\work\\repo\\src\\a.ts", ["d:\\Work\\Repo"])).toBe("src/a.ts");
    // a sibling folder that merely shares the prefix isn't inside the root
    expect(repoRelative(`${wt}-other/x.py`, [wt])).toBe(`${wt}-other/x.py`.slice(1));
  });
});

describe("#328 crew checkouts live where orchestra's do", () => {
  it("on the same disk as ~/.loom they stay under it; a configured root wins", () => {
    const dir = path.join(loomHome(), "..", "proj-on-same-disk");
    expect(crewWorktreeRoot(path.dirname(loomHome()), "p1")).toBe(path.join(loomHome(), "crews", "p1"));
    expect(crewWorktreeRoot(dir, "p1", "../wt")).toBe(path.join(path.resolve(dir, "../wt", "p1"), "crews"));
  });
});
