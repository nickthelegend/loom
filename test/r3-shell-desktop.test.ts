import { expect, it } from "vitest";
// @ts-expect-error desktop modules are plain ESM JavaScript.
import { readShortcuts } from "../desktop/shortcuts.js";

it("accepts validated per-device bindings from Loom, including disabled commands", () => {
  const bindings = { palette: "CmdOrCtrl+j", "new-chat": "", "tab:brain": "CmdOrCtrl+Shift+6" };
  expect(readShortcuts(bindings, "http://127.0.0.1:7420/app?pane=a", "http://127.0.0.1:7420")).toEqual(bindings);
});
it("refuses other origins, preview paths and malformed native accelerators", () => {
  const origin = "http://127.0.0.1:7420";
  for (const url of ["http://127.0.0.1.evil/app", "http://127.0.0.1:9999/app", origin + "/preview", "bad"]) {
    expect(readShortcuts({ palette: "Ctrl+j" }, url, origin)).toBeNull();
  }
  for (const bindings of [null, [], { palette: 7 }, { palette: "require('fs')" }, { palette: "CmdOrCtrl+" }, { palette: "a" }]) {
    expect(readShortcuts(bindings, origin + "/app", origin)).toBeNull();
  }
});
