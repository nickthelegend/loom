// Loom desktop — a thin Electron shell around the daemon's web app.
// Our own code: it starts the loom daemon and loads the same /app surface the
// phone and browser use. No IDE, no editor — the continuity layer, on desktop.

import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from "electron";
import { prepareAppUrl } from "./loom-app.js";

const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));
// The Loom mark. The packaged app gets its icon from electron-builder, but in
// dev (`electron .`) macOS shows the default Electron icon unless we set it, so
// the dock + window carry the same logo as the phone and the web app.
const ICON = fileURLToPath(new URL("./build/icon.png", import.meta.url));

// Orca-style chrome: the window background matches the app canvas so there is
// no flash while the daemon spins up (#0a0a0a dark / #ffffff light).
const BG = "#0a0a0a";
let win = null;

async function createWindow() {
  // Orca-style: fill the work area on launch (never larger than the display).
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1512, area.width),
    height: Math.min(945, area.height),
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
