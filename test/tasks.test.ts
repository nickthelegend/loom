/**
 * Sorting gh's failures into something a setup panel can say honestly.
 *
 * The strings below are what gh actually printed when probed — not invented.
 * The bug this guards: every non-auth failure used to be reported as "no
 * GitHub remote" with a hardcoded detail, so a network timeout on a repo that
 * plainly had a remote told the user to add one.
 */

import { describe, expect, it } from "vitest";
import { classifyGhFailure } from "../src/daemon/tasks.js";

describe("classifyGhFailure", () => {
  it("calls a missing remote a missing remote", () => {
    const r = classifyGhFailure("no git remotes found");
    expect(r.reason).toBe("no-remote");
    expect(r.detail).toBe("no git remotes found");
  });

  it("treats a non-git directory as no remote", () => {
    const r = classifyGhFailure(
      "failed to run git: fatal: not a git repository (or any of the parent directories): .git",
    );
    expect(r.reason).toBe("no-remote");
  });

  it("does not mistake a non-GitHub remote for being signed out", () => {
    // gh's own words here mention `gh auth login`, so a naive auth check
    // reports a GitLab remote as "signed out" and sends you to log in again
    const r = classifyGhFailure(
      "none of the git remotes configured for this repository point to a known GitHub host. " +
        "To tell gh about a new GitHub host, please use `gh auth login`",
    );
    expect(r.reason).toBe("no-remote");
  });

  it("recognises being signed out", () => {
    for (const msg of [
      "To get started with GitHub CLI, please run:  gh auth login",
      "error: not logged in to any hosts",
      "HTTP 401: Bad credentials",
    ]) {
      expect(classifyGhFailure(msg).reason, msg).toBe("no-auth");
    }
  });

  it("never blames a missing remote for a failure it doesn't recognise", () => {
    // the actual bug: these all used to render "No GitHub remote — add one"
    for (const msg of [
      "Command failed with ETIMEDOUT",
      "error connecting to api.github.com",
      "HTTP 500: Internal Server Error",
      "GraphQL: Could not resolve to a Repository with the name 'me/private-repo'. (repository)",
      "HTTP 403: API rate limit exceeded",
    ]) {
      const r = classifyGhFailure(msg);
      expect(r.reason, msg).toBe("error");
      // and it carries gh's own words rather than a guess
      expect(r.detail, msg).toContain(msg.slice(0, 12));
    }
  });

  it("shows the cause, not the help text gh appends after it", () => {
    const r = classifyGhFailure("no git remotes found\n\nUsage:  gh repo view [<repository>] [flags]\n\nFlags:");
    expect(r.detail).toBe("no git remotes found");
  });
});
