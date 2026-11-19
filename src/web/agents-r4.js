import { api } from './connection.js';
import { esc } from './format.js';
import { askText, toast } from './notifications.js';
import { state } from './state.js';

const base = pid => '/api/projects/' + encodeURIComponent(pid);
const send = (url, body, method = 'PUT') => api(url, { method, body: JSON.stringify(body) });
export function labelChips(labels){
  return (labels || []).map(l => '<span class="badge" style="color:' + esc(/^#[a-f0-9]{6}$/i.test(l.color) ? l.color : '#7598dc') + '">' + esc(l.name) + '</span>').join(' ');
}
export function catchMeUp(pid, chat, since){
  return send(base(pid) + '/chats/' + encodeURIComponent(chat) + '/catchup', { since: since || 0, markRead: false }, 'POST').then(result => {
    var box = document.createElement('div'); box.className = 'scrim';
    box.innerHTML = '<section class="modal" role="dialog" aria-label="Catch me up"><div class="modalhead">Catch me up · ' + esc(result.mode) + '<button class="btn ghost" data-close>Close</button></div><pre style="white-space:pre-wrap;padding:16px;max-height:60vh;overflow:auto">' + esc(result.summary) + '</pre><div class="modalfoot"><button class="btn" data-helper>Use a helper model…</button></div></section>';
    document.body.appendChild(box); box.querySelector('[data-close]').onclick = () => box.remove();
    box.querySelector('[data-helper]').onclick = async () => {
      var model = await askText('Helper model', { note: 'Opt in to sending the unread activity to this provider/model. Model charges may apply.' });
      if (!model) return;
      send(base(pid) + '/chats/' + encodeURIComponent(chat) + '/catchup', { since: since || 0, markRead: false, model }, 'POST').then(r => { box.querySelector('pre').textContent = r.summary; }).catch(e => toast(e.message));
    };
  }).catch(e => toast(e.message));
}
export function mountSessionSettings(pane, pid){
  if (!pid) return;
  var row = document.createElement('div'); row.className = 'prow';
  row.innerHTML = '<div class="pl"><div class="pt">Agents and sessions</div><div class="pd">Turn limits, sleep, retries, profiles and environment names.</div></div><button class="btn outline">Configure</button>';
  pane.appendChild(row); row.querySelector('button').onclick = () => openSessions(pid, 'agents');
}
export async function openSessions(pid, tab = 'chats'){
  var scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = '<section class="modal" style="max-width:640px" role="dialog" aria-label="Agents and sessions"><div class="modalhead">Agents and sessions<button class="btn ghost" data-close>Close</button></div><nav class="modalfoot"><button class="btn" data-tab="chats">Chats</button><button class="btn" data-tab="agents">Agents & Settings</button></nav><div data-content style="padding:16px;max-height:65vh;overflow:auto"></div></section>';
  document.body.appendChild(scrim);
  scrim.querySelector('[data-close]').onclick = () => scrim.remove();
  const content = scrim.querySelector('[data-content]');
  const error = e => toast(e.message);
  var archived = false, label = '', search = '', drawing = 0;
  async function drawChats(){
    const draw = ++drawing;
    const data = await api(base(pid) + '/chats?all=1');
    if (!scrim.isConnected || draw !== drawing) return;
    const labels = [...new Set(data.chats.flatMap(c => (c.labels || []).map(l => l.name)))];
    var matches = new Set(), searchRequest = 0;
    content.innerHTML = '<div class="cflab"><label><input type="checkbox" data-arch' + (archived ? ' checked' : '') + '> Archived</label><select class="cfin" aria-label="Filter by label" data-filter><option value="">All labels</option>' + labels.map(l => '<option' + (l === label ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select><input class="cfin" data-search aria-label="Search chats" placeholder="Search chats" value="' + esc(search) + '"></div><div data-chats></div>';
    const paint = () => {
      content.querySelector('[data-chats]').innerHTML = data.chats.filter(c => Boolean(c.archived) === archived && (!label || (c.labels || []).some(l => l.name === label)) && (c.title.toLowerCase().includes(search.toLowerCase()) || matches.has(c.id))).map(c => '<div class="prow" data-row="' + esc(c.id) + '"><div class="pl"><button class="btn ghost" data-open="' + esc(c.id) + '">' + esc(c.title) + '</button><div>' + labelChips(c.labels) + '</div></div><button class="btn xs" data-label="' + esc(c.id) + '">Labels</button>' + (c.id === 'main' ? '' : '<button class="btn xs" data-archive="' + esc(c.id) + '">' + (archived ? 'Restore' : 'Archive') + '</button>') + '</div>').join('');
      content.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { scrim.remove(); if (state.setChat) state.setChat(pid, b.dataset.open); else location.hash = '#p/' + pid; });
      content.querySelectorAll('[data-archive]').forEach(b => b.onclick = () => send(base(pid) + '/chats/' + encodeURIComponent(b.dataset.archive), { archived: !archived }, 'PATCH').then(drawChats).catch(error));
      content.querySelectorAll('[data-label]').forEach(b => b.onclick = async () => {
        var c = data.chats.find(c => c.id === b.dataset.label);
        var text = await askText('Chat labels', { value: (c.labels || []).map(l => l.name).join(', '), note: 'Separate names with commas. Empty clears labels.' });
        if (text === null) return;
        await send(base(pid) + '/chats/' + encodeURIComponent(c.id) + '/labels', { labels: text.split(',').map(s => s.trim()).filter(Boolean) }).then(drawChats).catch(error);
      });
    };
    function findMessages(){
      var request = ++searchRequest; matches = new Set(); paint();
      if (!search.trim()) return;
      api(base(pid) + '/chats/search?q=' + encodeURIComponent(search) + '&archived=' + (archived ? '1' : '0') + '&label=' + encodeURIComponent(label)).then(result => {
        if (request !== searchRequest || draw !== drawing || !scrim.isConnected) return;
        matches = new Set(result.hits.map(hit => hit.chat)); paint();
      }).catch(error);
    }
    content.querySelector('[data-arch]').onchange = e => { archived = e.target.checked; drawChats().catch(error); };
    content.querySelector('[data-filter]').onchange = e => { label = e.target.value; findMessages(); };
    content.querySelector('[data-search]').oninput = e => { search = e.target.value; findMessages(); };
    findMessages();
  }
  async function drawAgents(){
    const draw = ++drawing;
    const [project, settings] = await Promise.all([api(base(pid)), api(base(pid) + '/session-settings')]);
    if (!scrim.isConnected || draw !== drawing) return;
    const p = project.project || project;
    const number = (name, title, value) => '<label class="cflab">' + esc(title) + '<input class="cfin" name="' + name + '" type="number" min="0" step="any" value="' + esc(value ?? 0) + '"></label>';
    const policyFields = s => number('maxTurnMinutes', 'Turn limit (minutes; 0 = off)', s.maxTurnMinutes) + number('idleSleepMinutes', 'Sleep after idle minutes (0 = off)', s.idleSleepMinutes) + number('retryCount', 'Retry count (0–10)', s.retries?.count) + number('retryWait', 'Retry wait (seconds)', s.retries?.waitSeconds ?? 5);
    content.innerHTML = '<form data-policy=""><div class="sgrouph">Project defaults</div>' + policyFields(settings) + number('autoArchiveDays', 'Auto-archive after idle days (0 = off)', settings.autoArchiveDays) + '<button class="btn primary">Save defaults</button></form>' + (p.agents || []).map(a => '<details data-agent="' + esc(a.id) + '"><summary class="prow">' + esc(a.id) + ' · ' + (a.asleep ? 'Asleep' : a.busy ? 'Working' : 'Ready') + '</summary><form data-policy="' + esc(a.id) + '">' + policyFields({ ...settings, ...(settings.agents[a.id] || {}) }) + '<button class="btn primary">Save agent settings</button></form><div class="modalfoot"><button class="btn" data-clone="' + esc(a.id) + '">Duplicate</button><button class="btn" data-profile="' + esc(a.id) + '">Save profile</button></div><div data-env="' + esc(a.id) + '"></div><form data-env-form="' + esc(a.id) + '"><label class="cflab">Environment key<input class="cfin" name="key" required pattern="[A-Za-z_][A-Za-z0-9_]*"></label><label class="cflab">New value (never shown back)<input class="cfin" type="password" name="value" autocomplete="new-password"></label><button class="btn">Set variable</button></form></details>').join('');
    content.querySelectorAll('[data-policy]').forEach(form => form.onsubmit = e => {
      e.preventDefault(); const f = form.elements;
      const body = { maxTurnMinutes: Number(f.maxTurnMinutes.value), idleSleepMinutes: Number(f.idleSleepMinutes.value), retries: { count: Number(f.retryCount.value), waitSeconds: Number(f.retryWait.value) } };
      if (!form.dataset.policy) body.autoArchiveDays = Number(f.autoArchiveDays.value);
      send(base(pid) + (form.dataset.policy ? '/agents/' + encodeURIComponent(form.dataset.policy) + '/limits' : '/session-settings'), body).then(() => toast('Settings saved')).catch(error);
    });
    content.querySelectorAll('[data-clone]').forEach(b => b.onclick = () => send(base(pid) + '/agents/' + encodeURIComponent(b.dataset.clone) + '/clone', {}, 'POST').then(drawAgents).catch(error));
    content.querySelectorAll('[data-profile]').forEach(b => b.onclick = async () => {
      const a = p.agents.find(a => a.id === b.dataset.profile), name = await askText('Save agent profile', { required: true });
      if (!name) return;
      const options = await api(base(pid) + '/agents/' + encodeURIComponent(a.id) + '/options');
      send('/api/profiles/' + encodeURIComponent(name), { kind: a.kind, model: a.model, effort: options.effort, mode: a.permissions, instructions: a.instructions || '' }).then(() => toast('Profile saved')).catch(error);
    });
    async function envNames(id){
      const result = await api(base(pid) + '/agents/' + encodeURIComponent(id) + '/env');
      const el = [...content.querySelectorAll('[data-env]')].find(e => e.dataset.env === id); if (!el) return;
      el.innerHTML = '<div class="sgrouph">Environment · names only</div>' + result.names.map(key => '<div class="prow">' + esc(key) + '<button class="btn xs" data-unset="' + esc(key) + '">Unset</button></div>').join('');
      el.querySelectorAll('[data-unset]').forEach(b => b.onclick = () => send(base(pid) + '/agents/' + encodeURIComponent(id) + '/env', { key: b.dataset.unset }, 'DELETE').then(() => envNames(id)).catch(error));
    }
    content.querySelectorAll('[data-env-form]').forEach(form => {
      envNames(form.dataset.envForm).catch(error);
      form.onsubmit = e => { e.preventDefault(); const body = { key: form.elements.key.value, value: form.elements.value.value }; form.elements.value.value = ''; send(base(pid) + '/agents/' + encodeURIComponent(form.dataset.envForm) + '/env', body).then(() => envNames(form.dataset.envForm)).catch(error); };
    });
  }
  scrim.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => (b.dataset.tab === 'chats' ? drawChats() : drawAgents()).catch(error));
  await (tab === 'chats' ? drawChats() : drawAgents()).catch(error);
}
export function installAgentsR4(){
  const observer = new MutationObserver(() => {
    document.querySelectorAll('[data-newchat]').forEach(row => {
      if (row.parentNode.querySelector('[data-r4-open]')) return;
      const button = document.createElement('button'); button.className = 'btn ghost'; button.dataset.r4Open = row.dataset.newchat; button.textContent = 'Chats & agents';
      button.onclick = () => openSessions(button.dataset.r4Open); row.after(button);
    });
    document.querySelectorAll('.crow[data-chat][data-p]').forEach(row => {
      const project = state.projects.find(p => p.id === row.dataset.p), chat = project?.chats?.find(c => c.id === row.dataset.chat);
      if (!chat?.labels?.length || row.querySelector('[data-r4-labels]')) return;
      const span = document.createElement('span'); span.dataset.r4Labels = ''; span.innerHTML = labelChips(chat.labels); row.appendChild(span);
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
