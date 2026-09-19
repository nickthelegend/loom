/**
 * Loom Teams, Phase 5 — the pure parts: a runner's scrubbed environment and
 * container command (D70), its service file and token checks (D77, D78),
 * deploy events and release notes (D72), and the policy fields (D68, D70).
 */

import { describe, expect, it } from "vitest";

import { serviceFile, tokenFindings } from "../src/core/runner-setup.js";
import { OPEN_POLICY, parsePolicy, stricter } from "../src/core/team-policy.js";
import { deployEvent, prNumbersFromLog, renderReleaseNotes } from "../src/daemon/deploys.js";
import { dockerCommand, progressOf, scrubEnv } from "../src/daemon/runner.js";

describe("the runner's trust tier (D70)", () => {
  it("keeps agent keys and the GitHub token, drops everything secret-shaped", () => {
    const { env, removed } = scrubEnv({
      PATH: "/usr/bin",
      HOME: "/home/loom",
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "o",
      GH_TOKEN: "g",
      LOOM_HOME: "/loom",
      AWS_SECRET_ACCESS_KEY: "x",
      DATABASE_URL: "postgres://prod",
      STRIPE_SECRET_KEY: "sk",
      SENTRY_DSN: "d",
      MY_PASSWORD: "p",
      NPM_TOKEN: "n",
    });
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "GH_TOKEN", "HOME", "LOOM_HOME", "OPENAI_API_KEY", "PATH"]);
    expect(removed).toEqual(["AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "MY_PASSWORD", "NPM_TOKEN", "SENTRY_DSN", "STRIPE_SECRET_KEY"]);
  });

  it("a goal's container gets its own home and read-only agent logins, nothing else", () => {
    const args = dockerCommand({ jobId: "j1", teamId: "t1", image: "loom-runner", jobHome: "/runner/jobs/j1", home: "/nonexistent-home" });
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--name", "loom-job-j1"]);
    expect(args).toContain("/runner/jobs/j1:/loom");
    expect(args.slice(-7)).toEqual(["loom", "runner", "exec", "--job", "j1", "--team", "t1"]);
    expect(args.join(" ")).not.toMatch(/--privileged|docker\.sock|--network host/);
    // secrets pass by name only — the one value on the command line is the container's own home
    expect(args.filter((x) => x.includes("="))).toEqual(["LOOM_HOME=/loom"]);
  });

  it("a job's progress snapshot carries status, tasks, cost and landing — never transcripts", () => {
    const p = progressOf(undefined, "Add rate limiting\nmore detail");
    expect(p).toMatchObject({ runId: null, goal: "Add rate limiting", status: "preparing", tasks: [], costUsd: 0, landing: null });
  });
});

describe("setting up a runner (D77, D78)", () => {
  it("writes a launchd agent on macOS and a systemd user unit elsewhere", () => {
    const mac = serviceFile({ platform: "darwin", home: "/Users/a", node: "/usr/bin/node", loom: "/opt/loom/cli.js" });
    expect(mac.path).toBe("/Users/a/Library/LaunchAgents/dev.loom.runner.plist");
    expect(mac.content).toContain("<string>/usr/bin/node</string><string>/opt/loom/cli.js</string><string>daemon</string>");
    expect(mac.content).toContain("<key>KeepAlive</key><true/>");
    const linux = serviceFile({ platform: "linux", home: "/home/a", node: "/usr/bin/node", loom: "/opt/loom/cli.js", loomHome: "/srv/loom" });
    expect(linux.path).toBe("/home/a/.config/systemd/user/loom-runner.service");
    expect(linux.content).toContain("ExecStart=/usr/bin/node /opt/loom/cli.js daemon");
    expect(linux.content).toContain("Environment=LOOM_HOME=/srv/loom");
    expect(linux.enable.at(-1)).toEqual(["systemctl", "--user", "enable", "--now", "loom-runner.service"]);
  });

  it("warns about tokens that can do more than push to the shared repos", () => {
    expect(tokenFindings({ present: false, scopes: [], repos: {} })[0]!.level).toBe("warn");
    const classic = tokenFindings({ present: true, scopes: ["repo", "read:org"], repos: { "acme/app": { admin: false, push: true } } });
    expect(classic[0]).toMatchObject({ level: "warn" });
    expect(classic[0]!.fix).toContain("repo");
    const fine = tokenFindings({ present: true, scopes: [], repos: { "acme/app": { admin: true, push: true }, "acme/web": null, "acme/api": { admin: false, push: false } } });
    expect(fine.map((f) => f.level)).toEqual(["ok", "warn", "error", "error"]);
  });
});

describe("deploys and release notes (D72)", () => {
  it("maps deployment states to feed events", () => {
    const d = { id: 1, environment: "prod", sha: "abc", ref: "main", creator: null, url: null, at: 0 };
    expect(deployEvent({ ...d, state: "in_progress" })).toBe("deploy_started");
    expect(deployEvent({ ...d, state: "success" })).toBe("deploy_succeeded");
    expect(deployEvent({ ...d, state: "error" })).toBe("deploy_failed");
    expect(deployEvent({ ...d, state: "inactive" })).toBeNull();
  });

  it("finds PRs in merge and squash commit subjects", () => {
    expect(prNumbersFromLog("Merge pull request #41 from x/y\nfeat: stuff (#39)\nchore: no pr\nMerge pull request #41 from x/y")).toEqual([41, 39]);
  });

  it("groups notes by member and marks Loom goals", () => {
    const md = renderReleaseNotes("v1.0.0", "main", [
      { pr: 3, title: "Add login", author: "alice", url: "https://x/3", mergedAt: null, loom: true, summary: "Login with\nGitHub." },
      { pr: 4, title: "Fix typo", author: "bob", url: "https://x/4", mergedAt: null, loom: false },
      { pr: 5, title: "Add logout", author: "alice", url: "https://x/5", mergedAt: null, loom: true },
    ]);
    expect(md).toContain("3 pull requests merged into main.");
    expect(md.indexOf("### @alice")).toBeLessThan(md.indexOf("### @bob"));
    expect(md).toContain("- Add login ([#3](https://x/3)) · _Loom goal_\n  Login with GitHub.");
    expect(renderReleaseNotes("v2", "main", [])).toContain("Nothing merged since v2.");
  });
});

describe("runner policy (D68, D70)", () => {
  it("shared runners are off unless the reviewed policy allows them; the ceiling caps runners", () => {
    expect(OPEN_POLICY.runners).toEqual({ shared: false, permissions: "bypass" });
    const p = parsePolicy({ runners: { shared: true, permissions: "auto" } });
    expect(p.runners).toEqual({ shared: true, permissions: "auto" });
    expect(stricter(p, parsePolicy({ runners: { shared: true, permissions: "ask" } })).runners).toEqual({ shared: true, permissions: "ask" });
    expect(stricter(p, parsePolicy({ runners: { shared: false } })).runners.shared).toBe(false);
  });
});
