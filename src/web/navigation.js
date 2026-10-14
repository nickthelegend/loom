/** Browser navigation module. See README.md for ownership and startup. */
import { renderPair } from './connection.js';
import { joinFromHash,renderJoin } from './join.js';
import { renderBoard } from './home.js';
import { renderProject } from './project.js';
import { isDesktop,renderShell } from './shell.js';
import { root,state } from './state.js';
import { applyTheme } from './theme.js';
import { ICONS } from './icons.js';
import { KMOD } from './permissions.js';
import { esc } from './format.js';


  function route(){
    applyTheme();
    // drop every hook the old view installed — each closes over that render's
    // DOM and state (retheme holds its terminals), and the next view reinstalls
    // whichever ones it owns
    state.composer = null;
    state.toggleTerm = null;
    state.selectProject = null;
    state.drawRail = null;
    state.startTerminals = null;
    state.retheme = null;
    // palette hooks close over the old render's DOM — drop them too
    state.openFile = null; state.showTab = null; state.showRail = null; state.teamBrainPing = null;
    state.selectAgent = null; state.termRun = null; state.setChat = null;
    state.reloadBoard = null; state.setComposerMode = null; state.openPrompts = null;
    state.redrawFeed = null;
    if (!state.token) return renderPair();
    // An invite link opened here: what it sets up, then one click (join.js).
    var invite = joinFromHash();
    if (invite) return renderJoin(invite);
    takePermalink();
    document.documentElement.classList.toggle("desk", isDesktop());
    if (isDesktop()) return renderShell();
    var m = location.hash.match(/^#p\/(.+)$/);
    if (m) return renderProject(m[1], root, false);
    renderBoard();
  }
  /**
   * A message permalink: open that project and chat, then scroll to the
   * message once its history loads. The address settles back to #p/<pid>,
   * which is what the rest of the app routes on.
   */
  function takePermalink(){
    var m = location.hash.match(/^#p\/([^\/]+)\/c\/([^\/]+)\/m\/(\d+)$/);
    if (!m) return null;
    var go = { pid: decodeURIComponent(m[1]), chat: decodeURIComponent(m[2]), id: Number(m[3]) };
    try { localStorage.setItem("loomChat:" + go.pid, go.chat); } catch (e) {}
    state.pendingGo = go;
    history.replaceState(null, "", "#p/" + go.pid);
    return go;
  }

  /** Every key Loom listens for, on one sheet (press ?). */
  function openShortcuts(){
    if (document.querySelector(".scrim")) return;
    var K = KMOD;
    var rows = [
      ["Anywhere", [
        [K + "K", "Search everything — files, chats, commands"],
        [K + "F", "Find in this chat"],
        [K + ".", "Focus mode: hide the sidebar and panel"],
        [K + "⇧V", "Prompts you’ve saved"],
        ["Ctrl+\u0060", "Show or hide the terminal"],
        ["N", "New task"], ["P", "New project"], ["[ / ]", "Your previous / next prompt in this chat"],
        ["?", "This sheet"], ["Esc", "Close a menu, dialog or find"],
      ]],
      ["In the composer", [
        ["Enter", "Send"], ["⇧Enter", "New line"],
        ["↑ / ↓", "Walk through what you sent here (empty box)"],
        ["@", "Mention a file"], ["/", "Actions"],
      ]],
      ["Find", [["Enter / ⇧Enter", "Previous / next match"]]],
    ];
    // The desktop app's menu bar adds its own; the browser keeps those keys for itself.
    if (window.loomNative) rows.splice(1, 0, ["Desktop app", [
      [K + "N", "New chat"], [K + "⇧N", "New task"], [K + "O", "Add a project"],
      [K + "1 … " + K + "7", "Chat · Orchestra · Crew · Agents · Board · Memory · Insights"],
      [K + "B", "Show or hide the sidebar"], ["⌥" + K + "B", "Show or hide the right panel"],
      [K + "⇧A", "Choose the agent"], [K + "⇧M", "Plan mode"], [K + "⇧.", "Interrupt"],
      [K + "⇧E", "Export this chat"], ["⌥" + K + "↑ / ↓", "Previous / next project"], [K + "⇧[ / ]", "Previous / next chat"],
      [K + "⇧U", "Invite a teammate"], [K + "/", "This sheet"],
    ]]);
    rows.push(["Right-click", [["Messages", "Copy, retry, quote, branch, save as a prompt"], ["Code blocks", "Copy code, put it in the composer"],
      ["Files", "Open, mention in chat, copy path" + (window.loomNative ? ", reveal" : "")], ["Projects & chats", "Settings, rename, pin, archive, export"]]]);
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal kbmodal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">' +
      '<div class="modalhead">' + ICONS.keyboard + ' Keyboard shortcuts<button class="iconbtn" id="kbx" aria-label="close">' + ICONS.x + "</button></div>" +
      '<div class="modalbody kbgrid">' + rows.map(function(g){
        return '<div class="kbsec"><div class="kbh">' + esc(g[0]) + "</div>" + g[1].map(function(r){
          return '<div class="kbrow"><span class="kbd">' + esc(r[0]) + "</span><span>" + esc(r[1]) + "</span></div>";
        }).join("") + "</div>";
      }).join("") + '</div><div class="modalfoot"><span class="spacer"></span><button type="button" class="btn xs outline" id="kbtour">Take the tour again</button></div></div>';
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey, true); }
    document.getElementById("kbtour").onclick = function(){ close(); setTimeout(function(){ startTour(true); }, 50); };
    function onKey(e){ if (e.key === "Escape" || e.key === "?") { e.preventDefault(); e.stopPropagation(); close(); } }
    document.addEventListener("keydown", onKey, true);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("kbx").onclick = close;
  }
  /**
   * The first-run tour: a spotlight on the three things that make Loom Loom,
   * one at a time. Shown once per device, when a project is open; replayable
   * from the shortcut sheet. Steps whose target isn't on screen are skipped.
   */
  var TOUR = [
    { sel: "#box", title: "Say what you want done", body: "Type here and press Enter. The reply streams in live, and every agent in the project shares one memory — what one learns, the next one knows." },
    { sel: "#cagent", title: "Pick who answers", body: "Claude Code, Codex, OpenCode, a model… or Auto, and Loom routes each turn. Switch any time; the baton carries the context over." },
    { sel: '#cmode [data-cmode="orch"]', title: "Or hand it to a team", body: "Orchestrate: one agent plans the goal, the rest work it in parallel, each in its own worktree — and you watch the plan as a graph." },
    { sel: "#palettebtn", title: "Everything is a keystroke away", body: "⌘K searches files, chats and commands. Press ? any time for every shortcut." },
  ];
  function startTour(force){
    try { if (!force && localStorage.getItem("loomTourDone")) return; } catch (e) {}
    if (document.querySelector(".scrim") || document.getElementById("tourcard")) return;
    var steps = TOUR.filter(function(s){ var el = document.querySelector(s.sel); return el && el.getBoundingClientRect().width > 0; });
    if (!steps.length) return;
    var i = 0;
    var shade = document.createElement("div"); shade.className = "tourshade"; shade.id = "tourshade";
    var card = document.createElement("div"); card.className = "tourcard"; card.id = "tourcard"; card.setAttribute("role", "dialog"); card.setAttribute("aria-live", "polite");
    document.body.appendChild(shade); document.body.appendChild(card);
    function done(){
      try { localStorage.setItem("loomTourDone", "1"); } catch (e) {}
      shade.remove(); card.remove(); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", place);
    }
    function key(e){
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); }
      else if ((e.key === "Enter" || e.key === "ArrowRight") && card.contains(document.activeElement)) { e.preventDefault(); e.stopPropagation(); next(); }
    }
    function next(){ if (++i >= steps.length) done(); else show(); }
    function place(){
      var el = document.querySelector(steps[i].sel); if (!el) return next();
      var r = el.getBoundingClientRect(), pad = 6;
      shade.style.left = (r.left - pad) + "px"; shade.style.top = (r.top - pad) + "px";
      shade.style.width = (r.width + pad * 2) + "px"; shade.style.height = (r.height + pad * 2) + "px";
      var cw = card.offsetWidth, ch = card.offsetHeight;
      var top = r.top - ch - 16 > 8 ? r.top - ch - 16 : Math.min(window.innerHeight - ch - 8, r.bottom + 16);
      card.style.left = Math.max(8, Math.min(window.innerWidth - cw - 8, r.left + r.width / 2 - cw / 2)) + "px";
      card.style.top = top + "px";
    }
    function show(){
      var s = steps[i];
      card.innerHTML = '<div class="tourstep">' + (i + 1) + " of " + steps.length + "</div>" +
        '<div class="tourt">' + esc(s.title) + '</div><div class="tourb">' + esc(s.body) + "</div>" +
        '<div class="toura"><button type="button" class="btn xs ghost" id="tourskip">Skip tour</button>' +
        '<button type="button" class="btn xs primary" id="tournext">' + (i === steps.length - 1 ? "Start building" : "Next") + "</button></div>";
      document.getElementById("tourskip").onclick = done;
      document.getElementById("tournext").onclick = next;
      place();
      document.getElementById("tournext").focus();
    }
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", place);
    show();
  }
  state.startTour = startTour;
  state.openShortcuts = openShortcuts;
  function setFocusMode(on){
    document.documentElement.classList.toggle("focusmode", on);
    try { localStorage.setItem("loomFocus", on ? "1" : "0"); } catch (e) {}
  }
  try { if (localStorage.getItem("loomFocus") === "1") document.documentElement.classList.add("focusmode"); } catch (e) {}
  // Global shortcuts: Ctrl+backtick toggles the terminal; "n" opens New task
  // (both only while a desktop workspace is mounted, never while typing).
  function typingInField(t){
    if (!t) return false;
    var tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
  }

  // Same-machine window? Ask the daemon for the admin token so this becomes the
  // local admin console — pair phones, open phone access. Remote windows (a phone
  // on the tailnet) get 403 here and pair like any other device. In-memory only:
  // we never persist the admin token, so a stale one can't outlive a restart.
  function bootstrapAdmin(){
    return fetch("/api/bootstrap").then(function(r){
      if (!r.ok) return false;
      return r.json().then(function(j){
        if (j && j.token) { state.token = j.token; state.admin = true; return true; }
        return false;
      });
    }).catch(function(){ return false; });
  }
export { bootstrapAdmin,openShortcuts,route,setFocusMode,takePermalink,typingInField };