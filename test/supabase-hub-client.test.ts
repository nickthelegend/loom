/**
 * The hosted hub client, offline: the loopback OAuth callback (D65), the
 * session hand-off (refresh tokens rotate, so every new one must reach
 * team.json), error mapping, and snake_case rows → MemoryHub's shapes.
 *
 * A fake Supabase (a tiny HTTP server speaking the few auth + PostgREST
 * endpoints involved) stands in for the real one; the live two-member run is
 * test/supabase-hub-live.test.ts.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hostedHubUrl, hostedSupabaseUrl, hostedTarget, HOSTED_SUPABASE_URL, publishableKeyFor } from "../src/core/hosted.js";
import { HubError, LEASE_TTL_MS } from "../src/core/team-hub.js";
import {
  hostedSignIn,
  hubErrorFrom,
  loopbackSignIn,
  mapFeed,
  mapLease,
  mapMemory,
  mapPresence,
  ms,
  SupabaseHubClient,
  type HostedSession,
  codeFromPasted,
} from "../src/hub/supabase-client.js";

// ---------------------------------------------------------------------------
// A fake Supabase
// ---------------------------------------------------------------------------

const USER_ID = "11111111-2222-4333-8444-555555555555";
let fake: http.Server;
let fakeUrl = "";
const seen: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
let refreshCount = 0;

function session(access: string, refresh: string) {
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: USER_ID, aud: "authenticated", role: "authenticated", email: "a@example.com", app_metadata: {}, user_metadata: { user_name: "alice" }, created_at: new Date().toISOString() },
  };
}

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ method: req.method ?? "", path: url.pathname + url.search, body });
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
        if (body.auth_code !== "good-code" || !body.code_verifier) return json(400, { error: "invalid_grant", error_description: "bad code" });
        return json(200, session("access-1", "refresh-1"));
      }
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
        if (body.refresh_token === "spent") return json(400, { code: "refresh_token_already_used", error: "invalid_grant", msg: "Invalid Refresh Token: Already Used" });
        refreshCount++;
        return json(200, session(`access-r${refreshCount}`, `refresh-r${refreshCount}`));
      }
      if (url.pathname === "/rest/v1/profiles") {
        if (req.headers.authorization !== `Bearer access-r${refreshCount}` && req.headers.authorization !== "Bearer access-1") {
          return json(401, { code: "PGRST301", message: "JWT invalid" });
        }
        return json(200, [{ user_id: USER_ID, github: "alice", name: "" }]);
      }
      if (url.pathname === "/rest/v1/rpc/create_team") {
        return json(403, { code: "42501", message: "not signed in", details: null, hint: null });
      }
      json(404, { message: "not faked" });
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

afterAll(() => {
  fake?.closeAllConnections?.();
  fake?.close();
});

// ---------------------------------------------------------------------------

describe("the loopback OAuth callback", () => {
  it("hands out a 127.0.0.1 redirect, trades the code, and tells the tab to close", async () => {
    let redirect = "";
    let traded = "";
    let page = "";
    const out = await loopbackSignIn({
      start: async (redirectTo) => {
        redirect = redirectTo;
        // the "browser": first a stray request, then the real redirect
        expect((await fetch(redirectTo.replace("/callback", "/favicon.ico"))).status).toBe(404);
        expect((await fetch(redirectTo)).status).toBe(400); // no code yet: keeps waiting
        void fetch(`${redirectTo}?code=abc123&state=x`).then(async (r) => {
          page = await r.text();
        });
      },
      exchange: async (code) => {
        traded = code;
        return { ok: code };
      },
    });
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(traded).toBe("abc123");
    expect(out).toEqual({ ok: "abc123" });
    await new Promise((r) => setTimeout(r, 50));
    expect(page).toContain("You can close this tab");
    // and the listener is gone
    await expect(fetch(redirect, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });

  it("an OAuth error from the provider fails the sign-in with its description", async () => {
    let page = "";
    const p = loopbackSignIn({
      start: (redirectTo) => {
        void fetch(`${redirectTo}?error=access_denied&error_description=${encodeURIComponent("The user denied <access>")}`).then(async (r) => {
          page = await r.text();
        });
      },
      exchange: async () => "never",
    });
    await expect(p).rejects.toMatchObject({ name: "HubError", status: 401, message: expect.stringContaining("The user denied") });
    await new Promise((r) => setTimeout(r, 50));
    expect(page).toContain("The user denied &lt;access&gt;"); // escaped
  });

  it("a code the exchanger rejects fails the sign-in", async () => {
    const p = loopbackSignIn({
      start: (redirectTo) => void fetch(`${redirectTo}?code=bad`).catch(() => {}),
      exchange: async () => {
        throw new Error("invalid grant");
      },
    });
    await expect(p).rejects.toMatchObject({ status: 401, message: expect.stringContaining("invalid grant") });
  });

  it("times out when nothing comes back", async () => {
    const t0 = Date.now();
    await expect(loopbackSignIn({ start: () => {}, exchange: async () => 1, timeoutMs: 150 })).rejects.toMatchObject({
      status: 408,
      message: expect.stringContaining("timed out"),
    });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a failure to open the browser closes the listener and surfaces", async () => {
    await expect(
      loopbackSignIn({
        start: () => {
          throw new Error("no browser");
        },
        exchange: async () => 1,
      }),
    ).rejects.toThrow("no browser");
  });
});

describe("hostedSignIn (PKCE through Supabase Auth)", () => {
  it("opens GitHub's authorize URL with a loopback redirect and a PKCE challenge, then exchanges the code", async () => {
    let authorize: URL | null = null;
    const s = await hostedSignIn({
      supabaseUrl: fakeUrl,
      publishableKey: "sb_publishable_test",
      openBrowser: (u) => {
        authorize = new URL(u);
        const redirect = authorize.searchParams.get("redirect_to")!;
        void fetch(`${redirect}?code=good-code`).catch(() => {});
      },
      timeoutMs: 10_000,
    });
    const a = authorize as unknown as URL;
    expect(a.origin + a.pathname).toBe(`${fakeUrl}/auth/v1/authorize`);
    expect(a.searchParams.get("provider")).toBe("github");
    expect(a.searchParams.get("redirect_to")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(a.searchParams.get("code_challenge")).toBeTruthy();
    expect(a.searchParams.get("code_challenge_method")?.toLowerCase()).toBe("s256");
    expect(s).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", userId: USER_ID });
    expect(s.expiresAt).toBeGreaterThan(Date.now());
    const exchange = seen.find((x) => x.path.includes("grant_type=pkce"))!;
    expect(exchange.body).toMatchObject({ auth_code: "good-code" });
    expect(String(exchange.body.code_verifier).length).toBeGreaterThan(40);
  });
});

describe("SupabaseHubClient sessions", () => {
  it("restores from a refresh token, and hands every rotated token to onSession", async () => {
    const sessions: HostedSession[] = [];
    const c = new SupabaseHubClient({ supabaseUrl: fakeUrl, publishableKey: "sb_publishable_test", refreshToken: "refresh-0", onSession: (s) => sessions.push(s) });
    const later: string[] = [];
    c.onSession((s) => later.push(s.refreshToken));
    expect(c.session()).toBeNull();
    const me = await c.me();
    expect(me).toEqual({ id: USER_ID, github: "alice", name: "alice" }); // empty name falls back to the login
    expect(sessions.map((s) => s.refreshToken)).toEqual([`refresh-r${refreshCount}`]);
    expect(later).toEqual([`refresh-r${refreshCount}`]);
    expect(c.session()?.userId).toBe(USER_ID);
    expect(seen.find((x) => x.path.includes("grant_type=refresh_token"))!.body).toEqual({ refresh_token: "refresh-0" });
    await c.close();
    await expect(c.me()).rejects.toMatchObject({ status: 400 });
  });

  it("a spent refresh token means signing in again (401)", async () => {
    const c = new SupabaseHubClient({ supabaseUrl: fakeUrl, publishableKey: "k", refreshToken: "spent" });
    await expect(c.me()).rejects.toMatchObject({ name: "HubError", status: 401, message: expect.stringContaining("sign in again") });
    await c.close();
  });

  it("rule-function errors surface as HubError with the Postgres message", async () => {
    const c = new SupabaseHubClient({ supabaseUrl: fakeUrl, publishableKey: "k", refreshToken: "refresh-x" });
    await expect(c.createTeam("Acme")).rejects.toMatchObject({ name: "HubError", status: 403, message: "not signed in" });
    await expect(c.createTeam("   ")).rejects.toMatchObject({ status: 400 });
    await c.close();
  });

  it("needs a session or a refresh token", () => {
    expect(() => new SupabaseHubClient({ supabaseUrl: fakeUrl, publishableKey: "k" })).toThrow(HubError);
  });
});

describe("mapping", () => {
  it("maps Postgres error codes to hub statuses", () => {
    expect(hubErrorFrom({ code: "42501", message: "needs owner rights" })).toMatchObject({ status: 403, message: "needs owner rights" });
    expect(hubErrorFrom({ code: "P0002", message: "not a member" }).status).toBe(404);
    expect(hubErrorFrom({ code: "40001", message: "key version 1 is stale" }).status).toBe(409);
    expect(hubErrorFrom({ code: "22023", message: "bad" }).status).toBe(400);
    expect(hubErrorFrom({ code: "PGRST301", message: "JWT expired" }).status).toBe(401);
    expect(hubErrorFrom(null, 500).message).toContain("500");
  });

  it("parses both PostgREST and Realtime timestamps to epoch ms", () => {
    const t = Date.UTC(2026, 8, 19, 10, 0, 0, 123);
    expect(ms("2026-09-19T10:00:00.123456+00:00")).toBe(t);
    expect(ms("2026-09-19 10:00:00.123456+00")).toBe(t);
    expect(ms("2026-09-19T10:00:00.123Z")).toBe(t);
    expect(ms("2026-09-19T12:00:00.123+02:00")).toBe(t);
    expect(ms(null)).toBe(0);
  });

  it("rows become exactly MemoryHub's shapes", () => {
    const ts = "2026-09-19T10:00:00.000+00:00";
    const lease = mapLease(
      { id: "l1", team_id: "t", user_id: "u", device_id: "d", repo: "acme/app", run_id: "r", task_id: "t1", globs: ["src/**"], files: [], prefixes: ["src/"], state: "active", sealed: null, since: ts, ts },
      "alice",
      Date.parse(ts) + LEASE_TTL_MS + 1,
    );
    expect(lease).toEqual({
      globs: ["src/**"], files: [], prefixes: ["src/"], id: "l1", teamId: "t", userId: "u", github: "alice", deviceId: "d",
      repo: "acme/app", runId: "r", taskId: "t1", state: "active", since: Date.parse(ts), ts: Date.parse(ts), stale: true,
    });
    expect(mapFeed({ id: "7", team_id: "t", repo: null, user_id: null, type: "member_joined", meta: { github: "bob" }, sealed: null, device_id: null, sig: null, dedupe_key: null, ts }, null)).toEqual({
      type: "member_joined", meta: { github: "bob" }, id: 7, teamId: "t", userId: null, github: null, ts: Date.parse(ts),
    });
    expect(mapPresence({ team_id: "t", user_id: "u", device_id: "d", repo: "acme/app", agent: "codex#1", kind: "codex", run_id: null, task_id: "t1", branch: null, touches: ["a"], state: "running", since: ts, sealed: { v: 1, c: "x" }, sig: null, ts }, "alice")).toEqual({
      deviceId: "d", repo: "acme/app", taskId: "t1", agent: "codex#1", kind: "codex", touches: ["a"], state: "running", since: Date.parse(ts),
      sealed: { v: 1, c: "x" }, teamId: "t", userId: "u", github: "alice", ts: Date.parse(ts),
    });
    expect(mapMemory({ id: "m1", team_id: "t", repo: "acme/app", author_id: "u", author: "alice", hmac: "h", sealed: { v: 1, c: "x" }, state: "live", supersedes: null, superseded_by: null, resolved_by: null, resolved_reason: null, confirmed_by: ["alice"], created_at: ts, updated_at: ts })).toEqual({
      id: "m1", teamId: "t", repo: "acme/app", authorId: "u", author: "alice", hmac: "h", sealed: { v: 1, c: "x" }, state: "live",
      confirmedBy: ["alice"], createdAt: Date.parse(ts), updatedAt: Date.parse(ts),
    });
  });
});

describe("the hosted hub constants", () => {
  it("no URL, 'hosted', the project URL and supabase:<url> all mean the hosted hub; anything else is self-hosted", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(hostedSupabaseUrl("", env)).toBe(HOSTED_SUPABASE_URL);
    expect(hostedSupabaseUrl(undefined, env)).toBe(HOSTED_SUPABASE_URL);
    expect(hostedSupabaseUrl("hosted", env)).toBe(HOSTED_SUPABASE_URL);
    expect(hostedSupabaseUrl(HOSTED_SUPABASE_URL + "/", env)).toBe(HOSTED_SUPABASE_URL);
    expect(hostedSupabaseUrl("supabase:https://x.supabase.co", env)).toBe("https://x.supabase.co");
    expect(hostedSupabaseUrl("http://127.0.0.1:7777", env)).toBeNull();
    expect(hostedHubUrl(HOSTED_SUPABASE_URL)).toBe(`supabase:${HOSTED_SUPABASE_URL}`);
  });

  it("env overrides the project", () => {
    const env = { LOOM_SUPABASE_URL: "https://mine.supabase.co/", LOOM_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_mine" } as NodeJS.ProcessEnv;
    expect(hostedTarget(env)).toEqual({ supabaseUrl: "https://mine.supabase.co", publishableKey: "sb_publishable_mine" });
    expect(hostedSupabaseUrl("", env)).toBe("https://mine.supabase.co");
    expect(publishableKeyFor("https://mine.supabase.co", env)).toBe("sb_publishable_mine");
  });
});

describe("paste-the-URL sign-in on a machine without a browser (D74)", () => {
  it("finds the code in a full address, a query string, or on its own; surfaces GitHub's refusal", () => {
    expect(codeFromPasted("http://127.0.0.1:1/loom-signin?code=abc123-def_456")).toBe("abc123-def_456");
    expect(codeFromPasted("  ?state=x&code=zz%2Fyy  ")).toBe("zz/yy");
    expect(codeFromPasted("9f8e7d6c5b4a")).toBe("9f8e7d6c5b4a");
    expect(codeFromPasted("")).toBeNull();
    expect(codeFromPasted("hello there")).toBeNull();
    expect(() => codeFromPasted("http://127.0.0.1:1/loom-signin?error=access_denied&error_description=The+user+denied")).toThrow("The user denied");
  });
});

