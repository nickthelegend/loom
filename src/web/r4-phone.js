import { isGuest } from "./share-live.js";
import { closeMenu, openMenu } from "./menus.js";
import { api } from './connection.js';
import { esc } from './format.js';
import { state } from './state.js';
import { toast } from './notifications.js';
const key = 'loom.phone-r4';
const defaults = { replies: ['Continue', 'Run the tests', 'Explain that'], textScale: 1, highContrast: false };
function prefs() { try { return { ...defaults, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...defaults }; } }
function save(patch) { localStorage.setItem(key, JSON.stringify({ ...prefs(), ...patch })); appearance(); }
function appearance() { const p = prefs(); document.documentElement.style.setProperty('--phone-text-scale', String(p.textScale)); document.documentElement.classList.toggle('phone-contrast', !!p.highContrast); }
function openChat(row) { state.setChat?.(row.projectId, row.chat); location.hash = '#p/' + row.projectId; state.showTab?.('thread'); }
export async function renderPhonePanel(pane) {
  const generation = Symbol(); pane.phoneRender = generation;
  const live = () => pane.isConnected && pane.phoneRender === generation;
  pane.innerHTML = '<div class="phone-tools"><h2>Now & phone</h2><div data-phone-error role="alert"></div><section data-now>Loading Now…</section><section data-brief>Loading morning brief…</section><form data-quiet><h3>Quiet hours · your phones</h3><label><input type="checkbox" name="enabled"> Nightly window</label><label>Start <input type="time" name="start" required></label><label>End <input type="time" name="end" required></label><label>Timezone <input name="timeZone" required></label><label><input type="checkbox" name="holdApprovals"> Hold approvals too (shown in Now)</label><button class="btn" type="submit">Save quiet hours</button><button class="btn" type="button" data-snooze="hour">Snooze 1h</button><button class="btn" type="button" data-snooze="morning">Until morning</button><button class="btn" type="button" data-snooze="off">End snooze</button><p data-snoozed></p></form><section><h3>Appearance on this device</h3><label>Text size <select data-scale><option value="0.85">85%</option><option value="1">100%</option><option value="1.15">115%</option><option value="1.3">130%</option><option value="1.5">150%</option></select></label><label><input type="checkbox" data-contrast> High contrast</label></section><section><h3>Quick replies</h3><p>One reply per line, in display order.</p><textarea data-replies rows="5" aria-label="Quick replies"></textarea><button class="btn" data-save-replies>Save replies</button></section><section data-level></section></div>';
  const fail = e => { if (live()) pane.querySelector('[data-phone-error]').textContent = e.message || String(e); };
  // Owner preferences apply to all of the owner's phones on this daemon.
  const p = prefs(); pane.querySelector('[data-scale]').value = String(p.textScale); pane.querySelector('[data-contrast]').checked = p.highContrast; pane.querySelector('[data-replies]').value = p.replies.join('\n');
  pane.querySelector('[data-scale]').onchange = e => save({ textScale: Number(e.target.value) });
  pane.querySelector('[data-contrast]').onchange = e => save({ highContrast: e.target.checked });
  pane.querySelector('[data-save-replies]').onclick = () => { save({ replies: pane.querySelector('[data-replies]').value.split('\n').map(s => s.trim().slice(0, 200)).filter(Boolean).slice(0, 12) }); document.querySelector('[data-quick-replies]')?.remove(); toast('Quick replies saved'); };
  const now = api('/api/phone/now').then(data => {
    if (!live()) return;
    const box = pane.querySelector('[data-now]');
    box.innerHTML = '<h3>Now · ' + esc(data.machine) + '</h3>' + (data.rows.length ? data.rows.map((r, i) => '<button class="btn outline" data-now-row="' + esc(i) + '">' + esc(r.kind + ' · ' + r.project + ' · ' + r.title) + '</button>').join('') : '<p>Nothing needs attention</p>') + data.errors.map(e => '<p>' + esc(e.error) + '</p>').join('');
    box.querySelectorAll('[data-now-row]').forEach(b => { b.onclick = () => { openChat(data.rows[Number(b.dataset.nowRow)]); pane.closest('.scrim')?.remove(); }; });
  }).catch(fail);
  const quiet = api('/api/push/quiet').then(data => {
    if (!live()) return;
    const form = pane.querySelector('[data-quiet]'); let q = data.quiet;
    if (!q.enabled && q.timeZone === 'UTC' && q.snoozeUntil === 0) q = { ...q, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    form.elements.enabled.checked = q.enabled; form.elements.holdApprovals.checked = !q.allowApprovals;
    for (const name of ['start', 'end', 'timeZone']) form.elements[name].value = q[name];
    const show = () => { form.querySelector('[data-snoozed]').textContent = q.snoozeUntil > Date.now() ? 'Snoozed until ' + new Date(q.snoozeUntil).toLocaleString() : ''; }; show();
    const put = async snoozeUntil => { const next = { ...q, enabled: form.elements.enabled.checked, allowApprovals: !form.elements.holdApprovals.checked, start: form.elements.start.value, end: form.elements.end.value, timeZone: form.elements.timeZone.value, snoozeUntil }; q = (await api('/api/push/quiet', { method: 'PUT', body: JSON.stringify(next) })).quiet; show(); toast('Quiet hours saved'); };
    form.onsubmit = e => { e.preventDefault(); void put(q.snoozeUntil).catch(fail); };
    form.querySelectorAll('[data-snooze]').forEach(b => { b.onclick = () => { const morning = new Date(); morning.setHours(7, 0, 0, 0); if (+morning <= Date.now()) morning.setDate(morning.getDate() + 1); void put(b.dataset.snooze === 'off' ? 0 : b.dataset.snooze === 'hour' ? Date.now() + 3600000 : +morning).catch(fail); }; });
  }).catch(fail);
  const end = new Date(); end.setHours(0, 0, 0, 0); const start = new Date(end); start.setDate(start.getDate() - 1);
  const brief = api('/api/projects').then(async ({ projects }) => {
    const parts = await Promise.all(projects.map(async project => { try { return { project, brief: await api('/api/projects/' + encodeURIComponent(project.id) + '/phone/brief?start=' + (+start) + '&end=' + (+end)) }; } catch (e) { return { project, error: e.message }; } }));
    if (!live()) return;
    pane.querySelector('[data-brief]').innerHTML = '<h3>Morning brief · yesterday</h3>' + parts.map(r => '<p>' + esc(r.project.name + ': ' + (r.error || (r.brief.finishedTurns + ' finished turns · $' + r.brief.spend.toFixed(2) + ' · ' + r.brief.prs.length + ' PRs waiting'))) + (r.brief?.prError ? ' · ' + esc(r.brief.prError) : '') + '</p>').join('');
  }).catch(fail);
  if (state.pid) {
    const project = state.pid, chat = state.chat || 'main', path = '/api/projects/' + encodeURIComponent(project) + '/chats/' + encodeURIComponent(chat) + '/notification-level';
    const box = pane.querySelector('[data-level]'); box.innerHTML = '<h3>Current chat notifications</h3><select aria-label="Chat notification level"><option value="all">All</option><option value="needs-you">Only when it needs you</option><option value="none">Mute (approvals still notify)</option></select>';
    api(path).then(r => { if (live() && box.isConnected) box.querySelector('select').value = r.level; }).catch(fail);
    box.querySelector('select').onchange = e => { void api(path, { method: 'PUT', body: JSON.stringify({ level: e.target.value }) }).catch(fail); };
  }
  await Promise.all([now, quiet, brief]);
}
export function registerPhoneWeb() {
  appearance();
  document.addEventListener('contextmenu', event => {
    const row = event.target.closest?.('.crow[data-chat][data-p]');
    if (!row) return;
    const project = row.dataset.p, chat = row.dataset.chat;
    setTimeout(() => {
      const menu = document.getElementById('loommenu'); if (!menu) return;
      const button = document.createElement('button'); button.className = 'pickrow'; button.setAttribute('role', 'menuitem'); button.textContent = 'Notifications…';
      button.onclick = async ev => {
        ev.stopPropagation(); closeMenu();
        const path = '/api/projects/' + encodeURIComponent(project) + '/chats/' + encodeURIComponent(chat) + '/notification-level';
        try {
          const current = await api(path);
          openMenu(event.clientX, event.clientY, ['all', 'needs-you', 'none'].map(level => ({ label: ({ all: 'All notifications', 'needs-you': 'Only when it needs you', none: 'Mute (approvals still notify)' })[level], hint: current.level === level ? 'Selected' : '', run: () => { void api(path, { method: 'PUT', body: JSON.stringify({ level }) }).then(() => toast('Chat notifications updated')).catch(e => toast(e.message)); } })));
        } catch (e) { toast(e.message); }
      };
      menu.appendChild(button);
    }, 0);
  }, true);
  function open() {
    if (document.querySelector('.scrim')) return;
    const scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.innerHTML = '<div class="modal" role="dialog" aria-label="Now and phone"><div class="modalhead">Now & phone<button class="btn" data-close>Close</button></div><div class="phone-pane"></div></div>';
    document.body.appendChild(scrim); scrim.querySelector('[data-close]').onclick = () => scrim.remove(); scrim.onclick = e => { if (e.target === scrim) scrim.remove(); }; void renderPhonePanel(scrim.querySelector('.phone-pane'));
  }
  function mount() {
    if (!state.token || isGuest()) { document.getElementById('phone-r4-open')?.remove(); return; }
    const nav = document.querySelector('.topnav') || document.querySelector('#root header');
    if (nav && !document.getElementById('phone-r4-open')) { const b = document.createElement('button'); b.id = 'phone-r4-open'; b.className = nav.classList.contains('topnav') ? 'navitem' : 'btn ghost xs'; b.textContent = 'Now & phone'; b.onclick = open; nav.appendChild(b); }
    const box = document.getElementById('box');
    if (box && !document.querySelector('[data-quick-replies]')) {
      const chips = document.createElement('div'); chips.dataset.quickReplies = ''; chips.className = 'phone-chips';
      for (const reply of prefs().replies) { const b = document.createElement('button'); b.className = 'btn ghost xs'; b.textContent = reply; b.onclick = () => { box.value = reply; box.dispatchEvent(new Event('input', { bubbles: true })); box.focus(); }; chips.appendChild(b); }
      box.parentElement.before(chips);
    }
  }
  const observer = new MutationObserver(mount); observer.observe(document.body, { childList: true, subtree: true }); mount();
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
}
