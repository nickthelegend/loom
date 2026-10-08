import { agentGlyph,agentLabel,agentSub,kindOf,labelOf } from '../agents.js';
import { api } from '../connection.js';
import { clog } from '../console.js';
import { esc,money,pageGone,rel } from '../format.js';
import { ICONS,LOADER } from '../icons.js';
import { askConfirm,askText,fitMenu,toast } from '../notifications.js';
import { modelBadge,permBadge,permOf } from '../permissions.js';
import { state } from '../state.js';
import { fleetSince,jobProgressText,loadTeam,onlineRunners,runnerAct,runnerName,teamGlobs,teamGoalOf,teamRunners } from '../team.js';
import { durfmt,emptyArt,LAND_ST,landPill,ORCH_RUN_ST,ORCH_TASK_ST,plainPreview } from '../transcript.js';

/** orchestra behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createOrchestra(view) {


    // ---- Orchestra: one orchestrator plans, many workers run in parallel -----
    // The run lives on the daemon (core/orchestra.ts); this view is a reading of
    // GET /orchestra, refetched whenever an orchestra event crosses the socket.
    // The composer's Orchestrate mode starts a run; the view steers it.
    function orchRoster(){
      var p = state.project || {};
      return (p.agents || []).filter(function(a){ return a.tier === "adapter" && a.enabled !== false; });
    }
    // The cast is remembered per project: a reload used to reset it to "every
    // agent", and the next Orchestrate quietly ran agents you'd left out.
    var ORCH_KEY = "loomOrch:" + view.pid;
    function saveOrchCfg(c){
      try { localStorage.setItem(ORCH_KEY, JSON.stringify({ orchestrator: c.orchestrator, off: c.off, parallel: c.parallel, race: !!c.race })); } catch (e) {}
    }

    function orchCfg(){
      var roster = orchRoster();
      if (!state.orchCfg || state.orchCfg.pid !== view.pid) {
        var saved = null;
        try { saved = JSON.parse(localStorage.getItem(ORCH_KEY) || "null"); } catch (e) { saved = null; }
        state.orchCfg = { pid: view.pid, orchestrator: (saved && saved.orchestrator) || null, off: (saved && saved.off) || {},
          parallel: Math.max(1, Math.min(12, Number(saved && saved.parallel) || 4)), race: !!(saved && saved.race) };
      }
      var c = state.orchCfg;
      var ids = roster.map(function(a){ return a.id; });
      // Claude Code conducts by default when it's here; otherwise whoever's first.
      if (!c.orchestrator || ids.indexOf(c.orchestrator) < 0) {
        var cc = roster.filter(function(a){ return a.kind === "claude-code"; })[0] || roster[0];
        c.orchestrator = cc ? cc.id : null;
      }
      return c;
    }

    // "moved" (Phase 5, D75): the goal carries on on another machine; this copy is read-only
    function orchTerminal(st){ return st === "completed" || st === "failed" || st === "aborted" || st === "moved"; }

    function findOrchRun(id){ return (view.orch.runs || []).filter(function(r){ return r.id === id; })[0] || null; }

    /** The run whose orchestrator thread this chat is, if it is one. */
    /**
     * The run this thread answers for, if any. A thread the run opened is the
     * run's for good — replying there always steers it, even after it
     * finishes. A thread the run borrowed (you orchestrated from Main) is only
     * its while it is live; when it ends, Main goes back to being Main rather
     * than forwarding every message you ever send to a finished run (#100).
     */
    function owns(r){ return r && r.chat === view.chatId && (!r.inPlace || !orchTerminal(r.status)); }

    function orchRunForChat(){
      var hit = (view.orch.runs || []).filter(owns)[0];
      if (hit) return hit;
      var s = state.project && state.project.orchestra;
      return owns(s) ? { id: s.id, status: s.status, chat: s.chat, inPlace: s.inPlace } : null;
    }

    function mergeOrchRun(run){
      if (!run || !run.id) return;
      var list = view.orch.runs || (view.orch.runs = []);
      var i = list.map(function(r){ return r.id; }).indexOf(run.id);
      if (i >= 0) list[i] = run; else list.unshift(run);
      drawOrch();
    }


    function setComposerMode(mode){
      state.cmode = mode === "orch" ? "orch" : "chat";
      var orchMode = state.cmode === "orch";
      Array.prototype.forEach.call(document.querySelectorAll("#cmode [data-cmode]"), function(b){
        var on = b.getAttribute("data-cmode") === state.cmode;
        b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false");
      });
      var co = document.getElementById("corch"); if (co) co.style.display = orchMode ? "" : "none";
      var os = document.getElementById("orchsend"); if (os) os.style.display = orchMode ? "" : "none";
      var box = document.getElementById("box");
      if (box) box.placeholder = view.composerPlaceholder();
      if (view.menuState && (view.menuState.kind === "agentmenu" || view.menuState.kind === "orchmenu" || view.menuState.kind === "permmenu")) view.closeMenu();
      drawOrchControls();
      view.updateModelLabel();
      view.drawStatus(); // send/stop and the hint follow the mode
    }


    function drawOrchControls(){
      var el = document.getElementById("corch"); if (!el || state.cmode !== "orch") return;
      var roster = orchRoster(), c = orchCfg();
      saveOrchCfg(c); // every change to the cast ends in a redraw, so this keeps it
      if (!roster.length) {
        el.innerHTML = '<span class="colbl">No adapters in this project \u2014 add an agent to orchestrate</span>';
        return;
      }
      var lead = roster.filter(function(a){ return a.id === c.orchestrator; })[0] || roster[0];
      var modeSeg = '<span class="corace" role="group" aria-label="how to run the goal">' +
        '<button type="button" data-omode="plan" class="' + (c.race ? "" : "on") + '" title="one agent plans the goal and the team works it">Plan &amp; split</button>' +
        '<button type="button" data-omode="race" class="' + (c.race ? "on" : "") + '" title="every checked agent gets the same prompt in its own worktree — you compare and pick one">' + ICONS.play + "Race</button></span>";
      if (c.race) {
        el.innerHTML = modeSeg +
          '<span class="colbl" title="each gets the same prompt, in its own worktree">Racers</span>' +
          '<span class="cowk" id="cowk">' + roster.map(function(a){
            var on = !c.off[a.id];
            return '<button type="button" class="cowchip' + (on ? " on" : "") + '" data-wk="' + esc(a.id) + '" aria-pressed="' + on + '"><span class="cwon">' + (on ? ICONS.check : "") + "</span>" +
              agentGlyph(a.kind, a.id) + '<span class="cwn">' + esc(agentLabel(a.kind, a.id)) + '</span><span class="cwset">' + modelBadge(a) + permBadge(permOf(a), a.id) + "</span></button>";
          }).join("") + "</span>";
        Array.prototype.forEach.call(el.querySelectorAll("[data-wk]"), function(b){
          b.onclick = function(){ var id = b.getAttribute("data-wk"); c.off[id] = !c.off[id]; drawOrchControls(); };
        });
        Array.prototype.forEach.call(el.querySelectorAll("[data-omode]"), function(b){
          b.onclick = function(){ c.race = b.getAttribute("data-omode") === "race"; drawOrchControls(); };
        });
        wirePermBadges(el); wireModelBadges(el);
        var osb = document.getElementById("orchsend"); if (osb) osb.title = "start the race";
        return;
      }
      el.innerHTML = modeSeg +
        '<span class="colbl" title="plans the goal, splits it into tasks, reviews the results">Lead</span>' +
        '<button class="cagent" id="corchpick" type="button" title="who plans the goal and reviews the results">' +
          agentGlyph(lead.kind, lead.id) + '<span class="can">' + esc(agentLabel(lead.kind, lead.id)) + "</span>" +
          permBadge(permOf(lead), lead.id) + modelBadge(lead) +
          '<span class="cchev">' + ICONS.chevron + "</span></button>" +
        '<span class="colbl" title="who can be given tasks \u2014 click to include or leave out">Team</span>' +
        '<span class="cowk" id="cowk">' + roster.map(function(a){
          var on = !c.off[a.id];
          return '<button type="button" class="cowchip' + (on ? " on" : "") + '" data-wk="' + esc(a.id) + '" aria-pressed="' + on + '" title="' +
            esc((on ? "included \u2014 click to leave out" : "left out \u2014 click to include") + " \u00b7 " + a.id) + '"><span class="cwon">' + (on ? ICONS.check : "") + "</span>" +
            agentGlyph(a.kind, a.id) + '<span class="cwn">' + esc(agentLabel(a.kind, a.id)) + "</span>" +
            // each worker's model and mode, in their own zone of the chip
            '<span class="cwset">' + modelBadge(a) + permBadge(permOf(a), a.id) + "</span></button>";
        }).join("") +
          // A roster of CLIs is whatever you happen to have installed. An API
          // model is a name off a list, so it can be added here, in the row
          // where you are already deciding who runs the goal.
          '<button type="button" class="cowchip cowadd" id="cowadd" title="add an API model as a worker">' +
            ICONS.plus + "model</button>" + "</span>" +
        '<span class="colbl" title="how many tasks run at the same time">At once</span>' +
        '<span class="cstep" title="how many tasks run at once"><button type="button" data-step="-1" aria-label="fewer in parallel"' + (c.parallel <= 1 ? " disabled" : "") + ">\u2212</button>" +
          '<span class="cpar" id="cpar">' + c.parallel + "</span>" +
          '<button type="button" data-step="1" aria-label="more in parallel"' + (c.parallel >= 12 ? " disabled" : "") + ">+</button></span>" +
        runOnHtml(c);
      var pick = document.getElementById("corchpick");
      if (pick) pick.onclick = function(){
        if (view.menuState && view.menuState.kind === "orchmenu") { view.closeMenu(); return; }
        openOrchestratorMenu();
      };
      Array.prototype.forEach.call(el.querySelectorAll("[data-wk]"), function(b){
        b.onclick = function(){
          var id = b.getAttribute("data-wk");
          c.off[id] = !c.off[id];
          drawOrchControls();
        };
      });
      var add = document.getElementById("cowadd");
      if (add) add.onclick = function(){ addModelWorker(add); };
      Array.prototype.forEach.call(el.querySelectorAll("[data-runon]"), function(b){
        b.onclick = function(){ c.runOn = b.getAttribute("data-runon"); drawOrchControls(); };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-step]"), function(b){
        b.onclick = function(){
          c.parallel = Math.max(1, Math.min(12, c.parallel + Number(b.getAttribute("data-step"))));
          drawOrchControls();
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-omode]"), function(b){
        b.onclick = function(){ c.race = b.getAttribute("data-omode") === "race"; drawOrchControls(); };
      });
      wirePermBadges(el);
      wireModelBadges(el);
    }

    /**
     * A model agent joins the cast with no model chosen, which is the one
     * state it cannot run in — so adding one opens its model picker
     * immediately rather than leaving a chip that fails on send.
     */
    function addModelWorker(btn){
      btn.disabled = true;
      api("/api/projects/" + view.pid + "/agents", { method: "POST", body: JSON.stringify({ kind: "model" }) })
        .then(function(a){
          return view.refresh().then(function(){ return a; });
        })
        .then(function(a){
          drawOrchControls();
          if (a && a.id) view.openModelMenu(a.id);
        })
        .catch(function(e){ toast(e.message); })
        .then(function(){ var b = document.getElementById("cowadd"); if (b) b.disabled = false; });
    }

    /**
     * Phase 5 (D69, D73): where the goal runs — this machine, or one of the
     * project's online runners (mine, or a teammate's shared one). Only shown
     * when there's a runner to pick; a runner that went away falls back here.
     */
    function runOnHtml(c){
      var rs = onlineRunners(view.pid, false);
      if (c.runOn && !rs.some(function(r){ return r.deviceId === c.runOn; })) c.runOn = "";
      if (!rs.length) return "";
      return '<span class="colbl">Run on</span><span class="cowk" id="crunon">' + [{ deviceId: "", label: "This machine", mine: true }].concat(rs).map(function(r){
        var on = (c.runOn || "") === r.deviceId;
        return '<button type="button" class="cowchip' + (on ? " on" : "") + '" data-runon="' + esc(r.deviceId) + '" aria-pressed="' + on + '"' +
          (r.deviceId ? ' title="' + esc((r.mine ? "your runner" : (r.github || "a teammate") + "’s shared runner") + " · " + (r.kinds || []).join(", ")) + '"' : "") + ">" +
          esc(r.deviceId ? runnerName(r) : r.label) + (r.deviceId && !r.mine ? " · " + esc(r.github || "") : "") + "</button>";
      }).join("") + "</span>";
    }

    /** Likewise for the model chip: it picks that agent's model, not the chip's action. */
    function wireModelBadges(el){
      Array.prototype.forEach.call(el.querySelectorAll("[data-modelof]"), function(b){
        b.onmousedown = function(ev){ ev.stopPropagation(); };
        b.onclick = function(ev){
          ev.stopPropagation(); ev.preventDefault();
          var id = b.getAttribute("data-modelof");
          if (view.menuState && view.menuState.kind === "modelmenu" && view.menuState.agent === id) { view.closeMenu(); return; }
          view.openModelMenu(id);
        };
      });
    }

    /** A mode badge inside a chip opens that agent's permissions, not the chip's own action. */
    function wirePermBadges(el){
      Array.prototype.forEach.call(el.querySelectorAll("[data-permof]"), function(b){
        b.onmousedown = function(ev){ ev.stopPropagation(); };
        b.onclick = function(ev){
          ev.stopPropagation(); ev.preventDefault();
          var id = b.getAttribute("data-permof");
          if (view.menuState && view.menuState.kind === "permmenu" && view.menuState.agent === id) { view.closeMenu(); return; }
          view.openPermMenu(id);
        };
      });
    }


    function openOrchestratorMenu(){
      var roster = orchRoster(), c = orchCfg();
      var m = document.getElementById("cmenu"); if (!m || !roster.length) return;
      view.menuState = { kind: "orchmenu", at: 0, sel: 0, items: [] };
      m.style.display = "block"; fitMenu(m); m.className = "cmenu";
      m.innerHTML = '<div class="cmhead">who orchestrates</div>' + roster.map(function(a, i){
        var lbl = agentLabel(a.kind, a.id);
        var sub = agentSub(a, lbl);
        return '<div class="cmi" data-oi="' + i + '"><span class="ic">' + agentGlyph(a.kind, a.id) + "</span><span>" + esc(lbl) + "</span>" +
          permBadge(permOf(a), a.id) +
          (a.busy ? '<span class="cmbusy">working</span>' : "") +
          (a.id === c.orchestrator ? '<span class="tick"' + (a.busy ? ' style="margin-left:6px"' : "") + ">" + ICONS.info + "</span>"
            : (sub && !a.busy ? '<span class="sub">' + esc(sub) + "</span>" : "")) + "</div>";
      }).join("");
      Array.prototype.forEach.call(m.querySelectorAll("[data-oi]"), function(row){
        row.onmousedown = function(ev){
          ev.preventDefault();
          var a = roster[Number(row.getAttribute("data-oi"))];
          view.closeMenu();
          if (!a) return;
          c.orchestrator = a.id;
          drawOrchControls();
        };
      });
      wirePermBadges(m);
      setTimeout(function(){ document.addEventListener("mousedown", view.menuAway); }, 0);
    }


    function sendOrchestra(){
      var box = document.getElementById("box"); if (!box) return;
      var text = (box.value || "").trim();
      if (!text && !view.attach.length) { box.focus(); toast("describe the goal first"); return; }
      if (view.attach.some(function(a){ return a.uploading; })) { toast("still uploading\u2026"); return; }
      var refs = view.attach.map(function(a){ return (a.kind === "image" ? "[image] " : "[file] ") + a.path; });
      var goal = refs.length ? refs.join("\n") + (text ? "\n\n" + text : "") : text;
      var roster = orchRoster(), c = orchCfg();
      if (!roster.length) { toast("no adapters in this project to orchestrate"); return; }
      var cast = roster.filter(function(a){ return !c.off[a.id]; });
      var workers = cast.map(function(a){ return a.id; });
      if (!workers.length) { toast("pick at least one worker"); return; }
      if (c.race && workers.length < 2) { toast("a race needs at least two agents — check another"); return; }
      // A model agent with no model is a name for nothing. Catch it here, where
      // the chip that fixes it is on screen, rather than three tasks into a run.
      var lead = roster.filter(function(a){ return a.id === c.orchestrator; })[0];
      var blank = cast.concat(lead ? [lead] : []).filter(function(a){ return a.kind === "model" && !a.model; });
      if (blank.length) {
        toast(blank[0].id + " has no model yet — click its chip and pick one");
        view.openModelMenu(blank[0].id);
        return;
      }
      var btn = document.getElementById("orchsend");
      // One goal runs at a time: a second one waits in the queue and starts
      // itself when the first finishes (edit or reorder it while it waits).
      if (view.wouldQueue() && !c.runOn) {
        view.queueFromComposer(goal, view.planState).then(function(){
          box.value = ""; view.autosizeBox(); view.attach = []; view.drawAttach();
        }).catch(function(err){ toast(err.message); });
        return;
      }
      if (btn) btn.disabled = true;
      // Run on a runner (D69): the hub queues a start job; the runner clones and runs it there.
      var target = c.runOn && onlineRunners(view.pid, false).filter(function(r){ return r.deviceId === c.runOn; })[0];
      if (target) {
        runnerAct(view.pid, "start", { goal: goal, orchestrator: c.orchestrator || undefined, workers: workers, plan: view.planState || undefined, runner: target.deviceId }).then(function(res){
          box.value = ""; view.autosizeBox(); view.attach = []; view.drawAttach();
          if (btn) btn.disabled = false;
          toast("started on " + runnerName(target) + " — job " + ((res && res.jobId) || "queued"));
        }).catch(function(err){ if (btn) btn.disabled = false; toast(err.message); });
        return;
      }
      api("/api/projects/" + view.pid + "/orchestra", { method: "POST", body: JSON.stringify({
        goal: goal, orchestrator: c.orchestrator || undefined, workers: workers, maxParallel: c.parallel,
        plan: view.planState || undefined, race: c.race || undefined,
        // Orchestrate here, answer here. Without this the run opened a thread
        // of its own and walked you into it, leaving the goal you typed behind
        // in a thread that then said nothing at all (#100).
        chat: view.chatId,
      }) }).then(function(j){
        // Only now is the goal gone from the box: a refused run (no git repo,
        // one already running) leaves what you wrote where you wrote it.
        box.value = ""; view.autosizeBox(); view.attach = []; view.drawAttach();
        if (btn) btn.disabled = false;
        state.cmode = "chat"; // the orchestrator's own thread takes replies, not new runs
        openOrchRun(j.run);
      }).catch(function(err){
        if (btn) btn.disabled = false;
        toast(err.message);
        clog("error", "orchestra", "start failed: " + (err && err.message), err && err.stack);
      });
    }


    /**
     * A click inside an agent's question card (#106). Returns true when it
     * handled one, so the feed's other handlers stay out of the way.
     */
    function needsInputClick(ev){
      var card = ev.target.closest && ev.target.closest(".nicard");
      if (!card) return false;
      var pick = ev.target.closest("[data-nipick]");
      if (pick) { answerAgent(card, pick.getAttribute("data-nipick"), pick.getAttribute("data-niqid")); return true; }
      if (ev.target.closest(".nisend")) {
        var box = card.querySelector(".nitext");
        answerAgent(card, box ? box.value : "");
        return true;
      }
      // Clicking into the text box is not a click on whatever is behind it.
      return !!ev.target.closest(".nitext");
    }


    /**
     * Send an answer to the agent that asked for it.
     *
     * Deliberately not the composer's path: the composer aims at
     * state.selected, and in an orchestra thread that is the orchestrator — so
     * answering a worker's question through it sent the answer to the wrong
     * agent. The card carries who asked and in which thread; that is what is
     * used, whatever the composer happens to be pointed at.
     */
    function answerAgent(card, text, qid){
      if (!card) return;
      if (card.getAttribute("data-nireq")) return answerRequest(card, text, qid);
      var answer = String(text || "").trim();
      if (!answer) { var box = card.querySelector(".nitext"); if (box) box.focus(); return; }
      var who = card.getAttribute("data-niask") || undefined;
      var where = card.getAttribute("data-nichat") || view.chatId;
      var lock = function(on){
        Array.prototype.forEach.call(card.querySelectorAll("button,input"), function(el){ el.disabled = on; });
      };
      lock(true);
      api("/api/projects/" + view.pid + "/messages", {
        method: "POST",
        body: JSON.stringify({ text: answer, agentId: who, chat: where }),
      }).then(function(){
        var done = card.querySelector(".nidone");
        if (done) done.textContent = "↳ " + (who || "agent") + ": " + answer;
        card.classList.add("done");
        view.refresh();
      }).catch(function(err){ toast(err.message); lock(false); });
    }


    /**
     * Answer a structured question the agent's turn is waiting on. Each
     * question takes a pick or typed words; once every one has an answer they
     * go back to that request, and the turn carries on.
     */
    function answerRequest(card, text, qid){
      var blocks = Array.prototype.slice.call(card.querySelectorAll(".niqb"));
      var answer = String(text || "").trim();
      if (!answer) { var box = card.querySelector(".nitext"); if (box) box.focus(); return; }
      // Typed words answer the first question still open.
      var target = qid || (blocks.filter(function(b){ return !b.getAttribute("data-nians"); })[0] || blocks[0]).getAttribute("data-niqid");
      blocks.forEach(function(b){
        if (b.getAttribute("data-niqid") !== target) return;
        b.setAttribute("data-nians", answer);
        Array.prototype.forEach.call(b.querySelectorAll("[data-nipick]"), function(o){ o.classList.toggle("sel", o.getAttribute("data-nipick") === answer); });
      });
      var t = card.querySelector(".nitext"); if (t && !qid) t.value = "";
      if (blocks.some(function(b){ return !b.getAttribute("data-nians"); })) return;
      var answers = {};
      blocks.forEach(function(b){ answers[b.getAttribute("data-niqid")] = b.getAttribute("data-nians"); });
      var who = card.getAttribute("data-niask");
      var where = card.getAttribute("data-nichat") || view.chatId;
      Array.prototype.forEach.call(card.querySelectorAll("button,input"), function(el){ el.disabled = true; });
      api("/api/projects/" + view.pid + "/agents/" + encodeURIComponent(who) + "/answers", {
        method: "POST",
        body: JSON.stringify({ chat: where, requestId: card.getAttribute("data-nireq"), answers: answers }),
      }).then(function(){
        var done = card.querySelector(".nidone");
        if (done) done.textContent = "\u21b3 " + Object.keys(answers).map(function(k){ return answers[k]; }).join(" \u00b7 ");
        card.classList.add("done");
      }).catch(function(err){
        toast(err.message);
        Array.prototype.forEach.call(card.querySelectorAll("button,input"), function(el){ el.disabled = false; });
      });
    }


    /**
     * Rewind (#101): put the files back to a checkpoint.
     *
     * This throws work away, so it asks first — and the asking names the
     * checkpoint rather than saying "are you sure", because "are you sure"
     * tells you nothing you didn't already know. It says what stays too: this
     * is the working tree, not your commits and not the conversation.
     */
    function askRewind(id, btn){
      if (!id) return;
      var known = (state.checkpoints || []).filter(function(c){ return c.id === id; })[0];
      var what = known ? '\u201c' + known.label + '\u201d' : "that checkpoint";
      if (!window.confirm(
        "Put the files back to " + what + "?\n\n" +
        "Anything written since is removed, and anything removed since comes back. " +
        "Your commits, your history and files git ignores are untouched \u2014 and the rewind itself " +
        "is saved, so you can undo it."
      )) return;
      if (btn) btn.disabled = true;
      api("/api/projects/" + view.pid + "/checkpoints/" + encodeURIComponent(id) + "/rewind", { method: "POST" })
        .then(function(j){
          var n = (j && j.changed || []).length;
          toast("rewound \u00b7 " + n + " file" + (n === 1 ? "" : "s"));
          state.checkpoints = null;
          view.refreshTree(true);
          if (state.refreshExplorer) state.refreshExplorer();
        })
        .catch(function(err){ toast(err.message); })
        .then(function(){ if (btn) btn.disabled = false; });
    }


    /**
     * Every point the files can be put back to. Read when the menu opens
     * rather than on a timer — it is a list nobody looks at until the moment
     * they want it, and asking git for it costs a process.
     */
    function openRewindMenu(){
      var m = document.getElementById("cmenu"); if (!m) return;
      view.menuState = { kind: "rewindmenu", at: 0, sel: 0, items: [] };
      m.style.display = "block"; fitMenu(m); m.className = "cmenu";
      m.innerHTML = '<div class="cmhead">put the files back to\u2026</div><div class="cmlist" id="cmlist">' + LOADER + "</div>";
      setTimeout(function(){ document.addEventListener("mousedown", view.menuAway); }, 0);
      api("/api/projects/" + view.pid + "/checkpoints").then(function(j){
        var rows = (j && j.checkpoints) || [];
        state.checkpoints = rows;
        var list = document.getElementById("cmlist"); if (!list) return;
        if (!rows.length) {
          list.innerHTML = '<div class="cmmore">no checkpoints yet \u2014 one is taken before every turn, in a git repository</div>';
          return;
        }
        list.innerHTML = rows.slice(0, 40).map(function(c){
          return '<div class="cmi" data-rw="' + esc(c.id) + '"><span class="ic">' + ICONS.rewind + "</span><span>" +
            esc(String(c.label || c.id).slice(0, 70)) + '</span><span class="sub">' + esc(rel(c.at)) + "</span></div>";
        }).join("");
        Array.prototype.forEach.call(list.querySelectorAll("[data-rw]"), function(row){
          row.onmousedown = function(ev){ ev.preventDefault(); var id = row.getAttribute("data-rw"); view.closeMenu(); askRewind(id, null); };
        });
      }).catch(function(err){
        var list = document.getElementById("cmlist");
        if (list) list.innerHTML = '<div class="cmmore">' + esc(err.message) + "</div>";
      });
    }


    /** Show a run: its orchestrator thread behind, its Orchestra view in front. */
    function openOrchRun(run){
      if (!run) return;
      mergeOrchRun(run);
      view.orch.sel = run.id;
      if (view.desktop && state.setChat && run.chat && run.chat !== view.chatId) {
        state.pendingTab = "orchestra"; state.pendingOrchRun = run.id;
        state.setChat(view.pid, run.chat);
        return;
      }
      setComposerMode(state.cmode || "chat");
      // The run's thread is this one, so the thread is what to look at. Jumping
      // to the board would hide the summary in the place it was asked for.
      if (!view.desktop) openOrchSheet();
      else if (run.chat === view.chatId) view.showTab("thread");
      else view.showTab("orchestra");
    }

    function openOrchChat(chat){
      if (!chat) return;
      if (view.desktop && state.setChat) { if (chat === view.chatId) view.showTab("thread"); else state.setChat(view.pid, chat); return; }
      toast("open this thread from the desktop app");
    }


    function loadOrch(){
      return api("/api/projects/" + view.pid + "/orchestra").then(function(j){
        if (state.pid !== view.pid) return;
        view.orch.runs = j.runs || []; view.orch.active = j.active || null; view.orch.err = "";
        // Follow the live run unless you picked one yourself — a run started
        // from the CLI or a phone should take the view, not sit behind an old one.
        if (!view.orch.pinned || !findOrchRun(view.orch.sel)) view.orch.sel = view.orch.active || (view.orch.runs[0] && view.orch.runs[0].id) || null;
        drawOrch();
        view.drawStatus();
      }).catch(function(err){ view.orch.err = err.message; drawOrch(); });
    }

    /** Coalesce a burst of socket events (a plan spawns five tasks at once) into one fetch. */
    function scheduleOrch(){
      if (view.orch.t) return;
      view.orch.t = setTimeout(function(){ view.orch.t = null; if (state.pid === view.pid) loadOrch(); }, 150);
    }

    function onOrchEvent(ev){
      if (!ev) return;
      var p = ev.payload || {};
      // Phase 4: a PR's landing state repaints its card now; an alert is a toast.
      if (ev.kind === "orchestra" && p.phase === "landing" && p.landing) {
        var lr = findOrchRun(p.runId);
        if (lr) { lr.landing = p.landing; drawOrch(); }
      }
      if (ev.kind === "orchestra" && p.phase === "alert" && p.text) toast(String(p.text));
      if (ev.kind === "orchestra" || (p.orchestra && view.ORCH_TASK_KINDS[ev.kind])) scheduleOrch();
    }

    function drawOrchTabDot(sum){
      var d = document.getElementById("orchtdot"); if (!d) return;
      var live = sum && !orchTerminal(sum.status);
      d.style.display = live ? "" : "none";
      d.classList.toggle("warn", !!(sum && sum.status === "waiting_human"));
    }


    function orchEl(){
      if (pageGone()) return null;
      if (view.desktop) return state.tab === "orchestra" ? document.getElementById("pane-orchestra") : null;
      return document.getElementById("orchsheet");
    }

    function openOrchSheet(){
      var el = document.getElementById("routesheet"); if (!el) return;
      el.innerHTML = '<div class="sheet"><div id="orchsheet"></div></div>';
      var sc = document.getElementById("pane-thread"); if (sc) sc.scrollTop = 0;
      drawOrch(); loadOrch();
    }

    function closeOrchSheet(){ var el = document.getElementById("routesheet"); if (el) el.innerHTML = ""; }


    function orchPill(st){
      var s = ORCH_RUN_ST[st] || [st || "\u2014", "off"];
      return '<span class="opill ' + s[1] + '"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + "</span>";
    }

    function drawOrch(){
      var el = orchEl(); if (!el) return;
      var head = '<div class="ohead"><span class="ot">Orchestra</span>' +
        '<span class="os">One agent plans the goal; the rest work it in parallel, each in its own worktree.</span>' +
        '<span class="spacer"></span><button class="iconbtn" id="orefresh" title="refresh">' + ICONS.refresh + "</button></div>";
      if (view.orch.runs === null) { el.innerHTML = '<div class="orchview">' + head + (view.orch.err ? '<div class="onote err">' + esc(view.orch.err) + "</div>" : LOADER) + "</div>"; wireOrchHead(); return; }
      if (!view.orch.runs.length) {
        el.innerHTML = '<div class="orchview">' + head + '<div class="oempty">' + emptyArt("orch") + '<b>No orchestra runs yet.</b><br>' +
          "Switch the composer to <b>Orchestrate</b>, describe a goal, and pick who plans and who works.<br>" +
          '<button class="btn outline sm" id="ostart" style="margin-top:14px">' + ICONS.orchestra + "Start one</button></div></div>";
        wireOrchHead();
        var st = document.getElementById("ostart");
        if (st) st.onclick = function(){ if (view.desktop) view.showTab("thread"); else closeOrchSheet(); setComposerMode("orch"); var b = document.getElementById("box"); if (b) b.focus(); };
        return;
      }
      var run = findOrchRun(view.orch.sel) || view.orch.runs[0];
      // A wait names a teammate's goal, and its title is in the team view.
      if (!state.team && !state.teamErr && (run.tasks || []).some(function(t){ return (t.hold && t.hold.runId) || /^wait:/.test(t.overlap || ""); })) loadTeam();
      var list = '<div class="oruns"><div class="orunh">Runs</div>' + view.orch.runs.map(function(r){
        var s = ORCH_RUN_ST[r.status] || ["", "off"];
        var done = (r.tasks || []).filter(function(t){ return t.status === "done"; }).length;
        return '<div class="orun" data-run="' + esc(r.id) + '"' + (r.id === run.id ? ' data-current="true"' : "") + ">" +
          '<span class="org">' + esc(r.goal) + "</span>" +
          '<span class="orm"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + " \u00b7 " + done + "/" + (r.tasks || []).length +
          " \u00b7 " + rel(r.createdAt) + (r.landing ? " " + landPill(r.landing) : "") + "</span></div>";
      }).join("") + "</div>";
      el.innerHTML = '<div class="orchview">' + head + '<div class="ogrid">' + list +
        '<div class="odetail">' + orchDetail(run) + "</div></div></div>";
      wireOrchHead();
      wireOrchDetail(el, run);
    }
    /** A race's entrants side by side: how each did, what it changed, and the one to keep. */
    function raceBoard(run){
      var tasks = run.tasks || [], picked = run.applied && run.applied.task;
      var fastest = null;
      tasks.forEach(function(t){ if (t.status === "done" && t.startedAt && t.finishedAt && (!fastest || t.finishedAt - t.startedAt < fastest.finishedAt - fastest.startedAt)) fastest = t; });
      return '<div class="raceboard">' + tasks.map(function(t){
        var s = ORCH_TASK_ST[t.status] || [t.status, "off"];
        var dur = t.startedAt ? durfmt((t.finishedAt || Date.now()) - t.startedAt) : "—";
        var files = (t.files || []).length;
        return '<div class="racecard' + (picked === t.id ? " picked" : "") + '">' +
          '<div class="rch">' + agentGlyph(t.kind, t.agent) + '<b>' + esc(agentLabel(t.kind, t.agent)) + "</b>" +
            '<span class="opill ' + s[1] + '"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + "</span>" +
            (fastest && fastest.id === t.id && tasks.length > 1 ? '<span class="rfast" title="finished first">fastest</span>' : "") + "</div>" +
          '<div class="rcm"><span>' + esc(dur) + "</span><span>" + files + " file" + (files === 1 ? "" : "s") + "</span><span>" + Number(t.lines || 0) + " lines</span>" +
            (t.costUsd ? "<span>" + money(t.costUsd) + "</span>" : "") + "</div>" +
          (t.result ? '<div class="rcr">' + esc(plainPreview(t.result, 260)) + "</div>" : t.error ? '<div class="rcr err">' + esc(t.error.slice(0, 200)) + "</div>" : "") +
          '<div class="rca">' +
            (t.status === "done" ? '<button type="button" class="btn xs outline" data-racediff="' + esc(t.id) + '">' + ICONS.tree + "Diff</button>" : "") +
            '<button type="button" class="btn xs ghost" data-racechat="' + esc(t.chat) + '">' + ICONS.thread + "Thread</button>" +
            (picked === t.id ? '<span class="rpicked">' + ICONS.check + "applied to " + esc(run.applied.into) + "</span>"
              : !picked && t.status === "done" && orchTerminal(run.status) ? '<button type="button" class="btn xs primary" data-racepick="' + esc(t.id) + '">Pick this one</button>' : "") +
          "</div></div>";
      }).join("") + "</div>";
    }
    /**
     * The plan as a graph: each task a node, each dependsOn an arrow, left to
     * right in the order they can run. Colours are the task's live status.
     */
    function orchGraph(tasks){
      var byId = {}; tasks.forEach(function(t){ byId[t.id] = t; });
      var level = {}, seen = {};
      function lv(t){
        if (level[t.id] != null) return level[t.id];
        if (seen[t.id]) return 0; // a cycle the orchestrator shouldn't have made: flatten it
        seen[t.id] = true;
        var deps = (t.dependsOn || []).filter(function(d){ return byId[d]; });
        level[t.id] = deps.length ? 1 + Math.max.apply(null, deps.map(function(d){ return lv(byId[d]); })) : 0;
        return level[t.id];
      }
      tasks.forEach(lv);
      var cols = [];
      tasks.forEach(function(t){ (cols[level[t.id]] = cols[level[t.id]] || []).push(t); });
      var NW = 168, NH = 44, GX = 58, GY = 14, PAD = 10;
      var rows = Math.max.apply(null, cols.map(function(c){ return c.length; }));
      var W = PAD * 2 + cols.length * NW + (cols.length - 1) * GX, H = PAD * 2 + rows * NH + (rows - 1) * GY;
      var pos = {};
      cols.forEach(function(c, ci){
        var off = (H - (c.length * NH + (c.length - 1) * GY)) / 2;
        c.forEach(function(t, ri){ pos[t.id] = { x: PAD + ci * (NW + GX), y: off + ri * (NH + GY) }; });
      });
      var edges = "";
      tasks.forEach(function(t){
        (t.dependsOn || []).forEach(function(d){
          if (!pos[d]) return;
          var a = pos[d], b = pos[t.id], x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, mx = (x1 + x2) / 2;
          var done = byId[d].status === "done";
          edges += '<path class="oge' + (done ? " done" : "") + '" d="M' + x1 + " " + y1 + " C" + mx + " " + y1 + " " + mx + " " + y2 + " " + (x2 - 4) + " " + y2 + '" marker-end="url(#ogarrow)"/>';
        });
      });
      var nodes = tasks.map(function(t){
        var s = ORCH_TASK_ST[t.status] || [t.status, "off"], q = pos[t.id];
        var title = String(t.title || t.id);
        return '<g class="ogn ' + s[1] + '" data-otask="' + esc(t.id) + '" transform="translate(' + q.x + " " + q.y + ')"><title>' + esc(t.id + " · " + title + " · " + s[0]) + "</title>" +
          '<rect width="' + NW + '" height="' + NH + '" rx="10"/>' +
          '<circle cx="14" cy="15" r="4" class="ogd"/>' +
          '<text x="24" y="19" class="ogid">' + esc(t.id) + " · " + esc(labelOf(t.agent)) + "</text>" +
          '<text x="12" y="34" class="ogt">' + esc(title.length > 24 ? title.slice(0, 23) + "…" : title) + "</text></g>";
      }).join("");
      return '<details class="ograph" open><summary>Plan graph<span class="ogs">' + tasks.length + " tasks · " + cols.length + " stage" + (cols.length === 1 ? "" : "s") + "</span></summary>" +
        '<div class="ogscroll"><svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="task dependency graph">' +
        '<defs><marker id="ogarrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="currentColor"/></marker></defs>' +
        edges + nodes + "</svg></div></details>";
    }
    /**
     * When each task actually ran, on one time axis from the run's start:
     * where the parallelism was, and what everything waited on.
     */
    function orchTimeline(run, tasks){
      var t0 = Number(run.createdAt) || Math.min.apply(null, tasks.map(function(t){ return t.startedAt || Infinity; }));
      var now = Date.now();
      var end = Math.max.apply(null, tasks.map(function(t){ return t.finishedAt || (t.status === "running" ? now : t.startedAt || t0); }).concat([orchTerminal(run.status) ? Number(run.updatedAt) || t0 : now]));
      var span = Math.max(1000, end - t0);
      var rows = tasks.filter(function(t){ return t.startedAt; }).sort(function(a, b){ return a.startedAt - b.startedAt; }).map(function(t){
        var s = ORCH_TASK_ST[t.status] || [t.status, "off"];
        var a = (t.startedAt - t0) / span * 100;
        var b = ((t.finishedAt || (t.status === "running" ? now : t.startedAt)) - t0) / span * 100;
        var dur = (t.finishedAt || now) - t.startedAt;
        return '<div class="otlrow" data-otask="' + esc(t.id) + '" title="' + esc(t.id + " · " + (t.title || "") + " · " + s[0] + " · " + durfmt(dur)) + '">' +
          '<span class="otlid">' + esc(t.id) + '</span><span class="otltrack"><i class="otlbar ' + s[1] + '" style="left:' + a.toFixed(2) + "%;width:" + Math.max(0.8, b - a).toFixed(2) + '%"></i></span>' +
          '<span class="otld">' + esc(durfmt(dur)) + "</span></div>";
      }).join("");
      return '<details class="ograph otl" open><summary>Timeline<span class="ogs">' + esc(durfmt(span)) + " from start" + (orchTerminal(run.status) ? " to finish" : " so far") + "</span></summary>" +
        '<div class="otlbody">' + rows + '<div class="otlaxis"><span>0</span><span>' + esc(durfmt(span / 2)) + "</span><span>" + esc(durfmt(span)) + "</span></div></div></details>";
    }
    /** Put a finished goal back in the composer, cast and all. */
    function runAgain(run){
      var c = orchCfg(), roster = orchRoster(), ids = roster.map(function(a){ return a.id; });
      var lead = run.orchestrator && run.orchestrator.agent;
      if (lead && ids.indexOf(lead) >= 0) c.orchestrator = lead;
      var ws = (run.workers || []).filter(function(w){ return ids.indexOf(w) >= 0; });
      if (ws.length) { var off = {}; ids.forEach(function(id){ if (ws.indexOf(id) < 0) off[id] = true; }); c.off = off; }
      if (run.maxParallel) c.parallel = Math.max(1, Math.min(12, Number(run.maxParallel)));
      c.race = !!run.race;
      saveOrchCfg(c);
      if (owns(run) || orchRunForChat()) {
        // this thread steers its run; a new goal starts from Main
        try { localStorage.setItem(view.draftKey("main"), run.goal); localStorage.setItem("loomOrchNext:" + view.pid, "1"); } catch (e) {}
        if (state.setChat) state.setChat(view.pid, "main");
        return;
      }
      if (view.desktop) view.showTab("thread"); else closeOrchSheet();
      setComposerMode("orch");
      var box = document.getElementById("box");
      if (box) { box.value = run.goal; view.autosizeBox(); view.saveDraft(); box.focus(); }
      drawOrchControls();
      toast("the goal is back in the composer — same lead and team; edit it or press Enter");
    }

    function orchDetail(run){
      var tasks = run.tasks || [];
      var done = tasks.filter(function(t){ return t.status === "done"; }).length;
      var running = tasks.filter(function(t){ return t.status === "running"; }).length;
      var pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
      var rpct = tasks.length ? Math.round(running / tasks.length * 100) : 0;
      var o = run.orchestrator || {};
      var terminal = orchTerminal(run.status), moved = run.status === "moved";
      // Phase 5 (D75): a live or finished goal can move to one of my online runners
      var canMove = !run.moving && ["running", "reviewing", "completed"].indexOf(run.status) >= 0 && onlineRunners(view.pid, true).length > 0;
      var h = '<div class="ocard">' +
        '<div class="ogoal">' + esc(run.goal) + "</div>" +
        '<div class="ometa">' + orchPill(run.status) +
          (run.race ? '<span class="omi"><span class="omk">Mode</span><span class="omv">' + ICONS.play + " Race</span></span>"
            : '<span class="omi"><span class="omk">Orchestrator</span>' + agentGlyph(o.kind, o.agent) + '<span class="omv">' + esc(agentLabel(o.kind, o.agent)) + "</span></span>") +
          '<span class="omi"><span class="omk">Workers</span><span class="omv">' + (run.workers || []).map(function(w){ return agentGlyph(kindOf(w), w) + esc(labelOf(w)); }).join(", ") + "</span></span>" +
          (run.race ? "" : '<span class="omi"><span class="omk">Round</span><span class="omv">' + Number(run.round || 0) + "/" + Number(run.maxRounds || 0) + "</span></span>") +
          '<span class="omi"><span class="omk">Parallel</span><span class="omv">' + Number(run.maxParallel || 0) + "</span></span>" +
          '<span class="omi"><span class="omk">Cost</span><span class="omv">' + money(run.costUsd) + "</span></span>" +
          '<span class="omi"><span class="omk">Elapsed</span><span class="omv"' + (terminal ? "" : ' data-oel="' + Number(run.createdAt || 0) + '"') + ">" +
            durfmt(Math.max(0, (terminal ? Number(run.updatedAt || run.createdAt) : Date.now()) - Number(run.createdAt || 0))) + "</span></span>" +
          '<span class="omi"><span class="omk">Branch</span><code>' + esc(run.branch || "\u2014") + "</code></span>" +
        "</div>" +
        '<div class="oprog"><div class="obar" title="' + done + " done, " + running + ' running"><i style="width:' + pct + '%"></i><i class="run" style="width:' + rpct + '%"></i></div>' +
          '<span class="opn">' + done + "/" + tasks.length + " done</span></div>" +
        '<div class="oacts">' +
          (run.chat && view.desktop ? '<button class="btn outline sm" id="othread">' + ICONS.thread + (run.race ? "Thread" : "Orchestrator thread") + "</button>" : "") +
          (!terminal ? '<button class="btn outline sm prdanger" id="oabort">' + ICONS.stop + "Abort</button>" : "") +
          (run.status === "aborted" && run.interrupted ? '<button class="btn primary sm" type="button" id="oresume" title="Loom stopped this run by restarting — carry it on: the tasks that were in flight pick up in the worktrees they left">' + ICONS.play + "Resume</button>" : "") +
          // Apply only when something finished: a run that ended before any task
          // merged has nothing on its branch to bring over.
          (!run.race && terminal && !moved && !run.applied && (run.tasks || []).some(function(t){ return t.status === "done"; }) ? '<button class="btn primary sm" id="oapply">Apply to ' + esc(run.baseBranch || "your branch") + "</button>" : "") +
          (terminal && !moved ? '<button class="btn ghost sm" id="oclean" title="remove this run’s worktrees (the branch stays)">Clean up</button>' : "") +
          (terminal ? '<button class="btn outline sm" type="button" id="oagain" title="put this goal back in the composer with the same lead, team and parallelism">' + ICONS.refresh + "Run again</button>" : "") +
          (canMove ? '<button class="btn outline sm" type="button" id="orunner" title="move it to your runner; it carries on there">' + ICONS.orchestra + "Continue on runner</button>" : "") +
        "</div>" + orchMovedHtml(run) + orchOutcome(run) + orchLandingHtml(run) + "</div>";
      if (run.status === "waiting_human") {
        h += '<div class="oask"><div class="oqh">The orchestrator asks</div>' +
          '<div class="oq">' + esc(run.question || "What next?") + "</div>" +
          '<textarea id="oreply" placeholder="Answer, or give it direction\u2026"></textarea>' +
          '<div class="row"><button class="btn primary sm" id="oreplybtn">Reply</button></div></div>';
      }
      if (run.summary) h += '<div class="ocard onote"><b>Summary.</b> ' + esc(run.summary) + "</div>";
      // Team facts (drift, predicted conflicts) the orchestrator hears at its next review.
      if ((run.notes || []).length) {
        h += '<div class="ocard onote onotes"><b>From the team, for the orchestrator\u2019s next review</b>' +
          run.notes.map(function(n){ return '<span class="onn">' + ICONS.team + "<span>" + esc(n) + "</span></span>"; }).join("") + "</div>";
      }
      if (run.error) h += '<div class="ocard onote err">' + esc(run.error) + "</div>";
      if (run.applied && !run.delivered) h += '<div class="ocard onote"><b>Applied</b> to <code>' + esc(run.applied.into) + "</code> " + rel(run.applied.at) + ".</div>";
      if (!tasks.length) {
        h += '<div class="oempty">' + (terminal ? "This run ended before any task was planned."
          : run.status === "waiting_human" ? "No tasks yet \u2014 answer the orchestrator above and it plans again."
          : "The orchestrator is planning\u2026 tasks appear here as it spawns them.") + "</div>";
        return h;
      }
      if (run.race) return h + raceBoard(run);
      if (tasks.length > 1) h += orchGraph(tasks);
      if (tasks.some(function(t){ return t.startedAt; })) h += orchTimeline(run, tasks);
      // What needs you first, then what's moving, then what's settled.
      var ORDER = ["needs_input", "conflict", "running", "pending", "failed", "done", "cancelled"];
      ORDER.forEach(function(stName){
        var group = tasks.filter(function(t){ return t.status === stName; });
        if (!group.length) return;
        var s = ORCH_TASK_ST[stName];
        h += '<div class="ogh"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + ' <span class="bn">' + group.length + "</span></div>" +
          '<div class="otasks">' + group.map(function(t){ return orchTaskCard(run, t); }).join("") + "</div>";
      });
      return h;
    }

    /**
     * Where a run's output went: its plan (plan mode), and what the project's
     * git delivery policy did with it — merged, pushed, a PR — or why it
     * couldn't, with the retry right there.
     */
    function orchOutcome(run){
      var out = [];
      if (run.plan) out.push('<div class="oline plan">' + ICONS.plan + "<span>Plan:</span><code>plans/" + esc(run.id) + "/PLAN.md</code>" +
        "<span>on</span><code>" + esc(run.branch || "the run\u2019s branch") + "</code></div>");
      var dl = run.delivered;
      if (dl) {
        var what;
        if (dl.mode === "pr" && /^https?:\/\//.test(String(dl.prUrl || ""))) {
          var num = String(dl.prUrl).match(/\/pull\/(\d+)/);
          what = '<a href="' + esc(dl.prUrl) + '" target="_blank" rel="noopener noreferrer">' + (num ? "PR #" + esc(num[1]) : "Pull request") + " \u2197</a>" +
            (dl.pushed ? "<span>from</span><code>" + esc(dl.pushed) + "</code>" : "");
        } else if (dl.mode === "pr" || dl.mode === "push") {
          what = "<b>Pushed</b><code>" + esc(dl.pushed || dl.into || run.branch) + "</code>" + (dl.mode === "push" && dl.into ? "<span>after merging</span>" : "");
        } else {
          what = "<b>Merged into</b><code>" + esc(dl.into || run.baseBranch || "your branch") + "</code>";
        }
        out.push('<div class="oline ok">' + ICONS.check + what + (dl.at ? "<span>\u00b7 " + rel(dl.at) + "</span>" : "") + "</div>");
      }
      if (run.deliveryError) {
        out.push('<div class="oline err">' + ICONS.x + "<span>Delivery failed \u2014 " + esc(run.deliveryError) + "</span>" +
          '<button class="btn outline xs" type="button" id="oredeliver">' + ICONS.refresh + "Retry delivery</button></div>");
      }
      return out.length ? '<div class="olines">' + out.join("") + "</div>" : "";
    }

    function redeliverOrch(runId, btn){
      var run = findOrchRun(runId) || { id: runId };
      orchAction(run, "deliver", {}, btn, function(j){
        var r = (j && j.run) || {};
        toast(r.deliveryError ? "delivery failed again \u2014 " + r.deliveryError.slice(0, 80) : "delivered");
      });
    }

    /**
     * Phase 4 ("land safely"): the goal's PR on its way to main \u2014 its state,
     * checks, the cross-vendor review, fixes spent, and Land. The daemon's
     * landing loop (daemon/landing.ts) does the work; this shows it and asks.
     */
    function orchLandingHtml(run){
      var l = run.landing; if (!l) return "";
      var st = l.state, done = st === "merged" || st === "closed";
      var ck = l.checks || {}, failing = ck.failing || [], pending = ck.pending || [], rv = l.review;
      var code = function(list){ return list.slice(0, 4).map(function(n){ return "<code>" + esc(n) + "</code>"; }).join(" ") + (list.length > 4 ? " +" + (list.length - 4) : ""); };
      var line = function(cls, icon, html){ return '<div class="oll' + (cls ? " " + cls : "") + '">' + icon + "<span>" + html + "</span></div>"; };
      var h = '<div class="oland" data-oland="' + esc(run.id) + '"><div class="olr1">' + landPill(l) +
        (/^https?:\/\//.test(String(l.url || "")) ? '<a href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">PR #' + Number(l.pr) + " \u2197</a>" : "<b>PR #" + Number(l.pr) + "</b>") +
        (ck.passing || failing.length || pending.length ? '<span class="olk">' + Number(ck.passing || 0) + " passing" + (pending.length ? " \u00b7 " + pending.length + " running" : "") + "</span>" : "") +
        (l.fixAttempts ? '<span class="olk" title="fix attempts spent on failing checks and high review findings">' + Number(l.fixAttempts) + " fix attempt" + (l.fixAttempts === 1 ? "" : "s") + "</span>" : "") +
        (l.updatedAt ? '<span class="olk">' + rel(l.updatedAt) + "</span>" : "") + "</div>";
      if (failing.length) h += line("err", ICONS.x, "Failing: " + code(failing));
      if ((l.flaky || []).length) h += line("", ICONS.refresh, "Flaky (passed on rerun): " + code(l.flaky));
      if (rv) {
        var said = rv.overridden ? "overridden \u2014 " + esc(rv.overridden)
          : rv.state === "skipped" ? "skipped"
          : rv.state === "failure" ? Number(rv.high) + " high finding" + (rv.high === 1 ? "" : "s") + (rv.findings > rv.high ? " of " + Number(rv.findings) : "")
          : "passed" + (rv.findings ? " (" + Number(rv.findings) + " note" + (rv.findings === 1 ? "" : "s") + ")" : "");
        h += line(rv.overridden || rv.state === "success" ? "ok" : rv.state === "failure" ? "err" : "", ICONS.pr,
          "<b>loom/review</b>: " + said + (rv.reviewer ? " \u00b7 " + esc(labelOf(rv.reviewer)) : ""));
      }
      if (st === "needs_human" && l.reason) h += line("warn", ICONS.alert, esc(l.reason));
      if (st === "queued" && l.reason) h += line("", ICONS.branch, "Queued to land \u2014 " + esc(l.reason) + ((l.lanes || []).length ? " (lane" + (l.lanes.length === 1 ? " " : "s ") + l.lanes.map(function(x){ return "<code>" + esc(x) + "</code>"; }).join(", ") + ")" : ""));
      if (l.adoptedBy) h += line("", ICONS.team, "Adopted by <b>" + esc(l.adoptedBy) + "</b> \u2014 they\u2019re making it green, then hand it back");
      if (run.from) h += line("", ICONS.team, "You adopted <b>" + esc(run.from.owner || "a teammate") + "</b>\u2019s PR #" + Number(run.from.pr) + "; it goes back to them when green");
      if ((l.stack || []).length) {
        h += line("", ICONS.branch, "Stacked \u2014 lands bottom-up") + '<div class="olstack">' + l.stack.map(function(s){
          return "<span>" + (/^https?:\/\//.test(String(s.url || "")) ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">#' + Number(s.pr) + "</a>" : "#" + Number(s.pr)) +
            " <code>" + esc(s.branch) + "</code> \u2192 <code>" + esc(s.base) + "</code>" + (s.state ? " \u00b7 " + esc(s.state) : "") + "</span>";
        }).join("") + "</div>";
      }
      if (done || run.status === "moved") return h + "</div>"; // a moved run lands from its own card (orchMovedHtml)
      var canLand = !run.from && !l.landRequested && st !== "landing" && !l.adoptedBy;
      var reviewFailed = rv && rv.state === "failure" && !rv.overridden;
      h += '<div class="olacts">' +
        (canLand ? '<button class="btn ' + (st === "green" ? "primary" : "outline") + ' sm" type="button" data-oland-act="land">' + ICONS.check + "Land</button>" : "") +
        (l.headSha ? '<button class="btn ghost sm" type="button" data-oland-act="review">Re-review</button>' : "") +
        (reviewFailed ? '<button class="btn ghost sm" type="button" data-oland-act="override">Override review</button>' : "") +
        "</div>";
      return h + "</div>";
    }

    /**
     * Phase 5 (D75, D76): a goal on its way to a runner, or already there.
     * This copy is read-only; the runner's sealed progress says how it's
     * going, and Bring back / Land go to the runner through the hub.
     */
    function orchMovedHtml(run){
      if (run.moving && run.status !== "moved") return '<div class="oland" data-omoving><div class="olr1"><span class="opill live"><span class="odot live"></span>moving</span>' +
        '<span class="olk">running turns finish (up to 2 min), then it continues on the runner</span></div></div>';
      if (run.status !== "moved") return "";
      var mv = run.movedTo || {};
      var job = ((teamRunners[view.pid] || {}).jobs || []).filter(function(j){ return j.runId === run.id && j.progress; }).slice(-1)[0];
      var p = job && job.progress;
      var h = '<div class="oland omoved" data-omoved="' + esc(run.id) + '"><div class="olr1"><span class="opill off" data-moved><span class="odot off"></span>moved to ' + esc(mv.where || "a runner") + "</span>" +
        (mv.at ? '<span class="olk">' + rel(mv.at) + "</span>" : "") + "</div>";
      if (p) h += '<div class="oll">' + ICONS.orchestra + "<span>There: <b>" + esc(jobProgressText(p)) + "</b>" + (p.landing ? " " + landPill(p.landing) : "") + (p.at ? " \u00b7 " + rel(p.at) : "") + "</span></div>";
      h += '<div class="oll">' + ICONS.info + "<span>Read-only here \u2014 the runner finishes the goal. Bring it back to carry on on this machine.</span></div>";
      return h + '<div class="olacts"><button class="btn outline sm" type="button" data-omove="bring-back">Bring back</button>' +
        '<button class="btn outline sm" type="button" data-omove="land">' + ICONS.check + "Land</button></div></div>";
    }

    /** POST /team/landing/:action; the answer carries every goal's landing, merged into the runs. */
    function landAct(action, body, btn, done){
      if (btn) btn.disabled = true;
      return api("/api/projects/" + view.pid + "/team/landing/" + action, { method: "POST", body: JSON.stringify(body || {}) }).then(function(j){
        ((j && j.goals) || []).forEach(function(g){ var r = findOrchRun(g.runId); if (r && g.landing) r.landing = g.landing; });
        if (done) done(j);
        drawOrch();
      }).catch(function(err){ if (btn) btn.disabled = false; toast(err.message); });
    }

    function wireOrchLanding(el, run){
      Array.prototype.forEach.call(el.querySelectorAll("[data-oland-act]"), function(b){
        b.onclick = function(){
          var act = b.getAttribute("data-oland-act"), l = run.landing || {};
          if (act === "land") {
            if (l.state !== "green" && !window.confirm("PR #" + l.pr + " isn\u2019t green yet (" + ((LAND_ST[l.state] || [l.state])[0]) +
              "). Land it anyway? Loom brings in fresh main, runs the fast tests, pushes and merges once GitHub\u2019s required checks pass.")) return;
            landAct("land", { runId: run.id }, b, function(){ toast("landing PR #" + l.pr + "\u2026"); });
          } else if (act === "review") {
            landAct("review", { runId: run.id }, b, function(){ toast("review requested"); });
          } else if (act === "override") {
            askText("Override loom/review on PR #" + l.pr + "?", { note: "Say why — it goes on the PR.", multiline: true, required: true, ok: "Override" }).then(function(why){
              if (!why || !why.trim()) return;
              landAct("override", { runId: run.id, reason: why.trim() }, b, function(){ toast("review overridden"); });
            });
          }
        };
      });
    }

    function orchTaskCard(run, t){
      var s = ORCH_TASK_ST[t.status] || [t.status, "off"];
      var files = t.files || [];
      var key = run.id + "/" + t.id;
      var open = !!view.orch.files[key];
      return '<div class="otask" data-otask="' + esc(t.id) + '" title="open ' + esc(t.id) + '\u2019s thread">' +
        '<div class="otr1">' + agentGlyph(t.kind, t.agent) + '<span class="oid">' + esc(t.id) + "</span>" +
          '<span class="oag">' + esc(agentLabel(t.kind, t.agent)) + "</span>" +
          '<span class="ost ' + s[1] + '"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + "</span></div>" +
        '<div class="ott">' + esc(t.title) + "</div>" +
        '<div class="otb">' +
          (t.dependsOn || []).map(function(d){ return '<span class="obdg" title="waits for ' + esc(d) + '">after ' + esc(d) + "</span>"; }).join("") +
          (t.attempts > 1 ? '<span class="obdg" title="attempts">\u00d7' + Number(t.attempts) + "</span>" : "") +
          (t.costUsd ? '<span class="obdg">' + money(t.costUsd) + "</span>" : "") +
          (files.length ? '<button type="button" class="ofbtn" data-ofiles="' + esc(key) + '">' + files.length + " file" + (files.length === 1 ? "" : "s") + (open ? " \u25be" : " \u25b8") + "</button>" : "") +
          orchOverlapChip(t.overlap) +
        "</div>" +
        ((t.touches || []).length ? '<div class="tglobs otouch" title="the files it declared it will touch">' + teamGlobs(t.touches, 4) + "</div>" : "") +
        (open && files.length ? '<div class="ofiles">' + files.map(function(f){ return "<span>" + esc(f) + "</span>"; }).join("") + "</div>" : "") +
        (t.hold && t.status === "pending" ? orchHoldHtml(t) : "") +
        (t.error ? '<div class="oerr">' + esc(t.error) + "</div>" : "") +
        "</div>";
    }

    /**
     * The orchestrator's answer to a teammate overlap (D29), as a chip:
     * "proceed:<why>", "wait:<goal>" or "narrow".
     */
    function orchOverlapChip(ov){
      ov = String(ov || "");
      if (!ov) return "";
      var m = ov.match(/^(proceed|wait):\s*([\s\S]*)$/);
      if (m && m[1] === "proceed") {
        return '<span class="obdg ovl go" title="' + esc(ov) + '">proceeds' + (m[2] ? ": " + esc(m[2].slice(0, 60)) + (m[2].length > 60 ? "\u2026" : "") : "") + "</span>";
      }
      if (m) return '<span class="obdg ovl wait" title="' + esc(ov) + '">waits for ' + esc(teamGoalOf(m[2]).goal || m[2]) + "</span>";
      if (ov === "narrow") return '<span class="obdg ovl" title="it narrowed its files to stay clear of a teammate">narrowed</span>';
      return '<span class="obdg ovl">' + esc(ov.slice(0, 40)) + "</span>";
    }

    /**
     * Why a ready task isn't running, when the team is the reason: the
     * orchestrator owes an answer (decide), a teammate's PR hasn't merged
     * (wait \u2014 which you can call off), a hard zone is held (zone), or the
     * team is at its agent limit (capacity).
     */
    function orchHoldHtml(t){
      var h = t.hold, reason = String(h.reason || ""), body;
      var since = h.since ? '<span class="ohs">' + fleetSince(h.since) + "</span>" : "";
      if (h.kind === "wait") {
        var g = teamGoalOf(h.runId);
        var detail = reason.indexOf(" \u2014 ") >= 0 ? reason.slice(reason.indexOf(" \u2014 ") + 3) : "";
        body = '<span class="ohi">' + ICONS.clock + '</span><span class="oht">Waiting for ' +
          (g.github ? "<b>" + esc(g.github) + "</b>\u2019s PR for " : "the PR for ") +
          (g.goal ? "\u2018" + esc(g.goal) + "\u2019" : "goal <code>" + esc(h.runId || "?") + "</code>") + "\u2026" +
          (detail ? "<small>" + esc(detail) + "</small>" : "") + "</span>" + since +
          '<button class="btn outline xs" type="button" data-ostopwait="' + esc(t.id) + '">Stop waiting</button>';
        return '<div class="ohold live" data-ohold="wait">' + body + "</div>";
      }
      if (h.kind === "zone") {
        // paused mid-turn (drift into the zone, D33) or queued before it started (D31)
        var paused = /^it edited /.test(reason), tail = reason.lastIndexOf(" \u2014 ");
        body = '<span class="ohi">' + ICONS.lock + '</span><span class="oht">' + (paused ? "Paused inside " : "Queued behind ") + "<b>" + esc(h.holder || "a teammate") +
          "</b>\u2019s hard zone <code>" + esc(h.zone || "?") + "</code>" +
          (paused ? "<small>" + esc(reason) + "</small>" : tail >= 0 ? "<small>" + esc(reason.slice(tail + 3)) + "</small>" : "") + "</span>" + since;
        return '<div class="ohold warn" data-ohold="zone" title="' + esc(reason) + '">' + body + "</div>";
      }
      if (h.kind === "capacity") {
        return '<div class="ohold" data-ohold="capacity"><span class="ohi">' + ICONS.team + '</span><span class="oht">' + esc(reason || "The team is at its agent limit") + "</span>" + since + "</div>";
      }
      return '<div class="ohold warn" data-ohold="decide"><span class="ohi">' + ICONS.orchestra + '</span><span class="oht">Needs the orchestrator: ' + esc(reason) + "</span>" + since + "</div>";
    }

    function wireOrchHead(){
      var r = document.getElementById("orefresh"); if (r) r.onclick = loadOrch;
    }

    function orchAction(run, action, body, btn, done){
      if (btn) btn.disabled = true;
      return api("/api/projects/" + view.pid + "/orchestra/" + encodeURIComponent(run.id) + "/" + action, {
        method: "POST", body: JSON.stringify(body || {}),
      }).then(function(j){
        if (j && j.run) mergeOrchRun(j.run);
        if (done) done(j);
        loadOrch();
      }).catch(function(err){ if (btn) btn.disabled = false; toast(err.message); });
    }

    function applyOrch(runId, btn){
      var run = findOrchRun(runId) || { id: runId };
      orchAction(run, "apply", {}, btn, function(j){ toast("merged into " + ((j && j.into) || "your branch")); view.refreshTree(true); if (state.refreshExplorer) state.refreshExplorer(); });
    }

    function wireOrchDetail(el, run){
      Array.prototype.forEach.call(el.querySelectorAll("[data-racediff]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var tid = b.getAttribute("data-racediff"), t = (run.tasks || []).filter(function(x){ return x.id === tid; })[0];
          api("/api/projects/" + view.pid + "/orchestra/" + encodeURIComponent(run.id) + "/tasks/" + encodeURIComponent(tid) + "/diff")
            .then(function(j){
              if (!j.patch) { toast("no changes on " + tid); return; }
              if (view.desktop) view.openPatchDock(j.patch, (t ? agentLabel(t.kind, t.agent) + "’s take" : tid));
              else toast("open this on the desktop to read the diff");
            })
            .catch(function(err){ toast(err.message); });
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-racechat]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); openOrchChat(b.getAttribute("data-racechat")); };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-racepick]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var tid = b.getAttribute("data-racepick"), t = (run.tasks || []).filter(function(x){ return x.id === tid; })[0];
          askConfirm("Apply " + (t ? agentLabel(t.kind, t.agent) + "’s take" : tid) + " to your branch?\n\nIts changes merge into the branch you’re on. The other entrants stay on their own branches.", { ok: "Pick this one" }).then(function(yes){
            if (!yes) return;
            b.disabled = true;
            api("/api/projects/" + view.pid + "/orchestra/" + encodeURIComponent(run.id) + "/apply", { method: "POST", body: JSON.stringify({ task: tid }) })
              .then(function(r){ toast("merged " + r.merged + " into " + r.into); loadOrch(); if (state.loadGitStat) state.loadGitStat(); })
              .catch(function(err){ b.disabled = false; toast(err.message); });
          });
        };
      });
      var ag = document.getElementById("oagain");
      if (ag) ag.onclick = function(){ runAgain(run); };
      var rs = document.getElementById("oresume");
      if (rs) rs.onclick = function(){
        rs.disabled = true; rs.textContent = "Resuming…";
        api("/api/projects/" + view.pid + "/orchestra/" + encodeURIComponent(run.id) + "/resume", { method: "POST", body: "{}" })
          .then(function(j){ if (j && j.run) mergeOrchRun(j.run); toast("resumed — the interrupted tasks are picking up where they left off"); })
          .catch(function(err){ toast(err.message); rs.disabled = false; rs.textContent = "Resume"; });
      };
      Array.prototype.forEach.call(el.querySelectorAll("[data-run]"), function(row){
        row.onclick = function(){ view.orch.sel = row.getAttribute("data-run"); view.orch.pinned = true; drawOrch(); };
      });
      var th = el.querySelector("#othread"); if (th) th.onclick = function(){ openOrchChat(run.chat); };
      // a long goal is clamped to four lines; clicking it reads the rest
      var og = el.querySelector(".ogoal");
      if (og) { og.title = "click to " + (view.orch.goalOpen ? "fold" : "read the whole goal"); if (view.orch.goalOpen) og.classList.add("full");
        og.onclick = function(){ view.orch.goalOpen = !view.orch.goalOpen; og.classList.toggle("full", view.orch.goalOpen); }; }
      var ab = el.querySelector("#oabort");
      if (ab) ab.onclick = function(){
        askConfirm("Abort this orchestra run? Running workers are stopped; finished work stays on " + run.branch + ".", { ok: "Abort run", danger: true })
          .then(function(ok){ if (ok) orchAction(run, "abort", {}, ab, function(){ toast("orchestra aborted"); }); });
      };
      var apb = el.querySelector("#oapply"); if (apb) apb.onclick = function(){ applyOrch(run.id, apb); };
      var rdb = el.querySelector("#oredeliver"); if (rdb) rdb.onclick = function(){ redeliverOrch(run.id, rdb); };
      wireOrchLanding(el, run);
      var mvb = el.querySelector("#orunner");
      if (mvb) mvb.onclick = function(){
        var r = onlineRunners(view.pid, true)[0]; if (!r) return;
        if (!window.confirm("Move this goal to " + runnerName(r) + "? Running tasks finish their turn (up to 2 min), then it continues there.")) return;
        mvb.disabled = true;
        runnerAct(view.pid, "continue", { runId: run.id, runner: r.deviceId }).then(function(res){
          toast("moving to " + runnerName(r) + (res && res.jobId ? " \u2014 job " + res.jobId : "")); loadOrch();
        }).catch(function(err){ mvb.disabled = false; toast(err.message); });
      };
      Array.prototype.forEach.call(el.querySelectorAll("[data-omove]"), function(b){
        b.onclick = function(){
          var act = b.getAttribute("data-omove");
          if (act === "bring-back" && !window.confirm("Bring this goal back here? The runner pauses it at a safe point and hands it over.")) return;
          b.disabled = true;
          runnerAct(view.pid, act, { runId: run.id }).then(function(res){
            toast((act === "land" ? "the runner lands it" : "coming back") + (res && res.jobId ? " \u2014 job " + res.jobId : ""));
          }).catch(function(err){ b.disabled = false; toast(err.message); });
        };
      });
      var cl = el.querySelector("#oclean");
      if (cl) cl.onclick = function(){ orchAction(run, "cleanup", {}, cl, function(){ toast("worktrees removed"); }); };
      // D32: the owner calls off a wait on a teammate's goal; the task starts
      // alongside it, and the team feed says so.
      Array.prototype.forEach.call(el.querySelectorAll("[data-ostopwait]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation(); // the card behind it opens the thread
          var tid = b.getAttribute("data-ostopwait");
          var t = (run.tasks || []).filter(function(x){ return x.id === tid; })[0];
          var g = teamGoalOf(t && t.hold && t.hold.runId);
          askConfirm("Stop waiting? " + tid + " starts now, alongside " + (g.goal ? "\u2018" + g.goal + "\u2019" : "the other goal") +
            " instead of after its PR merges \u2014 you may have a conflict to resolve when both land.", { ok: "Start it now" }).then(function(ok){
            if (!ok) return;
            b.disabled = true;
            api("/api/projects/" + view.pid + "/orchestra/" + encodeURIComponent(run.id) + "/tasks/" + encodeURIComponent(tid) + "/stop-waiting", { method: "POST", body: "{}" })
              .then(function(){ toast(tid + " stopped waiting"); loadOrch(); })
              .catch(function(err){ b.disabled = false; toast(err.message); });
          });
        };
      });
      var rb = el.querySelector("#oreplybtn"), rt = el.querySelector("#oreply");
      if (rb && rt) {
        var go = function(){
          var v = (rt.value || "").trim(); if (!v) { rt.focus(); return; }
          orchAction(run, "reply", { text: v }, rb, function(){ toast("sent to the orchestrator"); });
        };
        rb.onclick = go;
        rt.onkeydown = function(e){ if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } };
      }
      Array.prototype.forEach.call(el.querySelectorAll("[data-ofiles]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation(); // the card behind it opens the thread
          var k = b.getAttribute("data-ofiles"); view.orch.files[k] = !view.orch.files[k]; drawOrch();
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-otask]"), function(card){
        card.onclick = function(){
          var t = (run.tasks || []).filter(function(x){ return x.id === card.getAttribute("data-otask"); })[0];
          if (t) openOrchChat(t.chat);
        };
      });
    }
return { orchRoster, orchCfg, orchTerminal, findOrchRun, orchRunForChat, mergeOrchRun, setComposerMode, drawOrchControls, sendOrchestra, needsInputClick, answerAgent, askRewind, openRewindMenu, openOrchChat, loadOrch, onOrchEvent, drawOrchTabDot, orchEl, openOrchSheet, closeOrchSheet, orchPill, drawOrch, redeliverOrch, applyOrch };
}
