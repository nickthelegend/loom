/**
 * Pictures attached to a prompt, picked out for harnesses that take images
 * natively (Claude image blocks, Codex localImage, OpenCode files).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { attachedImages } from "../src/providers/attachments.js";
import { tmpDir } from "./helpers.js";

describe("attachedImages", () => {
  it("finds attachment lines anywhere in the turn text, and only real images in .loom/attachments", () => {
    const dir = tmpDir("att");
    fs.mkdirSync(path.join(dir, ".loom", "attachments"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".loom", "attachments", "abc.png"), "png");
    fs.writeFileSync(path.join(dir, "secret.png"), "nope");
    const text = [
      "## briefing", "earlier context",
      "[image] .loom/attachments/abc.png",
      "[image] .loom/attachments/missing.png",
      "[image] .loom/attachments/../../secret.png",
      "[image] .loom/attachments/abc.png",
      "what colours are in this?",
    ].join("\n");
    const got = attachedImages(text, dir);
    expect(got.map((g) => [g.rel, g.mime])).toEqual([[".loom/attachments/abc.png", "image/png"]]);
    expect(got[0]!.abs).toBe(fs.realpathSync(path.join(dir, ".loom", "attachments", "abc.png")));
  });

  it("finds nothing without a folder or an attachments directory", () => {
    expect(attachedImages("[image] .loom/attachments/a.png", undefined)).toEqual([]);
    expect(attachedImages("[image] .loom/attachments/a.png", tmpDir("att-empty"))).toEqual([]);
  });
});
