import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpDir } from "./helpers.js";

// Opt in with LOOM_TEST_POSTGRES=1 for a private Unix-socket-only cluster, or
// LOOM_PGLITE_PATH=/path/to/@electric-sql/pglite for PostgreSQL compiled to WASM.
describe.skipIf(process.env.LOOM_TEST_POSTGRES !== "1" && !process.env.LOOM_PGLITE_PATH)("#424 hosted hub migration", () => {
  let bin: string, dir: string, socket: string, started = false;
  let embedded: { exec(sql: string): Promise<Array<{ rows: Array<Record<string, unknown>> }>>; close(): Promise<void> } | undefined;
  const sql = async (text: string): Promise<string> => {
    if (embedded) return (await embedded.exec(text)).flatMap(r => r.rows.map(row => Object.values(row).map(v => typeof v === "object" ? JSON.stringify(v) : v === true ? "t" : v === false ? "f" : String(v)).join("|"))).join("\n");
    return execFileSync(path.join(bin, "psql"), ["-X", "-h", socket, "-p", "55424", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", text], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  };
  const a = "00000000-0000-0000-0000-000000000001", b = "00000000-0000-0000-0000-000000000002", outsider = "00000000-0000-0000-0000-000000000003", team = "10000000-0000-0000-0000-000000000001";
  const as = (id: string, text: string) => sql(`set role authenticated; set request.jwt.claim.sub = '${id}'; ${text}`);
  beforeAll(async () => {
    if (process.env.LOOM_PGLITE_PATH) {
      const require = createRequire(import.meta.url), pkg = process.env.LOOM_PGLITE_PATH;
      const { PGlite } = require(path.join(pkg, "dist/index.cjs"));
      const { pgcrypto } = require(path.join(pkg, "dist/contrib/pgcrypto.cjs"));
      embedded = new PGlite({ extensions: { pgcrypto } });
    } else {
      bin = execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim(); dir = tmpDir("r3-pg"); socket = path.join(dir, "socket"); fs.mkdirSync(socket);
      execFileSync(path.join(bin, "initdb"), ["-D", path.join(dir, "data"), "-A", "trust", "--no-locale"], { stdio: "pipe" });
      execFileSync(path.join(bin, "pg_ctl"), ["-D", path.join(dir, "data"), "-l", path.join(dir, "postgres.log"), "-o", `-k ${socket} -h '' -p 55424`, "-w", "start"], { stdio: "pipe" }); started = true;
    }
    await sql(`create role anon; create role authenticated; create schema auth; create schema extensions;
      create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
      grant usage on schema auth to authenticated;`);
    await sql(fs.readFileSync("supabase/migrations/0002_teams.sql", "utf8"));
    await sql(fs.readFileSync("supabase/migrations/0015_teams_sharing.sql", "utf8"));
    await sql(`insert into auth.users values ('${a}', '{"user_name":"alice"}'), ('${b}', '{"user_name":"bob"}'), ('${outsider}', '{"user_name":"charlie"}');
      insert into teams(id,name) values ('${team}','r3');
      insert into team_members(team_id,user_id,role) values ('${team}','${a}','owner'), ('${team}','${b}','member');
      insert into team_repos(team_id,repo) values ('${team}','acme/app');`);
  }, 30_000);
  afterAll(async () => { await embedded?.close(); if (started) execFileSync(path.join(bin, "pg_ctl"), ["-D", path.join(dir, "data"), "-m", "immediate", "-w", "stop"], { stdio: "pipe" }); });

  it("allows members to read encrypted fleets and enforces authorship and membership", async () => {
    await as(a, `select put_team_fleet('${team}', 'fleet', '{"v":1,"c":"encrypted"}');`);
    expect(await as(b, `select list_team_fleets('${team}')->0->>'name';`)).toContain("fleet");
    await expect(as(b, `select put_team_fleet('${team}', 'fleet', '{"v":1,"c":"replace"}');`)).rejects.toThrow(/author/);
    await expect(as(outsider, `select list_team_fleets('${team}');`)).rejects.toThrow(/member/);
    await expect(as(b, "select * from team_fleets;")).rejects.toThrow(/permission denied/);
    await as(a, `select put_team_fleet('${team}', 'fleet', null);`); expect(await as(a, `select list_team_fleets('${team}');`)).toContain("[]");
  });
  it("revokes invites without exposing tokens and prevents redemption", async () => {
    const created = JSON.parse((await as(a, `select create_invite('${team}');`)).split("\n").at(-1)!);
    const invites = JSON.parse((await as(a, `select list_team_invites('${team}');`)).split("\n").at(-1)!);
    expect(JSON.stringify(invites)).not.toContain(created.invite);
    expect(await as(b, `select revoke_team_invite('${team}', '${invites[0].id}');`)).toMatch(/f$/);
    expect(await as(a, `select revoke_team_invite('${team}', '${invites[0].id}');`)).toMatch(/t$/);
    await expect(as(outsider, `select redeem_invite('${created.invite}');`)).rejects.toThrow(/invalid/);
  });
  it("accepts encrypted mentions through append_feed and rejects unknown recipients and repos", async () => {
    const event = (to: string, repo = "acme/app") => JSON.stringify({ type: "mention", repo, meta: { to }, sealed: { v: 1, c: "encrypted" } });
    expect(await as(a, `select (append_feed('${team}', '${event("bob")}')).type;`)).toMatch(/mention$/);
    await expect(as(a, `select append_feed('${team}', '${event("charlie")}');`)).rejects.toThrow(/recipient/);
    await expect(as(a, `select append_feed('${team}', '${event("bob", "acme/private")}');`)).rejects.toThrow(/not shared/);
    expect(await as(a, `select (append_feed('${team}', '{"type":"goal_started","repo":"acme/app","meta":{}}')).type;`)).toMatch(/goal_started$/);
  });
});
