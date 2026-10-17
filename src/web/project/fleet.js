import { agentGlyph,agentLabel } from '../agents.js';
import { api } from '../connection.js';
import { esc,hue,pageGone,rel } from '../format.js';
import { ICONS,LOADER } from '../icons.js';
import { toast } from '../notifications.js';
import { permBadge } from '../permissions.js';
import { openSettingsModal } from '../settings.js';
import { state } from '../state.js';
import { fleetSince,loadTeam,loadTeamLanding,teamAct,teamEditing,teamFleetHtml,teamHeadHtml,wireTeamDeploys,wireTeamForms,wireTeamInvites,wireTeamShare } from '../team.js';
import { ORCH_TASK_ST } from '../transcript.js';

/** fleet behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createFleet(view) {


    // ---- Fleet: what every agent in every open project is doing ------------
    // A reading of GET /api/activity, polled every 2s while you can see it —
    // the other projects' sockets aren't this view's to hold — and nudged
    // sooner by this project's own events.
    function fleetEl(){
      // A team frame can land after the window is torn down (a closed tab, a
      // finished test); there's no fleet to draw into then, and throwing here
      // surfaced as an unhandled rejection.
      if (pageGone()) return null;
      if (view.desktop) return state.tab === "fleet" ? document.getElementById("pane-fleet") : null;
      return document.getElementById("fleetsheet");
    }

    function loadFleet(){
      return api("/api/activity").then(function(j){
        if (state.pid !== view.pid) return;
        view.fleet.data = j; view.fleet.err = "";
        drawFleet();
      }).catch(function(err){ view.fleet.err = err.message; drawFleet(); });
    }

    function fleetPoll(on){
      if (on && !view.fleet.poll) {
        view.fleet.poll = setInterval(function(){ if (!fleetEl()) { fleetPoll(false); return; } loadFleet(); }, 2000);
        state.timers.push(view.fleet.poll); // a project switch clears it with the rest
      } else if (!on && view.fleet.poll) { clearInterval(view.fleet.poll); view.fleet.poll = null; }
    }

    function onFleetEvent(ev){
      if (!ev || !view.FLEET_KINDS[ev.kind] || view.fleet.t || !fleetEl()) return;
      view.fleet.t = setTimeout(function(){ view.fleet.t = null; if (state.pid === view.pid && fleetEl()) loadFleet(); }, 250);
    }

    function openFleetSheet(){
      var el = document.getElementById("routesheet"); if (!el) return;
      el.innerHTML = '<div class="sheet"><div id="fleetsheet"></div></div>';
      // the sheet sits at the head of the thread, which is usually scrolled to its end
      var sc = document.getElementById("pane-thread"); if (sc) sc.scrollTop = 0;
      drawFleet(); loadFleet(); loadTeam(); fleetPoll(true);
    }

    function closeFleetSheet(){
      var el = document.getElementById("routesheet");
      if (el && document.getElementById("fleetsheet")) el.innerHTML = "";
      fleetPoll(false);
    }

    function drawFleet(){
      var el = fleetEl(); if (!el) return;
      var d = view.fleet.data, projects = ((d && d.projects) || []).slice();
      // this project first; the rest as the daemon lists them
      projects.sort(function(a, b){ return ((b.project || {}).id === view.pid) - ((a.project || {}).id === view.pid); });
      var agentsN = 0, busyN = 0;
      projects.forEach(function(pr){
        (pr.crews || []).forEach(function(crew){ busyN += (crew.active || []).length; });
        (pr.agents || []).forEach(function(a){ agentsN++; if (a.busy) busyN++; });
        // An orchestra's workers run as copies of the roster, so the roster
        // reads idle while they work — the header said "no agents running"
        // above a run with three tasks in flight. Count what's really going.
        var o = pr.orchestra;
        if (o && !view.orchTerminal(o.status)) {
          (o.tasks || []).forEach(function(t){ if (t.status === "running") busyN++; });
          if (/^(planning|reviewing|starting)$/.test(String(o.status))) busyN++;
        }
      });
      var head = '<div class="ohead"><span class="ot">Fleet</span>' +
        '<span class="os">What every agent in every open project is doing, right now.</span><span class="spacer"></span>' +
        (d ? '<span class="fsum"><span class="fchip' + (busyN ? " live" : "") + '">' + busyN + " working</span>" +
          '<span class="fchip">' + agentsN + " agent" + (agentsN === 1 ? "" : "s") + "</span>" +
          (d.approvals ? '<span class="fchip warn">' + Number(d.approvals) + " to approve</span>" : "") + "</span>" : "") +
        '<button class="iconbtn" id="frefresh" title="refresh">' + ICONS.refresh + "</button></div>";
      // Two hosts in one view: this machine (redrawn on every 2s poll) and the
      // team below it, which keeps its own node so a poll can't wipe an
      // invite link you're typing or reading.
      var local = el.querySelector("#flocal");
      if (!local) {
        el.innerHTML = '<div class="fleetview"><div class="flocal" id="flocal"></div><div class="fteam" id="fteam"></div></div>';
        local = el.querySelector("#flocal");
      }
      if (!d) {
        local.innerHTML = head + (view.fleet.err ? '<div class="onote err">' + esc(view.fleet.err) + "</div>" : LOADER);
      } else if (!agentsN) {
        local.innerHTML = head + '<div class="oempty"><b>No agents running.</b><br>' +
          "Open a project with agents on its roster and every one shows up here \u2014 what it\u2019s doing, in which thread, and for how long.</div>";
      } else {
        local.innerHTML = head +
          (busyN ? "" : '<div class="fnote">No agents running right now \u2014 everyone below is idle.</div>') +
          projects.map(fleetProject).join("");
      }
      drawTeamBlock();
      var rf = el.querySelector("#frefresh"); if (rf) rf.onclick = function(){ loadFleet(); loadTeam(); };
      Array.prototype.forEach.call(el.querySelectorAll("[data-fchat]"), function(b){
        b.onclick = function(){ openFleetThread(b.getAttribute("data-fpid"), b.getAttribute("data-fchat")); };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-fopen]"), function(b){
        b.onclick = function(){ openFleetThread(b.getAttribute("data-fopen"), null); };
      });
    }

    function fleetProject(pr){
      var info = pr.project || {}, agents = pr.agents || [];
      var busy = agents.filter(function(a){ return a.busy; }).length;
      var holder = agents.filter(function(a){ return a.holdsBaton; })[0];
      var kindIn = function(id){ var a = agents.filter(function(x){ return x.id === id; })[0]; return a ? a.kind : null; };
      var h = hue(String(info.id || info.name || "?"));
      var out = '<div class="fproj" data-fproj="' + esc(info.id) + '">' +
        '<div class="fph"><span class="fpg" style="background:color-mix(in srgb, hsl(' + h + ',60%,50%) 18%, transparent);color:hsl(' + h + ',60%,var(--agent-l))">' +
          esc(String(info.name || info.id || "?").slice(0, 1)) + "</span>" +
          '<span class="fpn">' + esc(info.name || info.id) + "</span>" +
          (info.id === view.pid ? '<span class="fcur">this project</span>' : "") +
          '<span class="fpm">' + (busy ? busy + " working" : "idle") + (holder ? " \u00b7 baton " + esc(holder.id) : "") + "</span>" +
          '<span class="spacer"></span>' +
          (info.id !== view.pid ? '<button class="btn ghost xs" type="button" data-fopen="' + esc(info.id) + '">Open</button>' : "") + "</div>" +
        agents.map(function(a){ return fleetAgentRow(info, a); }).join("");
      var o = pr.orchestra;
      if (o && !view.orchTerminal(o.status)) {
        out += '<div class="forch"><div class="foh"><span class="fok">Orchestra</span>' + view.orchPill(o.status) +
          '<span class="fog" title="' + esc(o.goal) + '">' + esc(o.goal) + "</span>" +
          (o.chat ? '<span class="spacer" style="margin-left:auto"></span><button class="fthr" type="button" data-fchat="' + esc(o.chat) + '" data-fpid="' + esc(info.id) + '">' +
            ICONS.thread + "<span>orchestrator thread</span></button>" : "") + "</div>" +
          (o.tasks || []).map(function(t){
            var s = ORCH_TASK_ST[t.status] || [t.status || "", "off"], k = kindIn(t.agent);
            return '<div class="fotask"><span class="fost ' + s[1] + '">' + (t.status === "running" ? '<span class="fspin"></span>' : '<span class="odot ' + s[1] + '"></span>') + esc(s[0]) + "</span>" +
              '<span class="foag">' + agentGlyph(k, t.agent) + "<span>" + esc(agentLabel(k, t.agent)) + "</span></span>" +
              '<span class="fotl"><b title="' + esc(t.title) + '">' + esc(t.id) + " \u00b7 " + esc(t.title) + "</b>" +
                (t.last && t.last.line ? '<span class="fline">' + esc(t.last.line) + '<span class="ft">' + rel(t.last.ts) + "</span></span>" : "") + "</span>" +
              (t.chat ? '<button class="fthr" type="button" data-fchat="' + esc(t.chat) + '" data-fpid="' + esc(info.id) + '" title="open ' + esc(t.id) + '\u2019s thread">' + ICONS.thread + "<span>thread</span></button>" : "<span></span>") +
              "</div>";
          }).join("") + "</div>";
      }
      // borrowed hands and a pipeline in flight, one line each
      (pr.crews || []).forEach(function(crew){
        out += '<div class="forch"><div class="foh"><b>Crew ' + esc(crew.name) + '</b><span>' + esc(crew.status) + '</span><span class="fog">' + esc(crew.goal) + '</span><button class="fthr" data-fchat="' + esc(crew.channel) + '" data-fpid="' + esc(info.id) + '">Channel</button></div>' +
          (crew.cards || []).map(function(card){ return '<div class="fx">' + esc(card.title) + ' · ' + esc(card.stage) + (card.teammate ? ' · ' + esc(card.teammate) : '') + '</div>'; }).join('') + '</div>';
      });
      var extra = (pr.subtasks || []).map(function(st){
        return '<div class="fx">\u21b3 <b>' + esc(st.agentId) + "</b> subtask for " + esc(st.parent) + " \u2014 " + esc(String(st.task || "").slice(0, 140)) + "</div>";
      });
      var r = pr.route;
      if (r && (r.status === "running" || r.status === "waiting_human")) {
        var steps = r.steps || [];
        extra.push('<div class="fx">\u25b8 route <b>' + esc(r.name || "route") + "</b> " +
          (r.mode === "dynamic" ? "hop " + (Number(r.current) + 1) : "step " + (Number(r.current) + 1) + "/" + steps.length) +
          (steps[r.current] ? " \u00b7 " + esc(steps[r.current]) : "") + (r.status === "waiting_human" ? " \u00b7 waiting for you" : "") + "</div>");
      }
      if (extra.length) out += '<div class="fextra">' + extra.join("") + "</div>";
      return out + "</div>";
    }

    function fleetAgentRow(info, a){
      var lbl = agentLabel(a.kind, a.id), last = a.last;
      var sub = [a.id !== lbl ? a.id : "", a.role || ""].filter(Boolean).join(" \u00b7 ");
      var chatName = a.chatTitle || (a.chat === "main" ? "Main thread" : a.chat);
      return '<div class="frow' + (a.busy ? " busy" : "") + '" data-fagent="' + esc(a.id) + '">' +
        '<span class="fg">' + agentGlyph(a.kind, a.id) + "</span>" +
        '<span class="fn"><b>' + esc(lbl) + "</b>" + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</span>" +
        '<span class="fs">' + (a.busy ? '<span class="fspin"></span>working' + (a.since ? " \u00b7 " + fleetSince(a.since) : "") : '<span class="fidle"></span>idle') + "</span>" +
        '<span class="fa">' +
          (a.chat ? '<button class="fthr" type="button" data-fchat="' + esc(a.chat) + '" data-fpid="' + esc(info.id) + '" title="open this thread">' + ICONS.thread + "<span>" + esc(chatName) + "</span></button>" : "") +
          (last && last.line ? '<span class="fline">' + esc(last.line) + '<span class="ft">' + rel(last.ts) + "</span></span>" : (a.chat ? "" : '<span class="fline">no activity yet</span>')) +
        "</span>" +
        '<span class="fb">' + (a.holdsBaton ? '<span class="fbaton" title="holds the baton">baton</span>' : "") + permBadge(a.permissions || "auto", undefined, a.kind) + "</span></div>";
    }

    /** Jump to a project's thread — this one or another; setChat handles both. */
    function openFleetThread(toPid, chat){
      if (view.desktop && state.setChat) {
        if (chat) state.setChat(toPid, chat);
        else if (state.selectProject) state.selectProject(toPid);
        return;
      }
      // The phone has one thread per project: go to the project.
      if (toPid !== view.pid) { location.hash = "#p/" + toPid; return; }
      closeFleetSheet();
    }


    // ---- Team: teammates' sessions, the lease map and the feed (D26) --------
    // Drawn from the one shared reading (state.team, see loadTeam) into its own
    // node under this machine's projects. Fleet's 2s poll redraws it too, so
    // "running · 4m" keeps counting — unless you're typing into one of its
    // forms, which a redraw would wipe.
    function drawTeamBlock(force){
      var el = fleetEl(); if (!el) return;
      var host = el.querySelector("#fteam"); if (!host) return;
      if (!force && teamEditing(host)) return;
      var t = state.team;
      if (!t) {
        // A project-scoped client can't read the team at all; that's not news.
        host.innerHTML = state.teamErr && !/unscoped/.test(state.teamErr)
          ? teamHeadHtml() + '<div class="fnote">' + esc(state.teamErr) + "</div>" : "";
        wireTeamBlock(host);
        return;
      }
      host.innerHTML = teamFleetHtml(t, view.pid);
      wireTeamBlock(host);
    }

    function wireTeamBlock(host){
      var mg = host.querySelector("[data-tmanage]");
      if (mg) mg.onclick = function(){ openSettingsModal("team"); };
      wireTeamForms(host, teamAct);
      wireTeamInvites(host, teamAct);
      wireTeamShare(host, function(){ drawTeamBlock(true); });
      wireTeamDeploys(host);
      // D63: take a teammate's stuck goal — a small run here that makes its PR green
      Array.prototype.forEach.call(host.querySelectorAll("[data-tadopt]"), function(b){
        b.onclick = function(){
          var n = Number(b.getAttribute("data-tadopt")), owner = b.getAttribute("data-towner") || "a teammate";
          if (!window.confirm("Adopt PR #" + n + "? Your agents will work on " + owner + "’s branch.")) return;
          b.disabled = true;
          api("/api/projects/" + view.pid + "/team/landing/adopt", { method: "POST", body: JSON.stringify({ pr: n }) }).then(function(j){
            toast("adopted PR #" + n + " — it goes back to " + owner + " when green");
            if (j && j.result && j.result.id) view.mergeOrchRun(j.result);
            loadTeamLanding(view.pid, true);
          }).catch(function(err){ b.disabled = false; toast(err.message); });
        };
      });
    }
return { loadFleet, fleetPoll, onFleetEvent, openFleetSheet, closeFleetSheet, drawFleet, drawTeamBlock };
}
