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
 */
export function createCrew(view) {

    // This mount's reading of the crews. The factory is created per mount, so
    // its own closure is this view's state; nothing here outlives the view.
    var crew = { list: null, templates: [], sel: null, err: "", t: null, events: {}, diff: null, tpl: "ship", making: false, busy: "" };

    var TEMPLATES = {
      ship: ["Ship", "lead plans, two builders, a reviewer and a tester"],
      fix: ["Fix", "lead, builder and tester"],
      research: ["Research", "lead and two researchers"],
      solo: ["Solo+", "builder and reviewer"],
    };
    // status → [label, dot class]
    var GOAL_ST = {
      planning: ["planning", "live"],
      awaiting_approval: ["needs your OK", "warn"],
      running: ["running", "live"],
      waiting_human: ["needs you", "warn"],
      completed: ["completed", "ok"],
      failed: ["failed", "err"],
      stopped: ["stopped", "off"],
      interrupted: ["interrupted", "warn"],
    };
    var STAGES = ["planned", "building", "review", "testing", "done", "failed"];
    var STAGE_LBL = { planned: "Planned", building: "Building", review: "In review", testing: "Testing", done: "Done", failed: "Failed" };
    var terminal = function(s){ return s === "completed" || s === "failed" || s === "stopped"; };

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
      return api("/api/projects/" + pid + "/events?limit=30&chat=" + encodeURIComponent(ch)).then(function(j){
        if (state.pid !== pid) return;
        crew.events[c.id] = (j.events || []).filter(function(e){ return e.kind === "message" || e.kind === "crew"; }).slice(-30);
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

    function pill(st){
      var s = GOAL_ST[st] || [st || "—", "off"];
      return '<span class="opill ' + s[1] + '"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + "</span>";
    }

    function agentOf(id){
      return ((state.project && state.project.agents) || []).filter(function(a){ return a.id === id; })[0] || null;
    }

    // ---- drawing -------------------------------------------------------------

    function head(){
      return '<div class="ohead"><span class="ot">Crew</span>' +
        '<span class="os">Agents with roles work one goal: the lead plans, builders build, the reviewer and tester gate each card.</span>' +
        '<span class="spacer"></span>' +
        ((crew.list || []).length ? '<button class="btn xs outline" type="button" data-crew-new>' + ICONS.plus + "New crew</button>" : "") +
        '<button class="iconbtn" type="button" data-crew-refresh title="refresh">' + ICONS.refresh + "</button></div>";
    }

    function createForm(){
      var tpls = (crew.templates.length ? crew.templates : Object.keys(TEMPLATES));
      return '<div class="crewmake">' +
        '<div class="crewtpls" role="radiogroup" aria-label="crew template">' + tpls.map(function(t){
          var d = TEMPLATES[t] || [t, ""];
          return '<button type="button" role="radio" class="crewtpl' + (crew.tpl === t ? " on" : "") + '" aria-checked="' + (crew.tpl === t) + '" data-crew-tpl="' + esc(t) + '">' +
            "<b>" + esc(d[0]) + "</b><span>" + esc(d[1]) + "</span></button>";
        }).join("") + "</div>" +
        '<div class="crewmrow">' +
          '<input id="crewname" class="crewin" type="text" maxlength="60" placeholder="Name (optional)" autocomplete="off">' +
          '<label class="crewchk"><input type="checkbox" id="crewapprove" checked> Ask me to approve the plan</label>' +
          '<button class="btn sm primary" type="button" id="crewcreate"' + (crew.busy === "create" ? " disabled" : "") + ">" + ICONS.team + "Create crew</button>" +
          ((crew.list || []).length ? '<button class="btn sm ghost" type="button" data-crew-cancel>Cancel</button>' : "") +
        "</div></div>";
    }

    function roster(c){
      var g = c.state && c.state.goal;
      var liveId = g && !terminal(g.status) && g.current ? g.current.teammate : null;
      return '<div class="crewroster">' + (c.teammates || []).map(function(t){
        var a = agentOf(t.agent);
        var live = liveId === t.id;
        return '<span class="crewmate' + (live ? " live" : "") + '" data-mate="' + esc(t.id) + '" title="' + esc(t.id + " · " + t.role + " · " + t.agent + (t.charter ? "\n" + t.charter : "")) + '">' +
          (live ? '<span class="odot live" data-live></span>' : "") +
          agentGlyph(a ? a.kind : "", t.agent) +
          '<b class="cmid">' + esc(t.id) + "</b>" +
          '<span class="cmrole">' + esc(t.role) + "</span>" +
          '<span class="cmagent">' + esc(t.agent) + "</span></span>";
      }).join("") + "</div>";
    }

    function cards(g){
      if (!g.cards || !g.cards.length) return g.status === "planning" ? '<div class="crewnote">The lead is planning…</div>' : "";
      return '<div class="crewcards">' + STAGES.map(function(s){
        var here = g.cards.filter(function(c){ return c.stage === s; });
        if (!here.length) return "";
        return '<div class="crewstage" data-stage="' + s + '"><div class="crewsth">' + esc(STAGE_LBL[s]) + ' <span class="n">' + here.length + "</span></div>" +
          here.map(function(c){
            var working = g.current && g.current.card === c.id && !terminal(g.status);
            return '<div class="crewcard' + (working ? " live" : "") + '" data-card="' + esc(c.id) + '">' +
              '<div class="cct">' + esc(c.title) + "</div>" +
              '<div class="ccm">' + (c.builder ? "<span>" + esc(c.builder) + "</span>" : "") +
                (c.rounds ? "<span>" + c.rounds + " round" + (c.rounds === 1 ? "" : "s") + "</span>" : "") +
                ((c.commits || []).length ? "<span>" + c.commits.length + " commit" + (c.commits.length === 1 ? "" : "s") + "</span>" : "") +
                (working && g.current.step ? '<span class="live">' + esc(g.current.teammate) + " · " + esc(g.current.step) + "</span>" : "") + "</div>" +
              (c.error ? '<div class="cce">' + esc(c.error.slice(0, 300)) + "</div>" : "") +
            "</div>";
          }).join("") + "</div>";
      }).join("") + "</div>";
    }

    function actions(c, g){
      var b = function(act, label, cls, icon){
        return '<button type="button" class="btn xs ' + cls + '" data-crew-act="' + act + '"' + (crew.busy ? " disabled" : "") + ">" + (icon || "") + esc(label) + "</button>";
      };
      var out = "";
      if (g.status === "awaiting_approval") out += b("approve", "Approve plan", "primary", ICONS.check);
      if (/^(planning|running|waiting_human|awaiting_approval)$/.test(g.status)) out += b("stop", "Stop", "outline", ICONS.stop);
      if (/^(interrupted|stopped|failed)$/.test(g.status)) out += b("resume", "Resume", "outline", ICONS.play);
      if (g.status === "completed" && !g.applied) out += b("apply", "Apply (merge)", "primary", ICONS.check);
      if (g.status === "completed" || (g.cards || []).some(function(x){ return (x.commits || []).length; }))
        out += b("diff", crew.diff && crew.diff.goal === g.id ? "Hide diff" : "View diff", "ghost", ICONS.tree);
      if (g.applied) out += '<span class="crewapplied">' + ICONS.check + "applied to " + esc(g.applied.into) + "</span>";
      return out ? '<div class="crewacts">' + out + "</div>" : "";
    }

    function goalBlock(c){
      var g = c.state && c.state.goal;
      if (!g) return '<div class="crewnote">No goal yet. Tell the crew what to do below.</div>';
      var meta = [pill(g.status), '<span class="mono">' + esc(g.branch) + "</span>"];
      if (g.costUsd) meta.push("<span>" + money(g.costUsd) + "</span>");
      if (g.startedAt) meta.push("<span>" + esc(rel(g.startedAt)) + "</span>");
      return '<div class="ocard crewgoal">' +
        '<div class="ogoal">' + esc(g.text) + "</div>" +
        '<div class="crewmeta">' + meta.join("") + "</div>" +
        (g.status === "waiting_human" && g.question
          ? '<div class="crewask"><b>' + esc(g.question.teammate) + " asks:</b> " + esc(g.question.text) + "</div>" : "") +
        (g.error ? '<div class="onote err">' + esc(g.error.slice(0, 600)) + "</div>" : "") +
        (g.summary && g.status === "completed" ? '<div class="crewsum">' + esc(g.summary.slice(0, 1200)) + "</div>" : "") +
        actions(c, g) +
        (crew.diff && crew.diff.goal === g.id
          ? '<div class="crewdiff">' + (crew.diff.text === null ? LOADER : crew.diff.text ? '<div class="dcode">' + renderDiffLines(crew.diff.text.split("\n")) + "</div>" : '<div class="crewnote">No changes on the branch.</div>') + "</div>"
          : "") +
        cards(g) +
      "</div>";
    }

    var PHASE = {
      goal_started: function(p){ return "goal started on " + (p.branch || "a branch"); },
      planned: function(p){ var n = (p.cards || []).length; return "planned " + n + " card" + (n === 1 ? "" : "s") + (p.awaitingApproval ? " — waiting for your OK" : ""); },
      plan_approved: function(){ return "plan approved"; },
      claimed: function(p){ return (p.teammate || "a builder") + " took “" + (p.title || "") + "”"; },
      reviewed: function(p){ return (p.teammate || "reviewer") + " reviewed “" + (p.title || "") + "”: " + (p.verdict || "") + (p.notes ? " — " + p.notes : ""); },
      tested: function(p){ return (p.teammate || "tester") + " tested “" + (p.title || "") + "”: " + (p.result || ""); },
      card_done: function(p){ return "“" + (p.title || "") + "” done"; },
      card_failed: function(p){ return "“" + (p.title || "") + "” failed" + (p.error ? ": " + p.error : ""); },
      asks: function(p){ return (p.teammate || "a teammate") + " asks: " + (p.question || ""); },
      completed: function(){ return "goal completed"; },
      failed: function(p){ return "goal failed" + (p.error ? ": " + p.error : ""); },
      stopped: function(){ return "stopped"; },
      resumed: function(){ return "resumed"; },
      applied: function(p){ return "applied to " + (p.into || "your branch"); },
    };

    function channel(c){
      var evs = crew.events[c.id];
      var ch = c.state && c.state.channel;
      var open = ch ? '<button type="button" class="btn xs ghost" data-crew-chan="' + esc(ch) + '">' + ICONS.thread + "Open channel</button>" : "";
      var body;
      if (!evs) body = '<div class="crewnote">' + LOADER + "</div>";
      else if (!evs.length) body = '<div class="crewnote">Nothing in the channel yet.</div>';
      else body = evs.map(function(e){
        var p = e.payload || {};
        var when = '<span class="cwt">' + esc(rel(e.ts)) + "</span>";
        if (e.kind === "crew") {
          var f = PHASE[p.phase];
          var line = f ? f(p) : String(p.phase || "");
          return '<div class="crewev cphase" data-phase="' + esc(String(p.phase || "")) + '">' + when + '<span class="cwx">' + esc(line.slice(0, 400)) + "</span></div>";
        }
        var who = p.author === "user" ? "you" : p.crew && p.crew.teammate ? p.crew.teammate : p.author || e.agentId || "loom";
        var to = p.crew && p.crew.to && p.author === "user" ? " → @" + p.crew.to : "";
        return '<div class="crewev cmsg' + (p.author === "user" ? " cmine" : "") + '">' + when +
          '<b class="cww">' + esc(who + to) + "</b>" + '<span class="cwx">' + esc(String(p.text || "").slice(0, 600)) + "</span></div>";
      }).join("");
      return '<div class="crewchan"><div class="crewchh"><span>Channel</span><span class="spacer"></span>' + open + "</div>" +
        '<div class="crewevs">' + body + "</div></div>";
    }

    function sayForm(c){
      var g = c.state && c.state.goal;
      var ph = !g || terminal(g.status) ? "Give the crew a goal…"
        : g.status === "waiting_human" && g.question ? "Answer " + g.question.teammate + "…"
        : g.status === "awaiting_approval" ? "Feedback on the plan (the lead plans again)…"
        : "Say to the crew (a note for its next turn)…";
      var label = !g || terminal(g.status) ? "Start goal" : "Send";
      return '<form class="crewsay" id="crewsay" autocomplete="off">' +
        '<textarea id="crewsaytext" class="crewin" rows="2" placeholder="' + esc(ph) + '"></textarea>' +
        '<div class="crewsayrow"><select id="crewsayto" class="crewsel" title="who it\'s for"><option value="">' + (g && !terminal(g.status) ? "the crew" : "everyone") + "</option>" +
          (c.teammates || []).map(function(t){ return '<option value="' + esc(t.id) + '">@' + esc(t.id) + "</option>"; }).join("") + "</select>" +
          '<span class="spacer"></span><button class="btn sm primary" type="submit" id="crewsend"' + (crew.busy === "say" ? " disabled" : "") + ">" + ICONS.up + esc(label) + "</button></div>" +
      "</form>";
    }

    /** Redraws replace the pane; keep what you were typing (and where) across them. */
    function keep(el){
      var kept = {}, act = document.activeElement;
      ["crewsaytext", "crewsayto", "crewname"].forEach(function(id){
        var x = el.querySelector("#" + id); if (x) kept[id] = x.value;
      });
      var chk = el.querySelector("#crewapprove"); if (chk) kept.crewapprove = chk.checked;
      return { kept: kept, focus: act && el.contains(act) ? act.id : "", sel: act && typeof act.selectionStart === "number" ? [act.selectionStart, act.selectionEnd] : null };
    }
    function restore(el, k){
      Object.keys(k.kept).forEach(function(id){
        var x = el.querySelector("#" + id); if (!x) return;
        if (id === "crewapprove") x.checked = k.kept[id];
        else if (id === "crewsayto") { if ([].some.call(x.options, function(o){ return o.value === k.kept[id]; })) x.value = k.kept[id]; }
        else x.value = k.kept[id];
      });
      if (k.focus) {
        var f = el.querySelector("#" + k.focus);
        if (f) { f.focus(); if (k.sel && f.setSelectionRange) try { f.setSelectionRange(k.sel[0], k.sel[1]); } catch (e) {} }
      }
    }

    function drawCrew(){
      var el = crewEl(); if (!el) return;
      var k = keep(el);
      var body;
      if (crew.list === null) body = crew.err ? '<div class="onote err">' + esc(crew.err) + "</div>" : LOADER;
      else if (!crew.list.length || crew.making) {
        body = (crew.list.length ? "" : '<div class="oempty crewempty"><b>No crew yet.</b><br>Pick a template; Loom fills its roles from this project’s agents.</div>') +
          (crew.err ? '<div class="onote err">' + esc(crew.err) + "</div>" : "") + createForm();
      } else {
        var c = current();
        var picker = crew.list.length > 1
          ? '<select id="crewpick" class="crewsel" aria-label="crew">' + crew.list.map(function(x){
              return '<option value="' + esc(x.id) + '"' + (x.id === c.id ? " selected" : "") + ">" + esc(x.name) + "</option>";
            }).join("") + "</select>"
          : '<span class="crewname">' + esc(c.name) + "</span>";
        body = (crew.err ? '<div class="onote err">' + esc(crew.err) + "</div>" : "") +
          '<div class="crewtop">' + picker + (c.busy ? '<span class="crewbusy"><span class="odot live"></span>working</span>' : "") + "</div>" +
          roster(c) +
          '<div class="crewgrid"><div class="crewmain">' + goalBlock(c) + sayForm(c) + "</div>" + channel(c) + "</div>";
      }
      el.innerHTML = '<div class="orchview crewview">' + head() + body + "</div>";
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
      };
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
