import { EventEmitter } from "node:events";
import { ChatPresenceTracker } from "../src/daemon/presence.js";
import { createShare, revokeShare } from "../src/core/shares.js";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpDir } from "./helpers.js";
import { publishShared, readShared, sharedLibrary, localRecipeOptions } from "../src/core/teams-r4/library.js";
import { savePrompt } from "../src/core/prompts.js";
import { saveOrchestraRecipe } from "../src/core/orchestra-options.js";
import { acceptsPasscode, addAnnotation, configureLink, linkDetails, linkStats, moderateAnnotation, recordOpen, MAX_LINK_COMMENTS } from "../src/core/teams-r4/links.js";
import { buildHandoff, buildStandup, sinceTime } from "../src/core/teams-r4/activity.js";
import { sharePage } from "../src/core/teams-r4/page.js";
import type { LoomEvent } from "../src/types.js";
let dir: string;
beforeEach(() => { process.env.LOOM_HOME = tmpDir("r4-core-home"); dir = tmpDir("r4-core-repo"); });
const message = (id: number, text: string, kind: LoomEvent["kind"] = "message", payload = {}): LoomEvent => ({ id, ts: id * 1000, kind, chat: "main", payload: { text, author: "user", ...payload } });

describe("repo libraries", () => {
  it("publishes personal templates and Orchestra recipes to portable files, then reads a teammate's copy", () => {
    savePrompt({ title: "Explain", text: "Explain {{topic}}" });
    saveOrchestraRecipe("Build", { goal: "Implement it", workers: ["echo"], maxUsd: 2, chat: "private", webhookUrl: "https://private.example/secret" });
    expect(publishShared(dir, "templates", "Explain").path).toBe(".loom/shared/templates/Explain.md");
    publishShared(dir, "recipes", "Build");
    const clone = tmpDir("r4-clone"); fs.cpSync(path.join(dir, ".loom"), path.join(clone, ".loom"), { recursive: true });
    expect(readShared(clone, "templates", "Explain")).toMatchObject({ text: "Explain {{topic}}", variables: ["topic"], source: "team" });
    const recipe = readShared(clone, "recipes", "Build");
    expect(recipe.options).toEqual({ goal: "Implement it", workers: ["echo"], maxUsd: 2, team: false });
    expect(localRecipeOptions(recipe, [{ id: "bot", kind: "echo" }]).workers).toEqual(["echo"]);
    expect(() => localRecipeOptions(recipe, [])).toThrow(/aren't available locally.*echo/);
    expect(() => localRecipeOptions({ ...recipe, options: { goal: "build", workers: ["@missing"] } }, [])).toThrow(/fleet entry isn't available locally/);
  });
  it("refuses malicious paths, symlinks, malformed entries and personal-validator failures", () => {
    expect(() => publishShared(dir, "templates", "../outside", "no")).toThrow();
    expect(() => publishShared(dir, "templates", "empty", " ")).toThrow();
    expect(() => publishShared(dir, "templates", "large", "x".repeat(20001))).toThrow();
    publishShared(dir, "recipes", "valid", { goal: "ok", workers: ["echo"] });
    const folder = path.join(dir, ".loom/shared/recipes");
    fs.writeFileSync(path.join(folder, "evil.json"), JSON.stringify({ options: { goal: "x", planOnly: "yes" } }));
    fs.writeFileSync(path.join(folder, "limit.json"), JSON.stringify({ options: { goal: "x", maxUsd: -1 } }));
    fs.writeFileSync(path.join(folder, "syntax.json"), "{");
    const outside = path.join(tmpDir("r4-outside"), "secret"); fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(folder, "link.json"));
    const result = sharedLibrary(dir, "recipes"); expect(result.entries).toHaveLength(1); expect(result.errors).toHaveLength(4);
    expect(() => publishShared(dir, "recipes", "link", { goal: "overwrite" })).toThrow(/regular files/); expect(fs.readFileSync(outside, "utf8")).toBe("secret");
    const badRepo = tmpDir("r4-symlink"); fs.symlinkSync(path.dirname(outside), path.join(badRepo, ".loom"));
    expect(() => publishShared(badRepo, "templates", "oops", "overwrite")).toThrow(/symlinks/);
  });
});
it("hashes passcodes, counts opens once per request, and caps submissions even after moderation", () => {
  configureLink("a", { passcode: "correct horse", notifyFirstOpen: true, reviewer: "bob" });
  expect(JSON.stringify(linkDetails("a"))).not.toContain("correct horse"); expect(acceptsPasscode("a", "wrong")).toBe(false); expect(acceptsPasscode("a", "correct horse")).toBe(true);
  expect(recordOpen("a", 100)).toBe(true); expect(recordOpen("a", 200)).toBe(false); expect(linkStats("a")).toMatchObject({ views: 2, lastOpenedAt: 200, passcodeProtected: true }); expect(JSON.stringify(linkStats("a"))).not.toContain("salt");
  const review = addAnnotation("a", { name: "Bob", text: "Looks good", verdict: "approve" });
  expect(() => addAnnotation("a", { name: "Bob", text: "Again", verdict: "approve" })).toThrow(/already/);
  moderateAnnotation("a", review.id, "Thanks"); expect(linkDetails("a").annotations[0]!.reply).toBe("Thanks");
  for (let i = 1; i < MAX_LINK_COMMENTS; i++) { const a = addAnnotation("a", { name: "Bob", text: "Hi", messageId: 1 }); moderateAnnotation("a", a.id); }
  expect(() => addAnnotation("a", { name: "Bob", text: "Over limit", messageId: 1 })).toThrow(/limit/);
  expect(() => addAnnotation("b", { name: "Bob", text: "Good", verdict: "approve" })).toThrow(/does not accept/);
});
it("builds hand-offs and standups from existing history, with stable person grouping and duration validation", () => {
  const events = [message(1, "Build the feature"), message(2, "What branch?", "needs_input", { question: "Which target?" }), message(3, "", "orchestra", { phase: "landed", goal: "Feature" })];
  expect(buildHandoff(events, "feature", "@BoB", "Please continue")).toMatchObject({ branch: "feature", to: "bob", note: "Please continue", questions: ["Which target?"] });
  const feed = [{ id: "f", ts: 2000, type: "goal_started", github: "alice", content: { goal: "API" } }, { id: "m", ts: 3000, type: "pr_merged", github: "bob", meta: { number: 3 } }];
  const report = buildStandup([...feed, ...feed], events, 1500, "alice");
  expect(report.people.find(p => p.person === "alice")?.started).toEqual(["API"]); expect(report.people.find(p => p.person === "bob")?.merged).toEqual(["PR #3"]);
  expect(report.markdown).toContain("Waiting: Which target?"); expect(sinceTime("1d", 86400100)).toBe(100);
  for (const value of ["-1d", "forever", "0h", "91d"]) expect(() => sinceTime(value)).toThrow();
});
it("escapes changes, hand-offs and annotations, and uses nonce scripts without the replay's conflicting CSP", () => {
  configureLink("page", { changes: { branch: "<main>", files: [{ path: "<img>.ts", diff: "<script>alert(1)</script>" }] }, reviewer: "bob" });
  addAnnotation("page", { name: "<Bob>", text: "<img onerror=boom>", messageId: 1 });
  const p = sharePage(null, linkDetails("page"), [message(1, "<prompt>")], Date.now() + 10000);
  expect(p.html).not.toContain("&lt;prompt&gt;"); expect(p.html).not.toContain('name="messageId"'); expect(p.html).toContain("&lt;script&gt;"); expect(p.html).toContain("&lt;Bob&gt;"); expect(p.html).not.toContain("<img onerror"); expect(p.html).toContain("Request changes"); expect(p.csp).toContain("connect-src 'self'");
  const locked = sharePage(null, linkDetails("page"), [], Date.now() + 10000, true); expect(locked.html).toContain("Passcode required"); expect(locked.html).not.toContain("&lt;main&gt;");
});

it("preserves dollar replacement sequences verbatim in comments, handoffs and message labels", () => {
  const text = 'a$`b $& $$';
  const d = { views: 0, submissions: 1, annotations: [{ id: "a", at: 1, name: "Visitor", text }], handoff: { to: "bob", summary: text, branch: "main", note: "", questions: [] } };
  const page = sharePage('<!doctype html><html><head></head><body><main>Transcript</main></body></html>', d, [message(1, text)], Date.now() + 10000);
  expect(page.html.match(/<!doctype/gi)).toHaveLength(1);
  expect(page.html.match(/a\$`b \$&amp; \$\$/g)).toHaveLength(3);
});


it("publishes owner views only while a guest follows, including first frames and chat switches", () => {
  const tracker = new ChatPresenceTracker<EventEmitter>(() => {});
  const owner = new EventEmitter(), guest = new EventEmitter();
  tracker.ownerSocket = socket => socket === owner;
  tracker.attach(owner); tracker.attach(guest);
  const send = (socket: EventEmitter, chat: string, fields: object, kind: "owner" | "guest") => {
    socket.emit("message", JSON.stringify({ type: "presence", chat, ...fields }));
    tracker.view(socket, "p", chat, { id: kind, name: kind, kind });
  };
  const ownerRow = (chat = "a") => tracker.snapshot("p", chat).people.find(p => p.kind === "owner");
  try {
    send(guest, "a", { following: false }, "guest");
    send(owner, "a", { view: { scroll: 0.1, file: "a.txt", preview: "private content" } }, "owner");
    expect(ownerRow()).not.toHaveProperty("view");
    send(guest, "a", { following: true }, "guest");
    expect(ownerRow()?.view).toMatchObject({ scroll: 0.1, file: "a.txt" });
    send(guest, "a", { following: false }, "guest");
    expect(ownerRow()).not.toHaveProperty("view");
    send(guest, "a", { following: true }, "guest");
    tracker.remove(guest);
    expect(ownerRow()).not.toHaveProperty("view");
    // The first frame for a new owner socket must work with no earlier view() call.
    tracker.remove(owner); owner.emit("close"); tracker.attach(owner);
    send(guest, "a", { following: true }, "guest");
    send(owner, "a", { view: { scroll: 0.3 } }, "owner");
    expect(ownerRow()?.view?.scroll).toBe(0.3);
    tracker.remove(guest);
    send(guest, "b", { following: true }, "guest");
    send(owner, "b", { view: { scroll: 0.7, file: "b.txt" } }, "owner");
    expect(ownerRow("b")?.view).toMatchObject({ scroll: 0.7, file: "b.txt" });
    expect(ownerRow("a")).toBeUndefined();
  } finally { tracker.close(); }
});

it("drops revoked and expired payloads, retains annotations for 30 days, and loads legacy entries", () => {
  const now = Date.now(), payload = { changes: { branch: "main", files: [{ path: "a", diff: "private diff" }] }, handoff: { to: "bob", summary: "private summary", branch: "main", note: "", questions: [] }, passcode: "1234" };
  const { share } = createShare({ projectId: "p", chat: "main", title: "Review" });
  configureLink(share.id, { ...payload, expiresAt: share.expiresAt });
  const annotation = addAnnotation(share.id, { name: "Bob", text: "Keep this" });
  expect(revokeShare(share.id)).toBe(true);
  expect(linkDetails(share.id).annotations).toEqual([annotation]);
  expect(linkDetails(share.id)).not.toHaveProperty("changes");
  expect(linkDetails(share.id)).not.toHaveProperty("handoff");
  expect(linkDetails(share.id)).not.toHaveProperty("passcode");
  configureLink("expired", { ...payload, expiresAt: now - 1 });
  configureLink("old", { ...payload, expiresAt: now - 31 * 86400000 });
  configureLink("legacy", payload);
  const stored = JSON.parse(fs.readFileSync(path.join(process.env.LOOM_HOME!, "teams-r4-links.json"), "utf8"));
  expect(stored.expired).not.toHaveProperty("changes"); expect(stored.expired).not.toHaveProperty("handoff"); expect(stored.expired).not.toHaveProperty("passcode");
  expect(stored).not.toHaveProperty("old"); expect(stored.legacy.changes).toEqual(payload.changes);
  moderateAnnotation(share.id, annotation.id, "Still moderated");
  expect(linkDetails(share.id).annotations[0]?.reply).toBe("Still moderated");
});

it("caches link data until its file changes, and does not leak mutations from failed validation", () => {
  configureLink("cached", { notifyFirstOpen: true });
  const file = path.join(process.env.LOOM_HOME!, "teams-r4-links.json");
  const read = vi.spyOn(fs, "readFileSync");
  try {
    for (let i = 0; i < 10; i++) linkDetails("cached");
    expect(read).not.toHaveBeenCalled();
    fs.writeFileSync(file, JSON.stringify({ cached: { views: 42, submissions: 0, annotations: [] } }));
    expect(linkDetails("cached").views).toBe(42);
    expect(read).toHaveBeenCalledTimes(1);
    linkDetails("cached"); expect(read).toHaveBeenCalledTimes(1);
    expect(() => configureLink("cached", { passcode: "1234", notifyFirstOpen: "bad" })).toThrow();
    expect(linkDetails("cached")).not.toHaveProperty("passcode");
  } finally { read.mockRestore(); }
});

it("retains expired annotations for moderation then removes the entry after thirty days", () => {
  const now = Date.now();
  configureLink("retention", { expiresAt: now + 1000, changes: { branch: "main", files: [{ path: "a", diff: "private" }] } });
  const annotation = addAnnotation("retention", { name: "Bob", text: "Retain" });
  const time = vi.spyOn(Date, "now").mockReturnValue(now + 2000);
  try {
    configureLink("trigger", {});
    expect(linkDetails("retention")).not.toHaveProperty("changes");
    expect(linkDetails("retention").annotations).toEqual([annotation]);
    moderateAnnotation("retention", annotation.id, "Reply after expiry");
    expect(linkDetails("retention").annotations[0]?.reply).toBe("Reply after expiry");
    time.mockReturnValue(now + 31 * 86400000);
    configureLink("trigger", {});
    const all = JSON.parse(fs.readFileSync(path.join(process.env.LOOM_HOME!, "teams-r4-links.json"), "utf8"));
    expect(all).not.toHaveProperty("retention");
  } finally { time.mockRestore(); }
});
