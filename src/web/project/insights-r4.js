import { api } from '../connection.js';
import { esc } from '../format.js';
import { state } from '../state.js';

const fmt = value => value == null ? 'unmeasured' : Number(value).toFixed(1);
const table = (headers, rows) => '<div class="r4table"><table><thead><tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + (rows.length ? rows.map(row => '<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>').join('') : '<tr><td colspan="' + esc(headers.length) + '">No recorded data yet.</td></tr>') + '</tbody></table></div>';
const panel = (title, content) => '<section class="obchart"><h3>' + esc(title) + '</h3>' + content + '</section>';
const button = (attr, value, label) => '<button type="button" class="btn" ' + attr + '="' + esc(value) + '">' + esc(label) + '</button>';
const link = (p, example) => '#p/' + encodeURIComponent(p.id) + '/c/' + encodeURIComponent(example.chat) + '/m/' + encodeURIComponent(example.eventId);

export function mountR4Insights(host, project, existing) {
  if (existing) { host.appendChild(existing); existing.refreshInsights(); return; }
  const root = document.createElement('div'); root.className = 'r4insights'; host.appendChild(root);
  const base = '/api/projects/' + encodeURIComponent(project.id);
  const storageKey = 'loom:r4:events:' + project.id;
  let saved = [];
  try { const value = JSON.parse(localStorage.getItem(storageKey) || '[]'); if (Array.isArray(value)) saved = value.slice(0, 20); } catch {}
  let filter = { type: '', agent: '', since: '' }, period = '7d', generation = 0;
  root.innerHTML = '<h2>Reliability & working time</h2><div class="r4toolbar"><label>Compare period <select data-period><option>1d</option><option selected>7d</option><option>30d</option></select></label><button class="btn" data-refresh>Refresh insights</button></div><div data-report role="status">Loading insights…</div><section class="obchart"><h3>Event explorer</h3><form data-filter class="r4toolbar"><label>Type <input name="type" placeholder="tool_call"></label><label>Agent <input name="agent" placeholder="any agent"></label><label>Since <input name="since" placeholder="7d or ISO date"></label><button class="btn">Query</button><button type="button" class="btn" data-save>Save filter</button><select data-saved aria-label="Saved event filters"></select></form><div data-events></div></section><section class="obchart"><h3>Reliability alerts</h3><form data-add-alert class="r4toolbar"><label>Rule <input name="expression" required placeholder="finish_rate &lt; 70% over 20 turns"></label><button class="btn">Add alert</button></form><p class="obsub">Also: turn_minutes &gt; 5 over 10 turns, errors_per_hour &gt; 3, queue_depth &gt; 5. Turn minutes uses the window average.</p><div data-alerts></div><p data-alert-status role="status"></p></section>';
  const report = root.querySelector('[data-report]');
  const fail = (el, error) => { el.textContent = error.message || String(error); };
  function charts(rows, field) {
    const max = Math.max(1, ...rows.map(r => r[field].p95 || 0));
    return rows.map(r => '<div class="r4bar"><span>' + esc(r.name) + '</span><meter min="0" max="' + esc(max) + '" value="' + esc(r[field].p95 || 0) + '" aria-label="' + esc(r.name + ' p95 milliseconds') + '"></meter><span>p50 ' + esc(fmt(r[field].p50)) + ' / p95 ' + esc(fmt(r[field].p95)) + ' ms · ' + esc(r[field].samples) + ' samples</span></div>').join('') || '<p>No measured turns yet.</p>';
  }
  async function load() {
    const seq = ++generation;
    try {
      const r = await api(base + '/insights/r4?period=' + encodeURIComponent(period));
      if (!root.isConnected || seq !== generation) return;
      const c = r.compare;
      report.innerHTML = '<div class="obmetrics">' + Object.keys(c.current).map(k => '<div class="obcard"><div class="obcl">' + esc(k) + '</div><div class="obcv">' + esc(fmt(c.current[k])) + '</div><div class="obcs">' + esc(c.changes[k].direction === 'up' ? '↑' : c.changes[k].direction === 'down' ? '↓' : '→') + ' ' + esc(fmt(Math.abs(c.changes[k].delta))) + ' · previous ' + esc(fmt(c.previous[k])) + '</div></div>').join('') + '</div>' +
        panel('Tool analytics', '<p class="obsub">Failure rates use reported outcomes; averages use measured durations.</p>' + table(['Tool', 'Calls', 'Failure rate', 'Average ms'], r.tools.byTool.map(t => [esc(t.name), esc(t.calls), esc(fmt(t.failureRate)) + '%', esc(fmt(t.averageMs))])) + table(['Agent', 'Calls', 'Failure rate', 'Average ms'], r.tools.byAgent.map(t => [esc(t.name), esc(t.calls), esc(fmt(t.failureRate)) + '%', esc(fmt(t.averageMs))]))) +
        panel('Latency by model', '<h4>First output</h4>' + charts(r.latency.byModel, 'firstOutputMs') + '<h4>Turn duration</h4>' + charts(r.latency.byModel, 'durationMs')) +
        panel('Latency by agent', '<h4>First output</h4>' + charts(r.latency.byAgent, 'firstOutputMs') + '<h4>Turn duration</h4>' + charts(r.latency.byAgent, 'durationMs')) +
        panel('Approval insights', '<p class="obsub">Answered wait p50 ' + esc(fmt(r.approvals.waitMs.p50)) + ' / p95 ' + esc(fmt(r.approvals.waitMs.p95)) + ' ms. Allow rules apply to every call of the named tool; deny rules still take precedence.</p>' + table(['Command', 'Asked', 'Total wait ms', 'Suggestion'], r.approvals.commands.map(a => [esc(a.command), esc(a.count), esc(fmt(a.totalWaitMs)), r.approvals.canAddAllowRule && a.allowable ? button('data-allow', a.exampleId, 'Add allow rule for ' + a.tool) : !a.allowable ? 'Shell: review each command' : 'Owner only'])) + table(['Agent', 'Command', 'Wait ms', 'Answered by'], r.approvals.rows.map(a => [esc(a.agent), esc(a.command), esc(fmt(a.waitMs)), esc(a.by || 'waiting') + ' ' + esc(a.behavior || '')]))) +
        panel('Failure groups', table(['Error', 'Count', 'Last seen', 'Examples'], r.errors.map(g => [esc(g.error), esc(g.count), esc(new Date(g.lastSeen).toLocaleString()), g.examples.map(e => '<a href="' + esc(link(project, e)) + '">' + esc(e.agent + ' #' + e.eventId) + '</a>').join(' · ')]))) +
        panel('File hot spots', table(['File', 'Edits', 'Re-edits', 'Rewinds'], r.files.rows.map(f => [button('data-file', f.path, f.path), esc(f.edits), esc(f.reEdits), esc(f.rewinds)])) + (r.files.unavailableRewinds ? '<p>' + esc(r.files.unavailableRewinds) + ' older rewinds no longer have checkpoint trees.</p>' : '')) +
        panel('Agent hours · UTC', '<p class="obsub">Measured work, including active and interrupted turns, excluding recorded human waits; overlapping work per agent is counted once.</p>' + r.hours.entries.map(h => '<div class="r4bar"><span>' + esc(h.day + ' · ' + h.agent) + '</span><meter min="0" max="24" value="' + esc(h.activeMs / 3600000) + '" aria-label="' + esc(h.agent + ' hours on ' + h.day) + '"></meter><span>' + esc((h.activeMs / 3600000).toFixed(2)) + ' h</span></div>').join(''));
      report.querySelectorAll('[data-file]').forEach(b => { b.onclick = () => state.openFile?.(b.dataset.file); });
      report.querySelectorAll('[data-allow]').forEach(b => { b.onclick = async () => { const tool = r.approvals.commands.find(a => a.exampleId === Number(b.dataset.allow)).tool; if (!confirm('Allow every ' + tool + ' call in this project without asking?')) return; b.disabled = true; try { await api(base + '/insights/approvals/allow', { method: 'POST', body: JSON.stringify({ eventId: Number(b.dataset.allow) }) }); b.textContent = 'Allow rule added'; } catch (e) { b.disabled = false; fail(b, e); } }; });
    } catch (e) { if (seq === generation) fail(report, e); }
  }
  const eventsEl = root.querySelector('[data-events]');
  let queryGeneration = 0;
  async function query(before) {
    const seq = ++queryGeneration, params = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
    if (before) params.set('before', before);
    try {
      const r = await api(base + '/events/query?' + params);
      if (!root.isConnected || seq !== queryGeneration) return;
      eventsEl.innerHTML = table(['Time', 'Type', 'Agent', 'Event'], r.events.map(e => [esc(new Date(e.ts).toLocaleString()), esc(e.kind), esc(e.agentId || '—'), '<details><summary>#' + esc(e.id) + '</summary><pre>' + esc(JSON.stringify(e.payload, null, 2)) + '</pre></details>'])) + (r.nextBefore ? button('data-next', r.nextBefore, 'Older events') : '');
      const next = eventsEl.querySelector('[data-next]'); if (next) next.onclick = () => query(next.dataset.next);
    } catch (e) { fail(eventsEl, e); }
  }
  const form = root.querySelector('[data-filter]');
  const readFilter = () => { filter = Object.fromEntries(['type', 'agent', 'since'].map(k => [k, form.elements[k].value.trim()])); };
  form.onsubmit = e => { e.preventDefault(); readFilter(); void query(); };
  function savedOptions() { root.querySelector('[data-saved]').innerHTML = '<option value="">Saved filters</option>' + saved.map((f, i) => '<option value="' + esc(i) + '">' + esc([f.type || 'all events', f.agent || 'all agents', f.since || 'all time'].join(' · ')) + '</option>').join(''); }
  root.querySelector('[data-save]').onclick = () => { readFilter(); saved = [filter, ...saved.filter(f => JSON.stringify(f) !== JSON.stringify(filter))].slice(0, 20); try { localStorage.setItem(storageKey, JSON.stringify(saved)); savedOptions(); } catch (e) { fail(eventsEl, e); } };
  root.querySelector('[data-saved]').onchange = e => { if (e.target.value === '') return; filter = saved[Number(e.target.value)]; for (const k of ['type', 'agent', 'since']) form.elements[k].value = filter[k] || ''; void query(); };
  const alertsEl = root.querySelector('[data-alerts]'), alertStatus = root.querySelector('[data-alert-status]');
  async function alerts() {
    try {
      const r = await api(base + '/alerts'); if (!root.isConnected) return;
      alertsEl.innerHTML = table(['Rule', 'State', 'Actions'], r.rules.map(a => [esc(a.expression), esc(a.paused ? 'paused' : a.firing ? 'firing' : 'watching'), button('data-pause', a.id, a.paused ? 'Resume' : 'Pause') + button('data-test', a.id, 'Test')]));
      alertsEl.querySelectorAll('[data-pause]').forEach(b => { b.onclick = () => action('/alerts/' + encodeURIComponent(b.dataset.pause), 'PATCH', { paused: !r.rules.find(a => a.id === b.dataset.pause).paused }); });
      alertsEl.querySelectorAll('[data-test]').forEach(b => { b.onclick = () => action('/alerts/' + encodeURIComponent(b.dataset.test) + '/test', 'POST'); });
    } catch (e) { fail(alertsEl, e); }
  }
  async function action(path, method, body) { try { const r = await api(base + path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); alertStatus.textContent = r.test ? 'Test notification sent · observed ' + (r.value ?? 'insufficient data') : 'Saved'; await alerts(); } catch (e) { fail(alertStatus, e); } }
  root.querySelector('[data-add-alert]').onsubmit = e => { e.preventDefault(); void action('/alerts', 'POST', { expression: e.target.elements.expression.value }); };
  root.querySelector('[data-period]').onchange = e => { period = e.target.value; void load(); };
  root.querySelector('[data-refresh]').onclick = () => { void load(); void query(); void alerts(); };
  root.refreshInsights = () => { void load(); void alerts(); };
  savedOptions(); void load(); void query(); void alerts();
}
