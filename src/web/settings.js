/** Browser settings module. See README.md for ownership and startup. */
import { agentLabel,brandMark } from './agents.js';
import { copyText } from './clipboard.js';
import { api,logout } from './connection.js';
import { esc,rel } from './format.js';
import { ICONS,LOADER } from './icons.js';
import { askConfirm,askText,chime,devicePref,setDevicePref,toast } from './notifications.js';
import { THEME_KEY,state } from './state.js';
import { JOB_KIND,loadTeam,loadTeamPolicy,loadTeamRunners,loadTeamShare,runnerName,teamAvatar,teamEditing,teamField,teamHooks,teamInviteHtml,teamInvites,teamNotify,teamPolicyHtml,teamRunners,teamShareHtml,teamShareOf,teamShares,wireTeamForms,wireTeamInvites,wireTeamShare } from './team.js';
import { ACCENTS,appearancePref,applyAppearance,applyTheme,isElectron,themeNow } from './theme.js';
import { durfmt } from './transcript.js';


  /**
   * Add a project. The daemon does the real work (writes .loom/config.json,
   * detects which ADEs are installed, registers it); this only collects a
   * folder. Inside Electron that folder comes from the OS picker — in a
   * browser the daemon may be on another host, so the path is typed.
   */
  /**
   * Settings — one sectioned modal for everything about this Loom. A nav rail on
   * the left; one pane on the right. Setup is folded in as the first section
   * rather than living in its own lonely modal, joined by Diagnostics (loom
   * doctor), Preferences (how the brain and handoffs behave), Updates, Devices,
   * and About.
   *
   * Setup and Diagnostics read from the daemon that can actually see the machine
   * (/api/setup, /api/doctor) rather than anything baked into the page: a
   * checklist that says the same thing everywhere is a brochure. Preferences are
   * per-project and land live on the next turn/handoff \u2014 no restart.
   */
  function openSettingsModal(section){
    if (document.querySelector(".scrim")) return;
    // The project whose brain/handoff prefs we edit \u2014 the open one, if any.
    var pid = (location.hash.match(/^#p\/(.+)$/) || [])[1] || state.pid || null;
    var SECTIONS = [
      { id: "setup", label: "Setup", icon: ICONS.tasks },
      { id: "diagnostics", label: "Diagnostics", icon: ICONS.console },
      { id: "preferences", label: "Preferences", icon: ICONS.gear },
      { id: "updates", label: "Updates", icon: ICONS.up },
      { id: "devices", label: "Devices", icon: ICONS.agents },
      { id: "cloud", label: "Loom Cloud", icon: ICONS.cloud },
      { id: "team", label: "Team", icon: ICONS.team },
      { id: "about", label: "About", icon: ICONS.info }
    ];
    var cur = section || "setup";
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal settings">' +
      '<div class="modalhead">Settings<button class="iconbtn" id="sclose" aria-label="close">' + ICONS.x + "</button></div>" +
      '<div class="setwrap"><nav class="setnav" id="setnav"></nav>' +
      '<div class="setpane" id="setpane">' + LOADER + "</div></div>" +
    "</div>";
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); delete teamHooks().settings; }
    function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("sclose").onclick = close;

    var nav = document.getElementById("setnav");
    var pane = document.getElementById("setpane");
    function drawNav(){
      nav.innerHTML = '<div class="navh">Settings</div>' + SECTIONS.map(function(s){
        return '<button data-sec="' + s.id + '" class="' + (s.id === cur ? "on" : "") + '">' + s.icon + "<span>" + esc(s.label) + "</span></button>";
      }).join("");
      Array.prototype.forEach.call(nav.querySelectorAll("button"), function(b){
        b.onclick = function(){ cur = b.getAttribute("data-sec"); drawNav(); render(); };
      });
    }
    // Every section loads asynchronously into one pane. A slow response for a
    // section you've already left (Setup probing every agent CLI, say) used to
    // land late and overwrite the section you'd moved to. Requests carry the
    // navigation generation they started in; a stale answer is dropped.
    var gen = 0;
    function sapi(path, opts){
      var g = gen;
      var never = new Promise(function(){});
      return api(path, opts).then(
        function(r){ return g === gen ? r : never; },
        function(e){ if (g === gen) throw e; return never; }
      );
    }
    function busy(){ pane.innerHTML = LOADER; }
    function fail(err){ pane.innerHTML = '<div class="snote">' + esc(err && err.message ? err.message : String(err)) + "</div>"; }

    // A segmented control (Auto | Off), and the wiring that makes exactly one
    // button live and calls back with the chosen value.
    function seg(name, opts, val){
      return '<div class="seg" data-seg="' + name + '">' + opts.map(function(o){
        return '<button data-val="' + o.v + '" class="' + (o.v === val ? "on" : "") + '">' + esc(o.l) + "</button>";
      }).join("") + "</div>";
    }
    function bindSeg(name, fn){
      var box = pane.querySelector('[data-seg="' + name + '"]');
      if (!box) return;
      Array.prototype.forEach.call(box.querySelectorAll("button"), function(b){
        b.onclick = function(){
          if (b.classList.contains("on")) return;
          Array.prototype.forEach.call(box.querySelectorAll("button"), function(x){ x.classList.remove("on"); });
          b.classList.add("on");
          fn(b.getAttribute("data-val"));
        };
      });
    }

    // ---- Setup: what this machine still needs (from the daemon) --------------
    function srow(st, title, detail, cmd){
      return '<div class="srow2"><span class="sdot ' + st + '"></span>' +
        '<div class="sbody"><div class="st">' + title + "</div>" +
        (detail ? '<div class="sd">' + detail + "</div>" : "") +
        (cmd ? '<code class="scmd">' + esc(cmd) + "</code>" : "") + "</div></div>";
    }
    function renderSetup(){
      busy();
      sapi("/api/setup").then(function(s){
        var osname = s.platform === "darwin" ? "macOS" : s.platform === "win32" ? "Windows" : "Linux";
        var h = '<div class="setphead">Setup</div><div class="setpsub">What this machine still needs to run agents.</div>';
        h += '<div class="sgrouph">Runtime</div>';
        h += srow(s.node.ok ? "ok" : "bad", "Node " + esc(s.node.version),
          s.node.ok ? "new enough for the event log"
            : "Loom needs \u2265" + esc(s.node.needed) + " \u2014 on anything older your history is silently dropped",
          s.node.ok ? "" : (s.platform === "darwin" ? "brew install node"
            : s.platform === "win32" ? "winget install OpenJS.NodeJS" : "install node 22.5 or newer"));
        h += '<div class="sgrouph">Agents that can take a turn</div>';
        if (!s.ready) h += '<div class="snote">Nothing here can hold the baton yet \u2014 install one and Loom has something to drive.</div>';
        s.agents.forEach(function(a){
          // Three states, not two. "Installed" was the lie that cost an
          // afternoon: claude answered --version happily while refusing every
          // turn with "Not logged in".
          var st = !a.found ? "warn" : a.authed === false ? "bad" : a.authed === true ? "ok" : "warn";
          var detail = !a.found ? "not installed"
            : a.authed === true ? "signed in \u00b7 ready to take a turn"
            : a.authed === false ? (a.authDetail || "signed out") + " \u2014 it will refuse every turn until you:"
            : "installed \u2014 couldn\u2019t confirm it\u2019s signed in:";
          h += srow(st, brandMark(a.kind) + " " + esc(a.label), esc(detail), !a.found ? a.install : a.authed === true ? "" : a.auth);
        });
        h += '<div class="sgrouph">Agents you drive in their own window</div>';
        s.bridges.forEach(function(b){
          h += srow(b.driveable ? "ok" : b.reachable ? "warn" : "off",
            brandMark(b.kind) + " " + esc(b.label) + ' <span class="sport">:' + b.port + "</span>",
            b.driveable ? "ready to drive" : esc(b.reason || "not running"), b.driveable ? "" : b.launch);
        });
        h += '<div class="sgrouph">Permissions on ' + osname + "</div>";
        s.permissions.forEach(function(p){
          h += '<div class="srow2"><span class="sdot ' + (p.refused ? "no" : "info") + '"></span>' +
            '<div class="sbody"><div class="st">' + esc(p.title) + (p.refused ? ' <span class="sport">not needed</span>' : "") + "</div>" +
            '<div class="sd">' + esc(p.why) + '</div><div class="sd how">' + esc(p.how) + "</div></div></div>";
        });
        h += '<div class="sgrouph">Your phone</div>';
        h += srow("info", "Let it reach this machine", "Loom listens on localhost by default, which your phone can\u2019t see.", "loom up --restart --tailnet");
        h += srow("info", "Pair the device", "Single use \u2014 or add one under Devices.", "loom pair");
        h += '<div class="pillrow"><button class="btn ghost sm" id="setuprecheck">Re-check</button>' +
          '<span class="hintx">' + (s.ready ? "This machine can run agents." : "No agents installed yet.") + "</span></div>";
        pane.innerHTML = h;
        document.getElementById("setuprecheck").onclick = renderSetup;
      }).catch(fail);
    }

    // ---- Diagnostics: loom doctor, live -------------------------------------
    function renderDiag(){
      busy();
      sapi("/api/doctor" + (pid ? "?project=" + encodeURIComponent(pid) : "")).then(function(d){
        var checks = d.checks || [];
        var bad = checks.filter(function(c){ return c.status === "fail"; }).length;
        var warn = checks.filter(function(c){ return c.status === "warn"; }).length;
        var h = '<div class="setphead">Diagnostics</div>' +
          '<div class="setpsub">loom doctor, run live on this daemon' + (pid ? " \u00b7 including the open project" : "") + ".</div>";
        h += '<div class="pillrow">';
        if (!bad && !warn) h += '<span class="updpill ok">All ' + checks.length + " checks pass</span>";
        else h += '<span class="updpill warn">' + (bad ? bad + " failing" : "") + (bad && warn ? " \u00b7 " : "") + (warn ? warn + " warning" + (warn > 1 ? "s" : "") : "") + "</span>";
        h += '<button class="btn ghost sm" id="diagrerun">Re-run</button></div>';
        h += '<div class="dsys" id="dsys"></div>';
        checks.forEach(function(c){
          var st = c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "bad";
          h += '<div class="dchk"><span class="sdot ' + st + '" style="margin-top:5px"></span>' +
            '<div class="sbody"><div class="dct">' + esc(c.name) + "</div>" +
            (c.detail ? '<div class="dcd">' + esc(c.detail) + "</div>" : "") + "</div></div>";
        });
        pane.innerHTML = h;
        document.getElementById("diagrerun").onclick = renderDiag;
        // what is actually running, beside what it checked
        Promise.all([sapi("/api/health"), sapi("/api/version")]).then(function(r){
          var hh = r[0] || {}, v = r[1] || {}, box = document.getElementById("dsys"); if (!box) return;
          var up = Number(v.uptimeSec || 0);
          var cells = [["Loom", (hh.version || "?") + " · " + String(hh.rev || v.rev || "").slice(0, 8)], ["Node", v.node || "?"],
            ["Platform", v.platform || "?"], ["Up for", durfmt(up * 1000)], ["Process", "pid " + (v.pid || "?")], ["Terminal", hh.terminal || "?"]];
          box.innerHTML = cells.map(function(c){ return '<div class="dsc"><span>' + esc(c[0]) + "</span><b>" + esc(c[1]) + "</b></div>"; }).join("");
        }).catch(function(){});
      }).catch(fail);
    }

    // ---- Preferences: theme, and per-project brain/handoff knobs -------------
    function patchCfg(body, okMsg){
      sapi("/api/projects/" + pid + "/config", { method: "PATCH", body: JSON.stringify(body) })
        .then(function(){ if (okMsg) toast(okMsg); if(body.brain && typeof body.brain.continuity === "boolean") renderPrefs(); })
        .catch(function(e){ toast(e.message); renderPrefs(); });
    }
    function renderPrefs(){
      var h = '<div class="setphead">Preferences</div>';
      h += '<div class="sgrouph">Appearance</div>';
      h += '<div class="prow"><div class="pl"><div class="pt">Theme</div>' +
        '<div class="pd">Light or dark. Open terminals repaint to match.</div></div>' +
        '<div class="pc">' + seg("theme", [{ v: "light", l: "Light" }, { v: "dark", l: "Dark" }], themeNow()) + "</div></div>";
      h += '<div class="prow"><div class="pl"><div class="pt">Text size</div>' +
        '<div class="pd">Scales the whole app on this device.</div></div>' +
        '<div class="pc">' + seg("textsize", [{ v: "s", l: "S" }, { v: "m", l: "M" }, { v: "l", l: "L" }, { v: "xl", l: "XL" }], appearancePref("textsize", "m")) + "</div></div>";
      h += '<div class="prow"><div class="pl"><div class="pt">Density</div>' +
        '<div class="pd">Compact fits more of a conversation on screen.</div></div>' +
        '<div class="pc">' + seg("density", [{ v: "comfy", l: "Comfortable" }, { v: "compact", l: "Compact" }], appearancePref("density", "comfy")) + "</div></div>";
      h += '<div class="prow"><div class="pl"><div class="pt">Accent</div>' +
        '<div class="pd">The thread colour: live replies, links, unread dots, the heatmap.</div></div>' +
        '<div class="pc"><div class="accents" role="group" aria-label="accent colour">' + Object.keys(ACCENTS).map(function(k){
          var on = appearancePref("accent", "cyan") === k;
          return '<button type="button" class="accentsw' + (on ? " on" : "") + '" data-accent="' + k + '" aria-pressed="' + on + '" title="' + k + '" style="--sw:' + ACCENTS[k][0] + '"></button>';
        }).join("") + "</div></div></div>";
      h += '<div class="sgrouph">Notifications · this device</div>';
      h += '<div class="prow"><div class="pl"><div class="pt">When a long turn finishes</div>' +
        '<div class="pd">A notification when an agent finishes something that took more than 20 seconds, while Loom is in the background.</div></div>' +
        '<div class="pc">' + seg("notifydone", [{ v: "on", l: "On" }, { v: "off", l: "Off" }], devicePref("notifyDone", true) ? "on" : "off") + "</div></div>";
      h += '<div class="prow"><div class="pl"><div class="pt">Chime</div>' +
        '<div class="pd">A soft two-note sound with it.</div></div>' +
        '<div class="pc">' + seg("chime", [{ v: "on", l: "On" }, { v: "off", l: "Off" }], devicePref("chime", false) ? "on" : "off") + "</div></div>";
      h += '<div id="projprefs"></div>';
      pane.innerHTML = h;
      bindSeg("notifydone", function(v){
        setDevicePref("notifyDone", v === "on");
        if (v === "on" && !window.loomNative && window.Notification && Notification.permission === "default") {
          try { Notification.requestPermission(); } catch (e) {}
        }
        toast(v === "on" ? "you’ll hear when long turns finish" : "finish notifications off");
      });
      bindSeg("chime", function(v){ setDevicePref("chime", v === "on"); if (v === "on") chime(); });
      bindSeg("textsize", function(v){ try { localStorage.setItem("loomPref:textsize", v); } catch (e) {} applyAppearance(); });
      bindSeg("density", function(v){ try { localStorage.setItem("loomPref:density", v); } catch (e) {} applyAppearance(); });
      Array.prototype.forEach.call(pane.querySelectorAll("[data-accent]"), function(b){
        b.onclick = function(){
          try { localStorage.setItem("loomPref:accent", b.getAttribute("data-accent")); } catch (e) {}
          Array.prototype.forEach.call(pane.querySelectorAll("[data-accent]"), function(x){ x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
          applyAppearance();
        };
      });
      bindSeg("theme", function(v){
        localStorage.setItem(THEME_KEY, v === "light" ? "light" : "dark");
        applyTheme();
        if (state.retheme) state.retheme();
      });
      var pp = document.getElementById("projprefs");
      if (!pid) { pp.innerHTML = '<div class="snote">Open a project to change how its brain learns and how handoff briefs are written.</div>'; return; }
      pp.innerHTML = LOADER;
      sapi("/api/projects/" + pid + "/config").then(function(cfg){
        var pname = state.project && state.project.name ? state.project.name : "this project";
        var hh = '<div class="sgrouph">Brain \u00b7 ' + esc(pname) + "</div>";
        hh += '<div class="prow"><div class="pl"><div class="pt">Native context continuity</div>' +
          '<div class="pd">Sequential Codex, Claude Code and OpenCode switching with per-chat sessions, protected user context and delivery diagnostics. Uses SQLite search; helpers and local inference are disabled. Bridges and parallel execution are not supported in this mode.</div></div>' +
          '<div class="pc">' + seg("continuity", [{ v: "on", l: "On" }, { v: "off", l: "Off" }], cfg.brain.continuity ? "on" : "off") + "</div></div>";
        if (!cfg.brain.continuity) {
          hh += '<div class="prow"><div class="pl"><div class="pt">Memory extractor</div>' +
            '<div class="pd">After each turn a small Claude reads what changed and files what\u2019s worth keeping. Off means the brain holds only what you write by hand.</div></div>' +
            '<div class="pc">' + seg("extractor", [{ v: "auto", l: "Auto" }, { v: "off", l: "Off" }], cfg.brain.extractor) + "</div></div>";
          hh += '<div class="prow"><div class="pl"><div class="pt">Semantic retrieval</div>' +
            '<div class="pd">Finds memories that mean the same thing in different words — “how does login work” reaching a note about JWKS. Needs a local model runtime Loom doesn’t ship: <code>npm i -g @huggingface/transformers</code> (~470MB once), then a 23MB model downloads on first use. Without it, retrieval is the three lexical channels it has always been.</div></div>' +
            '<div class="pc">' + seg("semantic", [{ v: "on", l: "On" }, { v: "off", l: "Off" }], cfg.brain.semantic ? "on" : "off") + "</div></div>";
          hh += '<div class="sgrouph">Handoffs</div>';
          hh += '<div class="prow"><div class="pl"><div class="pt">Brief style</div>' +
            '<div class="pd">How the baton note is written when one agent hands to the next. Template is instant and free; LLM distills it with a small Claude.</div></div>' +
            '<div class="pc">' + seg("projection", [{ v: "template", l: "Template" }, { v: "llm", l: "LLM" }], cfg.projection.mode) + "</div></div>";
        }
        var agents = cfg.agents || [];
        hh += '<div class="prow"><div class="pl"><div class="pt">Default agent</div>' +
          '<div class="pd">Who receives a message when nobody holds the baton.</div></div>' +
          '<div class="pc"><select id="defagent"><option value="">First available</option>' +
          agents.map(function(a){ return '<option value="' + esc(a.id) + '"' + (a.id === cfg.defaultAgent ? " selected" : "") + ">" + esc(a.id) + "</option>"; }).join("") +
          "</select></div></div>";
        pp.innerHTML = hh;
        bindSeg("continuity", function(v){ patchCfg({ brain: { continuity: v === "on" } }, "Native continuity " + v); });
        bindSeg("extractor", function(v){ patchCfg({ brain: { extractor: v } }, v === "off" ? "Extractor off" : "Extractor on"); });
        bindSeg("semantic", function(v){
          patchCfg({ brain: { semantic: v === "on" } },
            v === "on" ? "Semantic retrieval on — it warms up in the background" : "Semantic retrieval off");
        });
        bindSeg("projection", function(v){ patchCfg({ projection: { mode: v } }, "Briefs: " + v); });
        document.getElementById("defagent").onchange = function(){ patchCfg({ defaultAgent: this.value }, "Default agent saved"); };
      }).catch(function(e){ pp.innerHTML = '<div class="snote">' + esc(e.message) + "</div>"; });
    }

    // ---- Updates: is this Loom current, and bring it up to date -------------
    // Two different questions, and the answers come from different places: a
    // published release (every install has one to compare against) and, for a
    // checkout, how far its own tree is behind its remote.
    function renderUpdates(refresh){
      busy();
      sapi("/api/updates" + (refresh ? "?refresh=1" : "")).then(function(u){
        var g = u.git;
        var behind = g && g.behind ? g.behind : 0;
        var shortRev = (u.rev || "").slice(0, 7);
        var h = '<div class="setphead">Updates</div>' +
          '<div class="setpsub">Whether this Loom is current — the published release, the running build, and the code on disk.</div>';
        h += '<div class="pillrow">';
        if (u.behindRelease) h += '<span class="updpill warn">Loom ' + esc(u.latest) + " is out</span>";
        else if (u.latest) h += '<span class="updpill ok">Up to date</span>';
        else h += '<span class="updpill ok">Build ' + esc(shortRev || "unknown") + "</span>";
        if (u.root && behind > 0) h += '<span class="updpill warn">' + behind + " commit" + (behind > 1 ? "s" : "") + " behind</span>";
        h += '<button class="btn ghost sm" id="updcheck">Check again</button>';
        if (u.behindRelease && u.canApply) h += '<button class="btn primary sm" id="updnow">Update to ' + esc(u.latest) + "</button>";
        h += "</div>";
        h += '<dl class="abgrid"><dt>Version</dt><dd>' + esc(u.version) + "</dd>" +
          "<dt>Build</dt><dd>" + esc(shortRev || "—") + "</dd>" +
          "<dt>Installed</dt><dd>" + esc(u.install === "git" ? "git checkout" : u.install === "npm-global" ? "npm (global)" : "unknown") + "</dd>";
        if (u.latest) h += "<dt>Latest</dt><dd>" + esc(u.latest) + (u.release && u.release.url ? ' · <a href="' + esc(u.release.url) + '" target="_blank" rel="noopener">release notes</a>' : "") + "</dd>";
        if (u.root) h += "<dt>Source</dt><dd>" + esc(u.root) + "</dd>";
        if (g && g.branch) h += "<dt>Branch</dt><dd>" + esc(g.branch) + (g.ahead ? " (+" + g.ahead + " local)" : "") + "</dd>";
        h += "</dl>";
        if (u.behindRelease && u.canApply) {
          h += '<div class="snote">Update runs this, then restarts the daemon on the new build:</div>';
          h += '<code class="scmd">' + esc((u.steps || []).join("\n")) + "</code>";
        } else if (u.behindRelease && !u.canApply) {
          h += '<div class="snote">' + esc(u.refusal || "this install can’t update itself") + "</div>";
          if (u.release && u.release.url) h += '<code class="scmd">' + esc(u.release.url) + "</code>";
        } else if (u.root && behind > 0) {
          h += '<div class="snote">Your checkout is behind its remote, though the release matches. Pull and rebuild:</div>';
          h += '<code class="scmd">cd ' + esc(u.root) + " && git pull --ff-only && npm install && npm run build\nloom up --restart</code>";
        }
        h += '<div class="updlog" id="updlog" style="display:none"></div>';
        pane.innerHTML = h;
        document.getElementById("updcheck").onclick = function(){ renderUpdates(true); };
        var go = document.getElementById("updnow");
        if (go) go.onclick = function(){ startUpdate(go, u); };
      }).catch(fail);
    }

    /**
     * Run the update, and stay useful while it runs: the daemon's own log
     * records already stream to every client, so the update's output is shown
     * where it happens. When the daemon goes down to come back on the new
     * build, the page waits for it and reloads itself.
     */
    function startUpdate(btn, u){
      askConfirm("Update Loom to " + u.latest + "?\n\nThis runs:\n" + (u.steps || []).join("\n") + "\n\nThe daemon restarts when it finishes.", { ok: "Update" })
        .then(function(ok){ if (ok) runUpdate(btn, u); });
    }
    function runUpdate(btn, u){
      btn.disabled = true;
      btn.textContent = "Updating…";
      var log = document.getElementById("updlog");
      if (log) { log.style.display = "block"; log.textContent = "starting…"; }
      state.updating = true;
      sapi("/api/updates/apply", { method: "POST", body: "{}" }).then(function(){
        if (log) log.textContent = "running " + (u.steps || []).join(" && ") + "…";
        waitForNewBuild();
      }).catch(function(e){
        state.updating = false;
        btn.disabled = false;
        btn.textContent = "Update to " + u.latest;
        if (log) log.textContent = e.message;
        toast(e.message);
      });
    }

    /** Poll /api/health until the daemon answers again, then reload onto it. */
    function waitForNewBuild(){
      var log = document.getElementById("updlog");
      var deadline = Date.now() + 15 * 60000;
      var wentDown = false;
      var t = setInterval(function(){
        fetch("/api/health").then(function(r){ return r.json(); }).then(function(h){
          if (!wentDown) return; // still the old daemon; wait for it to go
          clearInterval(t);
          if (log) log.textContent = "back on build " + String(h.rev || "").slice(0, 7) + " — reloading";
          setTimeout(function(){ location.reload(); }, 600);
        }).catch(function(){
          wentDown = true;
          if (log) log.textContent = "the daemon is restarting on the new build…";
        });
        if (Date.now() > deadline) {
          clearInterval(t);
          if (log) log.textContent = "the update is taking longer than expected — see the Console, or run loom up --restart";
        }
      }, 1500);
      state.timers.push(t);
    }

    // ---- Devices: paired clients, revoke, add -------------------------------
    function pairNewDevice(){
      var out = document.getElementById("devpairout");
      out.innerHTML = LOADER;
      sapi("/api/pair/new", { method: "POST", body: "{}" }).then(function(p){
        var mins = p.expiresAt ? Math.max(1, Math.round((p.expiresAt - Date.now()) / 60000)) : 10;
        var link = p.link || (p.url + "/#pair=" + p.token);
        out.innerHTML = '<div class="snote">On the other device, open <b>' + esc(p.url) +
          "</b> and it will pair automatically from this link. It works once and expires in about " + mins + " minutes.</div>" +
          (/[#&]relay=/.test(link) ? '<span class="cloudbadge">' + ICONS.cloud + "Works anywhere via Loom Cloud</span>" : "") +
          '<code class="scmd">' + esc(link) + "</code>";
      }).catch(function(e){
        // Only an admin client (the one holding the daemon's own token, i.e. the
        // desktop shell) may mint pairing tokens. A paired phone can't — say so,
        // and point at the CLI path that always works from this machine.
        var adminOnly = /admin/i.test(e.message || "");
        out.innerHTML = adminOnly
          ? '<div class="snote">Only an admin client can add a device from here. From a terminal on this machine:</div><code class="scmd">loom pair</code>'
          : '<div class="snote">' + esc(e.message) + "</div>";
      });
    }
    function revokeDevice(id){
      var me = id === state.clientId;
      askConfirm(me ? "Revoke THIS device? You\u2019ll be signed out and have to pair again."
        : "Revoke this device? Its token stops working immediately.", { ok: "Revoke", danger: true }).then(function(ok){
        if (!ok) return;
        sapi("/api/pair/clients/" + encodeURIComponent(id), { method: "DELETE" }).then(function(){
          if (me) { close(); logout(); return; }
          toast("device revoked");
          renderDevices();
        }).catch(function(e){ toast(e.message); });
      });
    }
    // Unused: not seen for 30 days, or never used a week after pairing. Every
    // re-pair mints a new entry, so these pile up; never this device.
    var DAY = 24 * 3600 * 1000;
    function isStale(c){
      if (c.id === state.clientId) return false;
      if (c.lastSeen) return Date.now() - c.lastSeen > 30 * DAY;
      return Date.now() - Number(c.createdAt || 0) > 7 * DAY;
    }
    function removeStale(list){
      askConfirm("Remove " + list.length + " unused device" + (list.length === 1 ? "" : "s") + "?\n\nTheir tokens stop working. Anything you still use can pair again in a minute.", { ok: "Remove them", danger: true })
        .then(function(ok){
          if (!ok) return;
          return Promise.all(list.map(function(c){ return sapi("/api/pair/clients/" + encodeURIComponent(c.id), { method: "DELETE" }).catch(function(){ return null; }); }))
            .then(function(){ toast("removed " + list.length + " unused device" + (list.length === 1 ? "" : "s")); renderDevices(); });
        });
    }
    function renderDevices(){
      busy();
      sapi("/api/pair/clients").then(function(d){
        var clients = (d.clients || []).slice().sort(function(a, b){
          return (Number(b.lastSeen) || Number(b.createdAt) || 0) - (Number(a.lastSeen) || Number(a.createdAt) || 0);
        });
        var stale = clients.filter(isStale);
        var h = '<div class="setphead">Devices</div>' +
          '<div class="setpsub">Every client paired to this Loom. Revoke one and its token stops working at once.</div>';
        h += '<div class="pillrow"><button class="btn primary sm" id="devpair">Pair a new device</button>' +
          (stale.length ? '<button class="btn ghost sm" id="devstale">Remove ' + stale.length + " unused</button>" : "") + '</div><div id="devpairout"></div>';
        if (!clients.length) h += '<div class="snote">No devices paired yet.</div>';
        clients.forEach(function(c){
          var me = c.id === state.clientId;
          h += '<div class="dev' + (isStale(c) ? " stale" : "") + '"><div class="di">' + ICONS.agents + "</div>" +
            '<div class="dn"><div class="dnt">' + esc(c.name || "device") + (me ? ' <span class="devme">this device</span>' : "") + "</div>" +
            '<div class="dnd">' + (c.lastSeen ? "last used " + rel(c.lastSeen) : "not used since pairing") + " \u00b7 paired " + rel(c.createdAt) + (c.push ? " \u00b7 push on" : "") + "</div></div>" +
            '<button class="btn ghost sm" data-revoke="' + esc(c.id) + '">Revoke</button></div>';
        });
        pane.innerHTML = h;
        document.getElementById("devpair").onclick = pairNewDevice;
        var ds = document.getElementById("devstale"); if (ds) ds.onclick = function(){ removeStale(stale); };
        Array.prototype.forEach.call(pane.querySelectorAll("[data-revoke]"), function(b){
          b.onclick = function(){ revokeDevice(b.getAttribute("data-revoke")); };
        });
      }).catch(fail);
    }

    // ---- Loom Cloud: the phone reaches this machine from any network ---------
    // The daemon holds a Supabase Realtime channel open and relays the phone's
    // requests through it, sealed end to end: the key travels only in the
    // pairing link's fragment, so Supabase carries ciphertext it cannot read.
    var cloudErr = "";
    function renderCloud(){
      busy();
      sapi("/api/cloud").then(drawCloud).catch(fail);
    }
    function drawCloud(c){
      c = c || {};
      var err = cloudErr || c.error || "";
      var h = '<div class="setphead">Loom Cloud</div>' +
        '<div class="setpsub">Reach this computer from your phone on any network. End-to-end encrypted \u2014 Supabase only relays ciphertext.</div>';
      h += '<div class="cloudst" id="cloudst">';
      if (c.connected) h += '<span class="updpill ok">Connected</span>';
      else if (c.enabled) h += '<span class="updpill warn">On \u00b7 not connected</span>';
      else h += '<span class="updpill" style="color:var(--muted-foreground);background:var(--muted)">Off</span>';
      if (c.enabled) h += '<span class="hintx">' + Number(c.clients || 0) + " phone" + (Number(c.clients) === 1 ? "" : "s") + " connected through the cloud</span>";
      h += "</div>";
      if (err) h += '<div class="snote" style="color:var(--err)">' + esc(err) + "</div>";
      if (c.stats) {
        h += '<dl class="abgrid"><dt>Requests</dt><dd>' + Number(c.stats.requests || 0) + "</dd>" +
          "<dt>Frames</dt><dd>" + Number(c.stats.frames || 0) + "</dd>" +
          "<dt>Rejected</dt><dd>" + Number(c.stats.rejected || 0) + "</dd></dl>";
      }
      // Loom's own relay project is the default, so there's nothing to fill
      // in; your own Supabase project is an option, not a prerequisite.
      var own = !!(c.supabaseUrl && c.supabaseUrl !== c.hostedUrl && c.hostedUrl);
      h += '<details class="cloudadv"' + (own ? " open" : "") + '><summary>Use your own Supabase project…</summary>';
      h += '<div class="cloudin">' +
        '<div class="field"><label for="cloudurl">Supabase URL</label>' +
        '<input id="cloudurl" placeholder="https://your-project.supabase.co" autocomplete="off" spellcheck="false" value="' + esc(c.supabaseUrl || "") + '"></div>' +
        '<div class="field"><label for="cloudkey">Anon key <span class="opt">' + (c.configured ? "\u2014 blank keeps the saved one" : "") + "</span></label>" +
        '<input id="cloudkey" type="password" placeholder="' + (c.configured ? "\u2022\u2022\u2022\u2022\u2022\u2022 saved" : "eyJhbGciOi\u2026") + '" autocomplete="off" spellcheck="false"></div>' +
        "</div></details>";
      h += '<div class="pillrow">' +
        '<button class="btn primary sm" id="cloudon">' + (c.enabled ? "Save & reconnect" : "Enable") + "</button>" +
        (c.enabled ? '<button class="btn ghost sm" id="cloudoff">Disable</button>' : "") +
        '<button class="btn ghost sm" id="cloudrot" title="a new channel and key">Rotate key</button></div>';
      h += '<div class="snote">After enabling, pair the phone again (Connect a phone): its link now carries the relay, and the pairing dialog says <b>Works anywhere via Loom Cloud</b>. Rotating the key signs out every phone that paired through the cloud.</div>';
      pane.innerHTML = h;
      cloudErr = "";
      function act(action, body, btn){
        btn.disabled = true;
        sapi("/api/cloud/" + action, { method: "POST", body: JSON.stringify(body || {}) })
          .then(function(s){ toast(action === "enable" ? (s.connected ? "Loom Cloud connected" : "Loom Cloud on") : action === "disable" ? "Loom Cloud off" : "new key \u2014 re-pair cloud phones"); drawCloud(s); })
          .catch(function(e){ cloudErr = e.message; toast(e.message); renderCloud(); });
      }
      document.getElementById("cloudon").onclick = function(){
        var url = document.getElementById("cloudurl").value.trim();
        var key = document.getElementById("cloudkey").value.trim();
        var body = {};
        if (url && url !== (c.supabaseUrl || "")) body.supabaseUrl = url;
        if (key) body.anonKey = key;
        act("enable", body, this);
      };
      var off = document.getElementById("cloudoff");
      if (off) off.onclick = function(){ act("disable", {}, off); };
      document.getElementById("cloudrot").onclick = function(){
        if (!window.confirm("Rotate the Loom Cloud key? Every phone paired through the cloud has to pair again.")) return;
        act("rotate", {}, this);
      };
    }

    // ---- Team: this machine on a Loom Team Hub (daemon/team.ts) --------------
    // Sign-in, teams, members, invites and keys. It edits the same state.team
    // Fleet draws from, so an action here repaints the Team block there too;
    // a teammate's frame repaints this pane, unless you're mid-typing.
    function teamSact(action, body){
      return sapi("/api/team/" + action, { method: "POST", body: JSON.stringify(body || {}) }).then(function(j){
        if (j && j.team) { state.team = j.team; state.teamErr = ""; teamNotify(true); }
        return j ? j.result : null;
      });
    }
    teamHooks().settings = function(force){
      if (cur !== "team" || !pane.isConnected || !state.team) return;
      if (!force && teamEditing(pane)) return;
      drawTeamSettings();
    };
    function renderTeam(){
      busy();
      // the hook above paints the pane from what arrives
      sapi("/api/team").then(function(j){ state.team = j; state.teamErr = ""; teamNotify(true); }).catch(fail);
    }
    // ---- the landing doctor (D62): is this repo set up to land safely? ------
    // Merge queue, required checks, workflows that run on merge_group. Run on
    // request (it asks GitHub); the one fix it makes is a PR, never a setting.
    var tdoc = null; // {loading} | {data} | {err}, plus {fix: {prUrl, files}} once asked
    function doctorHtml(){
      if (!pid) return "";
      var pr = (state.projects || []).filter(function(x){ return x.id === pid; })[0];
      var d = tdoc && tdoc.data;
      var icon = { ok: ICONS.check, warn: ICONS.alert, error: ICONS.x };
      var h = '<div class="sgrouph">Landing doctor</div><div class="tpol tdoc" data-tdoctor="' + esc(pid) + '">' +
        '<div class="tpolh">' + ICONS.shield + "<b>" + esc((pr && pr.name) || "This project") + "</b>" +
          (d ? "<small>" + esc((d.repo || "no GitHub repo") + " · " + d.branch) + "</small>" : "") + "</div>";
      if (!tdoc) h += '<div class="tpols">Checks the repo can land goal PRs safely: a merge queue or required checks on the default branch, and workflows that also run in the queue.</div>';
      else if (tdoc.loading) h += LOADER;
      else if (tdoc.err) h += '<div class="tpols" style="color:var(--err)">' + esc(tdoc.err) + "</div>";
      if (d) h += (d.findings || []).map(function(f){
        return '<div class="tdocf ' + esc(f.level) + '" data-tdocf="' + esc(f.level) + '">' + (icon[f.level] || ICONS.info) +
          "<span>" + esc(f.what) + (f.fix ? "<small>" + esc(f.fix) + "</small>" : "") + "</span></div>";
      }).join("");
      var fix = tdoc && tdoc.fix;
      if (fix) h += '<div class="tpols tdocpr">' + (fix.prUrl ? 'Opened <a href="' + esc(fix.prUrl) + '" target="_blank" rel="noreferrer">' + esc(fix.prUrl) + "</a>" : "Nothing to fix") +
        ((fix.files || []).length ? " — " + fix.files.map(function(f){ return "<code>" + esc(f) + "</code>"; }).join(", ") : "") + "</div>";
      h += '<div class="pillrow"><button class="btn outline sm" type="button" data-tdocrun' + (tdoc && tdoc.loading ? " disabled" : "") + ">" + (d ? "Check again" : "Run doctor") + "</button>" +
        (d && (d.fixable || []).length && !(fix && fix.prUrl) ? '<button class="btn primary sm" type="button" data-tdocfix>Open fix PR</button>' +
          '<span class="hintx">adds <b>merge_group:</b> to ' + d.fixable.length + " workflow" + (d.fixable.length === 1 ? "" : "s") + "</span>" : "") + "</div></div>";
      return h;
    }
    function wireDoctor(){
      var redraw = function(){ if (cur === "team" && pane.isConnected) drawTeamSettings(); };
      var run = pane.querySelector("[data-tdocrun]");
      if (run) run.onclick = function(){
        tdoc = { loading: true }; redraw();
        sapi("/api/projects/" + pid + "/team/doctor").then(function(j){ tdoc = { data: j }; }, function(err){ tdoc = { err: err.message || String(err) }; }).then(redraw);
      };
      var fx = pane.querySelector("[data-tdocfix]");
      if (fx) fx.onclick = function(){
        fx.disabled = true;
        sapi("/api/projects/" + pid + "/team/doctor/fix", { method: "POST", body: "{}" }).then(function(j){
          tdoc = { data: tdoc && tdoc.data, fix: j }; toast(j && j.prUrl ? "opened the fix PR" : "nothing to fix"); redraw();
        }).catch(function(err){ fx.disabled = false; toast(err.message); });
      };
    }
    // ---- this machine as a runner (D67, D74): admin-only, it's this daemon ----
    // Start/Stop take jobs from the hub; Pair makes the one-time link another
    // box joins with. Below, this project's runners that are mine, revocable.
    var trun = null, tpair = null, trShared = null; // status {loading}|{data}|{err}; the pairing link while shown; the toggle before Start
    function loadRunnerStatus(){
      trun = { loading: true, data: trun && trun.data };
      sapi("/api/runner").then(function(j){ trun = { data: j }; }, function(err){ trun = { err: err.message || String(err) }; })
        .then(function(){ if (cur === "team" && pane.isConnected) drawTeamSettings(); });
    }
    function runnerSact(action, body){
      return sapi("/api/runner/" + action, { method: "POST", body: JSON.stringify(body || {}) }).then(function(j){ loadRunnerStatus(); return j ? j.result : null; });
    }
    function runnerPanelHtml(){
      if (!trun) loadRunnerStatus();
      if (pid && !teamRunners[pid]) loadTeamRunners(pid); // the list below; paints again when it lands
      var d = (trun && trun.data) || null, cfg = (d && d.config) || {};
      var shared = trShared != null ? trShared : !!cfg.shared;
      var mine = pid ? ((teamRunners[pid] || {}).runners || []).filter(function(r){ return r.mine; }) : [];
      var h = '<div class="sgrouph">This machine as a runner</div><div class="tpol trunpanel" data-trunpanel>' +
        '<div class="tpolh">' + ICONS.orchestra + "<b>" + (d ? (d.running ? "Running" : "Stopped") : "Runner") + "</b>" +
          (d ? "<small>" + [cfg.shared ? "shared" : "personal", Number(cfg.capacity || 1) + " at a time", cfg.isolation || "", (cfg.kinds || []).join(", ")]
            .filter(Boolean).map(esc).join(" \u00b7 ") + "</small>" : "") + "</div>" +
        '<div class="tpols">Takes your goals from the hub \u2014 Start or Continue on runner, CI fixes while you\u2019re away \u2014 each in a fresh container with your agent logins and a GitHub token, nothing else. Usually an always-on box; this machine works too.</div>';
      if (!d && trun && trun.loading) h += LOADER;
      if (trun && trun.err) h += '<div class="tpols" style="color:var(--err)">' + esc(trun.err) + "</div>";
      if (d) h += (d.active || []).map(function(a){
        return '<div class="tdocf ok" data-tractive="' + esc(a.jobId) + '">' + ICONS.orchestra + "<span>" + esc(JOB_KIND[a.kind] || a.kind) + " \u00b7 <code>" + esc(a.repo || "") + "</code>" +
          (a.owner ? " for <b>" + esc(a.owner) + "</b>" : "") + "</span></div>";
      }).join("");
      if (d && d.lastError) h += '<div class="tdocf error">' + ICONS.x + "<span>" + esc(d.lastError) + "</span></div>";
      if (d && d.running && !d.token) h += '<div class="tdocf warn">' + ICONS.alert + "<span>No GitHub token for the runner<small>loom runner join takes a fine-grained token (contents and pull requests only), or uses gh auth</small></span></div>";
      h += '<label class="trsw"><input type="checkbox" data-trshared' + (shared ? " checked" : "") + "><span>Shared" +
        "<small>take teammates\u2019 goals when their repo\u2019s loom.team.json allows <code>runners.shared</code> \u2014 billed to you, shown in the feed</small></span></label>";
      h += '<div class="pillrow">' + (d && d.running ? '<button class="btn outline sm" type="button" data-trstop>Stop</button>' : '<button class="btn primary sm" type="button" data-trstart>Start</button>') +
        '<button class="btn outline sm" type="button" data-trpair>Pair a runner</button><span class="hintx">another box, with <b>loom runner join</b></span></div>';
      if (tpair) h += '<div class="tinv" data-trpairbox><div class="tinvw">' + ICONS.shield + "<span><b>It carries your team keys; send it like a password.</b> Whoever opens it can sign in as you on a runner and read every team goal. Use it once, on your own box.</span></div>" +
        '<div class="tinvrow"><input readonly class="tinvlink" aria-label="runner pairing link" value="' + esc(tpair) + '">' +
          '<button class="btn ghost sm" type="button" data-trpshow>Show</button>' +
          '<button class="btn outline sm" type="button" data-trpcopy>' + ICONS.copy + "Copy</button>" +
          '<button class="iconbtn" type="button" data-trphide title="forget this link" aria-label="forget this link">' + ICONS.x + "</button></div>" +
        "<span class=\"tinvx\">on the runner: <code class=\"trcmd\">loom runner join '\u2026'</code> " +
          '<button class="btn ghost xs" type="button" data-trpcmd>Copy command</button></span></div>';
      if (mine.length) h += '<div class="trsub">Your runners</div>' + mine.map(function(r){
        return '<div class="trn" data-trmine="' + esc(r.deviceId) + '"><span class="tnt"><span class="odot ' + (r.online ? "ok" : "off") + '"></span><b>' + esc(runnerName(r)) + "</b>" +
          (r.shared ? '<span class="tbdg">shared</span>' : "") + "<small>" + (esc((r.kinds || []).join(", ")) || "no agents yet") + " \u00b7 " + (r.online ? "online" : "seen " + rel(r.lastSeen)) + "</small></span>" +
          '<button class="btn ghost sm danger" type="button" data-trrevoke="' + esc(r.deviceId) + '" data-trlabel="' + esc(runnerName(r)) + '">Revoke</button></div>';
      }).join("");
      return h + "</div>";
    }
    function wireRunnerPanel(){
      var box = pane.querySelector("[data-trunpanel]"); if (!box) return;
      var redraw = function(){ if (cur === "team" && pane.isConnected) drawTeamSettings(); };
      var fail = function(b){ return function(err){ if (b) b.disabled = false; toast(err.message); }; };
      var sh = box.querySelector("[data-trshared]");
      if (sh) sh.onchange = function(){
        trShared = sh.checked;
        // running: restart with the new setting; stopped: it applies on Start
        if (trun && trun.data && trun.data.running) runnerSact("start", { shared: sh.checked }).then(function(){ toast(sh.checked ? "shared \u2014 takes teammates\u2019 goals" : "personal \u2014 your goals only"); }, fail(null));
      };
      var st = box.querySelector("[data-trstart]");
      if (st) st.onclick = function(){ st.disabled = true; runnerSact("start", trShared != null ? { shared: trShared } : {}).then(function(){ toast("runner started"); }, fail(st)); };
      var sp = box.querySelector("[data-trstop]");
      if (sp) sp.onclick = function(){ sp.disabled = true; runnerSact("stop").then(function(){ toast("runner stopped"); }, fail(sp)); };
      var pr = box.querySelector("[data-trpair]");
      if (pr) pr.onclick = function(){ pr.disabled = true; runnerSact("pair").then(function(r){ tpair = (r && r.link) || null; redraw(); }, fail(pr)); };
      var inp = box.querySelector("[data-trpairbox] .tinvlink");
      var ps = box.querySelector("[data-trpshow]");
      if (ps) ps.onclick = function(){ var on = inp.classList.toggle("shown"); ps.textContent = on ? "Hide" : "Show"; };
      var pc = box.querySelector("[data-trpcopy]"); if (pc) pc.onclick = function(){ inp.select(); copyText(tpair); };
      var pm = box.querySelector("[data-trpcmd]"); if (pm) pm.onclick = function(){ copyText("loom runner join '" + tpair + "'"); };
      var ph = box.querySelector("[data-trphide]"); if (ph) ph.onclick = function(){ tpair = null; redraw(); };
      Array.prototype.forEach.call(box.querySelectorAll("[data-trrevoke]"), function(b){
        b.onclick = function(){
          var label = b.getAttribute("data-trlabel");
          if (!window.confirm("Revoke " + label + "? It\u2019s removed from the hub and every team key rotates: your devices and teammates get the new key automatically; the runner can\u2019t read anything new.")) return;
          b.disabled = true;
          runnerSact("revoke", { deviceId: b.getAttribute("data-trrevoke") }).then(function(){ toast("revoked " + label + " \u2014 team keys rotated"); if (pid) loadTeamRunners(pid, true); }, fail(b));
        };
      });
    }
    function drawTeamSettings(){
      var t = state.team || {}, teams = t.teams || [];
      var h = '<div class="setphead">Team</div>' +
        '<div class="setpsub">See what your teammates\u2019 agents are working on, live. Goal and task titles are end-to-end encrypted with the team key; prompts and transcripts never leave this machine.</div>';
      h += '<div class="cloudst" id="teamst">' + (t.signedIn
        ? '<span class="updpill ok">Signed in</span><span class="hintx"><b>' + esc(t.github) + "</b> on " + esc(t.hub) + "</span>"
        : '<span class="updpill" style="color:var(--muted-foreground);background:var(--muted)">Not signed in</span>') + "</div>";
      teams.forEach(function(tm){
        var owner = tm.role === "owner", members = tm.members || [];
        h += '<div class="sgrouph">' + esc(tm.name) + " \u00b7 " + esc(tm.role) + (tm.keyVersion != null ? " \u00b7 key v" + esc(tm.keyVersion) : "") + "</div>";
        h += '<div data-tsettings="' + esc(tm.id) + '">';
        members.forEach(function(m){
          var me = m.github === t.github;
          h += '<div class="dev tsetmem" data-tsmem="' + esc(m.github) + '">' + teamAvatar(m.github) +
            '<div class="dn"><div class="dnt">' + esc(m.github) + ' <span class="trole">' + esc(m.role) + "</span>" + (me ? ' <span class="devme">you</span>' : "") + "</div>" +
            '<div class="dnd">' + (m.name && m.name !== m.github ? esc(m.name) + " \u00b7 " : "") + Number(m.devices || 0) + " device" + (Number(m.devices) === 1 ? "" : "s") + "</div></div>" +
            (owner && !me ? '<button class="btn ghost sm danger" type="button" data-tremove="' + esc(m.id) + '" data-tteamid="' + esc(tm.id) + '" data-tlogin="' + esc(m.github) + '">Remove</button>' : "") + "</div>";
        });
        h += '<div class="snote">Repos: ' + ((tm.repos || []).map(function(r){ return "<b>" + esc(r) + "</b>"; }).join(", ") || "none shared yet") +
          ". A project is shared when you choose Shared, or automatically when its origin remote is one of these.</div>";
        // each of this machine's projects shared with this team, and the policy its repo sets
        (state.projects || []).forEach(function(pr){
          if (!teamShares[pr.id]) loadTeamShare(pr.id); // paints again when it lands
          var sh = teamShareOf(pr.id);
          if (sh.mode === "private" || !sh.team || sh.team.id !== tm.id) return;
          h += teamPolicyHtml(pr.id, pr.name + (sh.repo ? " \u00b7 " + sh.repo : ""));
        });
        h += teamInviteHtml(tm.id);
        h += '<div class="pillrow">' +
          (tm.role !== "viewer" ? '<button class="btn primary sm" type="button" data-tinvite="' + esc(tm.id) + '">Invite</button>' : "") +
          (owner ? '<button class="btn ghost sm" type="button" data-trotate="' + esc(tm.id) + '">Rotate key</button>' : "") +
          '<button class="btn ghost sm" type="button" data-tleave="' + esc(tm.id) + '">Leave</button></div></div>';
      });
      h += doctorHtml();
      if (t.signedIn) h += runnerPanelHtml();
      // your teams first; then making or joining another
      if (!t.signedIn) {
        // The hosted hub first: one button, your GitHub account. The form
        // below is for teams running their own loom hub.
        h += '<div class="sgrouph">Sign in</div>' +
          '<div class="pillrow"><button class="btn primary sm" type="button" id="tghsign">' + ICONS.github + "Sign in with GitHub</button>" +
          '<span class="hintx" id="tghnote">Uses the hosted Loom Team Hub. Only titles you share are sent, encrypted.</span></div>' +
          '<div class="sgrouph">Or use your own hub</div><div class="cloudin">' +
          teamField("Hub URL", "hub", 'class="mono" placeholder="https://hub.example.com"') +
          teamField('GitHub login <span class="opt">\u2014 blank uses the gh CLI\u2019s</span>', "cgh", 'placeholder="your GitHub username"') +
          teamField('Join secret <span class="opt">if the hub has one</span>', "csec", 'type="password"') + "</div>" +
          '<div class="pillrow"><button class="btn primary sm" type="button" data-tsignin>Sign in</button>' +
          '<span class="hintx">No hub yet? Run <b>loom hub --secret &lt;s&gt;</b> where your team can reach it.</span></div>';
      } else {
        h += '<div class="sgrouph">Create a team</div><div class="cloudin">' + teamField("Team name", "name", 'placeholder="e.g. Acme"') + "</div>" +
          '<div class="pillrow"><button class="btn outline sm" type="button" data-tcreate>Create team</button></div>';
      }
      h += '<div class="sgrouph">Join a team</div><div class="cloudin">' +
        teamField("Invite link", "link", 'class="mono" placeholder="https://\u2026/join/#\u2026"') + "</div>" +
        '<div class="pillrow"><button class="btn outline sm" type="button" data-tjoin>Join team</button>' +
        '<span class="hintx">' + (t.signedIn ? "The link names its hub; you join as " + esc(t.github) + "." : "Signs in to the link\u2019s hub with the login and secret above.") + "</span></div>";
      pane.innerHTML = h;
      var ghb = document.getElementById("tghsign");
      if (ghb) ghb.onclick = function(){
        var note = document.getElementById("tghnote");
        ghb.disabled = true;
        // Open the tab now, inside the click: a window opened after the
        // request comes back is a popup, and browsers block it silently.
        // (The desktop app hands every outside link to your real browser and
        // blocks nothing, so there it opens the URL itself once it has it.)
        var electron = isElectron();
        var win = null;
        if (!electron) { try { win = window.open("about:blank", "_blank"); } catch (e) { win = null; } }
        sapi("/api/team/hosted-signin", { method: "POST", body: "{}" }).then(function(j){
          if (j && j.url) {
            if (electron) window.open(j.url, "_blank");
            else if (win && !win.closed) { try { win.opener = null; } catch (e) {} win.location.href = j.url; }
            else if (note) { note.innerHTML = 'Your browser blocked the sign-in window — <a href="' + esc(j.url) + '" target="_blank" rel="noopener">open it here</a>.'; return; }
          }
          if (note) note.textContent = "Finish signing in with GitHub in the browser tab that opened — this page updates on its own.";
          // wait for the session to land (the daemon holds the callback)
          var tries = 0;
          var iv = setInterval(function(){
            if (++tries > 300 || !document.getElementById("tghsign")) { clearInterval(iv); return; }
            sapi("/api/team/hosted-signin").then(function(st){
              if (st && st.error) { clearInterval(iv); ghb.disabled = false; if (note) note.textContent = "Sign-in didn’t finish: " + st.error; return; }
              return sapi("/api/team").then(function(tt){ if (tt && tt.signedIn) { clearInterval(iv); state.team = tt; toast("signed in as " + (tt.github || "you")); renderTeam(); } });
            }).catch(function(){});
          }, 2000);
        }).catch(function(e){ if (win && !win.closed) win.close(); ghb.disabled = false; if (note) note.textContent = e.message; });
      };
      wireTeamForms(pane, teamSact);
      wireTeamInvites(pane, teamSact);
      wireDoctor();
      wireRunnerPanel();
      var nameOf = function(id){ var x = teams.filter(function(y){ return y.id === id; })[0]; return x ? x.name : "the team"; };
      var kvOf = function(id){ var x = teams.filter(function(y){ return y.id === id; })[0]; return x && x.keyVersion != null ? Number(x.keyVersion) : 0; };
      Array.prototype.forEach.call(pane.querySelectorAll("[data-tremove]"), function(b){
        b.onclick = function(){
          var id = b.getAttribute("data-tteamid"), who = b.getAttribute("data-tlogin");
          if (!window.confirm("Remove " + who + " from " + nameOf(id) + "?\n\nThe team key rotates to v" + (kvOf(id) + 1) + ": " + who +
            " keeps what they already saw, but can\u2019t read anything new. Everyone else\u2019s devices get the new key automatically.")) return;
          b.disabled = true;
          teamSact("remove", { userId: b.getAttribute("data-tremove"), teamId: id })
            .then(function(r){ toast("removed " + who + " \u2014 key rotated to v" + ((r && r.keyVersion) || "?")); })
            .catch(function(e){ b.disabled = false; toast(e.message); });
        };
      });
      Array.prototype.forEach.call(pane.querySelectorAll("[data-trotate]"), function(b){
        b.onclick = function(){
          var id = b.getAttribute("data-trotate");
          if (!window.confirm("Rotate the key for " + nameOf(id) + "? Every member\u2019s device is sent the new key; anything published from now on is sealed with it.")) return;
          b.disabled = true;
          teamSact("rotate", { teamId: id })
            .then(function(r){ toast("key rotated to v" + ((r && r.keyVersion) || "?")); })
            .catch(function(e){ b.disabled = false; toast(e.message); });
        };
      });
      Array.prototype.forEach.call(pane.querySelectorAll("[data-tleave]"), function(b){
        b.onclick = function(){
          var id = b.getAttribute("data-tleave");
          if (!window.confirm("Leave " + nameOf(id) + "? You stop seeing its sessions and feed, and your projects stop publishing to it.")) return;
          b.disabled = true;
          teamSact("leave", { teamId: id })
            .then(function(){ delete teamInvites[id]; toast("left " + nameOf(id)); })
            .catch(function(e){ b.disabled = false; toast(e.message); });
        };
      });
    }

    // ---- About --------------------------------------------------------------
    function renderAbout(){
      busy();
      sapi("/api/health").then(function(hh){
        var shortRev = (hh.rev || "").slice(0, 7);
        var h = '<div class="abhead"><div class="abmark">lo<b>om</b></div>' +
          '<div><div style="font-size:13px;font-weight:600">Agent orchestration</div>' +
          '<div class="abver">v' + esc(hh.version) + " \u00b7 " + esc(shortRev) + "</div></div></div>";
        h += '<div class="setpsub">One thread, many agents \u2014 they share a working tree, a baton, and a brain.</div>';
        h += '<dl class="abgrid"><dt>Version</dt><dd>' + esc(hh.version) + "</dd>" +
          "<dt>Build</dt><dd>" + esc(hh.rev || "\u2014") + "</dd>" +
          "<dt>Terminal</dt><dd>" + esc(hh.terminal || "\u2014") + "</dd></dl>";
        h += '<div class="ablinks">' +
          '<a href="https://github.com/nickthelegend/loom" target="_blank" rel="noreferrer">' + ICONS.github + "GitHub</a>" +
          '<a href="https://github.com/nickthelegend/loom/blob/main/README.md" target="_blank" rel="noreferrer">' + ICONS.info + "Docs</a></div>";
        h += '<div class="setpsub" style="margin-top:16px">Brand marks by @lobehub/icons. The memory layer follows mem0.</div>';
        pane.innerHTML = h;
      }).catch(fail);
    }

    function render(){
      gen++;
      if (cur === "diagnostics") renderDiag();
      else if (cur === "preferences") renderPrefs();
      else if (cur === "updates") renderUpdates();
      else if (cur === "devices") renderDevices();
      else if (cur === "cloud") renderCloud();
      else if (cur === "team") renderTeam();
      else if (cur === "about") renderAbout();
      else renderSetup();
    }
    drawNav();
    render();
  }

  // The sidebar foot and the first-run nudge open Settings on its Setup section.
  function openSetupModal(){ openSettingsModal("setup"); }


  // Per-project settings: toggle agents on/off and set each agent's role. Every
  // change lands on .loom/config.json and re-renders the fleet everywhere.
  function openProjectSettings(pid){
    if (document.querySelector(".scrim")) return;
    var scrim = document.createElement("div"); scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal psetmodal"><div class="modalhead">Project settings<button class="iconbtn" id="psx" aria-label="close">' + ICONS.x + '</button></div><div class="modalbody" id="psbody"><div class="loader"><i></i><i></i><i></i><i></i></div></div></div>';
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); delete teamHooks().pset; }
    function onKey(e){ if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("psx").onclick = close;
    function afterChange(){
      load();
      if (state.refreshProjects) state.refreshProjects();
      if (state.selectProject && state.project && state.project.id === pid) state.selectProject(pid);
    }
    function renderBody(p){
      var body = document.getElementById("psbody"); if (!body) return;
      var agents = p.agents || [];
      var roleOpts = ["planner", "builder", "reviewer", "executor", "researcher", "general"];
      var rows = agents.map(function(a){
        var on = a.enabled !== false;
        var opts = roleOpts.slice();
        if (a.role && opts.indexOf(a.role) < 0) opts.push(a.role);
        var roleSel = '<select class="psrole" data-agent="' + esc(a.id) + '"' + (on ? "" : " disabled") + ">" +
          opts.map(function(r){ return '<option value="' + esc(r) + '"' + (r === a.role ? " selected" : "") + ">" + esc(r) + "</option>"; }).join("") + "</select>";
        return '<div class="psrow' + (on ? "" : " off") + '">' +
          '<label class="psswitch" aria-label="toggle ' + esc(a.id) + '"><input type="checkbox" class="psen" data-agent="' + esc(a.id) + '"' + (on ? " checked" : "") + (a.holdsBaton ? " disabled" : "") + '><span class="pssl"></span></label>' +
          '<div class="psinfo"><div class="psname">' + esc(a.id) + (a.holdsBaton ? ' <span class="psbaton">baton</span>' : "") + '</div><div class="pskind">' + esc(a.kind) + (a.model ? " \u00b7 " + esc(a.model) : "") + "</div></div>" +
          '<div class="psrolewrap"><span class="pslabel">role</span>' + roleSel +
          '<button type="button" class="btn xs ' + (a.instructions ? "outline psinstr on" : "ghost psinstr") + '" data-instr="' + esc(a.id) + '" title="' +
            esc(a.instructions ? "Standing instructions: " + a.instructions.slice(0, 160) : "Add standing instructions this agent gets before every turn") + '">' +
            ICONS.pencil + (a.instructions ? "Instructions" : "Instruct") + "</button>" +
          '<button type="button" class="btn xs ghost psinstr" data-avatar="' + esc(a.id) + '" title="' + (a.avatar ? "change its picture" : "give this agent a picture") + '">' +
            (a.avatar ? '<img class="psav" src="' + a.avatar + '" alt="">' : ICONS.camera) + (a.avatar ? "Picture" : "Picture") + "</button>" +
          (a.avatar ? '<button type="button" class="btn xs ghost" data-avatarx="' + esc(a.id) + '" title="remove its picture" aria-label="remove picture">' + ICONS.x + "</button>" : "") +
          (a.kind === "model" ? '<button type="button" class="btn xs ghost psinstr" data-sampling="' + esc(a.id) + '" title="' +
            esc("Temperature " + (a.sampling && a.sampling.temperature != null ? a.sampling.temperature : "default") + " · max tokens " + (a.sampling && a.sampling.maxTokens ? a.sampling.maxTokens : "default")) + '">' +
            ICONS.gear + "Sampling</button>" : "") +
          '<button type="button" class="btn xs ghost psinstr" data-check="' + esc(a.id) + '" title="is it installed, signed in, and is its model there? No prompt is sent">' + ICONS.check + "Check</button>" +
          "</div></div>" + '<div class="pscheck" data-chkout="' + esc(a.id) + '"></div>';
      }).join("");
      body.innerHTML = '<div class="pshdr"><div class="psproj">' + esc(p.name) + '</div><div class="obsub">' + agents.length + " agents \u00b7 baton " + esc(p.holder || "\u2014") + "</div></div>" +
        '<div class="pssec">Agents \u2014 switch on/off, set each role</div><div class="psrows">' + rows + "</div>" +
        '<div class="pshint">Off agents stay in the roster but can\u2019t take turns or hold the baton. Changes land on the next turn \u2014 no restart. You can\u2019t switch off the baton holder; hand it off first.</div>' +
        '<div class="pssec" style="margin-top:14px">Policies \u2014 all off by default</div>' +
        '<div class="psrows" id="pspolicies"><div class="loader"><i></i><i></i><i></i><i></i></div></div>' +
        '<div class="pssec" style="margin-top:14px">Team</div><div id="psteam">' + LOADER + "</div>" +
        '<div class="pssec" style="margin-top:14px">Storage</div><div id="psstore" class="psstore">' + LOADER + "</div>";
      if (state.team) drawPsTeam(); else loadTeam().then(drawPsTeam);
      drawPsStore();
      // The policy toggles, from the same settings the CLI and config file use.
      api("/api/projects/" + pid + "/config").then(function(cfg){
        var host = document.getElementById("pspolicies"); if (!host) return;
        var POLS = [
          ["git.commitPerTurn", "Commit each turn", "one commit per turn, agent as co-author, staged by the turn\u2019s own files", (cfg.git || {}).commitPerTurn],
          ["git.branchPerTask", "Branch per card", "dragging a card to Working checks out task/<id>-<slug>", (cfg.git || {}).branchPerTask],
          ["git.worktreePerAgent", "Worktree per agent", "each agent in its own checkout on agent/<id> \u2014 applies to agents spawned from now on", (cfg.git || {}).worktreePerAgent],
          ["git.mergeOnHandoff", "Merge on handoff", "with worktrees on: the baton carries agent/&lt;from&gt; into the next agent\u2019s checkout \u2014 refused when either side has uncommitted work; a conflict stops a route", (cfg.git || {}).mergeOnHandoff],
          ["safety.snapshotBeforeRoutes", "Snapshot before routes", "checkpoint brain+board+config before a fleet runs unattended", (cfg.safety || {}).snapshotBeforeRoutes],
        ];
        host.innerHTML = POLS.map(function(pol){
          return '<div class="psrow">' +
            '<label class="psswitch" aria-label="' + esc(pol[1]) + '"><input type="checkbox" class="pspol" data-pol="' + pol[0] + '"' + (pol[3] ? " checked" : "") + '><span class="pssl"></span></label>' +
            '<div class="psinfo"><div class="psname">' + esc(pol[1]) + '</div><div class="pskind">' + pol[2] + "</div></div></div>";
        }).join("");
        Array.prototype.forEach.call(host.querySelectorAll(".pspol"), function(cb){
          cb.onchange = function(){
            var parts = cb.getAttribute("data-pol").split(".");
            var patch = {}; patch[parts[0]] = {}; patch[parts[0]][parts[1]] = cb.checked;
            api("/api/projects/" + pid + "/config", { method: "PATCH", body: JSON.stringify(patch) })
              .catch(function(err){ toast(err.message || "could not save"); cb.checked = !cb.checked; });
          };
        });
      }).catch(function(){
        var host = document.getElementById("pspolicies");
        if (host) host.innerHTML = '<div class="obsub">Policies unavailable \u2014 the daemon didn\u2019t answer.</div>';
      });
      Array.prototype.forEach.call(body.querySelectorAll(".psen"), function(cb){
        cb.onchange = function(){
          var agent = cb.getAttribute("data-agent");
          api("/api/projects/" + pid + "/agents/" + encodeURIComponent(agent) + "/enabled", { method: "PUT", body: JSON.stringify({ enabled: cb.checked }) })
            .then(afterChange).catch(function(err){ toast(err.message || "could not toggle"); cb.checked = !cb.checked; });
        };
      });
      /** Crop to a square and shrink to 96px on the device; only that small PNG is sent. */
      function pictureFrom(file){
        return new Promise(function(resolve, reject){
          if (!/^image\//.test(file.type)) return reject(new Error("that isn’t an image"));
          var url = URL.createObjectURL(file), img = new Image();
          img.onload = function(){
            var side = Math.min(img.width, img.height), c = document.createElement("canvas");
            c.width = c.height = 96;
            c.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 96, 96);
            URL.revokeObjectURL(url);
            resolve(c.toDataURL("image/png"));
          };
          img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error("couldn’t read that image")); };
          img.src = url;
        });
      }
      Array.prototype.forEach.call(body.querySelectorAll("[data-avatar]"), function(b){
        b.onclick = function(){
          var agent = b.getAttribute("data-avatar");
          var inp = document.createElement("input");
          inp.type = "file"; inp.accept = "image/png,image/jpeg,image/webp";
          inp.onchange = function(){
            var f = inp.files && inp.files[0]; if (!f) return;
            pictureFrom(f).then(function(dataUrl){
              return api("/api/projects/" + pid + "/agents/" + encodeURIComponent(agent) + "/avatar", { method: "PUT", body: JSON.stringify({ avatar: dataUrl }) });
            }).then(function(){ toast(agent + " has a picture now"); afterChange(); }).catch(function(err){ toast(err.message); });
          };
          inp.click();
        };
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-check]"), function(b){
        b.onclick = function(){
          var id = b.getAttribute("data-check");
          var out = body.querySelector('[data-chkout="' + id + '"]');
          if (!out) return;
          b.disabled = true;
          out.innerHTML = '<div class="pschk dim">checking ' + esc(id) + "…</div>";
          api("/api/projects/" + pid + "/agents/" + encodeURIComponent(id) + "/check", { method: "POST", body: "{}" }).then(function(r){
            out.innerHTML = '<div class="pschkhead ' + (r.ok ? "ok" : "bad") + '">' + (r.ok ? ICONS.check + esc(id) + " is ready" : ICONS.alert + esc(id) + " isn’t ready") +
              '<span class="dim"> · ' + (r.ms < 1000 ? r.ms + " ms" : (r.ms / 1000).toFixed(1) + " s") + "</span></div>" +
              (r.checks || []).map(function(c){
                return '<div class="pschk ' + (c.ok ? "ok" : "bad") + '"><span class="pschkn">' + (c.ok ? "✓ " : "✗ ") + esc(c.name) + "</span>" + esc(c.detail) + "</div>";
              }).join("");
          }).catch(function(err){
            out.innerHTML = '<div class="pschk bad">' + esc(err.message) + "</div>";
          }).then(function(){ b.disabled = false; });
        };
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-avatarx]"), function(b){
        b.onclick = function(){
          var agent = b.getAttribute("data-avatarx");
          api("/api/projects/" + pid + "/agents/" + encodeURIComponent(agent) + "/avatar", { method: "PUT", body: JSON.stringify({ avatar: null }) })
            .then(function(){ toast(agent + "’s picture removed"); afterChange(); }).catch(function(err){ toast(err.message); });
        };
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-sampling]"), function(b){
        b.onclick = function(){
          var agent = b.getAttribute("data-sampling");
          var a = (p.agents || []).filter(function(x){ return x.id === agent; })[0] || {};
          var cur = a.sampling || {};
          var sc = document.createElement("div");
          sc.className = "scrim cfscrim";
          sc.innerHTML = '<div class="modal cfmodal" role="dialog" aria-modal="true"><div class="cft">Sampling for ' + esc(agent) + "</div>" +
            '<div class="cfb">How ' + esc(agent) + ' writes. Leave a field blank for the provider’s default.</div>' +
            '<label class="cflab">Temperature <span>0 is steady, 1 is lively, up to 2</span><input class="cfin" id="smtemp" type="number" min="0" max="2" step="0.1" placeholder="default"></label>' +
            '<label class="cflab">Max tokens per reply <span>16 to 200000</span><input class="cfin" id="smmax" type="number" min="16" max="200000" step="1" placeholder="default"></label>' +
            '<div class="cfa"><button type="button" class="btn sm ghost" id="smcancel">Cancel</button><button type="button" class="btn sm primary" id="smsave">Save</button></div></div>';
          document.body.appendChild(sc);
          var t = document.getElementById("smtemp"), m = document.getElementById("smmax");
          if (cur.temperature != null) t.value = cur.temperature;
          if (cur.maxTokens) m.value = cur.maxTokens;
          function done(){ sc.remove(); document.removeEventListener("keydown", key, true); }
          function key(e){ if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); } }
          document.addEventListener("keydown", key, true);
          sc.onmousedown = function(e){ if (e.target === sc) done(); };
          document.getElementById("smcancel").onclick = done;
          document.getElementById("smsave").onclick = function(){
            var body2 = { temperature: t.value === "" ? null : Number(t.value), maxTokens: m.value === "" ? null : Number(m.value) };
            api("/api/projects/" + pid + "/agents/" + encodeURIComponent(agent) + "/sampling", { method: "PUT", body: JSON.stringify(body2) })
              .then(function(){ done(); toast(agent + " sampling saved — it takes on the next turn"); afterChange(); })
              .catch(function(err){
                var e = sc.querySelector(".mferr");
                if (!e) { e = document.createElement("div"); e.className = "mferr"; e.setAttribute("role", "alert"); sc.querySelector(".cfa").insertAdjacentElement("beforebegin", e); }
                e.textContent = err.message;
              });
          };
          setTimeout(function(){ t.focus(); }, 0);
        };
      });
      Array.prototype.forEach.call(body.querySelectorAll("[data-instr]"), function(b){
        b.onclick = function(){
          var agent = b.getAttribute("data-instr");
          var a = (p.agents || []).filter(function(x){ return x.id === agent; })[0] || {};
          askText("Standing instructions for " + agent, {
            value: a.instructions || "", multiline: true,
            placeholder: "e.g. Use pnpm, never npm. Don’t touch db/migrations. Keep replies short.",
            note: "Sent ahead of every turn " + agent + " takes in this project. Empty clears them.",
            ok: "Save",
          }).then(function(text){
            if (text === null) return;
            api("/api/projects/" + pid + "/agents/" + encodeURIComponent(agent) + "/instructions", { method: "PUT", body: JSON.stringify({ instructions: text }) })
              .then(function(r){ toast(r.instructions ? agent + " will get these before every turn" : agent + "’s instructions cleared"); afterChange(); })
              .catch(function(err){ toast(err.message); });
          });
        };
      });
      Array.prototype.forEach.call(body.querySelectorAll(".psrole"), function(sel){
        sel.onchange = function(){
          var agent = sel.getAttribute("data-agent");
          api("/api/projects/" + pid + "/agents/" + encodeURIComponent(agent) + "/role", { method: "POST", body: JSON.stringify({ role: sel.value }) })
            .then(afterChange).catch(function(err){ toast(err.message || "could not set role"); });
        };
      });
    }
    function kb(n){ return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }
    /** The event log on disk, and a button that gives back its free pages. */
    function drawPsStore(){
      var host = document.getElementById("psstore"); if (!host) return;
      api("/api/projects/" + pid + "/log/size").then(function(s){
        host.innerHTML = '<div class="psrow"><div class="psinfo"><div class="psname">Event log</div>' +
          '<div class="pskind">' + kb(s.bytes) + " · " + Number(s.events).toLocaleString() + " events — the whole history of this project’s threads</div></div>" +
          '<button type="button" class="btn xs outline" id="pscompact" title="reclaim space the log no longer uses (SQLite VACUUM) — nothing is deleted">Compact</button></div>';
        document.getElementById("pscompact").onclick = function(){
          var b = this; b.disabled = true; b.textContent = "Compacting…";
          api("/api/projects/" + pid + "/log/compact", { method: "POST", body: "{}" }).then(function(r){
            var saved = r.before.bytes - r.after.bytes;
            toast(saved > 0 ? "compacted — " + kb(saved) + " back, every event kept" : "already compact — every event kept");
            drawPsStore();
          }).catch(function(err){ toast(err.message); b.disabled = false; b.textContent = "Compact"; });
        };
      }).catch(function(){ host.innerHTML = '<div class="pshint" style="margin-top:0">Couldn’t read the log size.</div>'; });
    }
    // Sharing with the team (D8) — only when this machine is on one.
    function drawPsTeam(){
      var host = document.getElementById("psteam"); if (!host) return;
      var t = state.team, teams = (t && t.teams) || [];
      if (!teams.length) {
        host.innerHTML = '<div class="pshint" style="margin-top:0">' + (state.teamErr ? esc(state.teamErr)
          : (t && t.signedIn ? "Signed in to a team hub, but not on a team yet." : "Not on a team.") +
            ' <button class="btn ghost xs" type="button" id="psteamgo">Settings → Team</button>') + "</div>";
        var go = document.getElementById("psteamgo");
        if (go) go.onclick = function(){ close(); openSettingsModal("team"); };
        return;
      }
      if (!psPolicyAsked) { psPolicyAsked = true; loadTeamPolicy(pid, true); } // fresh each time the modal opens
      host.innerHTML = teamShareHtml(pid, true) + teamPolicyHtml(pid);
      wireTeamShare(host, drawPsTeam);
    }
    var psPolicyAsked = false;
    teamHooks().pset = function(){ drawPsTeam(); };
    function load(){
      api("/api/projects/" + pid).then(function(j){ renderBody(j.project); }).catch(function(){ var b = document.getElementById("psbody"); if (b) b.innerHTML = '<div class="obsub" style="padding:20px">Could not load project.</div>'; });
    }
    load();
  }


  function openProjectModal(){
    if (document.querySelector(".scrim")) return;
    var native = !!(window.loomNative && window.loomNative.pickFolder);
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal">' +
      '<div class="modalhead">New project<button class="iconbtn" id="pclose" aria-label="close">' + ICONS.x + "</button></div>" +
      '<div class="modalbody">' +
        '<div class="field"><label>Project folder</label>' +
          '<div class="pickrow"><input id="pdir" spellcheck="false" autocomplete="off" placeholder="' +
            (native ? "choose a folder\u2026" : "/path/to/repo on the daemon host") + '">' +
            (native ? '<button class="btn outline" id="pbrowse">Choose\u2026</button>' : "") + "</div>" +
          '<span class="ferr" id="perr" role="alert"></span>' +
          '<span class="hintx">Loom writes a <code>.loom/</code> folder here and leaves the rest of the repo alone.</span></div>' +
        '<div class="field"><label>Name <span class="opt">optional</span></label>' +
          '<input id="pname" spellcheck="false" autocomplete="off" placeholder="defaults to the folder name"></div>' +
      "</div>" +
      '<div class="modalfoot"><button class="btn ghost" id="pcancel">Cancel</button>' +
      '<button class="btn primary" id="pcreate">Create project<span class="kbd">\u2318\u21b5</span></button></div>' +
    "</div>";
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("pclose").onclick = close;
    document.getElementById("pcancel").onclick = close;
    var dirEl = document.getElementById("pdir");
    if (native) document.getElementById("pbrowse").onclick = function(){
      window.loomNative.pickFolder().then(function(p){
        if (!p) return;
        dirEl.value = p;
        var nm = document.getElementById("pname");
        if (!nm.value) nm.placeholder = p.split(/[\\/]/).filter(Boolean).pop() || "";
      }).catch(function(err){ toast(String(err.message || err)); });
    };
    setTimeout(function(){ dirEl.focus(); }, 30);
    // Errors belong under the field they're about, not in a toast behind the
    // dialog where your eyes aren't.
    function fieldErr(msg){
      var e = document.getElementById("perr"); if (e) e.textContent = msg || "";
      dirEl.classList.toggle("bad", !!msg);
      if (msg) dirEl.focus();
    }
    dirEl.addEventListener("input", function(){ fieldErr(""); });
    function create(){
      var dir = (dirEl.value || "").trim();
      if (!dir) return fieldErr(native ? "Choose a folder first." : "Enter the path to a folder on this machine.");
      var name = (document.getElementById("pname").value || "").trim();
      var btn = document.getElementById("pcreate");
      if (btn.disabled) return; // a double-click is one project, not two requests
      btn.disabled = true;
      var was = btn.innerHTML; btn.textContent = "Creating…";
      api("/api/projects", {
        method: "POST",
        body: JSON.stringify(name ? { dir: dir, name: name } : { dir: dir }),
      }).then(function(j){
        close();
        var p = j.project || {};
        // say what was actually detected rather than a bare "added"
        // (The config carries kinds, not tiers — filtering on tier counted
        // zero and told you no agents were found beside a roster of five.)
        var found = (j.config && j.config.agents) || [];
        toast(found.length
          ? p.name + " added \u00b7 " + found.length + " agent" + (found.length === 1 ? "" : "s") + ": " + found.map(function(a){ return agentLabel(a.kind, a.id); }).join(", ")
          : p.name + " added \u00b7 no agent CLIs found on this machine \u2014 install one, or add a model agent");
        if (state.refreshProjects) state.refreshProjects();
        if (p.id) { if (state.selectProject) state.selectProject(p.id); else location.hash = "#p/" + p.id; }
      }).catch(function(err){ btn.disabled = false; btn.innerHTML = was; fieldErr(String(err.message || err).replace(/^./, function(c){ return c.toUpperCase(); })); });
    }
    document.getElementById("pcreate").onclick = create;
    function onKey(e){
      if (e.key === "Escape") { e.preventDefault(); close(); }
      // Enter in a one-line field submits, as it does everywhere else
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.target === dirEl || (e.target && e.target.id === "pname"))) { e.preventDefault(); create(); }
    }
    document.addEventListener("keydown", onKey);
  }
export { openProjectModal,openProjectSettings,openSettingsModal,openSetupModal };
