import { test } from "node:test";
import assert from "node:assert/strict";
import { greet } from "./cli.js";
test("greets and explains usage", () => { assert.equal(greet([]), "Hello, world!"); assert.equal(greet(["Loom"]), "Hello, Loom!"); assert.match(greet(["--help"]), /Usage:/); });
