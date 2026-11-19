import { execFile } from 'node:child_process';

/** Electron exposes no Linux tray visibility API. Ask the session's notifier host.
 * A missing helper, bus, watcher or host cannot safely keep an invisible app alive.
 * https://specifications.freedesktop.org/status-notifier-item/latest/status-notifier-watcher.html
 */
export async function trayHostAvailable(platform = process.platform, run = execFile) {
  if (platform !== 'linux') return true;
  for (const name of ['org.kde.StatusNotifierWatcher', 'org.freedesktop.StatusNotifierWatcher']) {
    const available = await new Promise(resolve => {
      run('gdbus', ['call', '--session', '--dest', name, '--object-path', '/StatusNotifierWatcher', '--method', 'org.freedesktop.DBus.Properties.Get', name, 'IsStatusNotifierHostRegistered'],
        { timeout: 1000 }, (error, stdout) => resolve(!error && /\btrue\b/.test(String(stdout))));
    });
    if (available) return true;
  }
  return false;
}
