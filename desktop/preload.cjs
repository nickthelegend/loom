// Marks the page as running inside the Electron shell (with the platform), so
// the web app can adopt native desktop chrome — a draggable title strip and
// macOS traffic-light clearance. CommonJS so it loads in a sandboxed preload.
const { contextBridge, ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", function () {
  try {
    document.documentElement.setAttribute("data-electron", process.platform);
  } catch (e) {
    /* non-fatal: the app works without native chrome hints */
  }
});

// The one native affordance the browser can't offer: a real folder picker for
// "New project". Deliberately the whole surface — no fs, no shell, no ipc
// passthrough. The browser build just types the path instead.
contextBridge.exposeInMainWorld("loomNative", {
  pickFolder: function () {
    return ipcRenderer.invoke("loom:pick-folder");
  },
  // Native menu items (Loom ▸ New Orchestra…, Connect a Phone…, Settings…).
  // The page subscribes; the action is one of a fixed set of strings.
  onMenu: function (cb) {
    ipcRenderer.on("loom:menu", function (_e, action) {
      if (typeof action === "string") cb(action);
    });
  },
  // An agent's question, as a native notification carrying the question
  // itself. The page decides whether it's worth interrupting for; this only
  // shows what it was given, and hands back what the person did with it.
  notify: function (payload) {
    return ipcRenderer.invoke("loom:notify", payload);
  },
  isFocused: function () {
    return ipcRenderer.invoke("loom:focused");
  },
  onNotifyAction: function (cb) {
    ipcRenderer.on("loom:notify-action", function (_e, action) {
      if (action && typeof action === "object") cb(action);
    });
  },
});
