/** Browser main module. See README.md for ownership and startup. */
import { openConnectPhone } from './connect-phone.js';
import { api,pairFromHash } from './connection.js';
import { clog } from './console.js';
import { labelIcons } from './icons.js';
import { closeMenu } from './menus.js';
import { bootstrapAdmin,openShortcuts,route,setFocusMode,takePermalink,typingInField } from './navigation.js';
import { stopTitleFlash,toast } from './notifications.js';
import { openPalette } from './palette.js';
import { onPreviewMessage } from './preview.js';
import { openProjectModal,openProjectSettings,openSettingsModal } from './settings.js';
import { openJoin } from './join.js';
import { applyTheme } from './theme.js';
import { clearShell,isDesktop,mq } from './shell.js';
import { THEME_KEY,state } from './state.js';
import { loadLoomPad,loadUpdate } from './statusbar.js';
import { openTaskModal } from './tasks.js';

  document.addEventListener("visibilitychange", function(){ if (!document.hidden) stopTitleFlash(); });

  /** Keyboard access for the row/card controls that are <div>s driven by event
   *  delegation: make them focusable (so the :focus-visible ring shows) and let
   *  Enter/Space activate them, without touching every render site. */
  (function installRowA11y(){
    var SEL = ".card[data-id],.agentrow[data-agent],.trow[data-file],.trow[data-dir]," +
      ".hitrow[data-open],.scmrow[data-file],.srow[data-id],.crow[data-p],.crow[data-newchat]";
    function tag(el){
      if (el.getAttribute("tabindex") !== null) return;
      el.setAttribute("tabindex", "0");
      // role="button" only on leaf rows: a row that nests its own control (a
      // chat/project row with a menu button) must not claim to be a button.
      if (!el.querySelector("button,a[href],input,select,textarea,[role='button']")) el.setAttribute("role", "button");
    }
    function enhance(root){ if (root.querySelectorAll) { var n = root.querySelectorAll(SEL); for (var i = 0; i < n.length; i++) tag(n[i]); } }
    try {
      var mo = new MutationObserver(function(muts){
        for (var i = 0; i < muts.length; i++){ var an = muts[i].addedNodes;
          for (var j = 0; j < an.length; j++){ var nd = an[j]; if (nd.nodeType !== 1) continue;
            if (nd.matches && nd.matches(SEL)) tag(nd); enhance(nd); } }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* MutationObserver always present in target browsers */ }
    enhance(document);
    document.addEventListener("keydown", function(e){
      if (e.key !== "Enter" && e.key !== " ") return;
      var el = document.activeElement;
      if (el && el.matches && el.matches(SEL)) { e.preventDefault(); el.click(); }
    });
  })();

  new MutationObserver(function(muts){
    muts.forEach(function(m){
      Array.prototype.forEach.call(m.addedNodes, function(n){
        if (n.nodeType === 1) labelIcons(n);
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  state.closeMenu = closeMenu;

  if (!window.__loompadPoll){ window.__loompadPoll = setInterval(function(){ loadLoomPad(); }, 5000); }

  if (!window.__updatePoll){ window.__updatePoll = setInterval(function(){ loadUpdate(); }, 60 * 60000); }

  window.addEventListener("message", onPreviewMessage);

  // Catch what escapes user code: uncaught errors and rejected promises. Once.
  if (!window.__loomErrHooked) {
    window.__loomErrHooked = true;
    window.addEventListener("error", function(e){
      clog("error", "window", (e && e.message) || "script error", (e && e.error && e.error.stack) || (e && e.filename ? e.filename + ":" + e.lineno + ":" + e.colno : ""));
    });
    window.addEventListener("unhandledrejection", function(e){
      var r = e && e.reason;
      clog("error", "window", "unhandled rejection: " + ((r && r.message) || r), (r && r.stack) || "");
    });
  }

  window.addEventListener("hashchange", function(){
    var go = takePermalink();
    if (go && state.setChat && isDesktop()) { state.setChat(go.pid, go.chat); return; }
    if (!isDesktop()) return route();
    // The desktop shell navigates with replaceState, so this only fires for a
    // hash someone typed or pasted — honour it instead of ignoring the URL.
    var m = location.hash.match(/^#p\/(.+)$/);
    if (!m || !state.selectProject) return;
    var known = (state.projects || []).some(function(p){ return p.id === m[1]; });
    if (known) state.selectProject(m[1]);
  });

  mq.addEventListener("change", function(){ clearShell(); route(); });

  document.addEventListener("keydown", function(e){
    // ⌘K / Ctrl+K — the command palette, from anywhere (even mid-type)
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
      if (state.token && !document.querySelector(".scrim")) { e.preventDefault(); openPalette(); }
      return;
    }
    // ⌘F — find in this chat (the browser's own find can't see folded tool groups)
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "f" || e.key === "F")) {
      if (state.openFind && state.token && !document.querySelector(".scrim")) { e.preventDefault(); state.openFind(); }
      return;
    }
    // ⌘. — focus mode
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ".") {
      if (state.token && isDesktop()) { e.preventDefault(); setFocusMode(!document.documentElement.classList.contains("focusmode")); }
      return;
    }
    if ((e.key === "[" || e.key === "]") && !e.metaKey && !e.ctrlKey && !e.altKey && state.jumpPrompt && !typingInField(e.target) && !document.querySelector(".scrim")) {
      e.preventDefault(); state.jumpPrompt(e.key === "[" ? -1 : 1); return;
    }
    if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && state.token && !typingInField(e.target) && !document.querySelector(".scrim")) {
      e.preventDefault(); openShortcuts(); return;
    }
    // ⌘⇧V / Ctrl+Shift+V — the prompt manager, even mid-type (that's when you want it)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V")) {
      if (state.openPrompts && !document.querySelector(".scrim")) { e.preventDefault(); state.openPrompts(); }
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "`" || e.key === "~")) {
      if (state.toggleTerm) { e.preventDefault(); state.toggleTerm(); }
      return;
    }
    if ((e.key === "n" || e.key === "p") && !e.metaKey && !e.ctrlKey && !e.altKey &&
        isDesktop() && state.token && !typingInField(e.target) && !document.querySelector(".scrim")) {
      e.preventDefault();
      if (e.key === "n") openTaskModal(state.pid); else openProjectModal();
    }
  });

  /**
   * One menu-bar item, by name. Each presses the button (or calls the
   * function) the app already has for it, so the menu and the window never
   * disagree about what a command does.
   */
  function runMenuItem(item){
    var scrim = document.querySelector(".scrim");
    var click = function(id, why){
      var b = document.getElementById(id);
      if (b && b.offsetParent !== null) { b.click(); return true; }
      toast(why || "open a project first");
      return false;
    };
    var needProject = function(){ if (!state.pid || !state.showTab) { toast("open a project first"); return false; } return true; };
    if (item.indexOf("tab:") === 0) { if (needProject()) state.showTab(item.slice(4)); return; }
    if (item.indexOf("theme:") === 0) {
      var t = item.slice(6);
      // "system" takes the OS's choice now (there's no live-following theme yet)
      if (t === "system") t = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
      applyTheme(); if (state.retheme) state.retheme();
      return;
    }
    if (item.indexOf("quote:") === 0) {
      var q = item.slice(6), bx = document.getElementById("box");
      if (!bx) { toast("open a chat to quote into"); return; }
      if (state.showTab) state.showTab("thread");
      var cur = bx.value.replace(/\s+$/, "");
      bx.value = (cur ? cur + "\n\n" : "") + q.trim().split("\n").slice(0, 12).map(function(l){ return "> " + l; }).join("\n") + "\n\n";
      bx.dispatchEvent(new Event("input", { bubbles: true })); bx.focus();
      return;
    }
    if (item.indexOf("project:") === 0 || item.indexOf("chat:") === 0) { stepThrough(item); return; }
    switch (item) {
      case "settings": if (!scrim) openSettingsModal(); return;
      case "cloud": if (!scrim) openSettingsModal("cloud"); return;
      case "team-settings": if (!scrim) openSettingsModal("team"); return;
      case "pair": openConnectPhone(); return;
      case "new-chat": {
        var rows = Array.prototype.filter.call(document.querySelectorAll("[data-newchat]"), function(r){ return r.getAttribute("data-newchat") === state.pid; });
        var row = rows[0] || document.querySelector("[data-newchat]");
        if (row) row.click(); else toast("open a project first");
        return;
      }
      case "new-task": if (!scrim) openTaskModal(state.pid); return;
      case "add-project": if (!scrim) openProjectModal(); return;
      case "project-settings": if (state.pid && !scrim) openProjectSettings(state.pid); else toast("open a project first"); return;
      case "orchestrate":
        if (!state.setComposerMode) { toast("open a project first"); return; }
        if (state.showTab) state.showTab("thread");
        state.setComposerMode("orch");
        var ob = document.getElementById("box"); if (ob) ob.focus();
        return;
      case "crew":
        if (!needProject()) return;
        state.showTab("crew");
        setTimeout(function(){ var t = document.getElementById("crewsaytext"); if (t) t.focus(); }, 150);
        return;
      case "export-chat": if (state.exportThread) state.exportThread(); else toast("open a chat first"); return;
      case "find": if (state.openFind) state.openFind(); else toast("open a chat first"); return;
      case "palette": if (!scrim) openPalette(); return;
      case "prompts": if (state.openPrompts) state.openPrompts(); else toast("open a chat first"); return;
      case "toggle-sidebar": {
        var off = !document.documentElement.classList.contains("nosidebar");
        document.documentElement.classList.toggle("nosidebar", off);
        try { localStorage.setItem("loomNoSidebar", off ? "1" : "0"); } catch (e) {}
        return;
      }
      case "toggle-rail": click("railbtn"); return;
      case "toggle-terminal": if (state.toggleTerm) state.toggleTerm(); else toast("open a project first"); return;
      case "toggle-browser": click("browserbtn"); return;
      case "console": click("consolebtn"); return;
      case "focus": if (isDesktop()) setFocusMode(!document.documentElement.classList.contains("focusmode")); return;
      case "interrupt": {
        var stop = document.getElementById("stop");
        if (stop && stop.style.display !== "none") stop.click();
        else if (state.pid) api("/api/projects/" + state.pid + "/interrupt", { method: "POST", body: "{}" }).then(function(j){ toast(j.interrupted ? "interrupted " + j.interrupted : "nothing running"); }).catch(function(err){ toast(err.message); });
        return;
      }
      case "pick-agent": if (state.showTab) state.showTab("thread"); click("cagent", "open a chat first"); return;
      case "plan": if (state.showTab) state.showTab("thread"); click("planbtn", "open a chat first"); return;
      case "approvals": click("apbadge", "no tool calls are waiting on you"); return;
      case "add-agent": if (state.showRail) { if (!document.querySelector(".dshell.railopen")) click("railbtn"); state.showRail("agents"); } else toast("open a project first"); return;
      case "tools": if (state.showTab) state.showTab("thread"); click("morebtn", "open a chat first"); return;
      case "home": if (state.selectProject && state.projects && state.projects.length) location.hash = ""; return;
      case "invite": click("invitebtn", "open a project on GitHub to invite someone to it"); return;
      case "join":
        askLink();
        return;
      case "shortcuts": openShortcuts(); return;
    }
  }

  /** Go ▸ Next/Previous Project and Chat: step through the sidebar's order. */
  function stepThrough(item){
    var dir = /next$/.test(item) ? 1 : -1;
    if (item.indexOf("project:") === 0) {
      var ps = state.projects || [];
      if (!ps.length || !state.selectProject) return;
      var at = ps.findIndex(function(p){ return p.id === state.pid; });
      var next = ps[(at + dir + ps.length) % ps.length];
      if (next) state.selectProject(next.id);
      return;
    }
    var rows = Array.prototype.slice.call(document.querySelectorAll('.crow[data-p="' + state.pid + '"]'));
    if (!rows.length) return;
    var curChat = state.currentChat ? state.currentChat() : null;
    var i = rows.findIndex(function(r){ return r.getAttribute("data-chat") === curChat; });
    var row = rows[(i + dir + rows.length) % rows.length];
    if (row) row.click();
  }

  /** Team ▸ Join with an Invite Link…: paste it, and the join page takes over. */
  function askLink(){
    var link = window.prompt("Paste the invite link a teammate sent you");
    if (link && link.trim()) openJoin(link.trim());
  }
  try { if (localStorage.getItem("loomNoSidebar") === "1") document.documentElement.classList.add("nosidebar"); } catch (e) {}

  // The Electron shell's own menu bar. Each item arrives as a word; the browser
  // build has no loomNative, so this is a no-op there.
  if (window.loomNative && window.loomNative.onMenu) {
    window.loomNative.onMenu(function(item){
      if (!state.token) return;
      // The shell asking for a command to be run where you can see it — the
      // Homebrew upgrade, today. It goes into the terminal you already have
      // rather than running invisibly inside the app.
      if (item.indexOf("run:") === 0) {
        var cmd = item.slice(4);
        if (!state.termRun) { toast("open a project first — the terminal lives in one"); return; }
        state.termRun(cmd);
        toast("running in the terminal — restart Loom when it finishes");
        return;
      }
      runMenuItem(item);
    });
  }

  // What the person did with a notification: opened it, or answered from it.
  // Answering sends the reply to the agent that asked, in the chat it asked
  // in — the same call the composer makes, so nothing special happens to it.
  if (window.loomNative && window.loomNative.onNotifyAction) {
    window.loomNative.onNotifyAction(function(action){
      if (!state.token || !action) return;
      var pid = action.project || state.pid;
      if (!pid) return;
      var open = function(){
        if (state.pid !== pid) location.hash = "#p/" + pid;
        if (action.chat && state.setChat) state.setChat(pid, action.chat);
        if (state.showTab) state.showTab("thread");
      };
      if (action.kind === "reply" && String(action.text || "").trim()) {
        api("/api/projects/" + pid + "/messages", {
          method: "POST",
          body: JSON.stringify({
            text: String(action.text).trim(),
            agentId: action.agentId || undefined,
            chat: action.chat || undefined
          })
        }).then(function(){ open(); if (state.composer && state.composer.projectId === pid) state.composer.refresh(); }).catch(function(e){ open(); toast(e.message); });
        return;
      }
      open();
      var box = document.getElementById("box"); if (box) box.focus();
    });
  }

  bootstrapAdmin().then(function(){
    return pairFromHash();
  }).then(function(paired){
    if (paired) toast("paired \u2713");
    route();
  }).catch(function(err){ toast(err.message); route(); });
