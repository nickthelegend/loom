import { agentGlyph } from '../agents.js';
import { api } from '../connection.js';
import { renderDiffLines } from '../diff.js';
import { esc,money,pageGone,rel } from '../format.js';
import { ICONS,LOADER } from '../icons.js';
import { toast } from '../notifications.js';
import { state } from '../state.js';

/** crew behavior for one mounted project (Agent Teams, Phase 1).
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 *
 * The crew lives on the daemon (core/crew.ts); this tab is a reading of
 * GET /crews plus the last events of the crew's channel, refetched when a
 * `crew` event (or a crew message) crosses the socket. Actions are POSTs.
 *
 * What it draws: a hero with the crew's faces; each teammate as a card that
 * lights up while it works; the goal with its progress; the cards on a
 * board, one column per stage; the channel as a conversation; and a
 * composer that knows whether you're starting a goal, answering a question
 * or changing the plan. Colour means role (lead magenta, builders cyan,
 * reviewer amber, tester green) or state (live, needs you, done, failed).
 */
export function createCrew(view) {

    // This mount's reading of the crews. The factory is created per mount, so
    // its own closure is this view's state; nothing here outlives the view.
    var crew = { list: null, templates: [], previews: {}, roster: [], seats: {}, sel: null, err: "", t: null, events: {}, diff: null, tpl: "ship", making: false, busy: "" };

    var TEMPLATES = {
      ship: ["Ship", "lead plans, two builders, a reviewer and a tester", "Features end to end, reviewed and tested."],
      fix: ["Fix", "lead, builder and tester", "Bugs: reproduce, fix, prove it."],
      research: ["Research", "lead and two researchers", "Questions answered with sources."],
      solo: ["Solo+", "builder and reviewer", "One builder, with a second pair of eyes."],
    };
    var ROLE = {
      lead: ["Lead", ICONS.plan, "plans the goal into cards and writes the summary"],
      builder: ["Builder", ICONS.pencil, "builds a card in the goal's worktree"],
      reviewer: ["Reviewer", ICONS.search, "reads each card's diff: approve, or changes"],
      tester: ["Tester", ICONS.check, "runs the tests on each card"],
      researcher: ["Researcher", ICONS.telescope, "investigates and writes up what it found"],
    };
    // status → [label, state class]
    var GOAL_ST = {
      planning: ["planning", "live"],
      awaiting_approval: ["needs your OK", "warn"],
      running: ["working", "live"],
      waiting_human: ["needs you", "warn"],
      completed: ["completed", "ok"],
      failed: ["failed", "err"],
      stopped: ["stopped", "off"],
      interrupted: ["interrupted", "warn"],
    };
    var STAGES = ["planned", "building", "review", "testing", "done"];
    var STAGE_LBL = { planned: "Planned", building: "Building", review: "In review", testing: "Testing", done: "Done", failed: "Failed" };
    var STEP_VERB = { plan: "planning", planned: "starting", building: "building", review: "reviewing", testing: "testing", done: "wrapping up" };
    var SUGGEST = ["Add a health-check endpoint with a test", "Write a README section on how to run the tests", "Find and fix one flaky test"];
    var terminal = function(s){ return s === "completed" || s === "failed" || s === "stopped"; };
    /** Someone is actually at work right now (not waiting on you, not interrupted). */
    var moving = function(g){ return !!g && (g.status === "planning" || g.status === "running"); };

    function crewEl(){
      if (pageGone() || !view.desktop) return null;
      return state.tab === "crew" ? document.getElementById("pane-crew") : null;
    }

    function current(){
      var list = crew.list || [];
      return list.filter(function(c){ return c.id === crew.sel; })[0] || list[0] || null;
    }

    function loadCrews(){
      var pid = view.pid;
      return api("/api/projects/" + pid + "/crews").then(function(j){
        if (state.pid !== pid) return;
        crew.list = j.crews || [];
        crew.templates = j.templates || Object.keys(TEMPLATES);
        crew.previews = j.previews || {};
        crew.roster = j.roster || [];
        crew.err = "";
        var c = current();
        crew.sel = c ? c.id : null;
        drawCrewTabDot();
        drawCrew();
        if (c && crewEl()) return loadChannel(c);
      }).catch(function(err){ crew.err = err.message; drawCrew(); });
    }

    /** The channel's last events: the plan, hand-offs, reviews and what you said. */
    function loadChannel(c){
      var pid = view.pid, ch = c.state && c.state.channel;
      if (!ch) return;
      return api("/api/projects/" + pid + "/events?limit=40&chat=" + encodeURIComponent(ch)).then(function(j){
        if (state.pid !== pid) return;
        crew.events[c.id] = (j.events || []).filter(function(e){ return e.kind === "message" || e.kind === "crew"; }).slice(-40);
        drawCrew();
      }).catch(function(){});
    }

    /** Coalesce a burst of socket events into one fetch. */
    function scheduleCrew(){
      if (crew.t) return;
      crew.t = setTimeout(function(){ crew.t = null; if (state.pid === view.pid && !pageGone()) loadCrews(); }, 250);
    }

    function onCrewEvent(ev){
      if (!ev) return;
      var p = ev.payload || {};
      // Phase changes are rare and drive the tab dot, so they always refetch.
      // A crew's messages (a turn starting, a post) only matter on screen.
      if (ev.kind === "crew") { scheduleCrew(); return; }
      if (ev.kind === "message" && p.crew && typeof p.crew === "object" && crewEl()) scheduleCrew();
    }

    function drawCrewTabDot(){
      var d = document.getElementById("crewtdot"); if (!d) return;
      var goals = (crew.list || []).map(function(c){ return c.state && c.state.goal; }).filter(Boolean);
      var live = goals.some(function(g){ return !terminal(g.status) && g.status !== "interrupted"; });
      d.style.display = live ? "" : "none";
      d.classList.toggle("warn", goals.some(function(g){ return g.status === "waiting_human" || g.status === "awaiting_approval"; }));
    }

    // ---- pieces --------------------------------------------------------------

    function pill(st){
      var s = GOAL_ST[st] || [st || "—", "off"];
      return '<span class="opill ' + s[1] + '"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + "</span>";
    }

    function agentOf(id){
      return ((state.project && state.project.agents) || []).filter(function(a){ return a.id === id; })[0] || null;
    }

    function mateOf(c, id){
      return (c.teammates || []).filter(function(t){ return t.id === id; })[0] || null;
    }

    /** A teammate's face: its agent's mark, ringed in its role's colour, with the role's badge. */
    function avatar(t, size, live){
      if (!t) return '<span class="cav sz' + (size || 32) + '"><span class="cavin">?</span></span>';
      var a = agentOf(t.agent);
      return '<span class="cav sz' + (size || 32) + " r-" + esc(t.role) + (live ? " live" : "") + '" title="' + esc(t.id + " · " + t.role + " · " + t.agent) + '">' +
        '<span class="cavin">' + agentGlyph(a ? a.kind : "", t.agent) + "</span>" +
        '<span class="cavb">' + ((ROLE[t.role] || [])[1] || "") + "</span></span>";
    }

    function liveMate(c){
      var g = c.state && c.state.goal;
      return moving(g) && g.current ? g.current.teammate : null;
    }

    // ---- drawing -------------------------------------------------------------

    function hero(c){
      var mates = c ? c.teammates || [] : [];
      var picker = crew.list.length > 1
        ? '<select id="crewpick" class="crewsel" aria-label="crew">' + crew.list.map(function(x){
            return '<option value="' + esc(x.id) + '"' + (x.id === c.id ? " selected" : "") + ">" + esc(x.name) + "</option>";
          }).join("") + "</select>"
        : "";
      var roles = {};
      mates.forEach(function(t){ roles[t.role] = (roles[t.role] || 0) + 1; });
      var sub = Object.keys(roles).map(function(r){ return roles[r] + " " + ((ROLE[r] || [r])[0]).toLowerCase() + (roles[r] > 1 ? "s" : ""); }).join(" · ");
      return '<header class="cwhero">' +
        '<div class="cwstack">' + mates.slice(0, 6).map(function(t){ return avatar(t, 36, liveMate(c) === t.id); }).join("") + "</div>" +
        '<div class="cwtitle"><div class="cwnamerow"><span class="crewname">' + esc(c.name) + "</span>" + picker +
          (c.busy ? '<span class="crewbusy"><span class="odot live"></span>working</span>' : "") + "</div>" +
          '<div class="cwsub">' + esc(sub) + (c.planApproval === false ? " · starts without asking" : " · asks before building") + "</div></div>" +
        '<span class="spacer"></span>' +
        '<button class="btn xs outline" type="button" data-crew-new>' + ICONS.plus + "New crew</button>" +
        '<button class="iconbtn" type="button" data-crew-refresh title="refresh" aria-label="refresh">' + ICONS.refresh + "</button>" +
      "</header>";
    }

    function roster(c){
      var g = c.state && c.state.goal;
      var liveId = liveMate(c);
      return '<section class="crewroster" aria-label="teammates">' + (c.teammates || []).map(function(t){
        var live = liveId === t.id;
        var asking = g && g.status === "waiting_human" && g.question && g.question.teammate === t.id;
        var doing = live ? (STEP_VERB[g.current.step] || g.current.step || "working") + (g.current.card ? " " + cardTitle(g, g.current.card) : "")
          : asking ? "waiting for your answer" : (ROLE[t.role] || [])[2] || "";
        return '<div class="crewmate r-' + esc(t.role) + (live ? " live" : "") + (asking ? " asking" : "") + '" data-mate="' + esc(t.id) + '"' + (t.charter ? ' title="' + esc(t.charter) + '"' : "") + ">" +
          (live ? '<span class="odot live" data-live></span>' : "") +
          avatar(t, 34, live) +
          '<div class="cmtext"><div class="cmtop"><b class="cmid">' + esc(t.id) + '</b><span class="cmrole">' + esc(t.role) + "</span></div>" +
          (!c.busy && crew.roster.length > 1
            ? '<select class="cmagent cmswap" data-crew-swap="' + esc(t.id) + '" title="swap the agent in this seat" aria-label="agent for ' + esc(t.id) + '">' +
                crew.roster.map(function(a){ return '<option value="' + esc(a.id) + '"' + (a.id === t.agent ? " selected" : "") + ">" + esc(a.id) + "</option>"; }).join("") + "</select>"
            : '<div class="cmagent">' + esc(t.agent) + "</div>") +
          '<div class="cmdoing">' + esc(doing.slice(0, 90)) + "</div></div></div>";
      }).join("") + "</section>";
    }

    function cardTitle(g, id){
      var c = (g.cards || []).filter(function(x){ return x.id === id; })[0];
      return c ? "“" + (c.title.length > 40 ? c.title.slice(0, 39) + "…" : c.title) + "”" : "";
    }

    function progress(g){
      var n = (g.cards || []).length;
      if (!n) return "";
      var done = g.cards.filter(function(c){ return c.stage === "done"; }).length;
      return '<div class="cwprog" title="' + done + " of " + n + ' cards done">' +
        '<div class="cwbar">' + g.cards.map(function(c){
          return '<span class="seg s-' + esc(c.stage) + (g.current && g.current.card === c.id && moving(g) ? " now" : "") + '"></span>';
        }).join("") + "</div>" +
        '<span class="cwpn">' + done + "/" + n + "</span></div>";
    }

    function board(c, g){
      if (!g.cards || !g.cards.length) {
        return g.status === "planning"
          ? '<div class="cwplanning"><span class="cwloom"></span><span>' + esc(((mateOf(c, g.current && g.current.teammate) || {}).id || "The lead")) + " is planning the goal into cards…</span></div>"
          : "";
      }
      var cols = STAGES.slice();
      if (g.cards.some(function(x){ return x.stage === "failed"; })) cols.push("failed");
      // empty columns stay narrow, so the cards get the room
      var track = cols.map(function(s){
        return g.cards.some(function(x){ return x.stage === s; }) ? "minmax(150px,1.5fr)" : "minmax(84px,.7fr)";
      }).join(" ");
      return '<div class="cwboard crewcards" style="grid-template-columns:' + track + '">' + cols.map(function(s){
        var here = g.cards.filter(function(x){ return x.stage === s; });
        return '<div class="cwcol crewstage" data-stage="' + s + '">' +
          '<div class="cwch crewsth"><span class="cwcd"></span>' + esc(STAGE_LBL[s]) + ' <span class="n">' + here.length + "</span></div>" +
          (here.length ? here.map(function(x){ return card(c, g, x); }).join("") : '<div class="cwnone"></div>') +
        "</div>";
      }).join("") + "</div>";
    }

    function card(c, g, x){
      var working = g.current && g.current.card === x.id && moving(g);
      var who = working ? mateOf(c, g.current.teammate) : mateOf(c, x.builder);
      return '<article class="crewcard' + (working ? " live" : "") + '" data-card="' + esc(x.id) + '">' +
        '<div class="cct">' + esc(x.title) + "</div>" +
        (x.detail ? '<div class="ccd">' + esc(x.detail.slice(0, 220)) + "</div>" : "") +
        '<div class="ccm">' +
          (who ? '<span class="ccwho">' + avatar(who, 18, working) + esc(who.id) + "</span>" : "") +
          (x.rounds ? '<span class="ccchip warn" title="sent back to the builder">' + ICONS.rewind + x.rounds + "</span>" : "") +
          ((x.commits || []).length ? '<span class="ccchip">' + ICONS.branch + x.commits.length + "</span>" : "") +
          (working && g.current.step ? '<span class="live">' + esc(STEP_VERB[g.current.step] || g.current.step) + "…</span>" : "") +
        "</div>" +
        (x.error ? '<div class="cce">' + esc(x.error.slice(0, 300)) + "</div>" : "") +
      "</article>";
    }

    function actions(c, g){
      var b = function(act, label, cls, icon){
        return '<button type="button" class="btn sm ' + cls + '" data-crew-act="' + act + '"' + (crew.busy ? " disabled" : "") + ">" + (icon || "") + esc(label) + "</button>";
      };
      var out = "";
      if (/^(planning|running|waiting_human|awaiting_approval)$/.test(g.status)) out += b("stop", "Stop", "ghost", ICONS.stop);
      if (/^(interrupted|stopped|failed)$/.test(g.status)) out += b("resume", "Resume", "outline", ICONS.play);
      if (g.status === "completed" || (g.cards || []).some(function(x){ return (x.commits || []).length; }))
        out += b("diff", crew.diff && crew.diff.goal === g.id ? "Hide changes" : "View changes", "ghost", ICONS.tree);
      if (g.status === "completed" && !g.applied) out += b("apply", "Apply (merge)", "primary", ICONS.check);
      if (g.applied) out += '<span class="crewapplied">' + ICONS.check + "applied to " + esc(g.applied.into) + "</span>";
      return out ? '<div class="crewacts">' + out + "</div>" : "";
    }

    /** What the crew needs from you, said big: approve the plan, or answer. */
    function banner(c, g){
      if (g.status === "awaiting_approval") {
        var n = (g.cards || []).length;
        return '<div class="cwban warn"><div class="cwbi">' + ICONS.plan + "</div>" +
          '<div class="cwbt"><b>The plan is ready: ' + n + " card" + (n === 1 ? "" : "s") + ".</b>" +
          "<span>Nobody builds until you OK it. Not quite right? Say what to change below and the lead plans again.</span></div>" +
          '<button type="button" class="btn sm primary" data-crew-act="approve"' + (crew.busy ? " disabled" : "") + ">" + ICONS.check + "Approve plan</button></div>";
      }
      if (g.status === "waiting_human" && g.question) {
        var t = mateOf(c, g.question.teammate);
        return '<div class="cwban warn crewask">' + avatar(t, 30) +
          '<div class="cwbt"><b>' + esc(g.question.teammate) + " asks:</b> <span>" + esc(g.question.text) + "</span></div></div>";
      }
      if (g.status === "completed" && !g.applied) {
        return '<div class="cwban ok"><div class="cwbi">' + ICONS.sparkles + "</div>" +
          '<div class="cwbt"><b>Done: every card built, reviewed and tested.</b><span>It’s on <code>' + esc(g.branch) + "</code>. Look at the changes, then apply it to your branch.</span></div></div>";
      }
      if (g.status === "failed") {
        var bad = (g.cards || []).filter(function(x){ return x.stage === "failed"; })[0];
        return '<div class="cwban err"><div class="cwbi">' + ICONS.alert + "</div>" +
          '<div class="cwbt"><b>' + (bad ? "\u201c" + esc(bad.title) + "\u201d failed." : "The goal failed.") + "</b>" +
          "<span>" + esc(((bad && bad.error) || g.error || "").slice(0, 300).replace(/([^.!?])$/, "$1.")) + " Resume tries it again from where it stopped; what\u2019s done stays done.</span></div></div>";
      }
      if (g.status === "interrupted") {
        return '<div class="cwban warn"><div class="cwbi">' + ICONS.alert + '</div><div class="cwbt"><b>Interrupted.</b><span>Loom stopped while the crew was mid-turn. Resume picks up at the step it was on.</span></div></div>';
      }
      return "";
    }

    function goalBlock(c){
      var g = c.state && c.state.goal;
      if (!g) {
        return '<div class="ocard crewgoal cwidle"><div class="crewnote"><b>No goal yet.</b> Tell ' + esc(c.name) + " what to build — the lead plans it, you approve, the crew builds, reviews and tests it.</div>" +
          '<div class="cwsuggest">' + SUGGEST.map(function(s){ return '<button type="button" class="cwchip" data-crew-suggest="' + esc(s) + '">' + esc(s) + "</button>"; }).join("") + "</div></div>";
      }
      var meta = [pill(g.status), '<span class="mono">' + ICONS.branch + esc(g.branch) + "</span>"];
      if (g.costUsd) meta.push("<span>" + money(g.costUsd) + "</span>");
      if (g.startedAt) meta.push("<span>" + ICONS.clock + esc(rel(g.startedAt)) + "</span>");
      return '<div class="ocard crewgoal">' +
        '<div class="cwgtop"><div class="ogoal">' + esc(g.text) + "</div>" + progress(g) + "</div>" +
        '<div class="crewmeta">' + meta.join("") + "</div>" +
        banner(c, g) +
        (g.error && g.status !== "failed" ? '<div class="onote err">' + esc(g.error.slice(0, 600)) + "</div>" : "") +
        (g.summary && g.status === "completed" ? '<div class="crewsum">' + esc(g.summary.slice(0, 1200)) + "</div>" : "") +
        actions(c, g) +
        (crew.diff && crew.diff.goal === g.id
          ? '<div class="crewdiff">' + (crew.diff.text === null ? LOADER : crew.diff.text ? '<div class="dcode">' + renderDiffLines(crew.diff.text.split("\n")) + "</div>" : '<div class="crewnote">No changes on the branch.</div>') + "</div>"
          : "") +
        board(c, g) +
      "</div>";
    }

    var PHASE = {
      goal_started: [ICONS.spark, "", function(p){ return "Goal started on " + (p.branch || "a branch"); }],
      planned: [ICONS.plan, "lead", function(p){ var n = (p.cards || []).length; return "Planned " + n + " card" + (n === 1 ? "" : "s") + (p.awaitingApproval ? " — waiting for your OK" : ""); }],
      plan_approved: [ICONS.check, "ok", function(){ return "Plan approved"; }],
      claimed: [ICONS.pencil, "builder", function(p){ return (p.teammate || "A builder") + " took “" + (p.title || "") + "”"; }],
      reviewed: [null, "reviewer", function(p){ return (p.teammate || "Reviewer") + (p.verdict === "changes" ? " asked for changes on “" : " approved “") + (p.title || "") + "”" + (p.notes ? ": " + p.notes : ""); }],
      tested: [null, "tester", function(p){ return (p.teammate || "Tester") + ": tests " + (p.result === "fail" ? "fail" : "pass") + " on “" + (p.title || "") + "”"; }],
      card_done: [ICONS.check, "ok", function(p){ return "“" + (p.title || "") + "” done"; }],
      card_failed: [ICONS.alert, "err", function(p){ return "“" + (p.title || "") + "” failed" + (p.error ? ": " + p.error : ""); }],
      asks: [ICONS.help, "warn", function(p){ return (p.teammate || "A teammate") + " asks: " + (p.question || ""); }],
      completed: [ICONS.sparkles, "ok", function(){ return "Goal completed"; }],
      failed: [ICONS.alert, "err", function(p){ return "Goal failed" + (p.error ? ": " + p.error : ""); }],
      stalled: [ICONS.clock, "warn", function(p){ return (p.teammate || "A teammate") + (p.retrying ? " went silent \u2014 trying again" : " went silent again \u2014 giving up on this card"); }],
      retrying: [ICONS.refresh, "warn", function(p){ return (p.teammate || "A teammate") + "\u2019s turn errored" + (p.error ? " (" + p.error + ")" : "") + " \u2014 trying again"; }],
      stopped: [ICONS.stop, "", function(){ return "Stopped"; }],
      resumed: [ICONS.play, "", function(){ return "Resumed"; }],
      applied: [ICONS.check, "ok", function(p){ return "Applied to " + (p.into || "your branch"); }],
    };

    function channel(c){
      var evs = crew.events[c.id];
      var ch = c.state && c.state.channel;
      var open = ch ? '<button type="button" class="btn xs ghost" data-crew-chan="' + esc(ch) + '">' + ICONS.thread + "Open</button>" : "";
      var body;
      if (!evs) body = '<div class="crewnote">' + LOADER + "</div>";
      else if (!evs.length) body = '<div class="cwchempty">' + ICONS.chat + "<span>The crew talks here: the plan, hand-offs, reviews, and anything you say.</span></div>";
      else body = evs.map(function(e){
        var p = e.payload || {};
        var when = '<span class="cwt">' + esc(rel(e.ts)) + "</span>";
        if (e.kind === "crew") {
          var f = PHASE[p.phase] || [ICONS.dots, "", function(){ return String(p.phase || ""); }];
          var tone = p.phase === "reviewed" ? (p.verdict === "changes" ? "warn" : "ok") : p.phase === "tested" ? (p.result === "fail" ? "err" : "ok") : f[1];
          var icon = f[0] || (p.phase === "reviewed" ? (p.verdict === "changes" ? ICONS.rewind : ICONS.check) : p.result === "fail" ? ICONS.x : ICONS.check);
          return '<div class="crewev cphase t-' + esc(tone) + '" data-phase="' + esc(String(p.phase || "")) + '"><span class="cpi">' + icon + '</span><span class="cwx">' + esc(f[2](p).slice(0, 400)) + "</span>" + when + "</div>";
        }
        if (p.author === "user") {
          var to = p.crew && p.crew.to ? '<span class="cto">@' + esc(p.crew.to) + "</span> " : "";
          return '<div class="crewev cmsg cmine"><div class="cbub">' + to + esc(String(p.text || "").slice(0, 600)) + "</div>" + when + "</div>";
        }
        var t = p.crew && p.crew.teammate ? mateOf(c, p.crew.teammate) : null;
        return '<div class="crewev cmsg">' + avatar(t, 26) + '<div class="cmb"><div class="cmh"><b class="cww">' + esc(t ? t.id : p.author || e.agentId || "loom") + "</b>" +
          (t ? '<span class="cmrole r-' + esc(t.role) + '">' + esc(t.role) + "</span>" : "") + when + "</div>" +
          '<div class="cbub">' + esc(String(p.text || "").slice(0, 600)) + "</div></div></div>";
      }).join("");
      return '<aside class="crewchan"><div class="crewchh">' + ICONS.chat + "<span>Channel</span><span class=\"spacer\"></span>" + open + "</div>" +
        '<div class="crewevs" id="crewevs">' + body + "</div></aside>";
    }

    function sayForm(c){
      var g = c.state && c.state.goal;
      var fresh = !g || terminal(g.status);
      var ph = fresh ? "What should " + c.name + " build?"
        : g.status === "waiting_human" && g.question ? "Answer " + g.question.teammate + "…"
        : g.status === "awaiting_approval" ? "Feedback on the plan (the lead plans again)…"
        : "Say something to the crew — it reaches them on their next turn…";
      var label = fresh ? "Start goal" : g.status === "waiting_human" ? "Answer" : "Send";
      return '<form class="crewsay" id="crewsay" autocomplete="off">' +
        '<textarea id="crewsaytext" class="crewin" rows="2" placeholder="' + esc(ph) + '"></textarea>' +
        '<div class="crewsayrow"><label class="cwto">' + ICONS.team + '<select id="crewsayto" class="crewsel" title="who it\'s for"><option value="">' + (fresh ? "everyone" : "the crew") + "</option>" +
          (c.teammates || []).map(function(t){ return '<option value="' + esc(t.id) + '">@' + esc(t.id) + "</option>"; }).join("") + "</select></label>" +
          '<span class="cwhint">Enter to send · Shift+Enter for a new line</span>' +
          '<span class="spacer"></span><button class="btn sm primary" type="submit" id="crewsend"' + (crew.busy === "say" ? " disabled" : "") + ">" + ICONS.up + esc(label) + "</button></div>" +
      "</form>";
    }

    function createForm(){
      var tpls = (crew.templates.length ? crew.templates : Object.keys(TEMPLATES));
      var preview = crew.previews[crew.tpl] || [];
      var noAgents = !Object.keys(crew.previews).length;
      return '<div class="crewmake">' +
        '<div class="crewtpls" role="radiogroup" aria-label="crew template">' + tpls.map(function(t){
          var d = TEMPLATES[t] || [t, "", ""];
          var mine = crew.seats[t] || {};
          var faces = (crew.previews[t] || []).map(function(m){ return avatar(mine[m.id] ? Object.assign({}, m, { agent: mine[m.id] }) : m, 24); }).join("");
          return '<button type="button" role="radio" class="crewtpl' + (crew.tpl === t ? " on" : "") + '" aria-checked="' + (crew.tpl === t) + '" data-crew-tpl="' + esc(t) + '">' +
            '<span class="cwfaces">' + faces + "</span><b>" + esc(d[0]) + "</b><span>" + esc(d[1]) + '</span><span class="cwtd">' + esc(d[2]) + "</span></button>";
        }).join("") + "</div>" +
        (noAgents ? '<div class="onote err">This project has no agents that can be on a crew yet — add Codex, OpenCode or another agent first.</div>'
          : '<div class="cwseats"><span class="cwseatsh">Who sits where</span>' + seated(preview).map(function(m){
              return '<label class="cwseat r-' + esc(m.role) + '" title="' + esc(m.role + " \u2014 pick the agent for this seat") + '">' + avatar(m, 22) + "<b>" + esc(m.id) + "</b>" +
                '<select data-crew-seat="' + esc(m.id) + '" aria-label="agent for ' + esc(m.id) + '">' + crew.roster.map(function(a){
                  return '<option value="' + esc(a.id) + '"' + (a.id === m.agent ? " selected" : "") + ">" + esc(a.id) + "</option>";
                }).join("") + "</select></label>";
            }).join("") + "</div>") +
        '<div class="crewmrow">' +
          '<input id="crewname" class="crewin" type="text" maxlength="60" placeholder="Name it (optional) — e.g. Ship crew" autocomplete="off">' +
          '<label class="crewchk"><input type="checkbox" id="crewapprove" checked> Ask me to approve the plan</label>' +
          '<button class="btn sm primary" type="button" id="crewcreate"' + (crew.busy === "create" || noAgents ? " disabled" : "") + ">" + ICONS.team + "Create crew</button>" +
          ((crew.list || []).length ? '<button class="btn sm ghost" type="button" data-crew-cancel>Cancel</button>' : "") +
        "</div></div>";
    }

    /** The template's seats with any agent you picked instead. */
    function seated(preview){
      var mine = crew.seats[crew.tpl] || {};
      return preview.map(function(m){ return mine[m.id] ? Object.assign({}, m, { agent: mine[m.id] }) : m; });
    }

    function emptyHero(){
      var faces = ["lead", "builder", "builder", "reviewer", "tester"].map(function(r, i){
        return '<span class="cav sz40 r-' + r + '" style="--i:' + i + '"><span class="cavin">' + ROLE[r][1] + "</span></span>";
      }).join('<span class="cwthread"></span>');
      return '<div class="crewempty cwempty">' +
        '<div class="cwfacesbig">' + faces + "</div>" +
        "<h2>No crew yet.</h2>" +
        "<p>A crew is a few of your agents with jobs — a lead who plans, builders, a reviewer and a tester — working one goal on its own branch. Pick a template; Loom fills its roles from this project’s agents.</p></div>";
    }

    /** Redraws replace the pane; keep what you were typing (and where) across them. */
    function keep(el){
      var kept = {}, act = document.activeElement;
      ["crewsaytext", "crewsayto", "crewname"].forEach(function(id){
        var x = el.querySelector("#" + id); if (x) kept[id] = x.value;
      });
      var chk = el.querySelector("#crewapprove"); if (chk) kept.crewapprove = chk.checked;
      var evs = el.querySelector("#crewevs");
      return { kept: kept, focus: act && el.contains(act) ? act.id : "", sel: act && typeof act.selectionStart === "number" ? [act.selectionStart, act.selectionEnd] : null,
        scroll: el.scrollTop, chanBottom: !evs || evs.scrollHeight - evs.scrollTop - evs.clientHeight < 40, chanTop: evs ? evs.scrollTop : 0 };
    }
    function restore(el, k){
      Object.keys(k.kept).forEach(function(id){
        var x = el.querySelector("#" + id); if (!x) return;
        if (id === "crewapprove") x.checked = k.kept[id];
        else if (id === "crewsayto") { if ([].some.call(x.options, function(o){ return o.value === k.kept[id]; })) x.value = k.kept[id]; }
        else x.value = k.kept[id];
      });
      el.scrollTop = k.scroll;
      var evs = el.querySelector("#crewevs");
      if (evs) evs.scrollTop = k.chanBottom ? evs.scrollHeight : k.chanTop;
      if (k.focus) {
        var f = el.querySelector("#" + k.focus);
        if (f) { f.focus(); if (k.sel && f.setSelectionRange) try { f.setSelectionRange(k.sel[0], k.sel[1]); } catch (e) {} }
      }
    }

    function drawCrew(){
      var el = crewEl(); if (!el) return;
      var k = keep(el);
      var body;
      var err = crew.err ? '<div class="onote err">' + esc(crew.err) + "</div>" : "";
      if (crew.list === null) body = crew.err ? err : LOADER;
      else if (!crew.list.length || crew.making) {
        body = (crew.list.length
          ? '<header class="cwhero"><div class="cwtitle"><div class="cwnamerow"><span class="crewname">New crew</span></div><div class="cwsub">Pick a template; Loom fills its roles from this project’s agents.</div></div></header>'
          : emptyHero()) + err + createForm();
      } else {
        var c = current();
        body = hero(c) + err + roster(c) +
          '<div class="crewgrid"><div class="crewmain">' + goalBlock(c) + sayForm(c) + "</div>" + channel(c) + "</div>";
      }
      el.innerHTML = '<div class="orchview crewview">' + body + "</div>";
      restore(el, k);
      wire(el);
    }

    // ---- actions -------------------------------------------------------------

    function post(c, act, body){
      return api("/api/projects/" + view.pid + "/crews/" + encodeURIComponent(c.id) + "/" + act, { method: "POST", body: JSON.stringify(body || {}) });
    }

    function merge(j){
      if (!j || !j.crew || !crew.list) return;
      var i = crew.list.findIndex(function(x){ return x.id === j.crew.id; });
      if (i >= 0) crew.list[i] = j.crew; else crew.list.push(j.crew);
    }

    function act(name){
      var c = current(); if (!c || crew.busy) return;
      var g = c.state && c.state.goal;
      if (name === "diff") {
        if (crew.diff && g && crew.diff.goal === g.id) { crew.diff = null; drawCrew(); return; }
        crew.diff = { goal: g ? g.id : "", text: null }; drawCrew();
        api("/api/projects/" + view.pid + "/crews/" + encodeURIComponent(c.id) + "/diff").then(function(j){
          if (crew.diff && g && crew.diff.goal === g.id) { crew.diff.text = j.diff || ""; drawCrew(); }
        }).catch(function(err){ crew.diff = null; toast(err.message); drawCrew(); });
        return;
      }
      crew.busy = name; drawCrew();
      post(c, name).then(function(j){
        crew.busy = "";
        merge(j);
        if (name === "apply" && j.into) toast("merged into " + j.into);
        drawCrewTabDot(); drawCrew(); scheduleCrew();
      }).catch(function(err){ crew.busy = ""; toast(err.message); drawCrew(); });
    }

    function create(el){
      var name = (el.querySelector("#crewname") || {}).value || "";
      var chk = el.querySelector("#crewapprove");
      crew.busy = "create"; drawCrew();
      api("/api/projects/" + view.pid + "/crews", { method: "POST", body: JSON.stringify({
        template: crew.tpl, ...(name.trim() ? { name: name.trim() } : {}), ...(chk && !chk.checked ? { planApproval: false } : {}),
        ...(crew.seats[crew.tpl] && (crew.previews[crew.tpl] || []).length ? { teammates: seated(crew.previews[crew.tpl]) } : {}),
      }) }).then(function(j){
        crew.busy = ""; crew.making = false; crew.err = "";
        if (crew.list === null) crew.list = [];
        merge(j);
        if (j.crew) {
          crew.sel = j.crew.id;
          toast("created " + j.crew.name + ": " + (j.crew.teammates || []).map(function(t){ return t.id + " · " + t.role + " · " + t.agent; }).join(", "));
        }
        var n = el.querySelector("#crewname"); if (n) n.value = "";
        drawCrewTabDot(); drawCrew();
        var c = current(); if (c) loadChannel(c);
      }).catch(function(err){ crew.busy = ""; crew.err = err.message; drawCrew(); });
    }

    function say(el){
      var c = current(); if (!c || crew.busy) return;
      var box = el.querySelector("#crewsaytext"), to = el.querySelector("#crewsayto");
      var text = box ? box.value.trim() : "";
      if (!text) { if (box) box.focus(); return; }
      crew.busy = "say"; drawCrew();
      post(c, "say", { text: text, ...(to && to.value ? { to: to.value } : {}) }).then(function(j){
        crew.busy = "";
        merge(j);
        var b = document.getElementById("crewsaytext"); if (b) b.value = "";
        var routed = j.routed || "note";
        var words = { goal: "started as the goal", answer: "sent as the answer", note: "left as a note", replan: "sent to the lead — it plans again" };
        toast((words[routed] || routed) + (j.to ? " (@" + j.to + ")" : ""));
        drawCrewTabDot(); drawCrew(); scheduleCrew();
      }).catch(function(err){ crew.busy = ""; toast(err.message); drawCrew(); });
    }

    function openChannel(chat){
      if (!chat) return;
      if (view.desktop && state.setChat) { state.setChat(view.pid, chat); return; }
      toast("open this thread from the desktop app");
    }

    function wire(el){
      el.onclick = function(ev){
        var t = ev.target && ev.target.closest ? ev.target : null; if (!t) return;
        var x;
        if ((x = t.closest("[data-crew-refresh]"))) { loadCrews(); return; }
        if ((x = t.closest("[data-crew-new]"))) { crew.making = true; crew.err = ""; drawCrew(); return; }
        if ((x = t.closest("[data-crew-cancel]"))) { crew.making = false; crew.err = ""; drawCrew(); return; }
        if ((x = t.closest("[data-crew-tpl]"))) { crew.tpl = x.getAttribute("data-crew-tpl"); drawCrew(); return; }
        if ((x = t.closest("#crewcreate"))) { create(el); return; }
        if ((x = t.closest("[data-crew-act]"))) { act(x.getAttribute("data-crew-act")); return; }
        if ((x = t.closest("[data-crew-chan]"))) { ev.preventDefault(); openChannel(x.getAttribute("data-crew-chan")); return; }
        if ((x = t.closest("[data-crew-suggest]"))) {
          var box = el.querySelector("#crewsaytext");
          if (box) { box.value = x.getAttribute("data-crew-suggest"); box.focus(); }
          return;
        }
      };
      Array.prototype.forEach.call(el.querySelectorAll("[data-crew-seat]"), function(sel){
        sel.onchange = function(){
          var m = crew.seats[crew.tpl] || (crew.seats[crew.tpl] = {});
          m[sel.getAttribute("data-crew-seat")] = sel.value;
          drawCrew();
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-crew-swap]"), function(sel){
        sel.onchange = function(){
          var c = current(); if (!c) return;
          var id = sel.getAttribute("data-crew-swap");
          var teammates = (c.teammates || []).map(function(t){ return t.id === id ? Object.assign({}, t, { agent: sel.value }) : t; });
          api("/api/projects/" + view.pid + "/crews/" + encodeURIComponent(c.id), { method: "PATCH", body: JSON.stringify({ teammates: teammates }) })
            .then(function(j){ merge(j); toast(id + " is now " + sel.value); drawCrew(); })
            .catch(function(err){ toast(err.message); drawCrew(); });
        };
      });
      var pick = el.querySelector("#crewpick");
      if (pick) pick.onchange = function(){ crew.sel = pick.value; crew.diff = null; drawCrew(); var c = current(); if (c) loadChannel(c); };
      var form = el.querySelector("#crewsay");
      if (form) {
        form.onsubmit = function(ev){ ev.preventDefault(); say(el); };
        var box = form.querySelector("#crewsaytext");
        // Enter sends, Shift+Enter is a new line — like the composer.
        if (box) box.onkeydown = function(ev){
          if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); say(el); }
        };
      }
    }

return { loadCrews, onCrewEvent, drawCrew, drawCrewTabDot };
}
