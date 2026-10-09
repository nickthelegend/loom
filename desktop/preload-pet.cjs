// The pet window's whole surface: moods in, clicks and drags out. No token,
// no fetch — the shell talks to the daemon and only hands this a mood.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("loomPet", {
  onState: function (cb) {
    ipcRenderer.on("pet:state", function (_e, s) {
      if (s && typeof s === "object") cb(s);
    });
  },
  open: function (target) {
    ipcRenderer.send("pet:open", target && typeof target === "object" ? { project: String(target.project || ""), chat: target.chat ? String(target.chat) : null } : null);
  },
  menu: function () { ipcRenderer.send("pet:menu"); },
  setInside: function (inside) { ipcRenderer.send("pet:inside", !!inside); },
  drag: function (dx, dy) { ipcRenderer.send("pet:drag", Number(dx) || 0, Number(dy) || 0); },
  dragEnd: function () { ipcRenderer.send("pet:drag-end"); },
});
