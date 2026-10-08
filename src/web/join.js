/** Browser join module: the page an invite link opens on your own Loom. See README.md for ownership and startup. */
import { api,clearTimers } from './connection.js';
import { route } from './navigation.js';
import { clearShell } from './shell.js';
import { esc } from './format.js';
import { ICONS,LOADER } from './icons.js';
import { isElectron } from './theme.js';
import { root } from './state.js';


  // ---- joining from one link ------------------------------------------------
  /**
   * An invite opened here (`/app#join=<fragment>`, which is where the public
   * join page sends you) or pasted into the Team form. Shows what the link
   * will set up, then runs it step by step (daemon/onboard.ts) and opens the
   * project. The fragment is read once and dropped from the address bar —
   * it carries the team key.
   */
  var pendingJoin = null;

  function joinFromHash(){
    var m = location.hash.match(/^#join=([A-Za-z0-9_\-]+)/);
    if (!m) return pendingJoin;
    pendingJoin = m[1];
    history.replaceState(null, "", location.pathname + "#join");
    return pendingJoin;
  }

  /** Start the join page for a link someone pasted. */
  function openJoin(link){
    var s = String(link || "").trim();
    var frag = s.indexOf("#") >= 0 ? s.slice(s.indexOf("#") + 1) : s;
    pendingJoin = frag.replace(/^join=/, "");
    history.replaceState(null, "", location.pathname + "#join");
    route();
  }

  function renderJoin(frag){
    clearTimers();
    clearShell();
    root.innerHTML =
      (isElectron() ? '<div class="dragstrip"></div>' : "") +
      '<div class="joinwrap"><div class="joincard" id="joincard">' + LOADER + "</div></div>";
    var card = document.getElementById("joincard");
    var job = null, timer = null;
    function done(){ pendingJoin = null; if (timer) clearInterval(timer); }
    // the whole app is rebuilt from the address: a project's page, or home
    function leave(hash){ done(); history.replaceState(null, "", location.pathname + (hash ? "#" + hash : "")); route(); }

    function head(p){
      return '<div class="jhead"><div class="jlogo">' + ICONS.team + "</div>" +
        '<div class="jtitle">' + (p.from ? "<b>@" + esc(p.from) + "</b> invited you to " : "Join ") + "<b>" + esc(p.team || "a Loom team") + "</b></div>" +
        (p.repo ? '<div class="jrepo"><code>' + esc(p.repo) + "</code></div>" : "") + "</div>";
    }

    function steps(list){
      var MARK = { done: ICONS.check || "✓", skipped: "·", failed: ICONS.x, waiting: "…", running: "", pending: "" };
      return '<ol class="jsteps">' + list.map(function(s){
        return '<li class="js-' + s.state + '"><span class="jmark">' + (s.state === "running" ? '<span class="obspin"></span>' : MARK[s.state] || "") + "</span>" +
          '<span class="jl">' + esc(s.label) + (s.detail ? "<small>" + esc(s.detail) + "</small>" : "") + "</span></li>";
      }).join("") + "</ol>";
    }

    function preview(){
      api("/api/onboard/preview", { method: "POST", body: JSON.stringify({ link: frag }) }).then(function(p){
        var selfHosted = !p.signedIn && !/^supabase:/.test(p.hub || "");
        var plan = [
          { label: "Sign in with GitHub", state: p.signedIn ? "skipped" : "pending", detail: p.signedIn ? "signed in as @" + p.github : "a GitHub page opens" },
          { label: "Join the team", state: p.member ? "skipped" : "pending", detail: p.member ? "you're already on it" : "" },
        ];
        if (p.repo) {
          plan.push({ label: "Get the repo", state: "pending", detail: p.existing ? "you have it: " + p.existing.dir : "cloned to ~/loom-projects/" + p.repo.split("/")[1] });
          plan.push({ label: "Open it with your agents", state: "pending", detail: "the agent CLIs installed on this machine" });
          plan.push({ label: "Show the team what you work on", state: "pending", detail: "who’s on what, which files — never your prompts" });
          if (p.crews && p.crews.length) plan.push({ label: "Set up the crews", state: "pending", detail: p.crews.join(", ") });
        }
        card.innerHTML = head(p) + '<div class="jsub">Here’s what joining does:</div>' + steps(plan) +
          (selfHosted ? '<div class="jfields">' +
            '<div class="field"><label>GitHub login</label><input id="jgh" autocomplete="off" spellcheck="false" placeholder="your GitHub username"></div>' +
            '<div class="field"><label>Join secret <span class="opt">if the hub has one</span></label><input id="jsec" type="password"></div></div>' : "") +
          (p.repo ? '<details class="jmore"><summary>Clone somewhere else</summary><div class="field"><label>Folder</label><input id="jinto" class="mono" spellcheck="false" placeholder="~/loom-projects/' + esc(p.repo.split("/")[1]) + '"></div></details>' : "") +
          '<div class="jacts"><button class="btn ghost" id="jno">Not now</button><button class="btn primary" id="jgo">Join' + (p.team ? " " + esc(p.team) : "") + "</button></div>";
        document.getElementById("jno").onclick = function(){ leave(""); };
        document.getElementById("jgo").onclick = function(){ start(p); };
      }).catch(function(err){
        card.innerHTML = '<div class="jhead"><div class="jlogo">' + ICONS.team + '</div><div class="jtitle">This invite can’t be opened here</div></div>' +
          '<p class="jerr">' + esc(/admin only/.test(err.message)
            ? "Open the link on the computer where Loom runs — joining signs that machine in and clones the repo onto it."
            : err.message) + "</p>" +
          '<div class="jacts"><button class="btn ghost" id="jno">Back</button></div>';
        document.getElementById("jno").onclick = function(){ leave(""); };
      });
    }

    function val(id){ var i = document.getElementById(id); return i ? i.value.trim() : ""; }

    function start(p){
      var body = { link: frag };
      if (val("jgh")) body.github = val("jgh");
      if (val("jsec")) body.secret = val("jsec");
      if (val("jinto")) body.into = val("jinto");
      var go = document.getElementById("jgo"); if (go) go.disabled = true;
      api("/api/onboard", { method: "POST", body: JSON.stringify(body) }).then(function(r){
        job = r.job; draw(p);
        timer = setInterval(function(){
          api("/api/onboard/" + job.id).then(function(x){ job = x.job; draw(p); }).catch(function(){});
        }, 600);
      }).catch(function(err){
        if (go) go.disabled = false;
        card.insertAdjacentHTML("beforeend", '<p class="jerr">' + esc(err.message) + "</p>");
      });
    }

    function draw(p){
      var tail = "";
      if (job.state === "done") {
        if (timer) { clearInterval(timer); timer = null; }
        tail = '<div class="jok">' + (ICONS.check || "") + "You’re in" + (job.project ? " — " + esc(job.project.name) + " is ready." : ".") + "</div>" +
          '<div class="jacts">' + (job.project ? '<button class="btn primary" id="jopen">Open ' + esc(job.project.name) + "</button>" : '<button class="btn primary" id="jopen">Open Loom</button>') + "</div>";
      } else if (job.state === "failed") {
        if (timer) { clearInterval(timer); timer = null; }
        tail = '<p class="jerr">' + esc(job.error || "something went wrong") + "</p>" +
          '<div class="jacts"><button class="btn ghost" id="jno">Close</button><button class="btn outline" id="jretry">Try again</button></div>' +
          '<div class="jsub">Finished steps are skipped when you try again.</div>';
      }
      card.innerHTML = head({ from: job.from, team: job.team, repo: job.repo }) + steps(job.steps) + tail;
      var open = document.getElementById("jopen");
      if (open) open.onclick = function(){ leave(job.project ? "p/" + job.project.id : ""); };
      var no = document.getElementById("jno");
      if (no) no.onclick = function(){ leave(""); };
      var retry = document.getElementById("jretry");
      if (retry) retry.onclick = function(){ start(p); };
    }

    preview();
  }

export { joinFromHash, openJoin, renderJoin };
