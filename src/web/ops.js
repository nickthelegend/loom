import { esc } from './format.js';

const bytes = n => (Number(n || 0) / 1048576).toFixed(2) + ' MB';

function actionText(r) {
  if (r.fixed) return [r.fixed.length ? r.fixed.map(s => 'Fixed: ' + s).join('\n') : 'No repairs needed.', ...(r.unfixable || []).map(s => 'Needs attention: ' + s), r.summary ? 'Remaining failing checks: ' + r.summary.failures : ''].filter(Boolean).join('\n');
  if ('backup' in r) return r.backup ? 'Backups every ' + r.backup.every + '; keeping ' + r.backup.keep + '. Next: ' + new Date(r.backup.nextAt).toLocaleString() : 'Backup schedule disabled.';
  if (r.disk) return 'Report refreshed.';
  if (r.policy) return 'Saved worktree policy: ' + r.policy.days + ' days, at most ' + r.policy.keep + ' finished runs.';
  if (r.candidates) return [r.dryRun ? 'Dry run: ' + r.candidates.length + ' run' + (r.candidates.length === 1 ? '' : 's') + ' would be pruned.' : 'Pruned ' + (r.removed || []).length + ' runs.', (r.dryRun ? r.candidates : r.removed || []).join(', '), ...(r.skipped || []).map(s => 'Kept ' + s.id + ': ' + s.reason)].filter(Boolean).join('\n');
  if (r.respawned) return 'Session reaped and restarted.';
  return JSON.stringify(r, null, 2);
}

