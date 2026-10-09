// The Loom pet's window: small, transparent, always on top, on every Space.
// The shell polls the daemon (it already holds the admin token) and sends the
// pet a mood from pet-model.js; the pet sends back clicks and drags. Clicks
// pass through everywhere except the pet and its bubble.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import { petState } from "./pet-model.js";

const PAGE = fileURLToPath(new URL("./pet/pet.html", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./preload-pet.cjs", import.meta.url));
const W = 340, H = 214;
const POLL_MS = 1500;

const prefsFile = () => path.join(app.getPath("userData"), "pet.json");
function readPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsFile(), "utf8")); } catch { return {}; }
}
function writePrefs(p) {
  try { fs.writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...p })); } catch { /* a lost position is fine */ }
}

/** Is the pet switched on? On by default; the View menu and its own menu turn it off. */
export function petEnabled() {
  return readPrefs().show !== false;
}

/**
 * @param {{ daemon: () => { base: string, adminToken: string } | null, openChat: (target: {project: string, chat: string|null} | null) => void, onToggle?: (on: boolean) => void }} deps
 */
export function createPet(deps) {
  let win = null, timer = null, lastBusyAt = Date.now(), lastSent = "";

  function place() {
    const saved = readPrefs();
    const area = screen.getPrimaryDisplay().workArea;
    const fits = (x, y) => screen.getAllDisplays().some(({ workArea: a }) => x >= a.x - W / 2 && y >= a.y - H / 2 && x + W / 2 <= a.x + a.width && y + H / 2 <= a.y + a.height);
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && fits(saved.x, saved.y)) return { x: saved.x, y: saved.y };
    return { x: area.x + area.width - W - 24, y: area.y + area.height - H - 12 };
  }

  function show() {
    if (win && !win.isDestroyed()) return win.showInactive();
    const { x, y } = place();
    win = new BrowserWindow({
      width: W, height: H, x, y,
      frame: false, transparent: true, resizable: false, movable: true, hasShadow: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, fullscreenable: false, show: false,
      backgroundColor: "#00000000",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: PRELOAD },
    });
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    void win.loadFile(PAGE).then(() => { win?.showInactive(); lastSent = ""; void poll(); });
    win.on("closed", () => { win = null; });
    timer ??= setInterval(() => void poll(), POLL_MS);
  }

  function hide() {
    if (timer) { clearInterval(timer); timer = null; }
    if (win && !win.isDestroyed()) win.close();
    win = null;
  }

  function setEnabled(on) {
    writePrefs({ show: on });
    if (on) show(); else hide();
    deps.onToggle?.(on);
  }

  async function poll() {
    if (!win || win.isDestroyed()) return;
    const d = deps.daemon();
    if (!d) return;
    const get = async (p) => {
      const r = await fetch(d.base + p, { headers: { authorization: `Bearer ${d.adminToken}` }, signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    };
    try {
      const { projects = [] } = await get("/api/projects");
      // events only for projects with something going on, or that just did
      const lively = projects.filter((p) => p.needsInput || (p.agents ?? []).some((a) => a.busy) || p.id === poll.lastLively);
      const events = {};
      await Promise.all(lively.slice(0, 4).map(async (p) => {
        try { events[p.id] = (await get(`/api/projects/${p.id}/events?limit=25`)).events ?? []; } catch { /* that project can wait */ }
      }));
      const s = petState(projects, events, Date.now(), lastBusyAt);
      if (s.mood === "work" || s.mood === "alert") { lastBusyAt = Date.now(); poll.lastLively = s.project; }
      else if (s.mood === "idle" || s.mood === "sleep") poll.lastLively = undefined;
      const msg = JSON.stringify(s);
      if (msg !== lastSent && win && !win.isDestroyed()) { lastSent = msg; win.webContents.send("pet:state", s); }
    } catch {
      /* the daemon is restarting; the pet keeps its last face */
    }
  }

  const fromPet = (e) => win && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.on("pet:inside", (e, inside) => {
    if (fromPet(e)) win.setIgnoreMouseEvents(!inside, { forward: true });
  });
  ipcMain.on("pet:drag", (e, dx, dy) => {
    if (!fromPet(e)) return;
    const [x, y] = win.getPosition();
    win.setPosition(Math.round(x + dx), Math.round(y + dy));
  });
  ipcMain.on("pet:drag-end", (e) => {
    if (!fromPet(e)) return;
    const [x, y] = win.getPosition();
    writePrefs({ x, y });
  });
  ipcMain.on("pet:open", (e, target) => {
    if (fromPet(e)) deps.openChat(target && target.project ? target : null);
  });
  ipcMain.on("pet:menu", (e) => {
    if (!fromPet(e)) return;
    Menu.buildFromTemplate([
      { label: "Open Loom", click: () => deps.openChat(null) },
      { type: "separator" },
      { label: "Put the Pet Back in the Corner", click: () => { writePrefs({ x: undefined, y: undefined }); const p = place(); win?.setPosition(p.x, p.y); } },
      { label: "Hide the Pet", click: () => setEnabled(false) },
    ]).popup({ window: win });
  });

  return { show, hide, setEnabled, isShown: () => !!(win && !win.isDestroyed()) };
}
