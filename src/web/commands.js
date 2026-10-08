/** Browser commands module: one name per command, for the menu bar and the palette. See README.md for ownership and startup. */
import { openConnectPhone } from './connect-phone.js';
import { api } from './connection.js';
import { openJoin } from './join.js';
import { openShortcuts,setFocusMode } from './navigation.js';
import { askText,toast } from './notifications.js';
import { openPalette } from './palette.js';
import { openProjectModal,openProjectSettings,openSettingsModal } from './settings.js';
import { isDesktop } from './shell.js';
import { state } from './state.js';
import { openTaskModal } from './tasks.js';
import { setThemePref } from './theme.js';
import { ICONS } from './icons.js';

  /**
   * One menu-bar item, by name. Each presses the button (or calls the
   * function) the app already has for it, so the menu and the window never
   * disagree about what a command does.
   */
  function runCommand(item){
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
      setThemePref(item.slice(6)); // "system" follows the OS from here on
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
    // the app's own dialog: Electron has no window.prompt
    askText("Join a team", { placeholder: "https://\u2026/join/#\u2026", ok: "Open invite", required: true,
      note: "Paste the invite link a teammate sent you. It opens a page that shows what joining sets up before anything happens." })
      .then(function(link){ if (link && link.trim()) openJoin(link.trim()); });
  }

  /**
   * The commands worth finding by name, for the palette: label, the menu
   * shortcut (desktop), an icon, and whether it needs a project open.
   * The same names the menu bar sends, so ⌘K and the menu never drift.
   */
  var COMMANDS = [
    ["new-chat", "New chat", "⌘N", ICONS.chat, true],
    ["new-task", "New task", "⌘⇧N", ICONS.tasks, false],
    ["orchestrate", "New orchestra", "⌘⇧O", ICONS.orchestra, true],
    ["crew", "New crew goal", "⌘⇧G", ICONS.team, true],
    ["add-project", "Add a project", "⌘O", ICONS.folderPlus, false],
    ["project-settings", "Project settings", "", ICONS.gear, true],
    ["export-chat", "Export this chat as Markdown", "⌘⇧E", ICONS.download, true],
    ["find", "Find in this chat", "⌘F", ICONS.search, true],
    ["prompts", "Saved prompts", "⌘⇧V", ICONS.clipboard, true],
    ["tools", "Skills & MCP servers", "", ICONS.plug, true],
    ["tab:thread", "Go to Chat", "⌘1", ICONS.thread, true],
    ["tab:orchestra", "Go to Orchestra", "⌘2", ICONS.orchestra, true],
    ["tab:crew", "Go to Crew", "⌘3", ICONS.team, true],
    ["tab:fleet", "Go to Agents", "⌘4", ICONS.fleet, true],
    ["tab:board", "Go to Board", "⌘5", ICONS.board, true],
    ["tab:brain", "Go to Memory", "⌘6", ICONS.memory, true],
    ["tab:observatory", "Go to Insights", "⌘7", ICONS.telescope, true],
    ["toggle-sidebar", "Toggle sidebar", "⌘B", ICONS.panelRight, false],
    ["toggle-rail", "Toggle right panel", "⌥⌘B", ICONS.panelRight, true],
    ["toggle-terminal", "Toggle terminal", "Ctrl+`", ICONS.terminal, true],
    ["toggle-browser", "Toggle browser", "⌘⇧B", ICONS.globe, true],
    ["console", "Console · errors and logs", "⌘⇧Y", ICONS.console, true],
    ["focus", "Focus mode", "⌘.", ICONS.target, false],
    ["interrupt", "Interrupt the agent", "⌘⇧.", ICONS.stop, true],
    ["pick-agent", "Choose the agent", "⌘⇧A", ICONS.agents, true],
    ["plan", "Toggle plan mode", "⌘⇧M", ICONS.plan, true],
    ["approvals", "Approvals waiting on you", "", ICONS.shield, true],
    ["add-agent", "Add an agent", "", ICONS.plus, true],
    ["invite", "Invite a teammate", "⌘⇧U", ICONS.team, true],
    ["join", "Join a team with an invite link", "", ICONS.link, false],
    ["team-settings", "Team settings", "", ICONS.team, false],
    ["pair", "Connect a phone", "⌘⇧P", ICONS.phone, false],
    ["cloud", "Loom Cloud", "", ICONS.cloud, false],
    ["settings", "Settings", "⌘,", ICONS.gear, false],
    ["theme:light", "Light theme", "", ICONS.sun, false],
    ["theme:dark", "Dark theme", "", ICONS.moon, false],
    ["theme:system", "Match system theme", "", ICONS.sun, false],
    ["shortcuts", "Keyboard shortcuts", "⌘/", ICONS.keyboard, false],
  ].map(function(c){ return { id: c[0], label: c[1], keys: c[2], icon: c[3], needsProject: c[4] }; });

export { COMMANDS,runCommand };
