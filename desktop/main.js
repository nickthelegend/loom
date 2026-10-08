// Loom desktop — a thin Electron shell around the daemon's web app.
// Our own code: it starts the loom daemon and loads the same /app surface the
// phone and browser use. No IDE, no editor — the continuity layer, on desktop.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, screen, shell } from "electron";
import { prepareAppUrl } from "./loom-app.js";
import { checkForUpdates } from "./updater.js";

const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));
// The Loom mark. The packaged app gets its icon from electron-builder, but in
// dev (`electron .`) macOS shows the default Electron icon unless we set it, so
// the dock + window carry the same logo as the phone and the web app.
const ICON = fileURLToPath(new URL("./build/icon.png", import.meta.url));
// Name the app — dock, menu bar, About. Matches the packaged productName so the
// dev shell (`electron .`) and the built app read the same "Loom Desktop".
app.setName("Loom Desktop");

// Orca-style chrome: the window background matches the app canvas so there is
// no flash while the daemon spins up (#0a0a0a dark / #ffffff light).
const BG = "#0a0a0a";
let win = null;

// One Loom per machine: a second launch focuses the window that's already
// open instead of racing it for the daemon.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

// The window comes back where you left it. A saved rect that no longer fits a
// display (monitor unplugged) is ignored rather than opened off-screen.
const STATE_FILE = () => path.join(app.getPath("userData"), "window-state.json");

function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      b.x >= a.x - 40 && b.y >= a.y - 40 && b.x + 200 <= a.x + a.width && b.y + 100 <= a.y + a.height,
    );
    return visible && b.width >= 600 && b.height >= 400 ? b : null;
  } catch {
    return null;
  }
}

function persistBounds(w) {
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return;
      try {
        fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...w.getBounds(), maximized: w.isMaximized() }));
      } catch {
        /* losing a window position is not worth an error */
      }
    }, 400);
  };
  w.on("resize", save);
  w.on("move", save);
  w.on("close", save);
}

/** Tell the web app a native menu item was chosen (see preload's onMenu). */
function menuAction(action) {
  const target = BrowserWindow.getFocusedWindow() ?? win;
  target?.webContents.send("loom:menu", action);
}

async function createWindow() {
  // Orca-style: fill the work area on launch (never larger than the display).
  const area = screen.getPrimaryDisplay().workAreaSize;
  const saved = savedBounds();
  win = new BrowserWindow({
    width: saved?.width ?? Math.min(1512, area.width),
    height: saved?.height ?? Math.min(945, area.height),
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 600,
    minHeight: 400,
    backgroundColor: BG,
    title: "Loom",
    icon: ICON,
    acceptFirstMouse: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Centered in the web app's 40px title strips (light center = 20, radius 6).
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 14 } } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD,
    },
  });

  if (saved?.maximized) win.maximize();
  persistBounds(win);
  attachContextMenu(win.webContents);

  // Open external links (docs, github) in the real browser, not the shell.
  // Only this machine's own pages may open inside it — compared by parsed
  // hostname, because "http://localhost.evil.com" starts with
  // "http://localhost". The preview's "Open in browser" names its window
  // "loom-external", which always means the real browser, local or not.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    let u = null;
    try { u = new URL(url); } catch { /* not a url at all */ }
    if (!u) return { action: "deny" };
    // No popup opens inside Loom, loopback included: a child window would
    // inherit this window's preload (window.loomNative), so a page in the
    // preview could reach the shell through it. Every link goes to the real
    // browser; a dev server's OAuth popup works there just the same.
    void frameName;
    // Only the schemes a browser or mail client is for — never file:, or a
    // custom scheme that launches some other app with arguments from a page.
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") void shell.openExternal(u.href);
    return { action: "deny" };
  });

  try {
    const { url } = await prepareAppUrl();
    await win.loadURL(url);
  } catch (err) {
    await win.loadURL(
      "data:text/html," +
        encodeURIComponent(
          `<body style="background:${BG};color:#fafafa;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.01em;padding:48px">` +
            `<h2 style="font-weight:650;font-size:22px;margin:0 0 4px">loom</h2>` +
            `<div style="width:48px;height:2px;border-radius:1px;background:linear-gradient(90deg,transparent,#67e8f9,transparent);margin:0 0 18px"></div>` +
            `<p style="color:#a1a1a1">Could not start the loom daemon.</p>` +
            `<pre style="color:#ff6568;background:#171717;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:12px 14px;white-space:pre-wrap">${String(err)}</pre>` +
            `<p style="color:#a1a1a1">Make sure the project is built (<code style="background:#262626;border-radius:5px;padding:1px 6px">npm run build</code>) and try again.</p></body>`,
        ),
    );
  }
}

/**
 * The menu bar: everything the app can do, where a desktop app keeps it, with
 * the shortcut beside it. Items are words sent to the page (loom:menu), which
 * runs the same code the buttons do — the menu is a second door, not a second
 * implementation. Editing and windows use the OS's own roles.
 */
