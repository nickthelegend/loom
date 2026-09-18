/**
 * The hosted Team Hub's SQL, run for real: a throwaway Postgres cluster, a
 * minimal stand-in for what Supabase provides (the auth schema, auth.uid(),
 * the anon/authenticated roles, pgcrypto in `extensions`), both migrations
 * applied, then the same rules the reference hub is tested on — asserted as
 * the `authenticated` role, through RLS, exactly as a client would hit them.
 *
 * Skips when Postgres isn't installed (CI); runs on any dev machine with it.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasPg = (() => {
  try {
    execFileSync("initdb", ["--version"], { stdio: "ignore" });
    execFileSync("psql", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let dataDir = "";
let sockDir = "";
let port = 0;
let pg: ChildProcess | null = null;

function psql(sql: string, opts: { as?: string; user?: string } = {}): string {
  const preamble = opts.as
    ? `set role ${opts.as};\n${opts.user ? `select set_config('request.jwt.claim.sub', '${opts.user}', false);\n` : ""}`
    : "";
  return execFileSync("psql", ["-h", sockDir, "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"], {
    input: preamble + sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  })
    .split("\n")
    .filter((l) => l !== "")
    .join("\n")
    .trim();
}

/** Run as a user; returns the last output line. */
function asUser(user: string, sql: string): string {
  const out = psql(sql, { as: "authenticated", user });
  const lines = out.split("\n").filter((l) => l !== user);
  return lines[lines.length - 1] ?? "";
}

function fails(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? (err as Error).message);
  }
  throw new Error("expected the statement to fail, and it succeeded");
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";

