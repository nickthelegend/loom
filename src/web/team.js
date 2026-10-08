/** Browser team module. See README.md for ownership and startup. */
import { agentGlyph,agentLabel,labelOf } from './agents.js';
import { copyText } from './clipboard.js';
import { api } from './connection.js';
import { esc,hue,money,rel } from './format.js';
import { ICONS,LOADER } from './icons.js';
import { toast } from './notifications.js';
import { permBadge } from './permissions.js';
import { state } from './state.js';
import { openJoin } from './join.js';
import { ORCH_RUN_ST } from './transcript.js';


  // ---- Loom Teams, Phase 1: see each other (docs/teams-architecture.md) -----
  // GET /api/team is the daemon's decrypted view (daemon/team.ts): members,
  // shared repos, live presence and the feed. Intent only \u2014 goal and task
  // titles, never prompts or transcripts (D24). Every surface that draws it
  // (Fleet's Team block, Settings \u2192 Team, a project's share control)
  // reads the one copy in state.team and is told when it changes.
  function teamHooks(){ return state.teamHooks || (state.teamHooks = {}); }

  /** Tell every open team surface. force: redraw even over a half-typed form. */
  function teamNotify(force){
    var h = teamHooks();
    Object.keys(h).forEach(function(k){ h[k](!!force); });
  }

  function loadTeam(){
    if (state.teamLoading) return state.teamLoading;
    state.teamLoading = api("/api/team").then(function(j){ state.team = j; state.teamErr = ""; })
      .catch(function(err){ state.teamErr = err.message || String(err); })
      .then(function(){ state.teamLoading = null; teamNotify(false); return state.team; });
    return state.teamLoading;
  }

  /** POST /api/team/:action \u2014 the answer carries the fresh view, so no re-read. */
  function teamAct(action, body){
    return api("/api/team/" + action, { method: "POST", body: JSON.stringify(body || {}) }).then(function(j){
      if (j && j.team) { state.team = j.team; state.teamErr = ""; teamNotify(true); }
      return j ? j.result : null;
    });
  }

  // A heartbeat is one frame per live session every 15s; a burst of them (a
  // teammate's plan fanning out) coalesces into one read.
  var teamFrameT = null, runnerFrameT = null;

  function onTeamFrame(frame){
    // the one brain moved (a memory, a resolution, a canon PR): the Team view re-reads
    var ev = (frame && frame.event) || {}, fe = ev.event || {};
    if ((ev.type === "memory" || (ev.type === "feed" && (fe.type === "memory_resolved" || fe.type === "canon_proposed"))) && state.teamBrainPing) state.teamBrainPing();
    // a goal came up for adoption, was taken or landed: "Needs someone" re-reads
    if (ev.type === "feed" && TEAM_LANDING_EVENTS[fe.type] && state.pid && teamLandings[state.pid]) loadTeamLanding(state.pid, true);
    // Phase 5: a runner claimed, advanced or finished a job — the Runners list re-reads, once per burst
    if ((ev.type === "job" || (ev.type === "feed" && fe.type === "goal_moved")) && state.pid && !runnerFrameT) {
      runnerFrameT = setTimeout(function(){ runnerFrameT = null; if (state.pid) loadTeamRunners(state.pid, true); }, 400);
    }
    if (teamFrameT) return;
    teamFrameT = setTimeout(function(){ teamFrameT = null; loadTeam(); }, 300);
  }

  /** A form in this host has something typed into it: don't redraw over it. */
  function teamEditing(host){
    var a = document.activeElement;
    if (a && host.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    return Array.prototype.some.call(host.querySelectorAll("input[data-tf]"), function(i){ return !!i.value.trim(); });
  }

  /** "2m 10s" since a turn started \u2014 how long it has been at it. */
  function fleetSince(ts){
    var s = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
    return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
  }

  /** A person, as hue initials \u2014 the same hash the agents' monograms use. */
  function teamAvatar(login, cls){
    var h = hue(String(login || "?"));
    return '<span class="tav' + (cls ? " " + cls : "") + '" aria-hidden="true" style="background:color-mix(in srgb, hsl(' + h + ',60%,50%) 20%, transparent);color:hsl(' + h + ',60%,var(--agent-l))">' +
      esc(String(login || "?").slice(0, 1)) + "</span>";
  }

  /**
   * A presence's agent, for people: "codex#t1" is Codex on task t1,
   * "claude-code#orch" the orchestrator, a bare id a roster agent.
   */
  function teamAgentOf(p){
    var raw = String(p.agent || ""), i = raw.indexOf("#");
    var id = i < 0 ? raw : raw.slice(0, i), tag = i < 0 ? "" : raw.slice(i + 1);
    var label = agentLabel(p.kind, id);
    var what = tag === "orch" ? "orchestrator" : tag ? "task " + tag : "";
    var bits = [what];
    if (id !== label) bits.push(id);
    return { id: id, label: label, what: what, sub: bits.filter(Boolean).join(" \u00b7 ") };
  }

  var TEAM_ST = { idle: ["idle", "off"], planning: ["planning", "off"], running: ["running", "live"],
    reviewing: ["reviewing", "off"], waiting_human: ["needs them", "warn"], ci: ["in CI", "live"] };

  function teamPill(st){
    var s = TEAM_ST[st] || [st || "\u2014", "off"];
    return '<span class="opill ' + s[1] + '"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + "</span>";
  }

  /** File globs as mono chips: the first n, then "+N more". */
  function teamGlobs(list, n){
    var out = list.slice(0, n).map(function(g){ return '<span class="tglob" title="' + esc(g) + '">' + esc(g) + "</span>"; });
    if (list.length > n) out.push('<span class="tglob more" title="' + esc(list.slice(n).join("\n")) + '">+' + (list.length - n) + " more</span>");
    return out.join("");
  }

  function teamOthers(t){ return (t.presence || []).filter(function(p){ return !p.mine; }); }

  /**
   * A goal on the team, by run id: its title (when this device holds the key)
   * and whose it is, from its leases or the feed. {} when nobody has said.
   */
  function teamGoalOf(runId){
    var out = {};
    if (!runId) return out;
    ((state.team && state.team.teams) || []).forEach(function(t){
      (t.leases || []).forEach(function(l){
        if (l.runId !== runId) return;
        out.github = out.github || l.github;
        if (l.intent && l.intent.goal) out.goal = out.goal || l.intent.goal;
      });
      (t.feed || []).forEach(function(e){
        if (!e.meta || e.meta.runId !== runId) return;
        if (e.type === "goal_started") out.github = out.github || e.github;
        if (e.content && e.content.goal) out.goal = out.goal || e.content.goal;
      });
    });
    return out;
  }

  /** "‘Add OAuth login’", or the bare run id when the title isn't known here. */
  function orchGoalName(runId){
    var g = teamGoalOf(runId);
    return g.goal ? "\u2018" + esc(g.goal) + "\u2019" : "goal <code>" + esc(runId || "?") + "</code>";
  }


  /** One teammate session: who, doing what (by title), claiming which files, on which branch. */
  function teamRow(p){
    var a = teamAgentOf(p), it = p.intent, main, sub = "";
    if (!it) main = '<span class="sealed">sealed \u2014 this device has no key for it</span>';
    else if (it.task) { main = esc(it.task); sub = it.goal ? esc(it.goal) : ""; }
    else if (it.goal) { main = esc(it.goal); sub = it.role === "orchestrator" ? "orchestrating this goal" : ""; }
    else if (it.thread) { main = esc(it.thread); sub = "a thread"; }
    else main = '<span class="sealed">untitled</span>';
    var touches = p.touches || [];
    return '<div class="tses" data-tagent="' + esc(p.agent) + '">' +
      '<span class="fg">' + agentGlyph(p.kind, a.id) + "</span>" +
      '<span class="tsn"><b>' + esc(a.label) + "</b>" + (a.sub ? "<small>" + esc(a.sub) + "</small>" : "") + "</span>" +
      '<span class="tst">' + teamPill(p.state) + (p.since ? '<span class="ft">' + fleetSince(p.since) + "</span>" : "") + "</span>" +
      '<span class="tsi"><b class="tit">' + main + "</b>" + (sub ? '<small class="tsub">' + sub + "</small>" : "") +
        (touches.length ? '<span class="tglobs">' + teamGlobs(touches, 3) + "</span>" : "") + "</span>" +
      '<span class="tbr">' + (p.branch ? ICONS.branch + '<span title="' + esc(p.branch) + '">' + esc(p.branch) + "</span>" : "") + "</span></div>";
  }

  /** Teammates' sessions, grouped by member (roster order) then repo. */
  function teamSessionsHtml(t){
    var others = teamOthers(t);
    var head = '<div class="tsech">Live sessions<span class="n">' + others.length + "</span></div>";
    if (!others.length) {
      return head + '<div class="tempty">Nobody else on ' + esc(t.name) + " has an agent running right now. When a teammate starts one in a shared repo it shows up here \u2014 what it\u2019s working on, never what it\u2019s saying.</div>";
    }
    var order = (t.members || []).map(function(m){ return m.github; });
    var by = {};
    others.forEach(function(p){ var k = p.github || p.userId; (by[k] = by[k] || []).push(p); });
    var rank = function(k){ var i = order.indexOf(k); return i < 0 ? 1e6 : i; };
    return head + Object.keys(by).sort(function(a, b){ return rank(a) - rank(b) || (a < b ? -1 : 1); }).map(function(k){
      var list = by[k], repos = {};
      list.forEach(function(p){ (repos[p.repo] = repos[p.repo] || []).push(p); });
      var m = (t.members || []).filter(function(x){ return x.github === k; })[0];
      return '<div class="tgrp" data-tmember="' + esc(k) + '"><div class="tgh">' + teamAvatar(k, "lg") + "<b>" + esc(k) + "</b>" +
        (m && m.name && m.name !== k ? "<small>" + esc(m.name) + "</small>" : "") +
        "<small>" + list.length + " session" + (list.length === 1 ? "" : "s") + "</small></div>" +
        Object.keys(repos).sort().map(function(r){
          // the orchestrator heads its run; then oldest first
          var ps = repos[r].slice().sort(function(a, b){
            return (/#orch$/.test(b.agent) - /#orch$/.test(a.agent)) || (Number(a.since) - Number(b.since));
          });
          return '<div class="trepoh">' + ICONS.github + esc(r) + "</div>" + ps.map(teamRow).join("");
        }).join("") + "</div>";
    }).join("");
  }

  /**
   * The lease map, Phase 1: every glob a teammate's session has declared, and
   * whose. Two people on one glob is the collision it exists to show early.
   * Drawn whole for a daemon that predates real leases, and under the real
   * ones for sessions that hold none \u2014 a task queued before it could claim,
   * or a teammate on an older Loom.
   */
  function teamPresenceLeasesHtml(t){
    var others = teamOthers(t);
    var globs = teamClaimMap(others);
    var head = '<div class="tsech">Lease map<span class="n">' + Object.keys(globs).length + "</span></div>";
    if (!Object.keys(globs).length) return head + '<div class="tempty">No files claimed. The globs a teammate\u2019s task touches land here, so you can see which areas are taken before you start.</div>';
    return head + teamClaimRows(globs);
  }

  function teamClaimMap(sessions){
    var map = {};
    sessions.forEach(function(p){
      var a = teamAgentOf(p);
      (p.touches || []).forEach(function(g){ (map[g] = map[g] || []).push({ who: p.github, agent: a.what ? a.label + " \u00b7 " + a.what : a.label }); });
    });
    return map;
  }

  function teamClaimRows(map){
    return Object.keys(map).sort().map(function(g){
      var ws = map[g], people = {};
      ws.forEach(function(w){ people[w.who] = 1; });
      return '<div class="tlease' + (Object.keys(people).length > 1 ? " clash" : "") + '" data-tlease="' + esc(g) + '">' +
        '<span class="tglob" title="' + esc(g) + '">' + esc(g) + "</span>" +
        '<span class="tlw">' + ws.map(function(w){ return "<span>" + teamAvatar(w.who) + "<b>" + esc(w.who) + "</b>" + esc(w.agent) + "</span>"; }).join("") + "</span></div>";
    }).join("");
  }

  // ---- leases, Phase 2: what each goal's tasks have claimed (D28, D36) ------
  // A lease is active while its task runs, landing once it's done but the
  // goal's PR hasn't merged, and stale when its owner's machine has gone
  // quiet for 10 minutes (it no longer blocks anyone).
  var LEASE_STALE_MS = 10 * 60000;

  function leaseStale(l){ return !!l.stale || (l.ts && Date.now() - Number(l.ts) > LEASE_STALE_MS); }

  /** "src/auth/x.ts" under "src/auth/" (or equal to an exact path). "" is repo-wide. */
  function leaseUnder(p, prefix){
    if (prefix === "") return true;
    if (prefix.slice(-1) === "/") return p.indexOf(prefix) === 0;
    return p === prefix || p.indexOf(prefix + "/") === 0;
  }

  // A glob's literal directory prefix: "src/auth/**" gives "src/auth/"; a glob that
  // starts with a wildcard gives "" (repo-wide).
  function leasePrefix(g){
    g = String(g || "").replace(/^\.\//, "");
    var w = g.search(/[*?{]/);
    if (w < 0) return g;
    var head = g.slice(0, w), sl = head.lastIndexOf("/");
    return sl < 0 ? "" : head.slice(0, sl + 1);
  }

  /**
   * Where two leases seem to collide: a shared file, a file of one under the
   * other's prefix, or nested prefixes. A hint only \u2014 it sees the first 20
   * files of each; the hub's own check (team-leases.ts) is the authority.
   */
  function leaseClash(a, b){
    var out = [];
    var add = function(p){ if (out.indexOf(p) < 0) out.push(p); };
    var pre = function(l){ return ((l.prefixes && l.prefixes.length) ? l.prefixes : (l.globs || []).map(leasePrefix)).filter(function(p){ return p !== ""; }); };
    var af = a.files || [], bf = b.files || [], ap = pre(a), bp = pre(b);
    af.forEach(function(f){ if (bf.indexOf(f) >= 0) add(f); });
    af.forEach(function(f){ if (bp.some(function(p){ return leaseUnder(f, p); })) add(f); });
    bf.forEach(function(f){ if (ap.some(function(p){ return leaseUnder(f, p); })) add(f); });
    ap.forEach(function(x){ bp.forEach(function(y){ if (leaseUnder(x, y) || leaseUnder(y, x)) add(x.length >= y.length ? x : y); }); });
    return out.sort();
  }

  function leasePill(l){
    if (leaseStale(l)) return '<span class="opill off" title="its owner\u2019s machine has been quiet for over 10 minutes \u2014 it no longer blocks anyone"><span class="odot off"></span>stale</span>';
    if (l.state === "landing") return '<span class="opill ok" title="the task is done; the goal\u2019s PR hasn\u2019t merged yet"><span class="odot ok"></span>landing</span>';
    return '<span class="opill live"><span class="odot live"></span>active</span>';
  }

  function teamLeaseRow(l, mine){
    var it = l.intent, main, sub = "";
    if (!it) main = '<span class="sealed">sealed \u2014 this device has no key for it</span>';
    else { main = esc(it.task || it.goal || "untitled"); sub = it.task && it.goal ? esc(it.goal) : ""; }
    // a teammate's live lease against one of yours: the collision, early
    var clash = [];
    if (!l.mine && !leaseStale(l)) mine.forEach(function(m){ leaseClash(l, m).forEach(function(p){ if (clash.indexOf(p) < 0) clash.push(p); }); });
    var n = Number(l.fileCount != null ? l.fileCount : (l.files || []).length);
    return '<div class="tlrow' + (leaseStale(l) ? " stale" : "") + (clash.length ? " clash" : "") + '" data-tlease="' + esc(l.id) + '" data-tlstate="' + (leaseStale(l) ? "stale" : esc(l.state || "active")) + '">' +
      '<div class="tlr1"><span class="tlt"><b class="tit">' + main + "</b>" + (sub ? '<small class="tsub">' + sub + "</small>" : "") + "</span>" + leasePill(l) + "</div>" +
      '<div class="tlr2"><span class="oid">' + esc(l.taskId || "") + "</span>" + teamGlobs(l.globs || [], 3) +
        '<span class="tlfc">' + n + " file" + (n === 1 ? "" : "s") + "</span></div>" +
      (clash.length ? '<div class="tlclash">' + ICONS.alert + "<span>overlaps yours: " + clash.slice(0, 3).map(function(p){ return "<code>" + esc(p) + "</code>"; }).join(", ") +
        (clash.length > 3 ? " +" + (clash.length - 3) : "") + "</span></div>" : "") + "</div>";
  }

  /** Every lease on the team, grouped by member (roster order, yours last). */
  function teamLeasesHtml(t){
    if (!Array.isArray(t.leases)) return teamPresenceLeasesHtml(t);
    var leases = t.leases, leased = {};
    leases.forEach(function(l){ leased[l.runId + "/" + l.taskId] = 1; });
    var claims = teamClaimMap(teamOthers(t).filter(function(p){ return p.taskId && !leased[p.runId + "/" + p.taskId]; }));
    var nc = Object.keys(claims).length;
    var tail = nc ? '<div class="tsech tclh">Declared, no lease yet<span class="n">' + nc + "</span></div>" + teamClaimRows(claims) : "";
    var head = '<div class="tsech">Leases<span class="n">' + leases.length + "</span></div>";
    if (!leases.length) return head + (nc ? "" : '<div class="tempty">No files claimed. When a goal\u2019s task starts, the files it declared land here \u2014 so you can see which areas are taken before you start.</div>') + tail;
    var mine = leases.filter(function(l){ return l.mine && !leaseStale(l); });
    var order = (t.members || []).map(function(m){ return m.github; });
    var by = {};
    leases.forEach(function(l){ var k = l.mine ? "" : l.github || "?"; (by[k] = by[k] || []).push(l); });
    var rank = function(k){ if (k === "") return 2e6; var i = order.indexOf(k); return i < 0 ? 1e6 : i; };
    return head + Object.keys(by).sort(function(a, b){ return rank(a) - rank(b) || (a < b ? -1 : 1); }).map(function(k){
      var list = by[k].slice().sort(function(a, b){ return leaseStale(a) - leaseStale(b) || Number(a.since) - Number(b.since); });
      var who = k || (state.team && state.team.github) || "you";
      return '<div class="tlgrp" data-tlmember="' + esc(k || "you") + '"><div class="tgh">' + teamAvatar(who) + "<b>" + esc(k ? k : "Yours") + "</b>" +
        "<small>" + list.length + " lease" + (list.length === 1 ? "" : "s") + "</small></div>" +
        list.map(function(l){ return teamLeaseRow(l, mine); }).join("") + "</div>";
    }).join("") + tail;
  }

  /** A feed event as a sentence, with an icon and a state tint. Never the payload. */
  function teamFeedLine(e, t){
    var m = e.meta || {}, c = e.content;
    var who = "<b>" + esc(e.github || m.github || m.author || "someone") + "</b>";
    var q = function(s){ return '<span class="tq">\u2018' + esc(s) + "\u2019</span>"; };
    var goal = c && c.goal ? q(c.goal) : c ? "a goal" : '<span class="sealed">a goal it can\u2019t read (no key)</span>';
    var url = m.url || m.prUrl || "";
    var num = m.number || m.pr || (String(url).match(/\/pull\/(\d+)/) || [])[1];
    var prTxt = num ? "PR #" + esc(num) : "a PR";
    var pr = url ? '<a href="' + esc(url) + '" target="_blank" rel="noreferrer">' + prTxt + "</a>" : "<b>" + prTxt + "</b>";
    var title = c && c.title ? " \u2014 " + q(c.title) : "";
    var branch = m.branch ? " on <code>" + esc(m.branch) + "</code>" : "";
    var by = m.author ? " by <b>" + esc(m.author) + "</b>" : "";
    var prAfter = m.prUrl ? ' \u2014 <a href="' + esc(m.prUrl) + '" target="_blank" rel="noreferrer">' + (num ? "PR #" + esc(num) : "its PR") + "</a>" : "";
    switch (e.type) {
      case "member_joined": return { icon: ICONS.team, cls: "", html: who + " joined" };
      case "member_left": return { icon: ICONS.team, cls: "", html: who + " left the team" + (m.rotateKey ? " \u2014 the key rotates" : "") };
      case "key_rotated": return { icon: ICONS.key, cls: "", html: "key rotated to <b>v" + esc(m.version) + "</b>" + (e.github ? " by " + who : "") };
      case "repo_shared": return { icon: ICONS.github, cls: "", html: who + " shared <code>" + esc(m.repo || e.repo) + "</code>" };
      case "goal_started": {
        var ws = Array.isArray(m.workers) ? m.workers : [];
        var crew = m.orchestrator ? " (" + esc(m.orchestrator) + (ws.length ? " \u2192 " + ws.map(esc).join(", ") : "") + ")" : "";
        return { icon: ICONS.orchestra, cls: "live", html: who + " started " + goal + crew };
      }
      case "goal_finished":
        if (m.status === "failed") return { icon: ICONS.x, cls: "err", html: who + "\u2019s " + goal + " failed" };
        if (m.status === "aborted") return { icon: ICONS.stop, cls: "", html: who + " stopped " + goal };
        return { icon: ICONS.check, cls: "ok", html: who + " finished " + goal + prAfter };
      case "plan_written": return { icon: ICONS.plan, cls: "", html: who + "\u2019s orchestrator wrote the plan for " + goal };
      case "pr_opened":
        // Loom's own delivery says whose goal it was; gh's polling says the branch
        if (c && c.goal) return { icon: ICONS.pr, cls: "live", html: who + " opened " + pr + " for " + goal };
        return { icon: ICONS.pr, cls: "live", html: pr + " opened" + branch + title + by };
      case "pr_merged": return { icon: ICONS.pr, cls: "ok", html: pr + " merged" + title };
      case "pr_closed": return { icon: ICONS.pr, cls: "", html: pr + " closed without merging" + title };
      case "check_failed": {
        var names = Array.isArray(m.checks) ? m.checks : [];
        return { icon: ICONS.x, cls: "err", html: "check" + (names.length > 1 ? "s" : "") + " failed on " + pr + (names.length ? ": " + names.map(function(n){ return "<code>" + esc(n) + "</code>"; }).join(", ") : "") };
      }
      case "check_passed": return { icon: ICONS.check, cls: "ok", html: "checks passed on " + pr };
      case "review_requested": return { icon: ICONS.pr, cls: "", html: "review requested on " + pr + title };
      case "review_submitted": {
        // a human's review, from a GitHub webhook (Phase 6, D83)
        if (m.review) return { icon: ICONS.pr, cls: m.review === "changes_requested" ? "warn" : m.review === "approved" ? "ok" : "",
          html: "<b>" + esc(m.by || "someone") + "</b> " + (m.review === "approved" ? "approved" : m.review === "changes_requested" ? "asked for changes on" : "reviewed") + " " + pr + title };
        // Loom's own cross-vendor review (D60) says who reviewed and how it went
        if (!m.reviewer && !m.state) return { icon: ICONS.pr, cls: "", html: who + " reviewed " + pr + title };
        var hi = Number(m.high || 0);
        var verdict = m.state === "skipped" ? "skipped" : m.state === "failure" ? hi + " high finding" + (hi === 1 ? "" : "s") : "passed";
        return { icon: ICONS.pr, cls: m.state === "failure" ? "err" : m.state === "success" ? "ok" : "",
          html: "loom/review on " + who + "’s " + pr + (m.reviewer ? " by " + esc(labelOf(String(m.reviewer))) : "") + ": " + verdict };
      }
      // Phase 4: landing safely (D52–D64)
      case "goal_landed": return { icon: ICONS.check, cls: "ok", html: who + "’s " + teamFeedGoal(m.runId, c) + " landed — " + pr + " merged" + (m.costUsd ? " (" + money(m.costUsd) + ")" : "") };
      case "goal_needs_someone": return { icon: ICONS.alert, cls: "warn", html: who + "’s " + pr + " needs someone" + (m.reason ? ": " + esc(String(m.reason)) : "") };
      case "goal_adopted": return { icon: ICONS.team, cls: "live", html: "<b>" + esc(m.by || e.github || "someone") + "</b> adopted " + (m.owner ? "<b>" + esc(m.owner) + "</b>’s " : "") + pr };
      case "goal_returned": return { icon: ICONS.team, cls: "ok", html: "<b>" + esc(m.by || e.github || "someone") + "</b> handed " + pr + " back" + (m.owner ? " to <b>" + esc(m.owner) + "</b>" : "") + " — green" };
      case "check_flaky": return { icon: ICONS.refresh, cls: "", html: "<code>" + esc(m.check || "a check") + "</code> was flaky on " + pr + " — failed, then passed on rerun" };
      // Phase 6: the landing train (D79\u2013D82)
      case "land_queued": return { icon: ICONS.branch, cls: "", html: who + "’s " + pr + " is queued to land" + (m.lane ? " in lane <code>" + esc(m.lane) + "</code>" : "") + (m.behind ? ", behind <b>" + esc(m.behind) + "</b>" : "") };
      case "land_turn": return { icon: ICONS.branch, cls: "live", html: who + "’s " + pr + " is landing now" + (Array.isArray(m.lanes) && m.lanes.length ? " (lane" + (m.lanes.length === 1 ? " " : "s ") + m.lanes.map(function(x){ return "<code>" + esc(x) + "</code>"; }).join(", ") + ")" : "") };
      // Phase 5: runners and deploys (D69, D72, D75) \u2014 Loom reads deploys, never runs them
      case "goal_moved": return { icon: ICONS.orchestra, cls: "live", html: who + " moved " + teamFeedGoal(m.runId, c) + " to <b>" + esc(m.to || "a runner") + "</b>" };
      case "deploy_started": case "deploy_succeeded": case "deploy_failed": {
        var env = "<b>" + esc(m.environment || "an environment") + "</b>", sha = m.sha ? "<code>" + esc(String(m.sha).slice(0, 7)) + "</code>" : "a deploy";
        var tail = (m.creator ? " by <b>" + esc(m.creator) + "</b>" : "") +
          (/^https?:\/\//.test(String(m.url || "")) ? ' \u2014 <a href="' + esc(m.url) + '" target="_blank" rel="noreferrer">log</a>' : "");
        if (e.type === "deploy_started") return { icon: ICONS.cloud, cls: "live", html: "deploying " + sha + " to " + env + tail };
        if (e.type === "deploy_succeeded") return { icon: ICONS.check, cls: "ok", html: sha + " deployed to " + env + tail };
        return { icon: ICONS.x, cls: "err", html: "deploy of " + sha + " to " + env + " failed" + tail };
      }
      // Phase 2: leases, overlaps and zones (D29\u2013D36)
      case "lease_released": {
        var nl = Number(m.leases || 0), why = String(m.reason || "");
        var landed = /merged|applied|delivered/i.test(why);
        return { icon: landed ? ICONS.check : ICONS.info, cls: landed ? "ok" : "",
          html: who + "\u2019s " + teamFeedGoal(m.runId, c) + (landed ? " landed \u2014 " : " \u2014 ") + (nl || "its") + " lease" + (nl === 1 ? "" : "s") + " released" +
            (why ? " (" + esc(why) + ")" : "") };
      }
      case "overlap_decided": {
        var mineRuns = teamMyRuns(t), withs = Array.isArray(m.with) ? m.with : [];
        var yours = withs.some(function(r){ return mineRuns.indexOf(r) >= 0; });
        var what = c && c.goal ? q(c.goal) : "<code>" + esc(m.taskId || "a task") + "</code>";
        var along = yours ? "yours" : withs.length ? withs.map(function(r){ return teamFeedGoal(r, null); }).join(", ") : "a teammate\u2019s work";
        return { icon: ICONS.orchestra, cls: yours ? "warn" : "",
          html: who + "\u2019s " + what + " proceeds alongside " + along + (c && c.reason ? ": " + esc(c.reason) : "") };
      }
      case "drift": {
        var paths = Array.isArray(m.paths) ? m.paths : [], holders = Array.isArray(m.holders) ? m.holders : [];
        var me = state.team && state.team.github;
        var names = holders.map(function(h){ return h === me ? "you" : "<b>" + esc(h) + "</b>"; });
        var held = names.length ? " (" + names.join(" and ") + " " + (names.length === 1 && names[0] !== "you" ? "holds" : "hold") + " " + (paths.length === 1 ? "it" : "them") + ")" : "";
        return { icon: ICONS.alert, cls: holders.length ? "warn" : "",
          html: who + "\u2019s " + esc(m.taskId || "task") + " edited " + teamPaths(paths) + " outside its plan" + held };
      }
      case "zone_waiting": {
        var holder = m.holder && state.team && m.holder === state.team.github ? "your" : "<b>" + esc(m.holder || "a teammate") + "</b>\u2019s";
        return { icon: ICONS.lock, cls: "",
          html: who + "\u2019s " + esc(m.taskId || "task") + " is queued behind " + holder + " hard zone <code>" + esc(m.zone || "?") + "</code>" };
      }
      case "conflict_predicted": {
        var runs = Array.isArray(m.runs) ? m.runs : [], mem = Array.isArray(m.members) ? m.members : [];
        var side = function(i){ return "<b>" + esc(mem[i] || "someone") + "</b>\u2019s " + teamFeedGoal(runs[i], null); };
        return { icon: ICONS.alert, cls: "err",
          html: "merge conflict predicted between " + side(0) + " and " + side(1) + " in " + teamPaths(Array.isArray(m.files) ? m.files : []) };
      }
      default: return { icon: ICONS.info, cls: "", html: who + " \u00b7 " + esc(String(e.type || "event").replace(/_/g, " ")) };
    }
  }

  /** A goal in a feed sentence: its title from the event, or from the rest of the team's view, else its id. */
  function teamFeedGoal(runId, c){
    if (c && c.goal) return '<span class="tq">\u2018' + esc(c.goal) + "\u2019</span>";
    var g = teamGoalOf(runId);
    return g.goal ? '<span class="tq">\u2018' + esc(g.goal) + "\u2019</span>" : runId ? "<code>" + esc(runId) + "</code>" : "goal";
  }

  /** Paths as code, the first three then "+N more". */
  function teamPaths(list){
    return (list.slice(0, 3).map(function(p){ return "<code>" + esc(p) + "</code>"; }).join(", ") || "files") + (list.length > 3 ? " +" + (list.length - 3) + " more" : "");
  }

  /** Run ids of this member's own goals on a team, as its leases say. */
  function teamMyRuns(t){
    return ((t && t.leases) || []).filter(function(l){ return l.mine; }).map(function(l){ return l.runId; });
  }

  function teamFeedHtml(t, n){
    var feed = (t.feed || []).slice(-n).reverse();
    var head = '<div class="tsech">Team feed<span class="n">' + (t.feed || []).length + "</span></div>";
    if (!feed.length) return head + '<div class="tempty">Nothing yet. Goals started and finished, plans, PRs and checks from shared repos land here.</div>';
    return head + feed.map(function(e){
      var f = teamFeedLine(e, t);
      return '<div class="tfe' + (f.cls ? " " + f.cls : "") + '" data-tfeed="' + esc(e.type) + '"><span class="tfi">' + f.icon + "</span>" +
        '<span class="tft">' + f.html + "</span>" + '<span class="tfr">' + (e.ts ? rel(e.ts) : "") + "</span></div>";
    }).join("");
  }

  /** Member chips for a team header: initials, login, owner and you marked. */
  function teamMembersHtml(t){
    var me = state.team && state.team.github;
    return (t.members || []).map(function(m){
      return '<span class="tmem' + (m.role === "owner" ? " own" : "") + '" data-tmem="' + esc(m.github) + '" title="' + esc(m.github + " \u00b7 " + m.role) + '">' +
        teamAvatar(m.github) + '<span class="tml">' + esc(m.github) + "</span>" +
        (m.role === "owner" ? '<span class="tmo">owner</span>' : m.role === "viewer" ? '<span class="tmo">viewer</span>' : "") +
        (m.github === me ? '<span class="tmo">you</span>' : "") + "</span>";
    }).join("");
  }

  // ---- invites: the link carries the team key, so it's shown like a password
  // Kept per team until dismissed, so a redraw (a poll, a teammate's heartbeat)
  // doesn't take it away while you're copying it.
  var teamInvites = {};

  function teamInviteHtml(teamId){
    var inv = teamInvites[teamId]; if (!inv) return "";
    var mins = inv.expiresAt ? Math.max(1, Math.round((inv.expiresAt - Date.now()) / 60000)) : 0;
    var left = !mins ? "" : mins >= 120 ? "about " + Math.round(mins / 60) + " hours" : mins + " minute" + (mins === 1 ? "" : "s");
    return '<div class="tinv" data-tinvfor="' + esc(teamId) + '">' +
      '<div class="tinvw">' + ICONS.shield + "<span><b>Treat this link like a password.</b> It carries the team key: whoever opens it joins the team and can read every goal and task title. Send it to one person, privately. It works once" + (left ? " and expires in " + left : "") + ".</span></div>" +
      '<div class="tinvrow"><input readonly class="tinvlink" aria-label="invite link" value="' + esc(inv.link) + '">' +
        '<button class="btn ghost sm" type="button" data-tshow>Show</button>' +
        '<button class="btn outline sm" type="button" data-tcopy>' + ICONS.copy + "Copy</button>" +
        '<button class="iconbtn" type="button" data-thide title="forget this link" aria-label="forget this link">' + ICONS.x + "</button></div>" +
      '<span class="tinvx">they click it \u2014 or run <b>loom join &lt;link&gt;</b>. For the repo and crews too, use <b>Invite</b> in a project.</span></div>';
  }

  function wireTeamInvites(host, act){
    Array.prototype.forEach.call(host.querySelectorAll("[data-tinvite]"), function(b){
      b.onclick = function(){
        var id = b.getAttribute("data-tinvite");
        b.disabled = true;
        act("invite", { teamId: id }).then(function(r){
          teamInvites[id] = r; teamNotify(true);
        }).catch(function(err){ b.disabled = false; toast(err.message); });
      };
    });
    Array.prototype.forEach.call(host.querySelectorAll(".tinv"), function(box){
      var id = box.getAttribute("data-tinvfor"), inp = box.querySelector(".tinvlink");
      var sh = box.querySelector("[data-tshow]");
      if (sh) sh.onclick = function(){ var on = inp.classList.toggle("shown"); sh.textContent = on ? "Hide" : "Show"; };
      var cp = box.querySelector("[data-tcopy]");
      if (cp) cp.onclick = function(){ inp.select(); copyText(inp.value); };
      var hd = box.querySelector("[data-thide]");
      if (hd) hd.onclick = function(){ delete teamInvites[id]; teamNotify(true); };
    });
  }

  // ---- joining or creating: one pair of forms, in Fleet and in Settings -----
  function teamField(label, key, attrs){
    return '<div class="field"><label>' + label + '</label><input data-tf="' + key + '" aria-label="' + esc(String(label).replace(/<[^>]+>/g, "").trim()) + '" autocomplete="off" spellcheck="false" ' + (attrs || "") + "></div>";
  }

  function teamJoinCardHtml(){
    var t = state.team || {}, signed = !!t.signedIn;
    return '<div class="tcard tjoincard"><div class="tjoin">' +
      "<div>" +
        '<div class="tjh">' + ICONS.team + "Join your team</div>" +
        '<div class="tjd">Paste the invite link a teammate sent you \u2014 Loom signs you in, clones the repo and sets up your agents. It carries the hub\u2019s address and the team key.</div>' +
        teamField("Invite link", "link", 'class="mono" placeholder="https://\u2026/join/#\u2026"') +
        '<div class="tjgo"><button class="btn primary sm" type="button" data-tjoin>Join team</button></div>' +
      "</div>" +
      "<div>" +
        '<div class="tjh">' + ICONS.plus + "Create a team</div>" +
        '<div class="tjd">' + (signed
          ? "Signed in as <b>" + esc(t.github) + "</b> on " + esc(t.hub) + ". Name the team, then invite people."
          : "Sign in to a Loom Team Hub (run one with <b>loom hub</b>), then name the team.") + "</div>" +
        (signed ? "" : teamField("Hub URL", "hub", 'class="mono" placeholder="https://hub.example.com"') +
          teamField("GitHub login", "cgh", 'placeholder="your GitHub username"') +
          teamField('Join secret <span class="opt">optional</span>', "csec", 'type="password"')) +
        teamField("Team name", "name", 'placeholder="e.g. Acme"') +
        '<div class="tjgo"><button class="btn outline sm" type="button" data-tcreate>Create team</button></div>' +
      "</div></div>" +
      '<div class="tjfoot">Teammates see each other\u2019s live agents and goals. Titles are encrypted with a key only members hold; prompts and transcripts never leave this machine.</div></div>';
  }

  /** Wire the join / create / sign-in forms in host. act is teamAct, or Settings' generation-guarded twin. */
  function wireTeamForms(host, act){
    var v = function(k){ var i = host.querySelector('[data-tf="' + k + '"]'); return i ? i.value.trim() : ""; };
    var opt = function(o){ Object.keys(o).forEach(function(k){ if (!o[k]) delete o[k]; }); return o; };
    var jb = host.querySelector("[data-tjoin]");
    if (jb) jb.onclick = function(){
      var link = v("link");
      if (!link) { toast("paste the invite link first"); return; }
      // One link does the whole join — team, repo, agents, crews — on its own page (join.js).
      if (document.querySelector(".scrim")) document.querySelector(".scrim").remove();
      openJoin(link);
    };
    var cb = host.querySelector("[data-tcreate]");
    if (cb) cb.onclick = function(){
      var name = v("name");
      if (!name) { toast("name the team first"); return; }
      var signed = state.team && state.team.signedIn;
      if (!signed && !v("hub")) { toast("which hub? paste its URL"); return; }
      cb.disabled = true;
      var first = signed ? Promise.resolve() : act("signin", opt({ hub: v("hub"), github: v("cgh"), secret: v("csec") }));
      first.then(function(){ return act("create", { name: name }); })
        .then(function(r){ toast("created " + ((r && r.name) || name) + " \u2014 now invite your teammates"); })
        .catch(function(err){ cb.disabled = false; toast(err.message); });
    };
    var sb = host.querySelector("[data-tsignin]");
    if (sb) sb.onclick = function(){
      if (!v("hub")) { toast("which hub? paste its URL"); return; }
      sb.disabled = true;
      act("signin", opt({ hub: v("hub"), github: v("cgh"), secret: v("csec") }))
        .then(function(){ toast("signed in to the team hub"); })
        .catch(function(err){ sb.disabled = false; toast(err.message); });
    };
  }

  // ---- sharing a project: Shared / Private / Auto (D8) ----------------------
  // POST share is an explicit opt-in, DELETE an explicit opt-out; with neither,
  // the daemon shares a project whose origin matches a team repo. It keeps the
  // choice in .loom/config.json ("team") and learns the repo from .git/config,
  // so the control reads both, through the same file endpoint Explorer uses:
  // what it shows is what the daemon will do, not what this window last did.
  var teamShares = {};
 // pid → {cfg: config.team, repo: "owner/name" or ""}, or {loading: true}
  /** "git@github.com:Acme/App.git" → "acme/app"; anything not GitHub → "". */
  function ghRepo(url){
    url = String(url || "").trim();
    if (!/github\.com[:\/]/i.test(url)) return "";
    var r = url.replace(/^.*github\.com[:\/]/i, "").replace(/\.git$/, "").replace(/\/$/, "");
    return /^[\w.-]+\/[\w.-]+$/.test(r) ? r.toLowerCase() : "";
  }

  function loadTeamShare(pid){
    var cur = teamShares[pid];
    if (cur && cur.loading) return;
    teamShares[pid] = { loading: true, cfg: cur && cur.cfg, repo: cur ? cur.repo : "" };
    api("/api/projects/" + pid + "/team/share").then(function(j){
      teamShares[pid] = { cfg: j.cfg, repo: j.repo || "" }; // no cfg = never chosen = auto
      teamNotify(false);
    }, function(){ teamShares[pid] = { cfg: cur && cur.cfg, repo: cur ? cur.repo : "" }; });
  }

  /** Where this project stands, as the daemon's teamFor() would decide: {mode, team?, repo}. */
  function teamShareOf(pid){
    var teams = (state.team && state.team.teams) || [];
    var sh = teamShares[pid] || {}, cfg = sh.cfg;
    var byId = function(id){ return teams.filter(function(x){ return x.id === id; })[0]; };
    if (cfg === null || (cfg && cfg.optOut)) return { mode: "private", repo: sh.repo || "" };
    if (cfg && cfg.teamId && byId(cfg.teamId)) return { mode: "shared", team: byId(cfg.teamId), repo: cfg.repo || sh.repo || "" };
    var repo = sh.repo || "";
    var match = repo ? teams.filter(function(x){ return (x.repos || []).indexOf(repo) >= 0; })[0] : null;
    return { mode: "auto", team: match || null, repo: repo };
  }

  function teamShareHtml(pid, bare){
    var teams = (state.team && state.team.teams) || [];
    if (!teams.length || !pid) return "";
    if (!teamShares[pid]) loadTeamShare(pid); // paints again when it lands
    var s = teamShareOf(pid), label, sub, dot;
    var code = function(r){ return "<code>" + esc(r) + "</code>"; };
    if (s.mode === "shared") {
      label = "Shared with " + esc(s.team.name); dot = "live";
      sub = (s.repo ? code(s.repo) + " \u2014 " : "") + "teammates see this project\u2019s live agents and goals.";
    } else if (s.mode === "private") {
      label = "Private"; dot = "off";
      sub = "Never published to a team, even if its remote matches a team repo.";
    } else if (s.team) {
      label = "Auto (remote matches " + esc(s.repo) + ")"; dot = "live";
      sub = "Published to " + esc(s.team.name) + " because its origin is a team repo.";
    } else {
      var repos = [];
      teams.forEach(function(x){ (x.repos || []).forEach(function(r){ if (repos.indexOf(r) < 0) repos.push(r); }); });
      label = "Auto"; dot = "off";
      sub = (s.repo ? "Its origin is " + code(s.repo) + ", not a team repo \u2014 not published. " : "") +
        "Published only if its origin remote matches a team repo" + (repos.length ? " (" + repos.slice(0, 3).map(code).join(", ") + (repos.length > 3 ? ", \u2026" : "") + ")" : "") + ".";
    }
    var cur = s.team ? s.team.id : teams[0].id;
    return '<div class="tshare' + (bare ? " bare" : "") + '" data-tshare="' + esc(pid) + '" data-tsmode="' + s.mode + '">' +
      '<div class="tshl"><span class="tshk">This project</span><span class="tshst"><span class="odot ' + dot + '"></span><span data-tslabel>' + label + "</span></span>" +
        "<small>" + sub + "</small></div>" +
      (teams.length > 1 ? '<select data-tsteam aria-label="team to share with">' + teams.map(function(x){
        return '<option value="' + esc(x.id) + '"' + (x.id === cur ? " selected" : "") + ">" + esc(x.name) + "</option>";
      }).join("") + "</select>" : "") +
      '<div class="seg" role="group" aria-label="share with the team">' +
        '<button type="button" data-tsv="shared" class="' + (s.mode === "shared" ? "on" : "") + '">Shared</button>' +
        '<button type="button" data-tsv="private" class="' + (s.mode === "private" ? "on" : "") + '">Private</button></div></div>';
  }

  function wireTeamShare(host, redraw){
    Array.prototype.forEach.call(host.querySelectorAll("[data-tshare]"), function(box){
      var pid = box.getAttribute("data-tshare");
      Array.prototype.forEach.call(box.querySelectorAll("[data-tsv]"), function(b){
        b.onclick = function(){
          if (b.classList.contains("on")) return;
          var sel = box.querySelector("[data-tsteam]");
          var btns = box.querySelectorAll("[data-tsv]");
          Array.prototype.forEach.call(btns, function(x){ x.disabled = true; });
          setTeamShare(pid, b.getAttribute("data-tsv"), sel ? sel.value : undefined)
            .then(redraw, function(err){ toast(err.message); Array.prototype.forEach.call(btns, function(x){ x.disabled = false; }); });
        };
      });
    });
  }

  function setTeamShare(pid, mode, teamId){
    var repo = (teamShares[pid] || {}).repo || "";
    if (mode === "private") {
      return api("/api/projects/" + pid + "/team/share", { method: "DELETE" }).then(function(){
        teamShares[pid] = { cfg: { optOut: true }, repo: repo };
        toast("private \u2014 this project stops publishing to the team");
      });
    }
    return api("/api/projects/" + pid + "/team/share", { method: "POST", body: JSON.stringify(teamId ? { teamId: teamId } : {}) })
      .then(function(r){
        teamShares[pid] = { cfg: { teamId: r.teamId, repo: r.repo }, repo: r.repo };
        var tm = ((state.team && state.team.teams) || []).filter(function(x){ return x.id === r.teamId; })[0];
        toast("shared " + r.repo + (tm ? " with " + tm.name : ""));
        return loadTeam(); // the team's repo list just grew
      });
  }

  // ---- team policy: loom.team.json, read-only (D37, D38) --------------------
  // The daemon reads it from origin's default branch, so changing it takes a
  // reviewed PR; a local copy can only tighten it. Shown, never edited, here.
  var teamPolicies = {};
 // pid \u2192 {policy} | {err} | {loading: true}
  function loadTeamPolicy(pid, force){
    var cur = teamPolicies[pid];
    if (cur && (cur.loading || !force)) return;
    teamPolicies[pid] = { loading: true, policy: cur && cur.policy };
    api("/api/projects/" + pid + "/team/policy").then(function(j){
      teamPolicies[pid] = { policy: (j && j.policy) || null };
    }, function(err){
      teamPolicies[pid] = { err: err.message || String(err), policy: cur && cur.policy };
    }).then(function(){ teamNotify(false); });
  }

  // ---- landing, Phase 4: teammates' goals that need someone (D63) ----------
  // GET /team/landing per project: its adoptable list is teammates' goal PRs
  // whose owner ran out of fixes, or went quiet with checks failing.
  var teamLandings = {};
 // pid \u2192 {adoptable, goals} | {err} | {loading: true}
  var TEAM_LANDING_EVENTS = { goal_needs_someone: 1, goal_adopted: 1, goal_returned: 1, goal_landed: 1, check_failed: 1, check_passed: 1, pr_merged: 1, pr_closed: 1, land_queued: 1, land_turn: 1 };

  function loadTeamLanding(pid, force){
    var cur = teamLandings[pid];
    if (cur && (cur.loading || !force)) return;
    teamLandings[pid] = { loading: true, adoptable: cur && cur.adoptable };
    api("/api/projects/" + pid + "/team/landing").then(function(j){
      teamLandings[pid] = { adoptable: (j && j.adoptable) || [], goals: (j && j.goals) || [] };
    }, function(err){
      teamLandings[pid] = { err: err.message || String(err), adoptable: cur && cur.adoptable };
    }).then(function(){ teamNotify(false); });
  }

  function teamNeedsHtml(pid){
    if (!pid) return "";
    if (!teamLandings[pid]) loadTeamLanding(pid); // paints again when it lands
    var list = (teamLandings[pid] || {}).adoptable || [];
    if (!list.length) return "";
    return '<div class="tcard tneeds"><div class="tsec" style="border-top:0"><div class="tsech">Needs someone<span class="n">' + list.length + "</span></div>" +
      list.map(function(a){
        var pr = /^https?:\/\//.test(String(a.url || "")) ? '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer">PR #' + Number(a.pr) + "</a>" : "<b>PR #" + Number(a.pr) + "</b>";
        return '<div class="tneed" data-tneed="' + Number(a.pr) + '"><span class="tnt">' + teamAvatar(a.owner) + " " + pr + " \u00b7 <b>" + esc(a.owner) + "</b>\u2019s <code>" + esc(a.branch) + "</code>" +
          (a.reason ? "<small>" + esc(a.reason) + "</small>" : "") + "</span>" +
          '<button class="btn outline xs" type="button" data-tadopt="' + Number(a.pr) + '" data-towner="' + esc(a.owner) + '">Adopt</button></div>';
      }).join("") + "</div></div>";
  }

  // ---- runners, Phase 5 (D67\u2013D78): where a goal runs besides here ------
  // GET /team/runners per project: runners that take its goals (mine, and
  // teammates' shared ones) and its recent jobs, progress unsealed. Read once
  // per project view and again on a hub job frame; an action's answer carries
  // the fresh view.
  var teamRunners = {};
 // pid \u2192 {runners, jobs} | {err} | {loading: true}
  var runnerHooks = {};
 // views drawn from a project's runners (the orchestra), told when they change
  function setTeamRunners(pid, j){ teamRunners[pid] = { runners: (j && j.runners) || [], jobs: (j && j.jobs) || [] }; }

  function runnersChanged(pid){
    if (!window.document) return; // an answer that landed after the page closed
    teamNotify(false); Object.keys(runnerHooks).forEach(function(k){ runnerHooks[k](pid); }); }

  function loadTeamRunners(pid, force){
    var cur = teamRunners[pid];
    if (cur && (cur.loading || !force)) return;
    teamRunners[pid] = { loading: true, runners: cur && cur.runners, jobs: cur && cur.jobs };
    api("/api/projects/" + pid + "/team/runners").then(function(j){ setTeamRunners(pid, j); }, function(err){
      teamRunners[pid] = { err: err.message || String(err), runners: cur && cur.runners, jobs: cur && cur.jobs };
    }).then(function(){ runnersChanged(pid); });
  }

  /** Online runners for a project, most recently seen first; mine: only my own (moving a goal is mine to do). */
  function onlineRunners(pid, mine){
    return ((teamRunners[pid] || {}).runners || []).filter(function(r){ return r.online && (!mine || r.mine); })
      .sort(function(a, b){ return Number(b.lastSeen) - Number(a.lastSeen); });
  }

  function runnerName(r){ return (r && (r.label || r.deviceId)) || "a runner"; }

  /** POST /team/runners/:action \u2014 start, continue, bring-back, land. */
  function runnerAct(pid, action, body){
    return api("/api/projects/" + pid + "/team/runners/" + action, { method: "POST", body: JSON.stringify(body || {}) }).then(function(j){
      if (j && j.runners) { setTeamRunners(pid, j); runnersChanged(pid); }
      return j ? j.result : null;
    });
  }

  var JOB_ST = { queued: ["queued", "off"], claimed: ["running", "live"], done: ["done", "ok"], failed: ["failed", "err"], cancelled: ["cancelled", "off"] };

  var JOB_KIND = { start: "Start", "continue": "Continue", fix: "CI fix", "return": "Bring back", land: "Land" };

  /** A job's sealed progress as a line: its run's status, tasks done/total, cost. */
  function jobProgressText(p){
    if (!p) return "";
    var ts = p.tasks || [], done = ts.filter(function(t){ return t.status === "done"; }).length;
    return (ORCH_RUN_ST[p.status] || [p.status || "preparing"])[0] + " \u00b7 " + done + "/" + ts.length + " tasks \u00b7 " + money(p.costUsd) +
      (p.question ? " \u00b7 asks: " + p.question : "");
  }

  function teamRunnersHtml(pid){
    if (!pid) return "";
    if (!teamRunners[pid]) loadTeamRunners(pid); // paints again when it lands
    var tr = teamRunners[pid] || {}, rs = tr.runners || [], jobs = (tr.jobs || []).slice(-8).reverse();
    if (!rs.length && !jobs.length) return "";
    var byId = {}; rs.forEach(function(r){ byId[r.deviceId] = r; });
    var h = '<div class="tcard trunners"><div class="tsec" style="border-top:0"><div class="tsech">Runners<span class="n">' +
      rs.filter(function(r){ return r.online; }).length + "/" + rs.length + " online</span></div>";
    h += rs.map(function(r){
      return '<div class="trn" data-trunner="' + esc(r.deviceId) + '"><span class="tnt"><span class="odot ' + (r.online ? "ok" : "off") + '" title="' + (r.online ? "online" : "offline") + '"></span>' +
        "<b>" + esc(runnerName(r)) + "</b>" + (r.shared ? '<span class="tbdg">shared</span>' : "") +
        "<small>" + (r.mine ? "yours" : esc(r.github || "a teammate") + "\u2019s") + " \u00b7 " + (esc((r.kinds || []).join(", ")) || "no agents yet") +
          (r.capacity ? " \u00b7 " + Number(r.capacity) + " at a time" : "") + (r.online ? "" : " \u00b7 seen " + rel(r.lastSeen)) + "</small></span></div>";
    }).join("");
    if (jobs.length) h += '<div class="trsub">Jobs</div>' + jobs.map(function(j){
      var s = JOB_ST[j.state] || [j.state || "\u2014", "off"], on = byId[j.runnerId];
      return '<div class="trn" data-tjob="' + esc(j.id) + '"><span class="tnt"><b>' + esc(JOB_KIND[j.kind] || j.kind) + "</b> " +
          (j.goal ? '<span class="tq">\u2018' + esc(j.goal) + "\u2019</span>" : "") +
          "<small>" + (j.mine ? "yours" : esc(j.github || "a teammate") + "\u2019s") + (on || j.runnerGithub ? " \u00b7 on " + esc(on ? runnerName(on) : j.runnerGithub + "\u2019s runner") : "") +
            " \u00b7 " + rel(j.updatedAt || j.createdAt) + (j.progress ? " \u00b7 " + esc(jobProgressText(j.progress)) : "") + "</small>" +
          (j.error ? '<small class="err">' + esc(j.error) + "</small>" : "") + "</span>" +
        '<span class="opill ' + s[1] + '" data-jstate="' + esc(j.state) + '"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + "</span></div>";
    }).join("");
    return h + "</div></div>";
  }

  // ---- deploys and release notes (D72): GitHub's, read-only, on request ----
  // Each check asks GitHub (gh api), so it runs when you ask, like the doctor.
  // pid \u2192 {list} | {err} | {loading}, plus notes: {since, md} | {since, err} | {since, loading},
  // and since: the tag as typed, so a redraw (a teammate's heartbeat) keeps it
  var teamDeploys = {};

  var DEPLOY_ST = { success: ["deployed", "ok"], failure: ["failed", "err"], error: ["error", "err"], in_progress: ["deploying", "live"],
    queued: ["queued", "live"], pending: ["pending", "live"], inactive: ["inactive", "off"] };

  function teamDeploysHtml(pid){
    if (!pid) return "";
    var d = teamDeploys[pid] || {}, list = (d.list || []).slice(0, 6), n = d.notes || {};
    var h = '<div class="tcard tdeploys" data-tdeploys="' + esc(pid) + '"><div class="tsec" style="border-top:0"><div class="tsech">Deploys' +
      (d.list ? '<span class="n">' + d.list.length + "</span>" : "") + '<span class="spacer"></span>' +
      '<button class="btn ghost xs" type="button" data-tdepload' + (d.loading ? " disabled" : "") + ">" + (d.list ? "Check again" : "Check deploys") + "</button></div>";
    if (d.loading) h += LOADER;
    else if (d.err) h += '<div class="tpols" style="color:var(--err)">' + esc(d.err) + "</div>";
    else if (!d.list) h += '<div class="tpols">GitHub\u2019s deployments of this repo. Loom reads them and tells the feed; it never deploys.</div>';
    else if (!list.length) h += '<div class="tpols">No deployments on GitHub yet.</div>';
    h += list.map(function(x){
      var s = DEPLOY_ST[x.state] || [x.state || "\u2014", "off"];
      return '<div class="trn" data-tdeploy="' + esc(x.id) + '"><span class="tnt"><b>' + esc(x.environment || "?") + "</b> <code>" + esc(String(x.sha || "").slice(0, 7)) + "</code>" +
          (/^https?:\/\//.test(String(x.url || "")) ? ' <a href="' + esc(x.url) + '" target="_blank" rel="noreferrer">log \u2197</a>' : "") +
          "<small>" + (x.creator ? esc(x.creator) + " \u00b7 " : "") + (x.ref ? esc(x.ref) + " \u00b7 " : "") + rel(x.at) + "</small></span>" +
        '<span class="opill ' + s[1] + '" data-dstate="' + esc(x.state) + '"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + "</span></div>";
    }).join("");
    h += '<div class="trsub">Release notes</div><div class="trform"><input data-trsince aria-label="since which tag" placeholder="since a tag, e.g. v1.2.0" value="' + esc(d.since != null ? d.since : n.since || "") + '">' +
      '<button class="btn outline xs" type="button" data-trnotes' + (n.loading ? " disabled" : "") + ">Write</button></div>";
    if (n.loading) h += LOADER;
    else if (n.err) h += '<div class="tpols" style="color:var(--err)">' + esc(n.err) + "</div>";
    else if (n.md != null) h += '<pre class="trmd" data-trmd>' + esc(n.md) + '</pre><div class="trform"><span class="tpols">from goals merged since <b>' + esc(n.since) + "</b></span>" +
      '<span class="spacer" style="margin-left:auto"></span><button class="btn ghost xs" type="button" data-trcopy>' + ICONS.copy + "Copy</button></div>";
    return h + "</div></div>";
  }

  function wireTeamDeploys(host){
    var box = host.querySelector("[data-tdeploys]"); if (!box) return;
    var pid = box.getAttribute("data-tdeploys"), d = function(){ return teamDeploys[pid] || (teamDeploys[pid] = {}); };
    var ld = box.querySelector("[data-tdepload]");
    if (ld) ld.onclick = function(){
      var keep = function(o){ o.notes = d().notes; o.since = d().since; teamDeploys[pid] = o; };
      keep({ loading: true }); teamNotify(true);
      api("/api/projects/" + pid + "/team/deploys").then(function(j){ keep({ list: (j && j.deployments) || [] }); },
        function(err){ keep({ err: err.message || String(err) }); }).then(function(){ teamNotify(true); });
    };
    var go = box.querySelector("[data-trnotes]"), inp = box.querySelector("[data-trsince]");
    var write = function(){
      var since = (inp.value || "").trim();
      if (!since) { inp.focus(); toast("since which tag?"); return; }
      d().notes = { since: since, loading: true }; teamNotify(true);
      api("/api/projects/" + pid + "/team/release-notes?since=" + encodeURIComponent(since)).then(function(j){ d().notes = { since: since, md: String((j && j.markdown) || "") }; },
        function(err){ d().notes = { since: since, err: err.message || String(err) }; }).then(function(){ teamNotify(true); });
    };
    if (go) go.onclick = write;
    if (inp) inp.oninput = function(){ d().since = inp.value; };
    if (inp) inp.onkeydown = function(ev){ if (ev.key === "Enter") { ev.preventDefault(); write(); } };
    var cp = box.querySelector("[data-trcopy]");
    if (cp) cp.onclick = function(){ copyText((d().notes || {}).md || ""); };
  }

  /** What the team spent, from the feed (D64): each member today, per landed PR, total. */
  function teamCostsHtml(t){
    var c = t.costs; if (!c) return "";
    var today = new Date().toISOString().slice(0, 10); // the rollup's days are UTC dates
    var rows = (c.byMemberDay || []).filter(function(r){ return r.day === today; });
    return '<div class="tsec"><div class="tsech">Costs<span class="n">' + money(c.totalUsd) + '</span></div><table class="tcost">' +
      (rows.length ? rows.map(function(r){
        return '<tr data-tcost="' + esc(r.member) + '"><td>' + teamAvatar(r.member) + " <b>" + esc(r.member) + "</b> today</td>" +
          '<td class="n">' + Number(r.goals) + " goal" + (r.goals === 1 ? "" : "s") + '</td><td class="n">' + money(r.usd) + "</td></tr>";
      }).join("") : '<tr><td colspan="3" class="n" style="text-align:left">Nothing finished today.</td></tr>') +
      '<tr class="sum"><td>Per landed PR</td><td class="n">' + Number(c.landed || 0) + ' landed</td><td class="n" data-tcost-per>' +
        (c.perLandedPrUsd != null ? money(c.perLandedPrUsd) : "\u2014") + "</td></tr>" +
      (c.ciMinutes ? '<tr class="sum"><td>CI time of landed goals</td><td class="n"></td><td class="n" data-tcost-ci>' + Number(c.ciMinutes) + " min</td></tr>" : "") +
      '<tr class="sum"><td>Total</td><td class="n">' + (c.byGoal || []).length + ' goals</td><td class="n" data-tcost-total>' + money(c.totalUsd) + "</td></tr></table></div>";
  }

  var TEAM_POLICY_SAMPLE ='{"hardZones": ["db/migrations/**"], "permissions": {"ceiling": "auto"}}';

  /** The policy in effect for a project. label: whose it is, where several are listed. */
  function teamPolicyHtml(pid, label){
    if (!teamPolicies[pid]) loadTeamPolicy(pid); // paints again when it lands
    var tp = teamPolicies[pid] || {}, pol = tp.policy;
    var head = '<div class="tpolh">' + ICONS.shield + "<b>Team policy</b>" + (label ? "<small>" + esc(label) + "</small>" : "");
    if (!pol) {
      return '<div class="tpol" data-tpolicy="' + esc(pid) + '">' + head + "</div>" +
        (tp.err ? '<div class="tpols">' + esc(tp.err) + "</div>" : LOADER) + "</div>";
    }
    if (pol.source === "none") {
      return '<div class="tpol none" data-tpolicy="' + esc(pid) + '" data-tpsrc="none">' + head + '<span class="tpolsrc">no team policy</span></div>' +
        '<div class="tpols">No <code>loom.team.json</code> on origin \u2014 any agent, any permission, no hard zones. Add one with a PR, e.g.</div>' +
        '<code class="tpolsample">' + esc(TEAM_POLICY_SAMPLE) + "</code></div>";
    }
    var chips = function(list, empty){ return list && list.length ? '<span class="tglobs">' + list.map(function(g){ return '<span class="tglob" title="' + esc(g) + '">' + esc(g) + "</span>"; }).join("") + "</span>" : '<span class="tpolnone">' + empty + "</span>"; };
    var pm = pol.permissions || {}, orc = pol.orchestra || {}, caps = [];
    if (orc.maxParallelPerMember) caps.push(Number(orc.maxParallelPerMember) + " in parallel per member");
    if (orc.teamMaxConcurrentAgents) caps.push(Number(orc.teamMaxConcurrentAgents) + " agents across the team");
    var row = function(k, v){ return '<div class="tpolr"><span class="tpolk">' + k + '</span><span class="tpolv">' + v + "</span></div>"; };
    return '<div class="tpol" data-tpolicy="' + esc(pid) + '" data-tpsrc="' + esc(pol.source) + '">' + head +
        '<span class="tpolsrc">' + (pol.source === "local" ? "local copy" : "from origin") + "</span></div>" +
      row("Hard zones", chips(pol.hardZones, "none \u2014 two goals may share any file")) +
      row("Permissions", '<span class="tpolin">' + permBadge(pm.ceiling || "bypass") + '<span class="tpolnone">the ceiling \u2014 no agent runs looser' + (pm.bypassRequiresPlan ? "; bypass only in plan mode" : "") + "</span></span>") +
      row("Agents", pol.agents && pol.agents.allow ? chips(pol.agents.allow, "none allowed") : '<span class="tpolnone">any agent</span>') +
      row("Protected", chips((pol.delivery || {}).protected, "no protected branches")) +
      row("Caps", caps.length ? esc(caps.join(" \u00b7 ")) : '<span class="tpolnone">no caps</span>') +
      '<div class="tpols">' + (pol.source === "local"
        ? "From a local <code>loom.team.json</code> only \u2014 not reviewed, and it can only tighten what origin says. Open a PR to make it the team\u2019s."
        : "From <code>loom.team.json</code> on origin\u2019s default branch \u2014 change it with a PR to <code>loom.team.json</code>.") + "</div></div>";
  }

  // ---- the Team block under Fleet ------------------------------------------
  function teamHeadHtml(){
    return '<div class="tmh"><span class="ot">Team</span>' +
      '<span class="os">Your teammates\u2019 live agents and goals \u2014 intent, never transcripts.</span><span class="spacer"></span>' +
      '<button class="btn ghost xs" type="button" data-tmanage>' + ICONS.gear + "Manage</button></div>";
  }

  function teamCardHtml(t){
    var others = teamOthers(t);
    var h = hue(String(t.id || t.name));
    return '<div class="tcard" data-tteam="' + esc(t.id) + '">' +
      '<div class="tchd"><span class="fpg" style="background:color-mix(in srgb, hsl(' + h + ',60%,50%) 18%, transparent);color:hsl(' + h + ',60%,var(--agent-l))">' +
          esc(String(t.name || "?").slice(0, 1)) + "</span>" +
        '<span class="tcn">' + esc(t.name) + "</span>" +
        '<span class="trole">' + esc(t.role) + "</span>" +
        '<span class="tcm">' + (t.missing ? "not on the hub any more" : others.length ? others.length + " live" : "quiet") + (t.keyVersion != null ? " \u00b7 key v" + esc(t.keyVersion) : "") + "</span>" +
        '<span class="spacer"></span>' +
        (t.role !== "viewer" ? '<button class="btn outline xs" type="button" data-tinvite="' + esc(t.id) + '">' + ICONS.plus + "Invite</button>" : "") + "</div>" +
      '<div class="tcrow"><span class="tck">Members</span>' + teamMembersHtml(t) + "</div>" +
      '<div class="tcrow"><span class="tck">Repos</span>' + ((t.repos || []).map(function(r){ return '<span class="trepo">' + ICONS.github + esc(r) + "</span>"; }).join("") ||
        '<span class="tcm">none shared yet \u2014 share a project below, or push one whose remote is a team repo</span>') + "</div>" +
      '<div class="tinvslot">' + teamInviteHtml(t.id) + "</div>" +
      '<div class="tsec">' + teamSessionsHtml(t) + "</div>" +
      '<div class="tsplit"><div class="tsec">' + teamLeasesHtml(t) + '</div><div class="tsec">' + teamFeedHtml(t, 15) + "</div></div>" +
      teamCostsHtml(t) +
    "</div>";
  }

  function teamFleetHtml(st, pid){
    var teams = st.teams || [];
    if (!teams.length) return teamHeadHtml() + teamJoinCardHtml();
    var down = st.connected === false
      ? '<div class="tinvw thubdown">' + ICONS.alert + "<span><b>Can\u2019t reach the team hub.</b> " + esc(st.lastError || "") +
          " \u2014 your agents keep working here; Loom tries again every 15 seconds.</span></div>"
      : "";
    return teamHeadHtml() + down + teamShareHtml(pid, true) + teamNeedsHtml(pid) + teamRunnersHtml(pid) + teams.map(teamCardHtml).join("") + teamDeploysHtml(pid);
  }
export { DEPLOY_ST,fleetSince,ghRepo,JOB_KIND,JOB_ST,jobProgressText,LEASE_STALE_MS,leaseClash,leasePill,leasePrefix,leaseStale,leaseUnder,loadTeam,loadTeamLanding,loadTeamPolicy,loadTeamRunners,loadTeamShare,onlineRunners,onTeamFrame,orchGoalName,runnerAct,runnerFrameT,runnerHooks,runnerName,runnersChanged,setTeamRunners,setTeamShare,TEAM_LANDING_EVENTS,TEAM_POLICY_SAMPLE,TEAM_ST,teamAct,teamAgentOf,teamAvatar,teamCardHtml,teamClaimMap,teamClaimRows,teamCostsHtml,teamDeploys,teamDeploysHtml,teamEditing,teamFeedGoal,teamFeedHtml,teamFeedLine,teamField,teamFleetHtml,teamFrameT,teamGlobs,teamGoalOf,teamHeadHtml,teamHooks,teamInviteHtml,teamInvites,teamJoinCardHtml,teamLandings,teamLeaseRow,teamLeasesHtml,teamMembersHtml,teamMyRuns,teamNeedsHtml,teamNotify,teamOthers,teamPaths,teamPill,teamPolicies,teamPolicyHtml,teamPresenceLeasesHtml,teamRow,teamRunners,teamRunnersHtml,teamSessionsHtml,teamShareHtml,teamShareOf,teamShares,wireTeamDeploys,wireTeamForms,wireTeamInvites,wireTeamShare };