function buildMenu() {
  const isMac = process.platform === "darwin";
  const send = (action) => () => menuAction(action);
  const item = (label, action, accelerator) => ({ label, click: send(action), ...(accelerator ? { accelerator } : {}) });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [{
            label: app.name,
            submenu: [
              { role: "about" },
              { label: "Check for Updates…", click: () => void checkForUpdates().catch(() => {}) },
              { type: "separator" },
              item("Settings…", "settings", "CmdOrCtrl+,"),
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          }]
        : []),
      {
        label: "File",
        submenu: [
          item("New Chat", "new-chat", "CmdOrCtrl+N"),
          item("New Task…", "new-task", "CmdOrCtrl+Shift+N"),
          item("New Orchestra…", "orchestrate", "CmdOrCtrl+Shift+O"),
          item("New Crew Goal…", "crew", "CmdOrCtrl+Shift+G"),
          { type: "separator" },
          item("Add Project…", "add-project", "CmdOrCtrl+O"),
          item("Project Settings…", "project-settings"),
          { type: "separator" },
          item("Export Chat as Markdown…", "export-chat", "CmdOrCtrl+Shift+E"),
          { type: "separator" },
          ...(isMac ? [{ role: "close" }] : [item("Settings…", "settings", "CmdOrCtrl+,"), { type: "separator" }, { role: "quit" }]),
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          ...(isMac ? [{ role: "pasteAndMatchStyle" }] : []),
          { role: "delete" },
          { role: "selectAll" },
          { type: "separator" },
          item("Find in Chat…", "find", "CmdOrCtrl+F"),
          item("Command Palette…", "palette", "CmdOrCtrl+K"),
          item("Saved Prompts…", "prompts", "CmdOrCtrl+Shift+V"),
          ...(isMac ? [{ type: "separator" }, { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] }] : []),
        ],
      },
      {
        label: "View",
        submenu: [
          item("Chat", "tab:thread", "CmdOrCtrl+1"),
          item("Orchestra", "tab:orchestra", "CmdOrCtrl+2"),
          item("Crew", "tab:crew", "CmdOrCtrl+3"),
          item("Agents", "tab:fleet", "CmdOrCtrl+4"),
          item("Board", "tab:board", "CmdOrCtrl+5"),
          item("Memory", "tab:brain", "CmdOrCtrl+6"),
          item("Insights", "tab:observatory", "CmdOrCtrl+7"),
          { type: "separator" },
          item("Toggle Sidebar", "toggle-sidebar", "CmdOrCtrl+B"),
          item("Toggle Right Panel", "toggle-rail", "CmdOrCtrl+Alt+B"),
          item("Toggle Terminal", "toggle-terminal", "Ctrl+`"),
          item("Toggle Browser", "toggle-browser", "CmdOrCtrl+Shift+B"),
          item("Console", "console", "CmdOrCtrl+Shift+Y"),
          item("Focus Mode", "focus", "CmdOrCtrl+."),
          { type: "separator" },
          {
            label: "Appearance",
            submenu: [item("Light", "theme:light"), item("Dark", "theme:dark"), item("Match System", "theme:system")],
          },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
          { type: "separator" },
          { role: "reload" },
          { role: "toggleDevTools" },
        ],
      },
      {
        label: "Agent",
        submenu: [
          item("Interrupt", "interrupt", "CmdOrCtrl+Shift+."),
          item("Choose Agent…", "pick-agent", "CmdOrCtrl+Shift+A"),
          item("Toggle Plan Mode", "plan", "CmdOrCtrl+Shift+M"),
          { type: "separator" },
          item("Approvals…", "approvals"),
          item("Add an Agent…", "add-agent"),
          item("Skills & MCP Servers…", "tools"),
        ],
      },
      {
        label: "Go",
        submenu: [
          item("Next Project", "project:next", "CmdOrCtrl+Alt+Down"),
          item("Previous Project", "project:prev", "CmdOrCtrl+Alt+Up"),
          item("Next Chat", "chat:next", "CmdOrCtrl+Shift+]"),
          item("Previous Chat", "chat:prev", "CmdOrCtrl+Shift+["),
          { type: "separator" },
          item("All Projects", "home", "CmdOrCtrl+Shift+H"),
        ],
      },
      {
        label: "Team",
        submenu: [
          item("Invite a Teammate…", "invite", "CmdOrCtrl+Shift+U"),
          item("Join with an Invite Link…", "join"),
          { type: "separator" },
          item("Team Activity", "tab:fleet"),
          item("Team Settings…", "team-settings"),
          { type: "separator" },
          item("Connect a Phone…", "pair", "CmdOrCtrl+Shift+P"),
          item("Loom Cloud…", "cloud"),
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          item("Keyboard Shortcuts", "shortcuts", "CmdOrCtrl+/"),
          { label: "Documentation", click: () => shell.openExternal("https://github.com/nickthelegend/loom#readme") },
          { label: "Report an Issue…", click: () => shell.openExternal("https://github.com/nickthelegend/loom/issues/new") },
          { type: "separator" },
          ...(isMac ? [] : [{ label: "Check for Updates…", click: () => void checkForUpdates().catch(() => {}) }]),
          { label: "Loom on GitHub", click: () => shell.openExternal("https://github.com/nickthelegend/loom") },
        ],
      },
    ]),
  );
}

