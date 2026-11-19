import { trayHostAvailable } from './tray-host.js';
import fs from 'node:fs';
import path from 'node:path';

/** A fresh menu on every poll keeps approvals and running counts honest while Loom is hidden. */
export function trayMenu(mission, inbox, actions) {
  return [
    { label: `${mission.runningTurns} running turn${mission.runningTurns === 1 ? '' : 's'}`, enabled: false },
    { label: 'Mission control', click: actions.mission },
    { label: `Needs you (${inbox.count})`, submenu: inbox.items.length ? inbox.items.map(i => ({ label: `${i.projectName} · ${i.title}`.slice(0, 150), click: () => actions.chat(i) })) : [{ label: 'All clear', enabled: false }] },
    { label: 'Running chats', submenu: mission.chats.length ? mission.chats.map(c => ({ label: `${c.projectName} · ${c.title}`, click: () => actions.chat(c) })) : [{ label: 'No running chats', enabled: false }] },
    { type: 'separator' }, { label: 'Quick send…', click: actions.quick },
    { label: 'Open Loom', click: () => actions.chat(null) }, { role: 'quit' },
  ];
}
export function allowedWorkspaceSender(event, origin) {
  try { const url = new URL(event.senderFrame?.url); return !!origin && url.origin === origin && url.pathname === '/app' && event.senderFrame === event.sender.mainFrame; } catch { return false; }
}
export function popoutUrl(value, origin) {
  if (typeof value !== 'string' || !origin) return null;
  try {
    const u = new URL(value, origin);
    if (u.origin !== origin || u.pathname !== '/app' || u.searchParams.get('popout') !== '1' || !/^popout-[\w-]+$/.test(u.searchParams.get('pane') || '') || !/^#p\/[^/]+\/c\/[^/]+$/.test(u.hash)) return null;
    return u.href;
  } catch { return null; }
}
export function createTray({ app, Tray, Menu, nativeImage, icon, daemon, actions, platform = process.platform, hostAvailable = () => trayHostAvailable(platform), hasWindows = () => true }) {
  const file = path.join(app.getPath('userData'), 'tray-preference.json');
  let enabled = platform === 'darwin', available = platform !== 'linux', tray = null, busy = false, closed = false;
  try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')).enabled; if (typeof saved === 'boolean') enabled = saved; } catch {}
  async function refresh() {
    if (!enabled || busy || closed) return;
    busy = true;
    try {
      available = await hostAvailable();
      if (closed || !enabled) return;
      if (!available) {
        tray?.destroy(); tray = null;
        if (platform !== 'darwin' && !hasWindows()) app.quit();
        return;
      }
      if (!tray) {
        try {
          const image = nativeImage.createFromPath(icon).resize({ width: 18, height: 18 });
          tray = new Tray(image); tray.setToolTip('Loom'); tray.on('click', () => tray?.popUpContextMenu());
        } catch { available = false; if (platform !== 'darwin' && !hasWindows()) app.quit(); return; }
      }
      const cfg = daemon(); if (!cfg) return;
      const get = async p => { const r = await fetch(cfg.base + p, { headers: { Authorization: `Bearer ${cfg.adminToken}` }, signal: AbortSignal.timeout(4000) }); if (!r.ok) throw new Error('Daemon unavailable'); return r.json(); };
      const [mission, inbox] = await Promise.all([get('/api/mission'), get('/api/inbox')]);
      if (!tray || !enabled || closed) return;
      tray.setTitle(platform === 'darwin' ? String(mission.runningTurns) : '');
      tray.setToolTip(`Loom · ${mission.runningTurns} running · ${inbox.count} need you`);
      tray.setContextMenu(Menu.buildFromTemplate(trayMenu(mission, inbox, actions)));
    } catch { if (tray) { tray.setToolTip('Loom · daemon unavailable'); tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Daemon unavailable', enabled: false }, { label: 'Open Loom', click: () => actions.chat(null) }])); } }
    finally { busy = false; }
  }
  async function setEnabled(value) {
    enabled = value; fs.writeFileSync(file, JSON.stringify({ enabled }), { mode: 0o600 });
    if (!enabled) { tray?.destroy(); tray = null; } else await refresh();
    return state();
  }
  const timer = setInterval(() => void refresh(), 10000); timer.unref(); void refresh();
  app.once('before-quit', () => { closed = true; clearInterval(timer); tray?.destroy(); tray = null; });
  function state() { return { enabled: enabled && available && !!tray, requestedEnabled: enabled, available }; }
  return { setEnabled, state, refresh };
}
