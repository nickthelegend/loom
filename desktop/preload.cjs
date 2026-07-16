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
});