/**
 * The right-click menu the page doesn't draw itself. The app has its own for
 * messages, files, projects and chats (it calls preventDefault there); this
 * covers the rest the way a native app would: editing in any text field —
 * with spelling suggestions — copying a selection, and links.
 */
function attachContextMenu(contents) {
  contents.on("context-menu", (_e, p) => {
    const items = [];
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => contents.replaceMisspelling(s) });
      if (p.dictionarySuggestions.length) items.push({ type: "separator" });
      items.push({ label: "Add to Dictionary", click: () => contents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: "separator" });
    }
    if (p.linkURL && /^https?:/i.test(p.linkURL)) {
      items.push({ label: "Open Link in Browser", click: () => shell.openExternal(p.linkURL) });
      items.push({ label: "Copy Link", click: () => clipboard.writeText(p.linkURL) });
      items.push({ type: "separator" });
    }
    if (p.isEditable) {
      items.push(
        { role: "undo", enabled: p.editFlags.canUndo },
        { role: "redo", enabled: p.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: p.editFlags.canCut },
        { role: "copy", enabled: p.editFlags.canCopy },
        { role: "paste", enabled: p.editFlags.canPaste },
        { role: "selectAll" },
      );
    } else if (p.selectionText && p.selectionText.trim()) {
      items.push({ role: "copy" });
      items.push({ label: "Quote in Chat", click: () => menuAction("quote:" + p.selectionText.slice(0, 4000)) });
    }
    if (!items.length) return;
    while (items.length && items[items.length - 1].type === "separator") items.pop();
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
  });
}


// The Browser pane's screenshot, of exactly what's on screen: the preview is
// another origin, so the page can't photograph its own frame — the shell can.
// A rectangle of the asking window only, clamped to it; a PNG data URL back.
ipcMain.handle("loom:capture", async (e, rect) => {
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const r = rect && typeof rect === "object" ? { x: n(rect.x), y: n(rect.y), width: n(rect.width), height: n(rect.height) } : null;
  if (!r || r.width < 2 || r.height < 2 || r.width > 10000 || r.height > 10000) return null;
  const image = await e.sender.capturePage(r);
  return image.isEmpty() ? null : image.toDataURL();
});

// "Reveal in Finder" from the Explorer: only an absolute path to something that exists.
ipcMain.handle("loom:reveal", async (_e, p) => {
  if (typeof p !== "string" || !path.isAbsolute(p) || !fs.existsSync(p)) return false;
  shell.showItemInFolder(p);
  return true;
});

// Native folder picker for "New project". The renderer only ever receives a
// path the user chose in the OS dialog themselves.
ipcMain.handle("loom:pick-folder", async () => {
  const parent = BrowserWindow.getFocusedWindow() ?? win;
  const opts = { title: "Choose a project folder", properties: ["openDirectory", "createDirectory"] };
  const r = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

/**
 * An agent asked you something.
 *
 * The web build raises a browser notification, which the desktop shell can do
 * better: a native one that carries the question itself, and clicking it puts
 * that conversation in front of you. Nothing fires while the window is focused
 * and already showing that chat — the page decides that and only calls here
 * when it's worth interrupting for.
 */
ipcMain.handle("loom:notify", (_e, payload) => {
  if (!Notification.isSupported()) return false;
  const p = payload && typeof payload === "object" ? payload : {};
  const title = String(p.title ?? "An agent needs you").slice(0, 120);
  const body = String(p.body ?? "").slice(0, 400);
  const note = new Notification({
    title,
    body,
    // The reply arrives back through the same channel the page listens on.
    hasReply: process.platform === "darwin" && p.canReply !== false,
    replyPlaceholder: "Answer\u2026",
    silent: false,
  });
  note.on("click", () => {
    const target = BrowserWindow.getAllWindows()[0] ?? win;
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    target.webContents.send("loom:notify-action", { kind: "open", chat: p.chat ?? null, project: p.project ?? null });
  });
  note.on("reply", (_ev, reply) => {
    const target = BrowserWindow.getAllWindows()[0] ?? win;
    if (!target) return;
    target.webContents.send("loom:notify-action", {
      kind: "reply",
      text: String(reply ?? ""),
      chat: p.chat ?? null,
      project: p.project ?? null,
      agentId: p.agentId ?? null,
    });
  });
  note.show();
  return true;
});

/** Does the shell's window have focus? The page asks before deciding to notify. */
ipcMain.handle("loom:focused", () => {
  const target = BrowserWindow.getAllWindows()[0] ?? win;
  return Boolean(target && target.isFocused() && target.isVisible());
});

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(ICON);
    } catch {
      /* a missing/bad icon shouldn't stop the app launching */
    }
  }
  buildMenu();
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
