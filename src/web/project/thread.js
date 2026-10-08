import { agentGlyph,agentLabel,BRAND_TITLES,brandMark,hasBrand,labelOf } from '../agents.js';
import { settleApprovalCards } from '../approvals.js';
import { api,checkBuild } from '../connection.js';
import { addLogRecord,clog } from '../console.js';
import { esc,hue,mdToHtml,money,pageGone } from '../format.js';
import { notifyDone,notifyNeedsInput,toast } from '../notifications.js';
import { maybeReloadPreview,onServerFrame,onSpecFrame } from '../preview.js';
import { state } from '../state.js';
import { drawStatusbar } from '../statusbar.js';
import { onTeamFrame } from '../team.js';
import { actSummary,avatarFor,durfmt,lineFor,relClock,settleQuestionCard,untilText,whoHtml } from '../transcript.js';
import { observeUsage,usageMeter } from '../usage.js';
import { ICONS } from '../icons.js';

/** thread behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createThread(view) {


    // ---- status (title, chips, routebar, rail, statusbar) --------------------
    function drawChips(){
      var p = state.project; if (!p) return;
      var chips = document.getElementById("chips");
      if (!chips) return;
      var adapters = p.agents.filter(function(a){ return a.tier === "adapter"; });
      pickDefaultAgent(p, adapters);
      chips.innerHTML = adapters.filter(function(a){ return a.enabled !== false; }).map(function(a){
        var sel = a.id === state.selected, lbl = agentLabel(a.kind, a.id);
        // the role only when it says something the name doesn't
        var role = a.role && a.role !== a.id && a.role !== a.kind ? a.role : "";
        return '<button class="chip' + (sel ? " sel" : "") + '" data-id="' + esc(a.id) + '">' +
          agentGlyph(a.kind, a.id) + esc(lbl) + (role || a.id === p.holder ? ' <span class="role">' + esc(role) + (a.id === p.holder ? " \u2190" : "") + "</span>" : "") +
          (a.busy ? ' <span class="busy"></span>' : "") + usageMeter(a) + "</button>";
      }).join("");
      Array.prototype.forEach.call(chips.querySelectorAll(".chip"), function(chip){
        chip.onclick = function(){ state.selected = chip.getAttribute("data-id"); drawStatus(); };
      });
    }

    /**
     * Aim at the baton holder by default — unless that agent is switched off
     * for this project, which would make the first send a refusal.
     */
    function pickDefaultAgent(p, adapters){
      var usable = adapters.filter(function(a){ return a.enabled !== false; });
      var ok = function(id){ return usable.some(function(a){ return a.id === id; }); };
      var off = (p.agents || []).some(function(a){ return a.id === state.selected && a.enabled === false; });
      if (state.selected === null || off) {
        // A thread with an agent of its own (pinned when it was made, or a
        // task's worker) is talked to through that agent — not whoever the
        // last thread you were in happened to be aimed at.
        var own = chatOwnAgent(p);
        state.selected = (own && ok(own) ? own : null) ||
          (ok(p.holder) ? p.holder : (usable[0] && usable[0].id)) || p.holder || (adapters[0] && adapters[0].id) || null;
      }
    }
    function chatOwnAgent(p){
      if (!view.chatId || view.chatId === "main") return null;
      var agents = (p && p.agents) || [];
      var resolve = function(want){
        if (!want) return null;
        for (var k = 0; k < agents.length; k++) if (agents[k].id === want) return agents[k].id;
        for (var m = 0; m < agents.length; m++) if (agents[m].kind === want) return agents[m].id;
        return null;
      };
      var threads = (p && p.orchestra && p.orchestra.threads) || [];
      for (var i = 0; i < threads.length; i++) if (threads[i] && threads[i].chat === view.chatId) return resolve(threads[i].agent);
      var chats = (p && p.chats) || [];
      for (var j = 0; j < chats.length; j++) if (chats[j].id === view.chatId && chats[j].agentId) return resolve(chats[j].agentId);
      return null;
    }
    function drawStatus(){
      var p = state.project; if (!p) return;
      var adapters = p.agents.filter(function(a){ return a.tier === "adapter"; });
      pickDefaultAgent(p, adapters);
      var nm = document.getElementById("pname"); if (nm) nm.textContent = p.name;
      var stat = document.getElementById("pstat");
      if (stat) stat.textContent = p.needsInput ? "needs input" : p.costUsd > 0 ? money(p.costUsd) : "";

      // Send ⇄ stop. While an adapter is mid-turn the composer offers the
      // interrupt, in the one place you're already looking. Driven by the
      // agents' own busy flag rather than a local guess, so a turn you started
      // from your phone shows a stop here too.
      // busy *in this chat*: an agent working in another thread doesn't take
      // this one's Send away (a daemon too old to say which chat counts as here)
      var here = view.chatId || "main";
      var anyBusy = adapters.some(function(a){ return a.busy && (!a.chat || a.chat === here); });
      var sendBtn = document.getElementById("send");
      var stopBtn = document.getElementById("stop");
      // Orchestrate has its own send, and a run is stopped from its view
      // (Abort), not by interrupting whichever agent the composer points at.
      var orchMode = state.cmode === "orch";
      if (sendBtn && stopBtn) {
        sendBtn.style.display = orchMode || anyBusy ? "none" : "";
        stopBtn.style.display = !orchMode && anyBusy ? "" : "none";
      }

      var hint = document.getElementById("hint");
      var orun = view.orchRunForChat();
      if (hint) hint.textContent = orchMode
        ? (view.planState
          ? "plan mode \u00b7 orchestrator writes PLAN.md + a spec per task that any agent can pick up"
          : "the orchestrator plans your goal into tasks \u00b7 each worker gets its own thread and git worktree")
        : orun && !view.orchTerminal(orun.status)
        ? "this is an orchestra thread \u00b7 what you send goes to its orchestrator"
        : orun && orun.status !== "aborted" && orun.status !== "moved"
        ? "this orchestra has finished \u00b7 sending reopens it with its orchestrator"
        : view.planState
        ? "plan mode \u00b7 agent writes a plan to plans/\u2026, no code changes"
        // The resting state says nothing: who you're talking to is on the
        // composer's own button, and repeating it underneath was noise.
        : "";
      reconcileLive(p);
      view.drawOrchTabDot(p.orchestra);
      view.updateModelLabel(); // the picker button reflects whoever's selected now
      if (!view.desktop) drawChips();
      // Whose thread is this? A task's worker, or a pinned thread's agent —
      // null when the thread has no opinion and the baton should answer.
      function threadAgent(p){
        // currentChat() belongs to the shell's scope; this render is in
        // another. state.currentChat is the seam between them — calling the
        // bare name threw, and a throw in here hid the header entirely.
        var chat = state.currentChat ? state.currentChat() : null;
        if (!chat || chat === "main") return null;
        var agents = (p && p.agents) || [];
        // A task's agent field is a roster agent id OR a kind, so match either —
        // an id that isn't in the roster would resolve to nothing and the
        // header would fall back to the baton, which is the bug being fixed.
        var resolve = function(want){
          if (!want) return null;
          for (var k = 0; k < agents.length; k++) if (agents[k].id === want) return agents[k].id;
          for (var m = 0; m < agents.length; m++) if (agents[m].kind === want) return agents[m].id;
          return null;
        };
        var run = p && p.orchestra;
        var tasks = (run && run.threads) || [];
        for (var i = 0; i < tasks.length; i++) {
          if (tasks[i] && tasks[i].chat === chat) return resolve(tasks[i].agent);
        }
        var chats = (p && p.chats) || [];
        for (var j = 0; j < chats.length; j++) {
          if (chats[j].id === chat && chats[j].agentId) return resolve(chats[j].agentId);
        }
        return null;
      }

      // agent header block — who the composer talks to, and where
      var ah = document.getElementById("agenthead");
      if (ah) {
        // Resolve over EVERY agent, bridges included — selecting Kiro or
        // Antigravity must show Kiro or Antigravity, not fall through to the
        // first adapter (which read as "the header says Claude").
        //
        // The thread you are IN wins over the baton. An orchestra task thread
        // belongs to the agent doing that task: during a run with four
        // workers, every task thread used to claim to be whoever held the
        // project baton, so you could not tell a Codex task from an
        // Antigravity one by looking at it. A thread pinned to an agent (its
        // own binding) answers the same way, for the same reason.
        var wanted = threadAgent(p) || state.selected || p.holder;
        var focus = null;
        (p.agents || []).forEach(function(a){ if (a.id === wanted) focus = a; });
        if (!focus) focus = adapters[0] || (p.agents || [])[0] || null;
        if (focus) {
          var hh = hue(focus.id);
          ah.innerHTML =
            // the agent's own logo when we have it; the hue monogram is only
            // for kinds with no mark (a custom adapter, echo)
            (hasBrand(focus.kind)
              ? '<span class="ag brandbox" title="' + esc(BRAND_TITLES[focus.kind]) + '">' + brandMark(focus.kind, "brand xl") + "</span>"
              : '<span class="ag" style="background:color-mix(in srgb, hsl(' + hh + ',60%,50%) 18%, transparent);color:hsl(' + hh + ',60%,var(--agent-l))">' + esc(focus.id.slice(0, 2)) + "</span>") +
            '<span class="meta"><span class="l1">' + esc(focus.id) +
            '<span class="role">' + esc(focus.role) + (focus.id === p.holder ? " \u00b7 baton" : "") + (focus.busy ? " \u00b7 working\u2026" : "") + "</span></span>" +
            '<span class="l2">' + esc(p.dir || p.name) + "</span></span>" +
            '<span class="badge kind">' + esc(focus.kind || "agent") + "</span>";
          ah.style.display = "";
        } else {
          ah.style.display = "none";
        }
      }
      var bar = document.getElementById("routebar");
      var r = p.route;
      if (bar) {
        if (r && (r.status === "running" || r.status === "waiting_human")) {
          var pos = r.mode === "dynamic"
            ? "hop " + (r.current + 1) + (r.maxHops ? " of \u2264" + r.maxHops : "")
            : "step " + (r.current + 1) + "/" + r.steps.length;
          bar.innerHTML = '<div class="routebar"><button class="abort btn xs outline" id="rabort">abort</button>\u25b8 ' +
            esc(r.name || "route") + " " + pos + " &middot; " + esc(r.steps[r.current]) +
            (r.mode === "dynamic" && r.reason ? '<span style="opacity:.7"> &mdash; ' + esc(r.reason) + "</span>" : "") +
            (r.status === "waiting_human" ? '<div class="q">\u23f8 ' + esc(r.pendingQuestion || "waiting for you") + " \u2014 reply below to resume</div>" : "") + "</div>";
          var ab = document.getElementById("rabort");
          if (ab) ab.onclick = function(){
            api("/api/projects/" + view.pid + "/route", { method: "DELETE" })
              .then(function(){ toast("route aborted"); refresh(); })
              .catch(function(err){ toast(err.message); });
          };
        } else { bar.innerHTML = ""; }
      }
      // only the live views (Source Control, Tasks) redraw on status polls;
      // Explorer/Search are user-driven so they aren't torn down mid-scroll.
      if (view.desktop) {
        if (state.railView === "scm" || state.railView === "tasks") view.drawRail();
        drawStatusbar();
      }
    }


    function refresh(){
      // Returned, so a caller that changed the roster can wait for the answer
      // before redrawing off it.
      return api("/api/projects/" + view.pid).then(function(j){
        var first = !state.project || !state.project.agents;
        state.project = j.project;
        view.syncStars();
        // the empty thread drew before the project arrived ("Ready in this
        // project", no agent) — draw it again now that it knows both
        drawStatus();
        if (first) { var h = document.getElementById("threadempty"); if (h) { h.remove(); drawEmpty(); } }
      }).catch(function(err){ toast(err.message); });
    }


    // ---- feed + live websocket ----------------------------------------------
    // ---- scrolling ------------------------------------------------------------
    // New content pulls the view down only if you were already at the bottom.
    // Someone scrolled up to read shouldn't be yanked away mid-sentence; they
    // get a "new messages" pill instead. Your own send always goes to the end.
    var forceScroll = false;
    /** The next thing appended scrolls into view, wherever you'd scrolled to. */
    function wantScroll(){ forceScroll = true; }
    function threadScroller(){ var f = document.getElementById("feed"); return f ? f.parentNode : null; }
    function nearBottom(){
      var sc = threadScroller();
      return !sc || !sc.scrollHeight || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140;
    }
    function toBottom(){
      var sc = threadScroller();
      if (sc && sc.scrollHeight) sc.scrollTop = sc.scrollHeight;
      var j = document.getElementById("jumpnew"); if (j) j.classList.remove("show");
    }
    function stickOrFlag(wasNear){
      if (wasNear || forceScroll) { forceScroll = false; toBottom(); return; }
      var j = document.getElementById("jumpnew"); if (j) j.classList.add("show");
    }

    // ---- the feed -------------------------------------------------------------
    /** Who wrote the last thing in the feed, if it was an agent still mid-turn. */
    function lastAuthor(feed){
      for (var n = feed.lastElementChild; n; n = n.previousElementSibling) {
        var c = n.classList;
        if (c.contains("tool") || c.contains("acts") || c.contains("thinking") || c.contains("turncard")) continue;
        if (c.contains("msg") && c.contains("agent")) return n.getAttribute("data-agent");
        return null;
      }
      return null;
    }
    function updateActs(g){
      var rows = g.querySelectorAll(".actlist > .tool");
      var s = g.querySelector(".as"), l = g.querySelector(".al");
      if (s) s.textContent = actSummary(Array.prototype.slice.call(rows));
      var last = rows[rows.length - 1];
      if (l) l.textContent = last ? (last.querySelector(".tx") || last).textContent : "";
    }
    /**
     * Put one rendered line into the feed. Two things happen on the way in: a
     * run of tool rows folds into one "activity" line you can open, and an
     * agent continuing its own turn doesn't get a second byline.
     */
    function placeLine(feed, html, before){
      var tmp = document.createElement("div");
      tmp.innerHTML = html;
      Array.prototype.slice.call(tmp.children).forEach(function(n){
        var last = before ? before.previousElementSibling : feed.lastElementChild;
        if (n.classList.contains("tool")) {
          if (last && last.classList.contains("acts")) {
            last.querySelector(".actlist").appendChild(n); updateActs(last); return;
          }
          if (last && last.classList.contains("tool")) {
            var g = document.createElement("details");
            g.className = "acts";
            g.innerHTML = '<summary><span class="ai">' + ICONS.chevron + '</span><span class="as"></span><span class="al"></span></summary><div class="actlist"></div>';
            feed.insertBefore(g, last);
            g.querySelector(".actlist").appendChild(last);
            g.querySelector(".actlist").appendChild(n);
            updateActs(g);
            return;
          }
        }
        // A task's status line updates where the task first appeared, rather
        // than adding a line per state (pending, running, done…) — three rows
        // per task read as noise, one row that changes reads as progress.
        var tk = !before && n.getAttribute && n.getAttribute("data-otask");
        if (tk) {
          var olds = feed.querySelectorAll('[data-otask="' + tk.replace(/"/g, "") + '"]');
          if (olds.length) {
            var old = olds[olds.length - 1];
            old.parentNode.replaceChild(n, old);
            n.classList.add("bump");
            return;
          }
        }
        if (n.classList.contains("msg") && n.classList.contains("agent") && !n.classList.contains("thinking")) {
          var who = n.getAttribute("data-agent");
          var prev = before ? null : lastAuthor(feed);
          if (who && prev === who) n.classList.add("cont");
        }
        if (before) feed.insertBefore(n, before); else feed.appendChild(n);
      });
    }
    function append(events){
      var feed = document.getElementById("feed"); if (!feed) return;
      // only the loading placeholder gets cleared — never real history
      if (feed.firstChild && feed.firstChild.className === "loader") feed.innerHTML = "";
      var wasNear = nearBottom(), added = false, meters = false;
      events.forEach(function(e){
        if (e.id <= state.lastId) return;
        state.lastId = e.id;
        if (!state.firstId || e.id < state.firstId) state.firstId = e.id;
        if (e.kind === "needs_input" && e.payload) state.lastQuestion = e.payload.question || null;
        // An answered approval folds the card it answers. Only when that card
        // is out of the loaded window does it need a line of its own.
        if (observeUsage(state.project, e)) meters = true;
        // A compaction that ended folds its "compacting…" row; flush first,
        // since the row may be in the html not yet inserted.
        var pl = e.payload || {};
        if (e.agentId && (pl.state === "native_compacted" || pl.state === "interrupted" || e.kind === "run_complete" || e.kind === "error")) {
          Array.prototype.forEach.call(feed.querySelectorAll(".sys.compacting"), function(row){
            if (row.getAttribute("data-agent") === e.agentId) row.parentNode.removeChild(row);
          });
        }
        // A tool still showing as running goes when the turn does.
        if (e.agentId && ((e.kind === "message" && !pl.reasoning) || pl.state === "interrupted" || e.kind === "run_complete" || e.kind === "error")) {
          clearStreaming(feed, e.agentId);
        }
        // A question answered (on its card, by a typed reply, in the agent's own UI) folds its card;
        // a turn that ended leaves its unanswered cards closed, not clickable into an error.
        if (e.kind === "status" && pl.state === "question_answered" && pl.requestId) {
          Array.prototype.forEach.call(feed.querySelectorAll('.nicard[data-nireq]'), function(c){
            if (c.getAttribute("data-nireq") === pl.requestId) settleQuestionCard(c, pl.answers || {});
          });
        }
        if (e.agentId && (pl.state === "interrupted" || e.kind === "run_complete" || e.kind === "error")) {
          Array.prototype.forEach.call(feed.querySelectorAll('.nicard[data-nireq]:not(.done)'), function(c){
            if (c.getAttribute("data-niwho") === e.agentId) settleQuestionCard(c, null);
          });
        }
        if (e.kind === "approval" && e.payload && e.payload.phase === "decided") {
          if (settleApprovalCards(e.payload.approvalId, e.payload.behavior, e.payload.message)) return;
        }
        noteLive(e);
        // a todo list that changed mid-turn updates its checklist in place, rather than stacking copies
        if (e.kind === "status" && pl.state === "plan_updated") {
          var cards = feed.querySelectorAll(".plancheck"), prevCard = null;
          for (var ci = cards.length - 1; ci >= 0; ci--) if (cards[ci].getAttribute("data-agent") === (e.agentId || "")) { prevCard = cards[ci]; break; }
          var sib = prevCard && prevCard.nextElementSibling, userSince = false;
          while (sib && !userSince) { if (sib.classList.contains("user")) userSince = true; sib = sib.nextElementSibling; }
          if (prevCard && !userSince) { var fresh = lineFor(e); if (fresh) prevCard.outerHTML = fresh; return; }
        }
        var html = lineFor(e);
        if (!html) return;
        placeLine(feed, html);
        added = true;
      });
      if (meters) { drawChips(); view.updateModelLabel(); }
      drawEmpty();
      if (added) { view.markDays(); markSeen(); if (state.railView === "outline") view.drawRail(); }
      if (added) stickOrFlag(wasNear);
      // A day-long live session piles thousands of nodes into one page. Once
      // it's that big and you're reading the newest part, start again from the
      // newest page — Load earlier still reaches everything, and a reply being
      // written carries on from the snapshot.
      if (added && view.historyLoaded && !trimQueued && feed.childElementCount > 1200 && nearBottom()) {
        trimQueued = true;
        setTimeout(function(){ if (!pageGone()) loadHistory().then(function(){ trimQueued = false; }, function(){ trimQueued = false; }); }, 0);
      }
    }
    var trimQueued = false;
    /** What this device has read in this chat — the sidebar's unread dots. */
    function markSeen(){
      var m = {};
      try { m = JSON.parse(localStorage.getItem("loomSeen") || "{}") || {}; } catch (e) {}
      var k = view.pid + ":" + view.chatId;
      if ((m[k] || 0) >= state.lastId) return;
      m[k] = state.lastId;
      try { localStorage.setItem("loomSeen", JSON.stringify(m)); } catch (e) {}
    }

    // ---- live: a reply being written, and who is working ----------------------
    // The daemon streams replies as they're typed (a "stream" frame, never
    // logged) and the finished message lands as an event afterwards. Between
    // your send and that message, the thread shows who's on it, for how long,
    // and what they're doing — instead of fifteen seconds of nothing.
    var live = {};
    var TERMINAL = { run_complete: 1, error: 1 };
    function liveHost(){ return document.getElementById("feedlive"); }
    function liveFor(agentId){
      var L = live[agentId];
      if (L && L.el && L.el.parentNode) return L;
      var host = liveHost(); if (!host) return null;
      var el = document.createElement("div");
      el.className = "livebox";
      el.setAttribute("data-live", agentId);
      host.appendChild(el);
      L = live[agentId] = { el: el, text: "", think: "", act: "", since: Date.now(), touched: Date.now(), raf: 0 };
      paintLive(agentId);
      return L;
    }
    function endLive(agentId){
      var L = live[agentId];
      if (L) { if (L.el && L.el.parentNode) L.el.parentNode.removeChild(L.el); if (L.raf) cancelAnimationFrame(L.raf); }
      delete live[agentId];
    }
    function clearLive(){ Object.keys(live).forEach(endLive); var h = liveHost(); if (h) h.innerHTML = ""; }
    function paintLiveState(agentId){
      var L = live[agentId]; if (!L) return;
      var st = L.el.querySelector(".lstate"); if (!st) return;
      var secs = Math.floor((Date.now() - L.since) / 1000);
      var what = L.text ? "Writing" : L.think ? "Thinking" : L.act ? L.act : "Working";
      // how fast it's coming: words so far, and words a second since the first one
      var pace = "";
      if (L.text && L.firstTextAt) {
        var words = (L.text.match(/\S+/g) || []).length;
        var dt = (Date.now() - L.firstTextAt) / 1000;
        pace = '<span class="lpace">' + words + " word" + (words === 1 ? "" : "s") + (dt >= 1.5 ? " · " + (words / dt).toFixed(1) + " w/s" : "") + "</span>";
      }
      st.innerHTML = '<span class="shimmer">' + esc(what) + "</span>" + (secs >= 1 ? '<span class="lsecs">' + durfmt(secs * 1000) + "</span>" : "") + pace;
    }
    function paintLive(agentId){
      var L = live[agentId]; if (!L) return;
      var feed = document.getElementById("feed");
      if (!L.text) {
        // Nothing written yet: one quiet line, not an empty message.
        if (L.el.className !== "livebox bar") {
          L.el.className = "livebox bar";
          L.el.innerHTML = '<span class="lav">' + avatarFor(agentId) + '<i class="lring"></i></span><span class="lname">' + esc(labelOf(agentId)) + '</span><span class="lstate"></span>';
        }
        paintLiveState(agentId);
        return;
      }
      if (L.el.className.indexOf("livebox msgmode") !== 0) {
        L.el.className = "livebox msgmode";
        L.el.innerHTML = '<div class="msg agent live' + (feed && lastAuthor(feed) === agentId ? " cont" : "") + '" data-agent="' + esc(agentId) + '">' +
          whoHtml({ agentId: agentId, ts: Date.now(), payload: {} }, '<span class="lstate"></span>') +
          '<div class="bubble md lbody"></div></div>';
      }
      var body = L.el.querySelector(".lbody");
      body.innerHTML = mdToHtml(L.text);
      // the caret sits at the end of the last line written, not below it
      var tail = body;
      while (tail.lastElementChild && !/^(PRE|CODE|TABLE|svg)$/.test(tail.lastElementChild.tagName)) tail = tail.lastElementChild;
      tail.insertAdjacentHTML("beforeend", '<span class="caret"></span>');
      paintLiveState(agentId);
    }
    function schedulePaint(agentId, wasNear){
      var L = live[agentId]; if (!L || L.raf) return;
      L.raf = requestAnimationFrame(function(){ L.raf = 0; paintLive(agentId); stickOrFlag(wasNear); });
    }
    /** Keep the live view in step with the logged events as they arrive. */
    // Turns the history replay saw start and not end. Replay never draws a
    // live line itself: whether a turn is STILL running is a question for the
    // agent's busy flag (or the run's state), answered once replay is done.
    var openTurns = {};
    function noteLive(e){
      if (!e.agentId) return;
      var p = e.payload || {}, id = e.agentId;
      var ends = TERMINAL[e.kind] || e.kind === "needs_input" || (e.kind === "status" && (p.state === "interrupted" || p.state === "stopped"));
      var starts = (e.kind === "status" && p.state === "turn_started") || e.kind === "tool_call" || e.kind === "file_edit" || e.kind === "message";
      if (!view.historyLoaded) {
        if (ends) delete openTurns[id];
        else if (starts) openTurns[id] = { since: Number(e.ts) || Date.now(), act: e.kind === "tool_call" ? String(p.summary || p.tool || "") : "" };
        return;
      }
      if (ends) {
        endLive(id);
        // Stop turns back into Send the moment the turn ends, not a poll later.
        clearTimeout(state.endRefresh);
        state.endRefresh = setTimeout(function(){ if (state.pid === view.pid) refresh(); }, 150);
        return;
      }
      if (!starts) return;
      var L = liveFor(id); if (!L) return;
      L.touched = Date.now();
      if (e.kind === "message") { if (p.reasoning) L.think = ""; else L.text = ""; L.synced = false; }
      if (e.kind === "tool_call") L.act = String(p.summary || p.tool || p.name || "Working").replace(/\s+/g, " ").slice(0, 80);
      if (e.kind === "file_edit") L.act = "Editing " + String(p.path || "").split("/").pop();
      paintLive(id);
    }
    function onStreamFrame(f){
      if ((f.chat || "main") !== view.chatId || !f.agentId || !f.text) return;
      var wasNear = nearBottom();
      var L = liveFor(f.agentId); if (!L) return;
      var key = f.reasoning ? "think" : "text", have = L[key];
      if (key === "text" && !L.firstTextAt) L.firstTextAt = Date.now();
      // Seeded from the snapshot of a reply already under way, pieces carry
      // their offset: skip what the snapshot already had, stitch the rest.
      if (L.synced && typeof f.off === "number") {
        if (f.off + f.text.length <= have.length) return;
        L[key] = have + (f.off <= have.length ? f.text.slice(have.length - f.off) : f.text);
      } else L[key] = have + f.text;
      L.touched = Date.now();
      schedulePaint(f.agentId, wasNear);
    }
    /**
     * Drop live lines the log will never close: an agent that died with the
     * daemon, or a turn whose end arrived while this view was elsewhere. Only
     * for plain threads — an orchestra worker runs as a copy of its roster
     * agent, so the roster's busy flag says nothing about it.
     */
    /**
     * Is this thread an orchestra's, and is its work going right now? The
     * run's own thread is going while the orchestrator plans or reviews; a
     * task thread while its task runs. null: not an orchestra thread at all.
     */
    function orchThreadGoing(p){
      var s = p && p.orchestra;
      if (!s) return null;
      if (s.chat === view.chatId) return /^(starting|planning|reviewing|running)$/.test(String(s.status || ""));
      var t = (s.threads || []).filter(function(x){ return x && x.chat === view.chatId; })[0];
      return t ? t.status === "running" : null;
    }
    function reconcileLive(p){
      var now = Date.now(), agents = (p && p.agents) || [];
      var og = orchThreadGoing(p), orchThread = og !== null;
      // Turns the replay left open become live lines only if they really are
      // still going: the agent says it's busy, or this thread's run is live.
      Object.keys(openTurns).forEach(function(id){
        var a = agents.filter(function(x){ return x.id === id; })[0];
        var going = orchThread ? og : !!(a && a.busy);
        if (going && !live[id]) {
          var L = liveFor(id);
          if (L) { L.since = openTurns[id].since; L.act = openTurns[id].act.slice(0, 80); paintLive(id); }
        }
        delete openTurns[id];
      });
      Object.keys(live).forEach(function(id){
        var L = live[id], a = agents.filter(function(x){ return x.id === id; })[0];
        if (orchThread ? (og === false && now - L.touched > 6000) : (a && !a.busy && now - L.touched > 6000)) endLive(id);
        else if (now - L.touched > 20 * 60 * 1000) endLive(id);
      });
    }
    state.timers.push(setInterval(function(){
      Object.keys(live).forEach(paintLiveState);
      Array.prototype.forEach.call(document.querySelectorAll("#feed .errcd[data-until]"), function(n){ n.textContent = untilText(Number(n.getAttribute("data-until"))); });
      Array.prototype.forEach.call(document.querySelectorAll("[data-oel]"), function(n){ n.textContent = durfmt(Math.max(0, Date.now() - Number(n.getAttribute("data-oel")))); });
      // "just now" → "3m ago" → the clock: once every ~30s is plenty
      if (Date.now() - (state.relTick || 0) > 30000) {
        state.relTick = Date.now();
        Array.prototype.forEach.call(document.querySelectorAll("#feed .wt[data-rel]"), function(n){
          var t = Number(n.getAttribute("data-rel")); if (!t) return;
          var v = relClock(t); if (n.textContent !== v) n.textContent = v;
          if (Date.now() - t > 3600000) n.removeAttribute("data-rel"); // settled: it's a clock now
        });
      }
    }, 1000));

    // ---- empty thread ---------------------------------------------------------
    var SUGGEST = [
      ["Explain this codebase", "Give me a tour of this codebase: what it does, how it\u2019s organised, and where the important parts live."],
      ["Find a bug", "Look through the code for a real bug, explain it, and fix it with a test."],
      ["Write tests", "Find the least-tested important code and write good tests for it."],
      ["Review my changes", "Review the uncommitted changes in this project and tell me what you\u2019d change."],
    ];
    function drawEmpty(){
      var feed = document.getElementById("feed"); if (!feed) return;
      var has = feed.querySelector(".msg,.sys,.tool,.acts,.turncard,.nicard,.apcard,.handoff,.turnend,.orchbrief,.plancard");
      var hero = document.getElementById("threadempty");
      if (has || (feed.firstChild && feed.firstChild.className === "loader") || Object.keys(live).length) { if (hero) hero.remove(); return; }
      if (hero) return;
      var p = state.project || {};
      var who = state.selected || p.holder || "";
      feed.insertAdjacentHTML("beforeend",
        '<div class="threadempty" id="threadempty"><div class="teav">' + (who ? avatarFor(who) : '<span class="av">' + ICONS.chat + "</span>") + "</div>" +
        '<div class="tet">What should we work on?</div>' +
        '<div class="tes">' + (who ? esc(labelOf(who)) + " is ready in " : "Ready in ") + "<b>" + esc(p.name || "this project") + "</b>. Every agent here shares one memory.</div>" +
        '<div class="tesug">' + SUGGEST.map(function(s, i){ return '<button type="button" class="tesb" data-sug="' + i + '">' + esc(s[0]) + "</button>"; }).join("") + "</div></div>");
      Array.prototype.forEach.call(feed.querySelectorAll("[data-sug]"), function(b){
        b.onclick = function(){
          var box = document.getElementById("box"); if (!box) return;
          box.value = SUGGEST[Number(b.getAttribute("data-sug"))][1];
          view.autosizeBox(); box.focus();
        };
      });
    }

    // ---- streamed text: shown while the reply is written, never stored -------
    function clearStreaming(feed, agentId){
      Array.prototype.forEach.call(feed.querySelectorAll(".msg.streaming, .tool.running"), function(row){
        if (row.getAttribute("data-agent") === agentId) row.parentNode.removeChild(row);
      });
    }

    // A provider agent's text reaches the thread as "stream" frames (the same
    // live reply every agent gets — see onStreamFrame), so a delta frame's
    // text is not drawn a second time. Kept for clients that only see deltas.
    function onDelta(frame){
      // a running command's output, live, under its row (the last few KB; the finished row keeps its tail)
      if (frame.streamKind === "command_output" && frame.itemId && view.historyLoaded && (frame.chat || "main") === view.chatId) {
        var fd = document.getElementById("feed"), run = null;
        if (fd) Array.prototype.forEach.call(fd.querySelectorAll(".tool.running"), function(r){ if (r.getAttribute("data-item") === frame.itemId) run = r; });
        if (run) {
          var pre = run.querySelector(".runout");
          if (!pre) { pre = document.createElement("pre"); pre.className = "runout"; run.appendChild(pre); }
          pre.textContent = (pre.textContent + String(frame.delta || "")).slice(-4000);
          pre.scrollTop = pre.scrollHeight;
        }
        return;
      }
      if (frame.streamKind !== "assistant_text" || !frame.agentId || !view.historyLoaded) return;
      if (typeof onStreamFrame === "function") return;
      if ((frame.chat || "main") !== view.chatId) return;
      var feed = document.getElementById("feed"); if (!feed) return;
      var key = String(frame.itemId || frame.turnId || "");
      var row = null;
      Array.prototype.forEach.call(feed.querySelectorAll(".msg.streaming"), function(r){
        if (r.getAttribute("data-agent") === frame.agentId && r.getAttribute("data-item") === key) row = r;
      });
      if (!row) {
        feed.insertAdjacentHTML("beforeend", '<div class="msg agent streaming" data-agent="' + esc(frame.agentId) + '" data-item="' + esc(key) +
          '"><div class="who" style="color:hsl(' + hue(frame.agentId) + ',60%,var(--agent-l))">' + esc(frame.agentId) +
          '</div><div class="bubble" style="white-space:pre-wrap;border-left-color:hsl(' + hue(frame.agentId) + ',50%,var(--selvage-l))"></div></div>');
        row = feed.lastElementChild;
      }
      var bubble = row.querySelector(".bubble");
      bubble.textContent += String(frame.delta || "");
      var sc = feed.parentNode;
      if (sc && sc.scrollHeight) sc.scrollTop = sc.scrollHeight;
    }

    // A tool while it runs: a row that goes when the tool finishes (the finished
    // tool arrives as its own tool_call line).
    function onItem(frame){
      if (!frame.agentId || !frame.itemId || !view.historyLoaded) return;
      if ((frame.chat || "main") !== view.chatId) return;
      var feed = document.getElementById("feed"); if (!feed) return;
      var row = null;
      Array.prototype.forEach.call(feed.querySelectorAll(".tool.running"), function(r){
        if (r.getAttribute("data-item") === frame.itemId) row = r;
      });
      if (frame.phase === "completed") { if (row) row.parentNode.removeChild(row); return; }
      var label = frame.itemType === "command_execution" ? "$ " + (frame.detail || "command") : (frame.detail || frame.title || frame.itemType);
      if (!row) {
        feed.insertAdjacentHTML("beforeend", '<div class="tool running" data-agent="' + esc(frame.agentId) + '" data-item="' + esc(frame.itemId) +
          '" style="opacity:.75">\u25cc <span class="rtl"></span></div>');
        row = feed.lastElementChild;
      }
      row.querySelector(".rtl").textContent = String(label).slice(0, 200);
      var sc = feed.parentNode;
      if (sc && sc.scrollHeight) sc.scrollTop = sc.scrollHeight;
    }

    var pendingStream = [];
    function flushPending(snap){
      view.historyLoaded = true;
      if (view.pendingWs.length) { append(view.pendingWs); view.pendingWs = []; }
      // A reply already being typed when this thread opened (a reload
      // mid-answer): show what it has said so far, then the pieces that came
      // in while the history loaded, deduped by offset.
      (snap || []).forEach(function(x){
        if (!x || !x.agentId || (x.chat || "main") !== view.chatId) return;
        var L = liveFor(x.agentId); if (!L) return;
        L.text = String(x.text || ""); L.think = String(x.think || ""); L.synced = true;
        L.touched = Date.now(); paintLive(x.agentId);
      });
      var q = pendingStream; pendingStream = [];
      q.forEach(onStreamFrame);
    }
    var PAGE = 80;
    function drawEarlier(more){
      var feed = document.getElementById("feed"); if (!feed) return;
      var old = document.getElementById("loadearlier"); if (old) old.remove();
      if (!more) return;
      feed.insertAdjacentHTML("afterbegin", '<button type="button" class="loadearlier" id="loadearlier">Load earlier messages</button>');
      document.getElementById("loadearlier").onclick = loadEarlier;
    }
    /** Page the thread backwards, keeping what you were looking at in place. */
    function loadEarlier(){
      var feed = document.getElementById("feed"), btn = document.getElementById("loadearlier");
      if (!feed || !state.firstId) return Promise.resolve();
      if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
      return api("/api/projects/" + view.pid + "/events?limit=" + PAGE + "&before=" + state.firstId + "&chat=" + encodeURIComponent(view.chatId))
        .then(function(j){
          var evs = j.events || [], sc = threadScroller();
          var fromBottom = sc ? sc.scrollHeight - sc.scrollTop : 0;
          var anchor = btn ? btn.nextElementSibling : feed.firstElementChild;
          var hero = document.getElementById("threadempty"); if (hero) hero.remove();
          evs.forEach(function(e){
            if (!state.firstId || e.id < state.firstId) state.firstId = e.id;
            var html = lineFor(e);
            if (html) placeLine(feed, html, anchor);
          });
          drawEarlier(evs.length >= PAGE);
          view.markDays();
          if (sc) sc.scrollTop = sc.scrollHeight - fromBottom;
        })
        .catch(function(err){ toast(err.message); if (btn) { btn.disabled = false; btn.textContent = "Load earlier messages"; } });
    }

    // Reading the thread again from scratch. Changing the transcript level
    // changes what every past line renders as, so there is nothing to patch —
    // the whole feed is re-read rather than re-styled.
    function loadHistory(){
      var feed = document.getElementById("feed");
      if (feed) feed.innerHTML = '<div class="loader"></div>';
      state.lastId = 0; state.firstId = 0;
      clearLive();
      openTurns = {};
      view.historyLoaded = false; pendingStream = [];
      view.syncStars();
      if (state.loadGitStat && (!state.gitStat || state.gitStat.pid !== view.pid)) setTimeout(function(){ if (!pageGone() && state.loadGitStat) state.loadGitStat(); }, 300);
      return api("/api/projects/" + view.pid + "/events?limit=" + PAGE + "&chat=" + encodeURIComponent(view.chatId))
        .then(function(j){
          var evs = j.events || [];
          forceScroll = true;
          append(evs);
          if (!evs.length) { var f = document.getElementById("feed"); if (f && f.firstChild && f.firstChild.className === "loader") f.innerHTML = ""; drawEmpty(); }
          drawEarlier(evs.length >= PAGE);
          flushPending(j.live);
          view.markDays(); markSeen();
          var go = state.pendingGo;
          if (go && go.pid === view.pid && go.chat === view.chatId) { state.pendingGo = null; setTimeout(function(){ if (!pageGone()) view.jumpToMessage(go.id); }, 60); }
          if (state.project) reconcileLive(state.project);
          toBottom();
        })
        .catch(function(err){ toast(err.message); flushPending(); });
    }


    function connect(){
      var proto = location.protocol === "https:" ? "wss://" : "ws://";
      // Carry the bearer token in the subprotocol, not the URL — a query token
      // lands in browser history and proxy logs; a header does not.
      var ws = new WebSocket(proto + location.host + "/ws?project=" + encodeURIComponent(view.pid), ["loom.bearer." + state.token]);
      state.ws = ws;
      ws.onopen = function(){
        state.wsLive = true; drawStatusbar();
        // (re)read what's waiting: anything filed while the socket was down
        // arrived as events nobody heard
        view.loadApprovals();
        // Open shells only once the socket is truly listening, or the pty's
        // first output (its prompt) is broadcast into the void. Runs once —
        // a reconnect must not spawn another set of terminals.
        var start = state.startTerminals;
        if (start) { state.startTerminals = null; start(); }
      };
      ws.onmessage = function(ev){
        try {
          var frame = JSON.parse(ev.data);
          // The daemon says hello once this socket is subscribed. Anything the
          // queue did before then went out as a frame this page never got, so
          // read it again now (a reconnect lands here too).
          if (frame.type === "hello") { checkBuild(); view.loadQueue(); return; }
          if (frame.type === "term") { view.onTermFrame(frame); return; }
          if (frame.type === "spec" || frame.type === "spec_done") { onSpecFrame(frame); return; }
          // A log record belongs to no chat — a daemon fault has no
          // conversation, and it's the one you most need to see.
          if (frame.type === "log" && frame.record) { addLogRecord(frame.record); return; }
          // Loom Teams: a teammate's presence or a feed event. Daemon-level, so
          // it arrives on whichever project socket is open; re-read the view.
          if (frame.type === "team") { onTeamFrame(frame); return; }
          // the prompt queue changed — sent, edited, reordered, paused
          if (frame.type === "queue") { view.onQueueFrame(frame); return; }
          // a reply as it's being written (not logged; the message follows)
          if (frame.type === "stream") { if (view.historyLoaded) onStreamFrame(frame); else if (pendingStream.length < 2000) pendingStream.push(frame); return; }
          // a dev server started, stopped, crashed, or printed a line
          if (frame.type === "server") { onServerFrame(frame); return; }
          // a reply being written, a few words at a time
          if (frame.type === "delta") { onDelta(frame); return; }
          // a tool starting, or finishing, while the turn runs
          if (frame.type === "item") { onItem(frame); return; }
          // an agent changed files while a preview is open: show the new page
          if (frame.type === "event" && frame.event && frame.event.kind === "turn_diff") { maybeReloadPreview(); if (state.loadGitStat) state.loadGitStat(); }
          if (frame.type === "event" && frame.event) {
            // "an agent needs you" is the whole reason Loom exists, so it must
            // reach you even when this isn't the chat you're looking at, or the
            // tab is in the background: announce it, flash the title, and (if
            // permitted) raise an OS notification. Deliberately above the
            // per-chat filter below, which would otherwise swallow it.
            if (frame.event.kind === "needs_input") notifyNeedsInput(frame.event);
            if (frame.event.kind === "run_complete") notifyDone(frame.event, state.project && state.project.name);
            // An orchestra spans many chats — its run's and one per task — so
            // the view listens above the per-chat filter too.
            view.onOrchEvent(frame.event);
            // A crew spans its channel and one thread per teammate, likewise.
            view.onCrewEvent(frame.event);
            // Approvals are per project, not per chat: the badge counts them
            // all, and a request from another thread still reaches you.
            view.onApprovalEvent(frame.event);
            view.onFleetEvent(frame.event);
            // one socket carries the whole project; this thread is one chat.
            // An event with no chat predates chats and belongs to main.
            if ((frame.event.chat || "main") !== view.chatId) return;
            if (view.historyLoaded) append([frame.event]);
            else view.pendingWs.push(frame.event);
            if (view.historyLoaded && frame.event.kind === "orchestra" && frame.event.payload && frame.event.payload.phase === "completed") {
              var dn = document.querySelectorAll("#feed .odone"); if (dn.length) dn[dn.length - 1].classList.add("celebrate");
            }
          }
        } catch (e) {
          // a frame that throws while drawing is a bug to see, not to swallow
          try { clog("error", "thread", "couldn't draw a live update: " + ((e && e.message) || e), (e && e.stack) || ""); } catch (e2) {}
        }
      };
      ws.onclose = function(){
        state.wsLive = false; drawStatusbar();
        if (state.pid === view.pid) state.timers.push(setTimeout(connect, 3000));
      };
    }
return { drawStatus, refresh, loadHistory, connect, drawEmpty, threadScroller, wantScroll, stickOrFlag, toBottom, liveFor, nearBottom, loadEarlier };
}
