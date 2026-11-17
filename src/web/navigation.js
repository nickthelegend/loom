/** Browser navigation module. See README.md for ownership and startup. */
import { signInGate } from './signin.js';
import { applyMode,setDevMode } from './mode.js';
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
import { toast } from './notifications.js';
import { isGuest,renderGuest } from './share-live.js';


  function route(){
    state.rerender = route;
    applyTheme();
    applyMode();
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
    // a teammate let into one chat sees that chat and nothing else
    if (isGuest()) return renderGuest();
    // An invite link opened here: what it sets up, then one click (join.js).
    var invite = joinFromHash();
    if (invite) return renderJoin(invite);
    // Loom Desktop opens on "Sign in with GitHub" until you sign in or say you'd rather not
    if (signInGate(route)) return;
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
    // #p/<pid>/c/<chat>[/m/<id>] — a pane opens on a chat with no message to scroll to
    var m = location.hash.match(/^#p\/([^\/]+)\/c\/([^\/]+)(?:\/m\/(\d+))?$/);
    if (!m) return null;
    var go = { pid: decodeURIComponent(m[1]), chat: decodeURIComponent(m[2]), id: m[3] ? Number(m[3]) : 0 };
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
        [K + "D / " + K + "⇧D", "Split: another view beside / below (drag a chat onto a pane's edge)"],
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
  /**
   * The demo walkthrough (#402): `loom try` and the "Try a demo project" buttons land here with
   * ?tour=1 (or a one-shot flag). Unlike the spotlight tour it does things: it types into the box and
   * sends, then steers the running turn, so someone with no agents and no keys sees the whole loop
   * work. Each step's target must be on screen; a step whose target isn't is skipped.
   */
  var DEMO_TOUR = [
    { sel: "#box", title: "Ask for something", body: "This project has three demo agents \u2014 scripted, offline and free. Ask one to add dark mode: it reads the code, edits a real file and runs the tests.", prefill: "Add dark mode", primary: "Send it", act: "send" },
    { sel: "#pane-thread", title: "Watch it work", body: "Every step streams in as it happens. The edit is real \u2014 the file in the demo folder changed \u2014 and the cost is $0.00. Wait for the reply, then carry on." },
    { sel: "#box", title: "Steer while it works", body: "Send another request. While a turn is running, Steer (\u2325\u23ce) slips a note into it instead of waiting in the queue \u2014 we\u2019ll do both for you.", prefill: "Write tests for the filter", primary: "Send, then steer", act: "steer" },
    { sel: '.tab[data-tab="fleet"]', title: "Your agents", body: "The Agents tab shows what each agent is doing right now. Add more on any model, as many as you want \u2014 two on one model, two on another.", primary: "Show me", act: "tab" },
    { sel: "#setupbtn", title: "Bring your own agents", body: "When you\u2019re ready: Settings \u25b8 Setup finds the agent CLIs you have and installs the ones you don\u2019t. Developer mode turns on Orchestra, races, the terminal and the rest.", primary: "Turn on Developer mode", act: "devmode", last: true },
  ];
  function demoTourWanted(){
    try {
      if (/(?:^|[?&])tour=1(?:&|$)/.test(location.search)) return true;
      return sessionStorage.getItem("loomDemoTour") === "1";
    } catch (e) { return false; }
  }
  function startDemoTour(waited){
    // Something modal is up (a first-run dialog, a confirm): wait for it rather than lose the tour.
    if ((document.querySelector(".scrim") || document.getElementById("tourcard")) && (waited || 0) < 20) {
      return void setTimeout(function(){ startDemoTour((waited || 0) + 1); }, 500);
    }
    try {
      sessionStorage.removeItem("loomDemoTour");
      // drop ?tour=1 so a reload doesn't start it again
      if (/[?&]tour=1/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);
      localStorage.setItem("loomTourDone", "1");
    } catch (e) {}
    if (document.querySelector(".scrim") || document.getElementById("tourcard")) return;
    var i = 0;
    var shade = document.createElement("div"); shade.className = "tourshade"; shade.id = "tourshade";
    var card = document.createElement("div"); card.className = "tourcard demotour"; card.id = "tourcard"; card.setAttribute("role", "dialog"); card.setAttribute("aria-live", "polite");
    document.body.appendChild(shade); document.body.appendChild(card);
    // On screen = has a size; with no layout engine at all (a DOM test), = not hidden by style.
    var noLayout = document.documentElement.getBoundingClientRect().width === 0;
    function shown(el){
      if (!el) return false;
      if (!noLayout) return el.getBoundingClientRect().width > 0;
      for (var n = el; n && n.nodeType === 1; n = n.parentNode) if (getComputedStyle(n).display === "none") return false;
      return true;
    }
    function target(){ var el = document.querySelector(DEMO_TOUR[i].sel); return shown(el) ? el : null; }
    function done(){ shade.remove(); card.remove(); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", place); }
    function key(e){ if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); } }
    function next(){
      do { i++; } while (i < DEMO_TOUR.length && !target());
      if (i >= DEMO_TOUR.length) done(); else show();
    }
    function place(){
      var el = target(); if (!el) return;
      var r = el.getBoundingClientRect(), pad = 6;
      shade.style.left = (r.left - pad) + "px"; shade.style.top = (r.top - pad) + "px";
      shade.style.width = (r.width + pad * 2) + "px"; shade.style.height = (r.height + pad * 2) + "px";
      var cw = card.offsetWidth, ch = card.offsetHeight;
      var top = r.top - ch - 16 > 8 ? r.top - ch - 16 : Math.min(window.innerHeight - ch - 8, r.bottom + 16);
      card.style.left = Math.max(8, Math.min(window.innerWidth - cw - 8, r.left + r.width / 2 - cw / 2)) + "px";
      card.style.top = Math.max(8, top) + "px";
    }
    function type(text){
      var box = document.getElementById("box"); if (!box) return null;
      box.value = text;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      return box;
    }
    function sendBox(){ var b = document.getElementById("send"); if (b) b.click(); }
    function act(s){
      if (s.act === "send") { type(s.prefill); sendBox(); return next(); }
      if (s.act === "steer") {
        type(s.prefill); sendBox();
        // the demo turn takes a few seconds; once the Steer button shows, steer it
        var tries = 0;
        var t = setInterval(function(){
          var st = document.getElementById("steer");
          if (st && st.style.display !== "none" && shown(st)) {
            clearInterval(t);
            type("Also cover an empty list");
            st.click();
          } else if (++tries > 40) clearInterval(t);
        }, 150);
        return next();
      }
      if (s.act === "tab") { var tb = document.querySelector(s.sel); if (tb) tb.click(); return setTimeout(next, 300); }
      if (s.act === "devmode") {
        setDevMode(true);
        done();
        toast("Developer mode on \u2014 Orchestra, races and the terminal are back");
        if (state.rerender) state.rerender();
        return;
      }
      next();
    }
    function show(){
      var s = DEMO_TOUR[i];
      if (s.prefill && !s.act) type(s.prefill);
      card.innerHTML = '<div class="tourstep">Try Loom \u00b7 ' + (i + 1) + " of " + DEMO_TOUR.length + "</div>" +
        '<div class="tourt">' + esc(s.title) + '</div><div class="tourb">' + esc(s.body) + "</div>" +
        (s.prefill ? '<div class="tourpre"><span>\u201c' + esc(s.prefill) + '\u201d</span></div>' : "") +
        '<div class="toura"><button type="button" class="btn xs ghost" id="tourskip">' + (s.last ? "Finish" : "End tour") + "</button>" +
        '<span class="spacer"></span>' +
        (s.primary ? '<button type="button" class="btn xs primary" id="touract">' + esc(s.primary) + "</button>" : "") +
        (s.last ? "" : '<button type="button" class="btn xs ' + (s.primary ? "ghost" : "primary") + '" id="tournext">' + (s.primary ? "Skip" : "Next") + "</button>") +
        "</div>";
      document.getElementById("tourskip").onclick = done;
      var a = document.getElementById("touract"); if (a) a.onclick = function(){ act(s); };
      var n = document.getElementById("tournext"); if (n) n.onclick = next;
      place();
      (a || n || document.getElementById("tourskip")).focus();
    }
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", place);
    if (!target()) { i = -1; return next(); }
    show();
  }
  state.startDemoTour = startDemoTour;
  state.demoTourWanted = demoTourWanted;
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