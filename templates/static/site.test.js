import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("page has a language, title and landmark", () => { const page = readFileSync(new URL("index.html", import.meta.url), "utf8"); for (const marker of ['lang="en"', "<title>", "<main>"]) assert.ok(page.includes(marker)); });
