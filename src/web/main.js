/** Browser main module. See README.md for ownership and startup. */
import { api,pairFromHash } from './connection.js';
import { clog } from './console.js';
import { labelIcons } from './icons.js';
import { closeMenu } from './menus.js';
import { bootstrapAdmin,openShortcuts,route,setFocusMode,takePermalink,typingInField } from './navigation.js';
import { stopTitleFlash,toast } from './notifications.js';
import { openPalette } from './palette.js';
import { runCommand } from './commands.js';
import { onPreviewMessage } from './preview.js';
import { openProjectModal } from './settings.js';
import { clearShell,isDesktop,mq } from './shell.js';
import { state } from './state.js';
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
      runCommand(item);
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
