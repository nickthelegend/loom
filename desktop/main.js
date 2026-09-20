// Loom desktop — a thin Electron shell around the daemon's web app.
// Our own code: it starts the loom daemon and loads the same /app surface the
// phone and browser use. No IDE, no editor — the continuity layer, on desktop.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, screen, shell } from "electron";
import { prepareAppUrl } from "./loom-app.js";

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

  // Open external links (docs, github) in the real browser, not the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
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

function buildMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" }] : []),
      {
        label: "Loom",
        submenu: [
          { label: "New Orchestra…", accelerator: "CmdOrCtrl+Shift+O", click: () => menuAction("orchestrate") },
          { label: "New Chat", accelerator: "CmdOrCtrl+N", click: () => menuAction("new-chat") },
          { type: "separator" },
          { label: "Connect a Phone…", accelerator: "CmdOrCtrl+Shift+P", click: () => menuAction("pair") },
          { label: "Loom Cloud…", click: () => menuAction("cloud") },
          { type: "separator" },
          { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => menuAction("settings") },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Help",
        submenu: [
          {
            label: "Loom on GitHub",
            click: () => shell.openExternal("https://github.com/nickthelegend/loom"),
          },
        ],
      },
    ]),
  );
}

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