export function renderOps(pane, api, selected) {
  pane.innerHTML = '<div class="setphead">Operations</div><div class="setpsub">Backups, disk usage and safe repairs on this computer.</div>' +
    '<div id="ops-machine"></div><label>Project <select id="ops-project" aria-label="Operations project"></select></label><div id="ops-detail"></div><pre class="scmd ops-output" id="ops-result" role="status"></pre>';
  const machine = pane.querySelector('#ops-machine'), detail = pane.querySelector('#ops-detail'), result = pane.querySelector('#ops-result');
  const projects = pane.querySelector('#ops-project');
  let generation = 0;
  function action(button, path, method, body, done) {
    button.disabled = true;
    const gen = generation;
    api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }).then(r => {
      if (gen !== generation) return;
      button.disabled = false;
      result.textContent = actionText(r);
      if (done) done(r);
    }).catch(e => { button.disabled = false; if (gen === generation) result.textContent = e.message; });
  }
  function loadMachine() {
    api('/api/ops').then(m => {
      machine.innerHTML = '<div class="sgrouph">Scheduled backups</div><div class="snote">Runs while Loom is running. Missed backups run once on restart. Archives stay in Loom’s private backups folder.</div>' +
        '<div class="ops-fields"><label>Every <input id="ops-every" aria-label="Backup interval" value="' + esc(m.backup?.every || '1d') + '"></label>' +
        '<label>Keep <input id="ops-keep" aria-label="Backups to keep" type="number" min="1" max="365" value="' + esc(m.backup?.keep || 7) + '"></label></div>' +
        '<div class="pillrow"><button class="btn sm" id="ops-save-backup">Save schedule</button><button class="btn ghost sm" id="ops-off-backup">Disable schedule</button></div>' +
        '<div class="snote">' + esc(m.backup ? 'Next: ' + new Date(m.backup.nextAt).toLocaleString() + (m.backup.lastAt ? ' · Last success: ' + new Date(m.backup.lastAt).toLocaleString() : '') + (m.backup.error ? ' · Failed: ' + m.backup.error : '') : 'No backup schedule') + '</div>' +
        '<div class="sgrouph">Daemon logs and metrics</div><div class="snote">Log ' + esc(bytes(m.log.bytes)) + ' · cap ' + esc(bytes(m.log.cap)) + ' · previous ' + esc(bytes(m.log.rotatedBytes)) + '. Rotation checks every second. Prometheus: /metrics with the admin bearer token.</div>' +
        '<div class="sgrouph">Redacted crash reports</div>' + (m.crashes.length ? m.crashes.map(f => '<button class="btn ghost sm" data-crash="' + esc(f) + '">' + esc(f) + '</button>').join('') : '<div class="snote">No crash reports</div>');
      machine.querySelector('#ops-save-backup').onclick = e => action(e.currentTarget, '/api/ops/backups', 'PUT', { every: machine.querySelector('#ops-every').value, keep: Number(machine.querySelector('#ops-keep').value) }, loadMachine);
      machine.querySelector('#ops-off-backup').onclick = e => action(e.currentTarget, '/api/ops/backups', 'DELETE', null, loadMachine);
      machine.querySelectorAll('[data-crash]').forEach(b => { b.onclick = () => action(b, '/api/ops/crashes/' + encodeURIComponent(b.dataset.crash), 'GET'); });
    }).catch(e => { machine.textContent = e.message; });
  }
  function loadProject() {
    const gen = ++generation, id = projects.value;
    result.textContent = '';
    if (!id) { detail.textContent = 'Add a project to inspect its disk and sessions.'; return; }
    const base = '/api/projects/' + encodeURIComponent(id);
    detail.textContent = 'Loading…';
    api(base + '/ops').then(p => {
      if (gen !== generation) return;
      detail.innerHTML = '<div class="sgrouph">Project metrics</div><div class="snote">Turns ' + esc(p.metrics.turns) + ' · Cost $' + esc(p.metrics.costUsd.toFixed(4)) + ' · Errors ' + esc(p.metrics.errors) + ' · Queue ' + esc(p.metrics.queueDepth) + '</div><div class="sgrouph">Disk usage</div><dl class="abgrid">' + [['Worktrees', p.disk.worktrees], ['Logs', p.disk.logs], ['Attachments', p.disk.attachments], ['Total', p.disk.total]].map(([name, value]) => '<dt>' + esc(name) + '</dt><dd>' + esc(bytes(value)) + '</dd>').join('') + '</dl>' +
        (p.disk.skipped.length ? '<div class="snote">Unreadable: ' + esc(p.disk.skipped.join(', ')) + '</div>' : '') +
        '<button class="btn sm" id="ops-fix">Apply safe doctor fixes</button><div class="sgrouph">Worktree retention</div><div class="snote">Finished Orchestra runs exceeding either limit are pruned automatically. Dirty or locked trees stay; branches stay. Preview before removing.</div>' +
        '<div class="ops-fields"><label>Days <input id="ops-days" aria-label="Worktree age in days" type="number" min="0" value="' + esc(p.policy.days) + '"></label><label>Keep runs <input id="ops-runs" aria-label="Worktree runs to keep" type="number" min="0" value="' + esc(p.policy.keep) + '"></label></div>' +
        '<div class="pillrow"><button class="btn sm" id="ops-policy">Save policy</button><button class="btn ghost sm" id="ops-preview">Dry run</button><button class="btn ghost sm" id="ops-prune" disabled>Prune now</button></div>' +
        '<div class="sgrouph">Stale agent sessions</div><div class="snote">Busy for at least 10 minutes. Reap interrupts the session and starts it fresh.</div>' +
        (p.stale.length ? p.stale.map(s => '<div class="dchk"><span class="sbody">' + esc(s.agentId) + ' · ' + esc(Math.round(s.busyMs / 60000)) + 'm</span><button class="btn sm" data-reap="' + esc(s.agentId) + '">Reap</button></div>').join('') : '<div class="snote">No stale sessions</div>') + '<button class="btn ghost sm" id="ops-refresh">Refresh report</button>';
      const policy = () => ({ days: Number(detail.querySelector('#ops-days').value), keep: Number(detail.querySelector('#ops-runs').value) });
      const prune = detail.querySelector('#ops-prune');
      detail.querySelectorAll('input').forEach(input => { input.oninput = () => { prune.disabled = true; }; });
      detail.querySelector('#ops-fix').onclick = e => action(e.currentTarget, base + '/doctor/fix', 'POST', {});
      detail.querySelector('#ops-policy').onclick = e => action(e.currentTarget, base + '/worktrees/policy', 'PUT', policy());
      detail.querySelector('#ops-preview').onclick = e => action(e.currentTarget, base + '/worktrees/prune', 'POST', { policy: policy(), dryRun: true }, r => { prune.disabled = !r.candidates.length; });
      prune.onclick = () => action(prune, base + '/worktrees/prune', 'POST', { policy: policy(), dryRun: false }, () => { prune.disabled = true; });
      detail.querySelectorAll('[data-reap]').forEach(b => { b.onclick = () => action(b, base + '/stale/' + encodeURIComponent(b.dataset.reap) + '/reap', 'POST', {}, loadProject); });
      detail.querySelector('#ops-refresh').onclick = loadProject;
    }).catch(e => { if (gen === generation) detail.textContent = e.message; });
  }
  loadMachine();
  api('/api/projects').then(r => {
    projects.innerHTML = r.projects.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
    if (r.projects.some(p => p.id === selected)) projects.value = selected;
    projects.onchange = loadProject;
    loadProject();
  }).catch(e => { result.textContent = e.message; });
}
