import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { feedbackBody, interviewAnswers, memoryLabels, memoryPaths, memoryQuery } from "../src/memory-model.ts";

describe("Loom 2.2 phone brain knowledge", () => {
  it("combines tags, usage sorting and existing filters without losing chat scope", () => {
    const route = memoryQuery({ q: "database", tag: "web & tests", sort: "usage", chat: "private/chat", kind: "fact", includeArchived: true });
    const query = new URLSearchParams(route.slice(route.indexOf("?") + 1));
    assert.equal(query.get("tag"), "web & tests"); assert.equal(query.get("sort"), "usage"); assert.equal(query.get("chat"), "private/chat"); assert.equal(query.get("includeArchived"), "1");
    assert.ok(route.startsWith("/search?"));
  });
  it("normalizes editable tags and preserves case-sensitive path globs", () => {
    assert.deepEqual(memoryLabels(" Tests, WEB, tests, "), ["tests", "web"]);
    assert.deepEqual(memoryPaths("src/Web/**, docs/**/*.md,src/Web/**"), ["src/Web/**", "docs/**/*.md"]);
    assert.deepEqual(memoryPaths(""), []);
    assert.throws(() => memoryLabels("x".repeat(101)));
    for (const path of ["/etc/*", "../secrets", "docs/../../*", "src\\web"]) assert.throws(() => memoryPaths(path));
  });
  it("saves only answered interview questions and rejects an empty interview", () => {
    assert.deepEqual(interviewAnswers(" npm test ", "ESM", ""), { tests: "npm test", conventions: "ESM" });
    assert.deepEqual(interviewAnswers("", "", " hardware/ "), { avoid: "hardware/" });
    assert.throws(() => interviewAnswers(" ", "", ""));
  });
  it("ties Helpful and Wrong feedback to the recorded turn", () => {
    assert.deepEqual(feedbackBody("helpful", 123), { value: "helpful", injection: 123 });
    assert.deepEqual(feedbackBody("wrong", 123), { value: "wrong", injection: 123 });
    for (const id of [0, -1, Infinity, 1.5]) assert.throws(() => feedbackBody("wrong", id));
  });
});
