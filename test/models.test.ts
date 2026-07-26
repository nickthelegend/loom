import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listModelsForKind } from "../src/daemon/server.js";
import { tmpDir } from "./helpers.js";

const previousPath = process.env.PATH;

afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  vi.restoreAllMocks();
});

describe("listModelsForKind", () => {
  it("parses and dedupes Grok's bulleted default-model output", async () => {
    const binDir = tmpDir("fake-grok-models");
    const grok = path.join(binDir, "grok");
    fs.writeFileSync(
      grok,
      "#!/bin/sh\nprintf '%s\\n' '  * grok-4.5 (default)' '  * grok-4.4' '  * grok-4.5 (default)'\n",
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);

    await expect(listModelsForKind("grok-code")).resolves.toEqual(["grok-4.5", "grok-4.4"]);
  });
});
