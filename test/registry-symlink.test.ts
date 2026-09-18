/**
 * One folder, one project — however you reach it.
 *
 * A project reached through a symlink (every macOS temp dir: /var → /private/var)
 * used to register a second time, and the daemon ran two runtimes over one
 * .loom/. Both rows' engines appended to the same log, each blind to the other.
 */

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findProject, listProjects, registerProject } from "../src/core/registry.js";
import { tmpDir } from "./helpers.js";

beforeAll(() => {
  process.env.LOOM_HOME = tmpDir("home-symlink");
});

describe("registry · symlinked paths", () => {
  it("finds and re-registers a project by its real path", () => {
    const real = tmpDir("real-proj");
    const link = path.join(tmpDir("links"), "via-link");
    fs.symlinkSync(real, link);

    const first = registerProject(link, "linked");
    const second = registerProject(real, "linked");
    expect(second.id).toBe(first.id);
    expect(listProjects().filter((p) => p.name === "linked")).toHaveLength(1);
    expect(findProject(real)?.id).toBe(first.id);
    expect(findProject(fs.realpathSync(link))?.id).toBe(first.id);
  });

  it("still finds by id and name, and tolerates paths that don't exist", () => {
    const dir = tmpDir("plain-proj");
    const info = registerProject(dir, "plain-one");
    expect(findProject(info.id)?.dir).toBe(info.dir);
    expect(findProject("plain-one")?.id).toBe(info.id);
    expect(findProject("/definitely/not/here")).toBeUndefined();
  });
});
