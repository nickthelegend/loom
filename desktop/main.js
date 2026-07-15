// Loom desktop — a thin Electron shell around the daemon's web app.
// Our own code: it starts the loom daemon and loads the same /app surface the
// phone and browser use. No IDE, no editor — the continuity layer, on desktop.

import { app, BrowserWindow, Menu, shell } from "electron";
import { prepareAppUrl } from "./loom-app.js";

const BG = "#0b0e14";
let win = null;

async function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: BG,
    title: "Loom",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
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
          `<body style="background:${BG};color:#dbe2f0;font:15px -apple-system,sans-serif;padding:40px">` +
            `<h2>lo<span style="color:#67e8f9">om</span></h2>` +
            `<p>Could not start the loom daemon.</p><pre style="color:#f87171">${String(err)}</pre>` +
            `<p style="color:#7c88a1">Make sure the project is built (<code>npm run build</code>) and try again.</p></body>`,
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

app.whenReady().then(() => {
  buildMenu();
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
