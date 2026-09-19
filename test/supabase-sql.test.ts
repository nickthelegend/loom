/**
 * The hosted Team Hub's SQL, run for real: a throwaway Postgres cluster, a
 * minimal stand-in for what Supabase provides (the auth schema, auth.uid(),
 * the anon/authenticated roles, pgcrypto in `extensions`), both migrations
 * applied, then the same rules the reference hub is tested on — asserted as
 * the `authenticated` role, through RLS, exactly as a client would hit them.
 *
 * Skips when Postgres isn't installed (CI); runs on any dev machine with it.
 */

import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
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
const CAROL = "00000000-0000-4000-8000-0000000ca201";

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
    grant usage on schema public, auth, extensions to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  for (const m of [
    "0001_app_opens.sql",
    "0002_teams.sql",
    "0003_team_leases.sql",
    "0004_team_memories.sql",
    "0005_hosted_hub.sql",
    "0006_landing.sql",
    "0007_runners.sql",
    "0008_key_version_conflict.sql",
    "0009_phase6.sql",
  ]) {
    psql(fs.readFileSync(path.join(root, "supabase", "migrations", m), "utf8"));
  }
  psql(`insert into auth.users (id, raw_user_meta_data) values
    ('${ALICE}', '{"user_name":"Alice","full_name":"Alice A"}'),
    ('${BOB}', '{"user_name":"bob"}'),
    ('${CAROL}', '{"user_name":"carol"}');`);
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
    expect(psql("select github from public.profiles order by github;")).toBe("alice\nbob\ncarol");
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

  it("team memories: twins confirm, only authors edit, resolution keeps the loser (D40, D41, D47)", () => {
    const pub = (user: string, dev: string, id: string, hmac: string, extra = "") =>
      JSON.parse(asUser(user, `select public.publish_memory('${team}', '{"id":"${id}","repo":"acme/app","hmac":"${hmac}","sealed":{"v":1,"c":"x"},"deviceId":"${dev}"${extra}}');`));
    expect(pub(ALICE, aliceDev, "mem1", "v1:zod").merged).toBe(false);
    const twin = pub(BOB, bobDev, "mem9", "v1:zod");
    expect(twin.merged).toBe(true);
    expect(twin.memory.id).toBe("mem1");
    expect(twin.memory.confirmed_by).toEqual(["alice", "bob"]);
    expect(fails(() => pub(BOB, bobDev, "mem1", "v1:other"))).toMatch(/belongs to someone else/);
    expect(fails(() => pub(BOB, bobDev, "mem3", "v1:z", ',"supersedes":"nope"'))).toMatch(/to supersede/);
    expect(fails(() => asUser(BOB, `select public.forget_team_memory('${team}', 'mem1', 'no');`))).toMatch(/only its author/);
    expect(fails(() => asUser(BOB, `select public.update_team_memory('${team}', 'mem1', 'v1:y', '{"v":1,"c":"y"}');`))).toMatch(/only its author/);
    pub(BOB, bobDev, "mem2", "v1:valibot", ',"supersedes":"mem1"');
    asUser(ALICE, `select public.resolve_memories('${team}', 'mem2', 'mem1', 'moved to valibot');`);
    expect(asUser(BOB, `select string_agg(id || ':' || state, ',' order by id) from public.team_memories where team_id = '${team}';`))
      .toBe("mem1:superseded,mem2:live");
    expect(asUser(BOB, `select array_to_string(confirmed_by, ',') from public.team_memories where id = 'mem2';`)).toBe("bob,alice");
    expect(asUser(BOB, `select resolved_by || '>' || superseded_by from public.team_memories where id = 'mem1';`)).toBe("alice>mem2");
    expect(asUser(BOB, `select type from public.feed where team_id = '${team}' order by id desc limit 1;`)).toBe("memory_resolved");
    expect(fails(() => asUser(BOB, `insert into public.team_memories (id, team_id) values ('mem7', '${team}');`))).toMatch(/permission denied/);
    expect(asUser(BOB, `select (public.append_feed('${team}', '{"type":"canon_proposed","repo":"acme/app","meta":{"ids":["mem2"]}}')).id is not null;`)).toBe("t");
  });

  it("members can post the Phase 4 landing events, and nothing made up (D53, D55, D63, D64)", () => {
    for (const t of ["goal_landed", "goal_needs_someone", "goal_adopted", "goal_returned", "check_flaky"]) {
      expect(asUser(BOB, `select (public.append_feed('${team}', '{"type":"${t}","repo":"acme/app","meta":{"pr":7}}')).id is not null;`)).toBe("t");
    }
    expect(fails(() => asUser(BOB, `select public.append_feed('${team}', '{"type":"merged_by_agent","meta":{}}');`))).toMatch(/can't post/);
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

describe.skipIf(!hasPg)("hosted Team Hub SQL, 0005 (extend_lease, team_member_list)", () => {
  let team = "";
  let aliceDev = "";
  let bobDev = "";
  const claim = (user: string, dev: string, run: string, globs: string, files: string, prefixes: string) =>
    JSON.parse(asUser(user, `select public.claim_lease('${team}', '{"deviceId":"${dev}","repo":"acme/web","runId":"${run}","taskId":"t1","globs":${globs},"files":${files},"prefixes":${prefixes},"hardZones":["db/migrations/**"]}');`));
  const extend = (user: string, lease: string, globs: string, files: string, prefixes: string) =>
    JSON.parse(asUser(user, `select public.extend_lease('${team}', '${lease}', '{"globs":${globs},"files":${files},"prefixes":${prefixes}}', '["db/migrations/**"]');`));

  beforeAll(() => {
    if (!hasPg) return;
    team = asUser(ALICE, "select id from public.create_team('Web');");
    aliceDev = asUser(ALICE, "select id from public.register_device('mac', 'sealA', 'signA');");
    bobDev = asUser(BOB, "select id from public.register_device('mbp', 'sealB', 'signB');");
    const invite = JSON.parse(asUser(ALICE, `select public.create_invite('${team}', 3600);`)).invite;
    asUser(BOB, `select public.redeem_invite('${invite}');`);
    asUser(ALICE, `select public.share_repo('${team}', 'acme/web');`);
  });

  it("widens your own lease, reports overlaps on the new part, and refuses a held hard zone (D31, D33)", () => {
    const a = claim(ALICE, aliceDev, "w1", '["src/ui/**"]', '["src/ui/app.ts"]', '["src/ui/"]');
    claim(BOB, bobDev, "w2", '["src/api/**"]', '["src/api/server.ts"]', '["src/api/"]');
    claim(BOB, bobDev, "w3", '["db/migrations/**"]', '[]', '["db/migrations/"]');
    const wide = extend(ALICE, a.lease.id, '["src/api/server.ts","src/ui/**"]', '["src/api/server.ts"]', '["src/api/server.ts"]');
    expect(wide.lease.id).toBe(a.lease.id);
    expect(wide.lease.globs).toEqual(["src/ui/**", "src/api/server.ts"]); // union, first-seen order
    expect(wide.lease.files).toEqual(["src/ui/app.ts", "src/api/server.ts"]);
    expect(wide.lease.prefixes).toEqual(["src/ui/", "src/api/server.ts"]);
    expect(wide.overlaps).toHaveLength(1);
    expect(wide.overlaps[0].lease.run_id).toBe("w2");
    expect(wide.overlaps[0].paths).toEqual(["src/api/server.ts"]);
    expect(wide.blockedBy).toBeUndefined();
    // a held hard zone refuses, and the lease stays as it was
    const z = extend(ALICE, a.lease.id, '["db/**"]', '[]', '["db/"]');
    expect(z.lease).toBeNull();
    expect(z.blockedBy).toMatchObject({ zone: "db/migrations/**", lease: { run_id: "w3" } });
    expect(asUser(ALICE, `select array_to_string(globs, ',') from public.leases where id = '${a.lease.id}';`)).toBe("src/ui/**,src/api/server.ts");
    // once the holder is gone, the widening lands
    asUser(BOB, `select public.release_leases('${team}', 'w3', 'merged');`);
    expect(extend(ALICE, a.lease.id, '["db/**"]', '[]', '["db/"]').lease.prefixes).toContain("db/");
  });

  it("only the lease's owner can widen it; non-members are refused", () => {
    const b = claim(BOB, bobDev, "w4", '["docs/**"]', '[]', '["docs/"]');
    expect(fails(() => extend(ALICE, b.lease.id, '["x/**"]', '[]', '["x/"]'))).toMatch(/isn't yours/);
    expect(fails(() => extend(CAROL, b.lease.id, '["x/**"]', '[]', '["x/"]'))).toMatch(/not a member/);
    expect(fails(() => extend(BOB, "00000000-0000-4000-8000-000000000000", '["x/**"]', '[]', '["x/"]'))).toMatch(/isn't yours/);
    expect(fails(() => psql(`select public.extend_lease('${team}', '${b.lease.id}', '{}', '[]');`, { as: "anon" }))).toMatch(
      /permission denied/,
    );
  });

  it("team_member_list: members with logins, roles and devices, for members only", () => {
    const list = JSON.parse(asUser(BOB, `select public.team_member_list('${team}');`));
    expect(list.map((m: { user: { github: string }; role: string }) => `${m.user.github}:${m.role}`)).toEqual(["alice:owner", "bob:member"]);
    expect(list[0].user).toEqual({ id: ALICE, github: "alice", name: "Alice A" });
    expect(list[1].devices[0]).toMatchObject({ id: bobDev, userId: BOB, label: "mbp", sealPub: "sealB", signPub: "signB" });
    expect(typeof list[0].joinedAt).toBe("number");
    expect(fails(() => asUser(CAROL, `select public.team_member_list('${team}');`))).toMatch(/not a member/);
  });
});

describe.skipIf(!hasPg)("hosted Team Hub SQL, 0007 (runners and jobs, D67–D78)", () => {
  let team = "";
  let aliceDev = "";
  let bobDev = "";
  let aliceRunner = "";
  let bobRunner = "";
  const sealed = '{"v":1,"c":"sealed"}';
  const job = (user: string, dev: string, extra = "") =>
    JSON.parse(asUser(user, `select to_jsonb(public.create_job('${team}', '{"repo":"acme/ops","kind":"start","sealed":${sealed},"deviceId":"${dev}"${extra}}'));`));
  const claim = (user: string, runner: string) =>
    JSON.parse(asUser(user, `select coalesce(to_jsonb(j), 'null') from public.claim_job('${team}', '${runner}') j where j.id is not null union all select 'null'::jsonb limit 1;`));
  const beat = (user: string, id: string, runner: string) =>
    JSON.parse(asUser(user, `select to_jsonb(public.heartbeat_job('${team}', '${id}', '${runner}', '{"v":1,"c":"p"}'));`));
  const finish = (user: string, id: string, runner: string) =>
    JSON.parse(asUser(user, `select to_jsonb(public.finish_job('${team}', '${id}', '${runner}', 'done', '{"v":1,"c":"r"}', null));`));
  const cancel = (user: string, id: string) => JSON.parse(asUser(user, `select to_jsonb(public.cancel_job('${team}', '${id}'));`));
  /** Leave the queue empty so each case starts clean. */
  const drain = () => psql(`update public.jobs set state = 'cancelled' where team_id = '${team}' and state in ('queued', 'claimed');`);

  beforeAll(() => {
    if (!hasPg) return;
    team = asUser(ALICE, "select id from public.create_team('Ops');");
    aliceDev = asUser(ALICE, "select id from public.register_device('mac', 'sealA', 'signA');");
    bobDev = asUser(BOB, "select id from public.register_device('mbp', 'sealB', 'signB');");
    aliceRunner = asUser(ALICE, "select id from public.register_device('vps', 'sealAR', 'signAR');");
    bobRunner = asUser(BOB, "select id from public.register_device('box', 'sealBR', 'signBR');");
    const invite = JSON.parse(asUser(ALICE, `select public.create_invite('${team}', 3600);`)).invite;
    asUser(BOB, `select public.redeem_invite('${invite}');`);
    asUser(ALICE, `select public.share_repo('${team}', 'acme/ops');`);
  });

  it("registers a runner on your own device; teammates see it, others don't", () => {
    const r = JSON.parse(asUser(ALICE, `select public.register_runner('${aliceRunner}', '["codex","claude","codex"]', false, 20);`));
    expect(r).toMatchObject({ deviceId: aliceRunner, userId: ALICE, github: "alice", label: "vps", kinds: ["codex", "claude"], shared: false, capacity: 8 });
    expect(typeof r.lastSeen).toBe("number");
    expect(fails(() => asUser(BOB, `select public.register_runner('${aliceRunner}', '[]', true, 1);`))).toMatch(/isn't yours/);
    asUser(BOB, `select public.register_runner('${bobRunner}', '["codex"]', false, 1);`);
    const list = JSON.parse(asUser(BOB, `select public.team_runners('${team}');`));
    expect(list.map((x: { github: string }) => x.github).sort()).toEqual(["alice", "bob"]);
    expect(asUser(BOB, `select count(*) from public.runners where user_id = '${ALICE}';`)).toBe("1"); // RLS: teammates
    expect(asUser(CAROL, `select count(*) from public.runners;`)).toBe("0");
    expect(fails(() => asUser(CAROL, `select public.team_runners('${team}');`))).toMatch(/not a member/);
    expect(fails(() => asUser(BOB, `insert into public.runners (device_id, user_id) values ('${bobDev}', '${BOB}');`))).toMatch(/permission denied/);
    expect(fails(() => psql(`select public.register_runner('${aliceRunner}', '[]', false, 1);`, { as: "anon" }))).toMatch(/permission denied/);
  });

  it("jobs need a shared repo, your device, a real kind and a sealed payload", () => {
    expect(fails(() => asUser(BOB, `select public.create_job('${team}', '{"repo":"acme/other","kind":"start","sealed":${sealed},"deviceId":"${bobDev}"}');`))).toMatch(/isn't shared/);
    expect(fails(() => job(BOB, aliceDev))).toMatch(/isn't yours/);
    expect(fails(() => asUser(BOB, `select public.create_job('${team}', '{"repo":"acme/ops","kind":"deploy","sealed":${sealed},"deviceId":"${bobDev}"}');`))).toMatch(/bad job kind/);
    expect(fails(() => asUser(BOB, `select public.create_job('${team}', '{"repo":"acme/ops","kind":"start","sealed":{"v":1},"deviceId":"${bobDev}"}');`))).toMatch(/sealed payload/);
    expect(fails(() => job(CAROL, bobDev))).toMatch(/not a member/);
    expect(fails(() => job(BOB, bobDev, `,"target":"${aliceRunner}"`))).toMatch(/isn't shared/); // alice's runner is personal
    expect(fails(() => job(BOB, bobDev, `,"target":"${bobDev}"`))).toMatch(/no such runner/);
    const j = job(BOB, bobDev, ',"kind":"land"');
    expect(j).toMatchObject({ kind: "land", state: "queued", user_id: BOB, github: "bob", repo: "acme/ops" });
    expect(fails(() => asUser(BOB, `update public.jobs set state = 'done' where id = '${j.id}';`))).toMatch(/permission denied/);
    drain();
  });

  it("eligibility: own jobs, anyone's only when shared, a targeted job only for its runner (D68)", () => {
    const bobs = job(BOB, bobDev);
    expect(claim(ALICE, aliceRunner)).toBeNull(); // alice's personal runner won't take bob's goal
    expect(fails(() => claim(ALICE, bobRunner))).toMatch(/isn't yours/);
    expect(fails(() => claim(ALICE, aliceDev))).toMatch(/isn't a runner/);
    asUser(ALICE, `select public.register_runner('${aliceRunner}', '["codex"]', true, 2);`);
    const got = claim(ALICE, aliceRunner);
    expect(got).toMatchObject({ id: bobs.id, state: "claimed", runner_id: aliceRunner, runner_github: "alice" });
    expect(got.claimed_at).toBeTruthy();
    // a job targeted at alice's (now shared) runner: bob's own runner can't take it
    const t = job(BOB, bobDev, `,"target":"${aliceRunner}"`);
    expect(claim(BOB, bobRunner)).toBeNull();
    expect(claim(ALICE, aliceRunner).id).toBe(t.id);
    // bob's own job goes to bob's runner, oldest first
    const o1 = job(BOB, bobDev);
    job(BOB, bobDev);
    expect(claim(BOB, bobRunner).id).toBe(o1.id);
    drain();
  });

  it("claims are atomic: two runners at once, one job, one winner", async () => {
    const j = job(ALICE, aliceDev);
    const run = (runner: string) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          "psql",
          ["-h", sockDir, "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"],
          (err, out) => (err ? reject(err) : resolve(out.trim().split("\n").pop() ?? "")),
        );
        child.stdin!.end(
          `set role authenticated; select set_config('request.jwt.claim.sub', '${runner === aliceRunner ? ALICE : BOB}', false);\n` +
            `select coalesce((select id::text from public.claim_job('${team}', '${runner}') where id is not null), 'none');`,
        );
      });
    // bob's runner shared too, so both are eligible for alice's job
    asUser(BOB, `select public.register_runner('${bobRunner}', '["codex"]', true, 1);`);
    const got = await Promise.all([run(aliceRunner), run(bobRunner)]);
    expect(got.filter((x) => x === j.id)).toHaveLength(1);
    expect(got.filter((x) => x === "none")).toHaveLength(1);
    drain();
  });

  it("only the holder heartbeats and finishes (409); a silent claim is claimable again (D12, D71)", () => {
    const j = job(ALICE, aliceDev);
    expect(claim(ALICE, aliceRunner).id).toBe(j.id);
    expect(fails(() => beat(BOB, j.id, bobRunner))).toMatch(/doesn't hold this job/);
    expect(fails(() => beat(BOB, j.id, aliceRunner))).toMatch(/isn't yours/);
    expect(fails(() => beat(ALICE, "00000000-0000-4000-8000-000000000000", aliceRunner))).toMatch(/no job/);
    expect(beat(ALICE, j.id, aliceRunner).progress).toEqual({ v: 1, c: "p" });
    // fresh: nobody else can take it
    expect(claim(BOB, bobRunner)).toBeNull();
    // ten minutes of silence: bob's shared runner takes it over
    psql(`update public.jobs set heartbeat_at = now() - interval '11 minutes' where id = '${j.id}';`);
    const taken = claim(BOB, bobRunner);
    expect(taken).toMatchObject({ id: j.id, runner_id: bobRunner, runner_github: "bob", progress: { v: 1, c: "p" } });
    expect(fails(() => beat(ALICE, j.id, aliceRunner))).toMatch(/doesn't hold this job/); // the old holder lost it
    expect(fails(() => asUser(BOB, `select public.finish_job('${team}', '${j.id}', '${bobRunner}', 'cancelled');`))).toMatch(/done or failed/);
    const done = finish(BOB, j.id, bobRunner);
    expect(done).toMatchObject({ state: "done", result: { v: 1, c: "r" } });
    expect(fails(() => finish(BOB, j.id, bobRunner))).toMatch(/doesn't hold this job/);
    // a finished job stays finished when its author cancels
    expect(cancel(ALICE, j.id).state).toBe("done");
    const f = job(ALICE, aliceDev);
    claim(ALICE, aliceRunner);
    const failed = JSON.parse(asUser(ALICE, `select to_jsonb(public.finish_job('${team}', '${f.id}', '${aliceRunner}', 'failed', null, '${"x".repeat(600)}'));`));
    expect(failed.state).toBe("failed");
    expect(failed.error).toHaveLength(500);
  });

  it("only the author cancels; a cancelled job stops its runner", () => {
    const j = job(BOB, bobDev);
    expect(fails(() => cancel(ALICE, j.id))).toMatch(/only whoever asked/);
    expect(claim(BOB, bobRunner).id).toBe(j.id);
    expect(cancel(BOB, j.id).state).toBe("cancelled");
    expect(fails(() => beat(BOB, j.id, bobRunner))).toMatch(/doesn't hold this job/);
    expect(asUser(ALICE, `select count(*) from public.jobs where team_id = '${team}';`)).not.toBe("0"); // viewers read the queue
    expect(asUser(CAROL, `select count(*) from public.jobs where team_id = '${team}';`)).toBe("0");
  });

  it("members can post the Phase 5 events (D72, D75)", () => {
    for (const t of ["goal_moved", "deploy_started", "deploy_succeeded", "deploy_failed"]) {
      expect(asUser(BOB, `select (public.append_feed('${team}', '{"type":"${t}","repo":"acme/ops","meta":{"n":1}}')).id is not null;`)).toBe("t");
    }
    expect(fails(() => asUser(BOB, `select public.append_feed('${team}', '{"type":"deploy_rolled_back","meta":{}}');`))).toMatch(/can't post/);
  });

  it("revoking a device removes it, its runner record and its envelopes — your own only (D74)", () => {
    asUser(BOB, `select public.put_key_envelopes('${team}', 1, '[{"deviceId":"${bobRunner}","box":"br1"}]');`);
    expect(fails(() => asUser(ALICE, `select public.revoke_device('${bobRunner}');`))).toMatch(/isn't yours/);
    asUser(BOB, `select public.revoke_device('${bobRunner}');`);
    expect(psql(`select count(*) from public.devices where id = '${bobRunner}';`)).toBe("0");
    expect(psql(`select count(*) from public.runners where device_id = '${bobRunner}';`)).toBe("0");
    expect(psql(`select count(*) from public.key_envelopes where device_id = '${bobRunner}';`)).toBe("0");
    expect(JSON.parse(asUser(ALICE, `select public.team_runners('${team}');`)).map((r: { github: string }) => r.github)).toEqual(["alice"]);
    // the jobs it ran keep their history
    expect(asUser(ALICE, `select count(*) from public.jobs where runner_id = '${bobRunner}';`)).not.toBe("0");
  });
});

describe.skipIf(!hasPg)("hosted Team Hub SQL, 0009 (landing train events, GitHub webhooks)", () => {
  let team = "";
  let aliceDev = "";
  let bobDev = "";
  const asService = (sql: string) => psql(sql, { as: "service_role" }).split("\n").pop() ?? "";
  const lane = (user: string, dev: string, run: string, name: string) =>
    JSON.parse(asUser(user, `select public.claim_lease('${team}', '{"deviceId":"${dev}","repo":"acme/train","runId":"${run}:land","taskId":"land:${name}","globs":[".loom/landing/${name}"],"files":[".loom/landing/${name}"],"prefixes":[".loom/landing/${name}"],"hardZones":[".loom/landing/${name}"]}');`));

  beforeAll(() => {
    if (!hasPg) return;
    team = asUser(ALICE, "select id from public.create_team('Train');");
    aliceDev = asUser(ALICE, "select id from public.register_device('mac', 'sealA', 'signA');");
    bobDev = asUser(BOB, "select id from public.register_device('mbp', 'sealB', 'signB');");
    const invite = JSON.parse(asUser(ALICE, `select public.create_invite('${team}', 3600);`)).invite;
    asUser(BOB, `select public.redeem_invite('${invite}');`);
    asUser(ALICE, `select public.share_repo('${team}', 'acme/train');`);
  });

  it("a lane's slot is a lease on its own hard zone: one goal per lane, other lanes free, release hands it on (D79)", () => {
    expect(lane(ALICE, aliceDev, "o1", "main").lease.run_id).toBe("o1:land");
    const refused = lane(BOB, bobDev, "o2", "main");
    expect(refused.lease).toBeNull();
    expect(refused.blockedBy).toMatchObject({ zone: ".loom/landing/main", lease: { run_id: "o1:land" } });
    expect(lane(BOB, bobDev, "o2", "api").lease).toBeTruthy();
    expect(lane(BOB, bobDev, "o3", "mainx").lease).toBeTruthy();
    expect(asUser(ALICE, `select public.release_leases('${team}', 'o1:land', 'merged');`)).toBe("1");
    expect(lane(BOB, bobDev, "o2", "main").lease).toBeTruthy();
  });

  it("members can post land_queued and land_turn (D82)", () => {
    for (const t of ["land_queued", "land_turn"]) {
      expect(asUser(BOB, `select (public.append_feed('${team}', '{"type":"${t}","repo":"acme/train","meta":{"pr":7,"lane":"main"}}')).id is not null;`)).toBe("t");
    }
    expect(fails(() => asUser(BOB, `select public.append_feed('${team}', '{"type":"land_skipped","meta":{}}');`))).toMatch(/can't post/);
  });

  it("the webhook secret: owners create and rotate it, nobody reads the table (D83)", () => {
    expect(fails(() => asUser(BOB, `select public.webhook_secret('${team}');`))).toMatch(/needs owner/);
    const s1 = asUser(ALICE, `select public.webhook_secret('${team}');`);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    expect(asUser(ALICE, `select public.webhook_secret('${team}');`)).toBe(s1);
    const s2 = asUser(ALICE, `select public.webhook_secret('${team}', true);`);
    expect(s2).not.toBe(s1);
    expect(fails(() => asUser(ALICE, "select secret from public.team_webhook_secrets;"))).toMatch(/permission denied/);
    expect(fails(() => asUser(ALICE, `select public.github_webhook_secret('${team}');`))).toMatch(/permission denied/);
    expect(asService(`select public.github_webhook_secret('${team}');`)).toBe(s2);
    expect(fails(() => psql(`select public.webhook_secret('${team}');`, { as: "anon" }))).toMatch(/permission denied/);
  });

  it("ingest: GitHub kinds only, shared repos only, as system events, deduped with polling (D83, D84)", () => {
    const events = JSON.stringify([
      { repo: "Acme/Train", type: "check_failed", meta: { number: 7, checks: ["test"] }, dedupeKey: "gh:acme/train#7:failed:abc:test" },
      { repo: "acme/elsewhere", type: "pr_merged", meta: { number: 1 }, dedupeKey: "gh:acme/elsewhere#1:merged" },
      { repo: "acme/train", type: "goal_landed", meta: {}, dedupeKey: "x" },
      { repo: "not a repo", type: "pr_opened", meta: {}, dedupeKey: "y" },
    ]);
    expect(fails(() => asUser(ALICE, `select public.github_webhook_ingest('${team}', '${events}');`))).toMatch(/permission denied/);
    expect(asService(`select public.github_webhook_ingest('${team}', '${events}');`)).toBe("1");
    expect(asService(`select public.github_webhook_ingest('${team}', '${events}');`)).toBe("0"); // redelivered
    expect(asUser(BOB, `select type || '|' || coalesce(user_id::text, 'system') || '|' || repo from public.feed where team_id = '${team}' and dedupe_key = 'gh:acme/train#7:failed:abc:test';`)).toBe(
      "check_failed|system|acme/train",
    );
    // a daemon polling the same fact later adds nothing
    expect(asUser(BOB, `select coalesce(id::text, 'deduped') from public.append_feed('${team}', '{"type":"check_failed","repo":"acme/train","meta":{},"dedupeKey":"gh:acme/train#7:failed:abc:test"}');`)).toBe("deduped");
  });
});