beforeAll(async () => {
  if (!hasPg) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pg-"));
  sockDir = fs.mkdtempSync(path.join("/tmp", "lpg-")); // unix socket paths must stay short
  // macOS: without a valid LC_ALL the postmaster refuses to start ("became multithreaded")
  const env = { ...process.env, LC_ALL: "C", LANG: "C" };
  execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"], { stdio: "ignore", env });
  port = await freePort();
  pg = spawn("postgres", ["-D", dataDir, "-p", String(port), "-k", sockDir, "-c", "listen_addresses="], { stdio: "ignore", env });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      execFileSync("psql", ["-h", sockDir, "-p", String(port), "-U", "postgres", "-d", "postgres", "-c", "select 1"], { stdio: "ignore" });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("postgres did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // What Supabase gives every project, minimally.
  psql(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema extensions;
    create extension pgcrypto schema extensions;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth, extensions to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  for (const m of ["0001_app_opens.sql", "0002_teams.sql", "0003_team_leases.sql"]) {
    psql(fs.readFileSync(path.join(root, "supabase", "migrations", m), "utf8"));
  }
  psql(`insert into auth.users (id, raw_user_meta_data) values
    ('${ALICE}', '{"user_name":"Alice","full_name":"Alice A"}'),
    ('${BOB}', '{"user_name":"bob"}');`);
}, 60_000);

afterAll(async () => {
  if (pg) {
    pg.kill("SIGINT");
    await new Promise((r) => pg!.once("exit", r));
  }
  for (const d of [dataDir, sockDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!hasPg)("hosted Team Hub SQL (Postgres, RLS as `authenticated`)", () => {
  let team = "";
  let invite = "";
  let aliceDev = "";
  let bobDev = "";

  it("creates profiles from GitHub sign-up metadata", () => {
    expect(psql("select github from public.profiles order by github;")).toBe("alice\nbob");
  });

  it("the creator owns the team; invites are single-use", () => {
    team = asUser(ALICE, "select id from public.create_team('Acme');");
    expect(team).toMatch(/^[0-9a-f-]{36}$/);
    aliceDev = asUser(ALICE, "select id from public.register_device('mac', 'sealA', 'signA');");
    bobDev = asUser(BOB, "select id from public.register_device('mbp', 'sealB', 'signB');");
    invite = JSON.parse(asUser(ALICE, `select public.create_invite('${team}', 3600);`)).invite;
    expect(invite.length).toBeGreaterThan(10);
    const joined = JSON.parse(asUser(BOB, `select public.redeem_invite('${invite}');`));
    expect(joined).toMatchObject({ role: "member", team: { name: "Acme" } });
    expect(fails(() => asUser(BOB, `select public.redeem_invite('${invite}');`))).toMatch(/invalid, used or expired/);
    // the raw token is never stored, and nobody can read the invites table
    expect(fails(() => asUser(ALICE, "select * from public.team_invites;"))).toMatch(/permission denied/);
    expect(psql(`select count(*) from public.team_invites where token_hash = '${invite}';`)).toBe("0");
  });

  it("writes only go through functions, never raw inserts", () => {
    expect(fails(() => asUser(BOB, `insert into public.feed (team_id, type) values ('${team}', 'pr_merged');`))).toMatch(
      /permission denied/,
    );
    expect(fails(() => asUser(BOB, `select public.append_feed('${team}', '{"type":"member_left","meta":{}}');`))).toMatch(
      /can't post member_left/,
    );
    expect(fails(() => psql(`select public.create_team('x');`, { as: "anon" }))).toMatch(/permission denied/);
  });

  it("presence needs a shared repo and your own device; teammates see it", () => {
    const beat = (dev: string) =>
      `select public.heartbeat('${team}', '{"deviceId":"${dev}","repo":"git@github.com:Acme/App.git","agent":"codex#t1","kind":"codex","touches":["src/**"],"state":"running","since":0,"sealed":{"v":1,"c":"xx"}}');`;
    expect(fails(() => asUser(BOB, beat(bobDev)))).toMatch(/isn't shared/);
    asUser(ALICE, `select public.share_repo('${team}', 'https://github.com/acme/app');`);
    expect(fails(() => asUser(BOB, beat(aliceDev)))).toMatch(/isn't yours/);
    asUser(BOB, beat(bobDev));
    expect(asUser(ALICE, `select repo || '|' || agent || '|' || array_to_string(touches, ',') from public.presence where team_id = '${team}';`)).toBe(
      "acme/app|codex#t1|src/**",
    );
  });

  it("key versions only move forward; envelopes are readable only by their device's owner", () => {
    asUser(BOB, `select public.put_key_envelopes('${team}', 1, '[{"deviceId":"${bobDev}","box":"b1"}]');`);
    expect(fails(() => asUser(BOB, `select public.put_key_envelopes('${team}', 2, '[{"deviceId":"${bobDev}","box":"b2"}]');`))).toMatch(
      /needs owner/,
    );
    asUser(ALICE, `select public.put_key_envelopes('${team}', 2, '[{"deviceId":"${aliceDev}","box":"a2"},{"deviceId":"${bobDev}","box":"b2"}]');`);
    expect(fails(() => asUser(ALICE, `select public.put_key_envelopes('${team}', 1, '[{"deviceId":"${aliceDev}","box":"x"}]');`))).toMatch(
      /stale/,
    );
    expect(asUser(BOB, `select string_agg(box, ',' order by version) from public.key_envelopes where team_id = '${team}';`)).toBe("b1,b2");
    expect(asUser(ALICE, `select string_agg(box, ',' order by version) from public.key_envelopes where team_id = '${team}';`)).toBe("a2");
    expect(asUser(ALICE, `select key_version from public.teams where id = '${team}';`)).toBe("2");
  });

  it("globs and overlap match the TypeScript rules (D28)", () => {
    const q = (sql: string) => psql(`select ${sql};`);
    expect(q(`'src/auth/session.test.ts' ~ public.glob_regex('**/*.test.ts')`)).toBe("t");
    expect(q(`'src/a/b.ts' ~ public.glob_regex('src/*.ts')`)).toBe("f");
    expect(q(`'src/auth/x.ts' ~ public.glob_regex('src/auth')`)).toBe("t");
    // the hard case: **/*.test.ts vs src/auth/**, through real files
    expect(q(`array_to_string(public.lease_overlap(
      '{"**/*.test.ts"}', '{"src/auth/session.test.ts"}', '{""}',
      '{"src/auth/**"}', '{"src/auth/session.ts","src/auth/session.test.ts"}', '{"src/auth/"}'), ',')`)).toBe("src/auth/session.test.ts");
    expect(q(`cardinality(public.lease_overlap('{"**/*.md"}', '{"README.md"}', '{""}', '{"src/**"}', '{"src/a.ts"}', '{"src/"}'))`)).toBe("0");
    expect(q(`public.lease_zone('{}', '{"db/"}', '{"db/migrations/**"}')`)).toBe("db/migrations/**");
  });

  it("leases: overlaps are reported, a held hard zone refuses, release frees it (D29, D31, D36)", () => {
    const claim = (user: string, dev: string, run: string, globs: string, files: string, prefixes: string) =>
      JSON.parse(asUser(user, `select public.claim_lease('${team}', '{"deviceId":"${dev}","repo":"acme/app","runId":"${run}","taskId":"t1","globs":${globs},"files":${files},"prefixes":${prefixes},"hardZones":["db/migrations/**"]}');`));
    const a = claim(ALICE, aliceDev, "o1", '["src/auth/**"]', '["src/auth/session.ts"]', '["src/auth/"]');
    expect(a.lease.run_id).toBe("o1");
    const b = claim(BOB, bobDev, "o2", '["src/auth/session.ts"]', '["src/auth/session.ts"]', '["src/auth/session.ts"]');
    expect(b.lease).toBeTruthy();
    expect(b.overlaps[0].paths).toEqual(["src/auth/session.ts"]);
    claim(ALICE, aliceDev, "o3", '["db/migrations/**"]', '[]', '["db/migrations/"]');
    const z = claim(BOB, bobDev, "o4", '["db/**"]', '[]', '["db/"]');
    expect(z.lease).toBeNull();
    expect(z.blockedBy.zone).toBe("db/migrations/**");
    expect(asUser(BOB, `select public.release_leases('${team}', 'o3', 'nope');`)).toBe("0"); // not bob's
    expect(asUser(ALICE, `select public.release_leases('${team}', 'o3', 'PR merged');`)).toBe("1");
    expect(claim(BOB, bobDev, "o4", '["db/**"]', '[]', '["db/"]').lease).toBeTruthy();
    // stale leases stop blocking (D12)
    psql(`update public.leases set ts = now() - interval '11 minutes' where run_id = 'o4';`);
    expect(claim(ALICE, aliceDev, "o5", '["db/migrations/**"]', '[]', '["db/migrations/"]').lease).toBeTruthy();
    expect(asUser(ALICE, `select public.set_run_lease_state('${team}', 'o5', 'landing');`)).toBe("1");
    expect(fails(() => asUser(BOB, `insert into public.leases (team_id) values ('${team}');`))).toMatch(/permission denied/);
    expect(asUser(BOB, `select (public.append_feed('${team}', '{"type":"conflict_predicted","meta":{"runs":["o1","o2"]}}')).id is not null;`)).toBe("t");
  });

  it("feed dedupes by key; removal is announced, then the member is cut off", () => {
    const post = `select coalesce(id::text, 'deduped') from public.append_feed('${team}', '{"type":"pr_opened","repo":"acme/app","meta":{"n":7},"dedupeKey":"gh:acme/app#7:opened"}');`;
    expect(asUser(BOB, post)).toMatch(/^\d+$/);
    expect(asUser(BOB, post)).toBe("deduped");
    expect(fails(() => asUser(BOB, `select public.remove_member('${team}', '${ALICE}');`))).toMatch(/needs owner/);
    expect(fails(() => asUser(ALICE, `select public.remove_member('${team}', '${ALICE}');`))).toMatch(/last owner/);
    asUser(ALICE, `select public.remove_member('${team}', '${BOB}');`);
    expect(asUser(BOB, `select count(*) from public.feed where team_id = '${team}';`)).toBe("0");
    expect(asUser(BOB, `select count(*) from public.key_envelopes where team_id = '${team}';`)).toBe("0");
    const types = asUser(ALICE, `select string_agg(type, ',' order by id) from public.feed where team_id = '${team}';`);
    expect(types.startsWith("member_joined,repo_shared,key_rotated")).toBe(true);
    expect(types.endsWith("pr_opened,member_left")).toBe(true);
    // and their leases went with them
    expect(asUser(ALICE, `select count(*) from public.leases where team_id = '${team}' and user_id = '${BOB}';`)).toBe("0");
  });
});
