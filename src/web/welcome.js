import { mountExamples, openHelp } from "./help/panel.js";
/** Browser Home (#403). See README.md for ownership and startup. */
import { agentLabel, brandMark } from './agents.js';
import { api } from './connection.js';
import { esc, money } from './format.js';
import { ICONS, LOADER } from './icons.js';
import { setDevMode } from './mode.js';
import { toast } from './notifications.js';
import { openProjectModal, openSettingsModal } from './settings.js';
import { state } from './state.js';
import { tryDemo } from './try-demo.js';

  /**
   * Home: where Loom starts when no project is open, and where the sidebar's Home goes.
   *
   * Left, Get started — GET /api/onboarding, every step derived by the daemon from what you've
   * really done (never a click counter), the next one lit with its button. Right, the two things a
   * new user most needs a door to: the demo, and teaching their own agents Loom. Under them, your
   * projects and which model is winning. Each card loads on its own and hides if its API isn't
   * there, so an older daemon still gets a working Home.
   */
  var STEP_BTN = {
    try: "Try the demo",
    "install-agent": "Set up agents",
    "open-project": "New project",
    "send-message": "Open a project",
    "run-fleet": "Start a fleet",
    "pair-phone": "Pair a phone",
    skills: "Install skills",
    share: "Invite someone",
  };

  function renderHome(el, opts){
    opts = opts || {};
    var greet = new Date().getHours();
    greet = greet < 5 ? "Working late" : greet < 12 ? "Good morning" : greet < 18 ? "Good afternoon" : "Good evening";
    el.innerHTML = '<div class="home scroll">' +
      '<div class="homehead"><div><div class="hgreet">' + esc(greet) + '</div>' +
        '<div class="hsub">Loom 2 · every agent, every model, as many as you want.</div></div>' +
        '<button class="btn sm" id="homenew">' + ICONS.folderPlus + "New project</button></div>" +
      '<div class="homegrid">' +
        '<section class="hcard hstart" id="hstart">' + LOADER + "</section>" +
        '<div class="hcol">' +
          '<section class="hcard hart" id="htry"><span class="lart lart-spool" aria-hidden="true"></span><div>' +
            '<div class="hct">Try Loom in two minutes</div>' +
            '<div class="hcd">A small project with three demo agents — scripted, offline, free — and a walkthrough that sends, steers and runs a fleet for you.</div>' +
            '<button class="btn sm" data-home="try">Try a demo project</button></div></section>' +
          '<section class="hcard hart" id="hskills"><span class="lart lart-skills-book" aria-hidden="true"></span><div>' +
            '<div class="hct">Teach your agents Loom</div>' +
            '<div class="hcd" id="hskillsd">Skills that teach Claude Code, Codex, OpenCode and Grok to drive Loom for you.</div>' +
            '<button class="btn sm ghost" data-home="skills">Loom for agents</button></div></section>' +
        "</div>" +
      "</div>" +
      '<section class="hcard hprojects" id="hprojects"></section>' +
      '<section class="hcard hart hscore" id="hscore" style="display:none"><span class="lart lart-trophy" aria-hidden="true"></span><div class="hscorebody">' +
        '<div class="hct">Who’s winning · 30 days</div><div id="hscorelist"></div></div></section>' +
    "</div>";

    function act(key){
      if (key === "try") return tryDemo(el.querySelector('[data-home="try"]'));
      if (key === "install-agent") return openSettingsModal("setup");
      if (key === "open-project") return openProjectModal();
      if (key === "skills") return openSettingsModal("agentskills");
      if (key === "pair-phone") return openSettingsModal("devices");
      if (key === "share") return openSettingsModal("team");
      var first = (state.projects || [])[0];
      if (!first) return openProjectModal();
      if (key === "run-fleet") {
        // Orchestra lives in Developer mode; turn it on and open the project ready to orchestrate
        setDevMode(true);
        try { localStorage.setItem("loomOrchNext:" + first.id, "1"); } catch (e) {}
        toast("Developer mode on — pick a fleet and give it a goal");
      }
      if (opts.openProject) opts.openProject(first.id);
    }
    Array.prototype.forEach.call(el.querySelectorAll("[data-home]"), function(b){ b.onclick = function(){ act(b.getAttribute("data-home")); }; });
    el.querySelector("#homenew").onclick = function(){ openProjectModal(); };

    function drawStart(r){
      var box = el.querySelector("#hstart"); if (!box) return;
      var steps = (r.steps || []).filter(function(s){ return !s.optional || !s.done; });
      var done = steps.filter(function(s){ return s.done; }).length;
      var next = steps.filter(function(s){ return !s.done && !s.optional; })[0];
      var demoDone = steps.some(function(s){ return s.id === "demo" && s.done; });
      var tryCard = el.querySelector("#htry"); if (tryCard) tryCard.classList.toggle("quiet", demoDone);
      if (r.dismissed) {
        box.innerHTML = '<div class="hstarthead"><span class="hct">Get started</span><span class="hprog">' + done + " of " + steps.length + '</span><button class="btn xs ghost" id="hrestore">Show</button></div>';
        box.querySelector("#hrestore").onclick = function(){ api("/api/onboarding/restore", { method: "POST" }).then(loadStart).catch(function(e){ toast(e.message); }); };
        return;
      }
      box.innerHTML = '<div class="hstarthead"><span class="lart lart-sm lart-checklist" aria-hidden="true"></span><span class="hct">Get started</span>' +
        '<span class="hprog">' + done + " of " + steps.length + "</span>" +
        '<span class="spacer"></span>' + (state.admin ? '<button class="btn xs ghost" id="hdismiss" title="hide the checklist; Home keeps a one-line summary">Hide</button>' : "") + "</div>" +
        '<div class="hbar"><i style="width:' + Math.round(100 * done / Math.max(1, steps.length)) + '%"></i></div>' +
        '<ol class="hsteps">' + steps.map(function(s){
          var isNext = next && s.id === next.id;
          return '<li class="hstep' + (s.done ? " done" : "") + (isNext ? " next" : "") + '">' +
            '<span class="hck">' + (s.done ? ICONS.check : "") + "</span>" +
            '<div class="hsb"><div class="hst">' + esc(s.title) + (s.optional ? ' <span class="hopt">optional</span>' : "") + "</div>" +
              '<div class="hsd">' + esc(s.detail || "") + "</div></div>" +
            (s.done ? "" : '<button class="btn xs ' + (isNext ? "primary" : "ghost") + '" data-home="' + esc(s.action) + '">' + esc(STEP_BTN[s.action] || "Go") + "</button>") +
          "</li>";
        }).join("") + "</ol>";
      Array.prototype.forEach.call(box.querySelectorAll("[data-home]"), function(b){ b.onclick = function(){ act(b.getAttribute("data-home")); }; });
      var d = box.querySelector("#hdismiss");
      if (d) d.onclick = function(){ api("/api/onboarding/dismiss", { method: "POST" }).then(loadStart).catch(function(e){ toast(e.message); }); };
    }
    function loadStart(){
      api("/api/onboarding").then(function(r){ if (el.isConnected) drawStart(r); }).catch(function(){
        var box = el.querySelector("#hstart"); if (box) box.style.display = "none";
      });
    }
    loadStart();

    api("/api/agent-skills").then(function(r){
      var d = el.querySelector("#hskillsd"); if (!d) return;
      var dirs = {}, current = 0, total = 0;
      (r.agents || []).forEach(function(a){
        if (dirs[a.dir]) return; dirs[a.dir] = 1;
        total++;
        if ((a.skills || []).length && a.skills.every(function(k){ return k.current; })) current++;
      });
      if (current) d.textContent = "Installed and current for " + current + " of " + total + " agent folders. Your agents know Loom.";
    }).catch(function(){ /* an older daemon, or a device that can't see it: the card still links there */ });

    function drawProjects(){
      var box = el.querySelector("#hprojects"); if (!box) return;
      var list = (state.projects || []).slice(0, 6);
      if (!list.length) { box.style.display = "none"; return; }
      box.style.display = "";
      box.innerHTML = '<div class="hct">Your projects</div><div class="hpgrid">' + list.map(function(p){
        var busy = (p.agents || []).filter(function(a){ return a.busy; });
        var kinds = {}; (p.agents || []).forEach(function(a){ if (a.tier !== "bridge") kinds[a.kind] = (kinds[a.kind] || 0) + 1; });
        return '<button class="hproj" data-proj="' + esc(p.id) + '">' +
          '<span class="hpn">' + esc(p.name) + "</span>" +
          '<span class="hpa">' + Object.keys(kinds).slice(0, 4).map(function(k){ return '<span title="' + esc(agentLabel(k, k)) + '">' + (brandMark(k) || '<span class="hpk">' + esc(agentLabel(k, k).split(" ")[0]) + "</span>") + (kinds[k] > 1 ? "×" + kinds[k] : "") + "</span>"; }).join("") + "</span>" +
          '<span class="hps">' + (p.needsInput ? '<b class="warn">needs you</b>' : busy.length ? '<b class="work">' + busy.length + " working</b>" : "idle") +
            (p.costUsd > 0 ? " · " + money(p.costUsd) : "") + "</span></button>";
      }).join("") + "</div>";
      Array.prototype.forEach.call(box.querySelectorAll("[data-proj]"), function(b){
        b.onclick = function(){ if (opts.openProject) opts.openProject(b.getAttribute("data-proj")); };
      });
    }
    drawProjects();
    mountExamples(el.querySelector(".homegrid"), opts.openProject);
    var help = document.createElement("button"); help.className = "btn sm"; help.textContent = "Help"; help.onclick = function() { openHelp(); }; el.querySelector(".homehead").appendChild(help);

    api("/api/scoreboard?project=all&window=30d").then(function(r){
      var rows = (r.byKindModel || []).filter(function(x){ return x.turns > 0; }).slice(0, 5);
      var card = el.querySelector("#hscore"); if (!card || !rows.length) return;
      card.style.display = "";
      el.querySelector("#hscorelist").innerHTML = '<ol class="hscores">' + rows.map(function(x){
        return "<li><span class=\"hsn\">" + (x.kind ? brandMark(x.kind) + " " : "") + esc(x.model) + "</span>" +
          '<span class="hsv">' + (x.entries ? Math.round(100 * (x.winRate || 0)) + "% wins" : x.turns + " turns") +
          (x.avgCostUsd != null ? " · " + money(x.avgCostUsd) + "/turn" : "") + "</span></li>";
      }).join("") + "</ol>" + (state.openScoreboard ? '<button class="btn xs ghost" id="hscoreall">Full scoreboard</button>' : "");
      var all = el.querySelector("#hscoreall"); if (all) all.onclick = function(){ state.openScoreboard(null); };
    }).catch(function(){ /* no scoreboard on this daemon */ });

    return { refreshProjects: drawProjects, refreshStart: loadStart };
  }

export { renderHome };
