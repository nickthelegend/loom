/**
 * Linear, with its one external dependency — the GraphQL endpoint — mocked. The
 * point isn't to test Linear's server; it's to prove that no key degrades
 * honestly, that the key is read from the environment (never hard-coded), that
 * an auth failure is named as one, and that the create path validates before it
 * ever reaches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linearCreateIssue, linearTeams, listLinearIssues } from "../src/daemon/linear.js";

const KEY = "lin_api_test_key";

/** A fetch that answers with `data` (or `errors`) and records the call. */
function mockFetch(payload: { data?: unknown; errors?: { message: string }[]; ok?: boolean }) {
  const fn = vi.fn(async () => ({
    ok: payload.ok ?? true,
    status: payload.ok === false ? 401 : 200,
    json: async () => ({ data: payload.data, errors: payload.errors }),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LINEAR_API_KEY;
});

describe("linear · no key configured", () => {
  beforeEach(() => {
    delete process.env.LINEAR_API_KEY;
  });

  it("degrades to no-key without touching the network", async () => {
    const fetchSpy = mockFetch({ data: {} });
    const teams = await linearTeams();
    expect(teams).toEqual(expect.objectContaining({ available: false, reason: "no-key" }));
    const issues = await listLinearIssues();
    expect(issues).toEqual(expect.objectContaining({ available: false, reason: "no-key" }));
    expect(fetchSpy, "no key means no request").not.toHaveBeenCalled();
  });
});

describe("linear · with a key", () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = KEY;
  });

  it("lists teams and sends the key in the Authorization header", async () => {
    const fetchSpy = mockFetch({
      data: { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }] } },
    });
    const res = await linearTeams();
    expect(res).toEqual({ available: true, teams: [{ id: "t1", key: "ENG", name: "Engineering" }] });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(KEY);
    expect(init.method).toBe("POST");
  });

  it("maps issues onto a flat shape", async () => {
    mockFetch({
      data: {
        issues: {
          nodes: [
            {
              id: "i1",
              identifier: "ENG-1",
              title: "Fix the thing",
              url: "https://linear.app/x/ENG-1",
              updatedAt: "2026-07-18T00:00:00Z",
              state: { name: "In Progress" },
              assignee: { name: "Nivesh" },
            },
          ],
        },
      },
    });
    const res = await listLinearIssues("t1");
    expect(res).toEqual({
      available: true,
      issues: [
        {
          id: "i1",
          identifier: "ENG-1",
          title: "Fix the thing",
          url: "https://linear.app/x/ENG-1",
          updatedAt: "2026-07-18T00:00:00Z",
          state: "In Progress",
          assignee: "Nivesh",
        },
      ],
    });
  });

  it("names an auth failure as one, not a generic error", async () => {
    mockFetch({ errors: [{ message: "Authentication required" }] });
    const res = await linearTeams();
    expect(res).toEqual(expect.objectContaining({ available: false, reason: "auth" }));
  });

  it("creates an issue and returns its identifier", async () => {
    const fetchSpy = mockFetch({
      data: {
        issueCreate: {
          success: true,
          issue: { id: "i9", identifier: "ENG-9", title: "New", url: "https://linear.app/x/ENG-9" },
        },
      },
    });
    const res = await linearCreateIssue({ teamId: "t1", title: "New", description: "body" });
    expect(res).toEqual({
      available: true,
      issue: { id: "i9", identifier: "ENG-9", title: "New", url: "https://linear.app/x/ENG-9" },
    });
    // the mutation carried the team and title
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { variables: { input: Record<string, unknown> } };
    expect(body.variables.input).toEqual(expect.objectContaining({ teamId: "t1", title: "New", description: "body" }));
  });

  it("validates before the network: no team, no title", async () => {
    const fetchSpy = mockFetch({ data: {} });
    expect(await linearCreateIssue({ teamId: "", title: "x" })).toEqual(
      expect.objectContaining({ available: false }),
    );
    expect(await linearCreateIssue({ teamId: "t1", title: "  " })).toEqual(
      expect.objectContaining({ available: false }),
    );
    expect(fetchSpy, "rejected before any request").not.toHaveBeenCalled();
  });
});
