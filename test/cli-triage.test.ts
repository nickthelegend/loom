import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ADES } from "../src/core/ades.js";
import { collectTriage, daemonLogTail, redactTriage, writeTriage } from "../src/cli/triage.js";
import { tmpDir } from "./helpers.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each([
  ['token=abc123 api_key="my secret"', ["abc123", "my secret"]],
  ['{"access_token":"tok-secret","apiKey":"key-secret"}', ["tok-secret", "key-secret"]],
  ['Authorization: Bearer abc.def.ghi', ["abc.def.ghi"]],
  ['loom send --token veryprivate --api-key abcdef', ["veryprivate", "abcdef"]],
  ['url?token=abc123&password=p4ssword', ["abc123", "p4ssword"]],
  ['key sk-123456789abcdef ghp_abcdefgh12345', ["sk-123456789abcdef", "ghp_abcdefgh12345"]],
  ['alice@example.com /Users/alice/project /home/bob/repo', ["alice@example.com", "alice", "bob"]],
  ['C:\\Users\\Alice\\repo and C:\\\\Users\\Bob\\\\repo', ["Alice", "Bob"]],
  ['-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----', ["secret"]],
  ['https://name:pass@example.com/test', ["name", "pass"]],
])("redacts %s", (input, secrets) => {
  const clean = redactTriage(input);
  for (const secret of secrets) expect(clean).not.toContain(secret);
});

it("redacts known secrets and home paths, leaving actionable failure text", () => {
  const result = redactTriage("\u001b[31mEADDRINUSE at /custom/home/project:12 opaque-value", { home: "/custom/home", secrets: ["opaque-value"] });
  expect(result).toBe("EADDRINUSE at ~/project:12 [REDACTED]");
});

it("collects exactly the last 200 lines, handles missing logs, and writes only redacted private Markdown", () => {
  const home = tmpDir("triage");
  vi.stubEnv("LOOM_HOME", home);
  expect(daemonLogTail()).toBe("(no daemon log)");
  fs.writeFileSync(path.join(home, "daemon.log"), Array.from({ length: 240 }, (_, i) => `line ${i} token=secret${i}`).join("\n") + "\n");
  const logs = daemonLogTail();
  expect(logs.split("\n")).toHaveLength(200);
  expect(logs.split("\n")[0]).toBe("line 40 token=secret40");
  const input = { logs, versions: { node: "v22", token: "version-secret" }, doctor: { detail: "alice@example.com failed" }, command: "loom send --key command-secret\n```" };
  const options = { now: new Date("2026-11-17T10:00:00Z") };
  const report = writeTriage(input, options);
  expect(report.file).toMatch(/triage-2026-11-17.*\.md$/);
  expect(fs.readFileSync(report.file, "utf8")).toBe(report.body);
  expect(report.body).not.toMatch(/secret|alice@example/);
  expect(report.body).toContain("````text");
  expect(report.body).toContain("v22");
  if (process.platform !== "win32") expect(fs.statSync(report.file).mode & 0o777).toBe(0o600);
  expect(writeTriage(input, options).file).not.toBe(report.file);
});

it("collects the real doctor report and versions with the daemon offline", async () => {
  const home = tmpDir("triage-offline");
  vi.stubEnv("LOOM_HOME", home);
  vi.stubEnv("PATH", tmpDir("triage-empty-path"));
  vi.stubEnv("SUPPORT_API_KEY", "opaque-support-credential");
  // Agent availability is outside the collector: never launch installed agent CLIs.
  for (const spec of ADES) if (spec.tier === "adapter") vi.spyOn(spec, "probe").mockResolvedValue(false);
  fs.writeFileSync(path.join(home, "daemon.log"), "Failed with opaque-support-credential\n");
  const report = await collectTriage(null, "loom send --token failing-secret");
  expect(report.body).toContain("never started");
  expect(report.body).toContain(process.version);
  expect(report.body).toContain('"daemon": null');
  expect(report.body).not.toContain("opaque-support-credential");
  expect(report.body).not.toContain("failing-secret");
  expect(fs.readFileSync(report.file, "utf8")).toBe(report.body);
  expect(fs.existsSync(path.join(home, "daemon.json"))).toBe(false);
});


it("retains 200 complete lines even when the recent log exceeds two megabytes", () => {
  const file = path.join(tmpDir("triage-large-log"), "daemon.log");
  fs.writeFileSync(file, Array.from({ length: 240 }, (_, i) => `${i} ${"x".repeat(11000)}`).join("\n"));
  const lines = daemonLogTail(file).split("\n");
  expect(lines).toHaveLength(200);
  expect(lines[0]).toBe(`40 ${"x".repeat(11000)}`);
  expect(lines[199]).toBe(`239 ${"x".repeat(11000)}`);
});
