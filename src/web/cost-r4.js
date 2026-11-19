import { api } from './connection.js';
import { esc } from './format.js';
import { state } from './state.js';

const money = n => n == null ? 'unknown' : '$' + Number(n).toFixed(4);
const base = pid => '/api/projects/' + encodeURIComponent(pid);
const field = (name, label, value, type = 'text') => '<label class="mrlabel">' + esc(label) + '<input data-r4="' + esc(name) + '" type="' + esc(type) + '" value="' + esc(value) + '"></label>';
const fail = (el, e) => { el.textContent = e.message || String(e); };
function action(el, key, run){ const b = el.querySelector('[data-r4="' + key + '"]'); if (b) b.onclick = () => Promise.resolve().then(run).catch(e => fail(el.querySelector('[role="status"]'), e)); }
function value(el, key){ return el.querySelector('[data-r4="' + key + '"]').value; }
function button(key, label){ return '<button type="button" class="btn sm" data-r4="' + esc(key) + '">' + esc(label) + '</button>'; }

export async function renderCostSettings(el, pid, request = api){
  el.innerHTML = '<div class="sgrouph">Prices and spend controls</div><div data-prices></div><div data-budget></div><div role="status"></div>';
  const prices = el.querySelector('[data-prices]'), budget = el.querySelector('[data-budget]');
  try {
    const r = await request('/api/prices');
    prices.innerHTML = '<label class="mrlabel">Price overrides · USD per million tokens<textarea data-r4="prices" rows="4">' + esc(JSON.stringify(r.overrides, null, 2)) + '</textarea></label><div class="pd">Example: {"my-model":{"in":1,"out":3,"cacheRead":0.1}}. Remove a row to restore catalog pricing. Unknown models remain unknown.</div>' + button('prices-save', 'Save prices');
    action(el, 'prices-save', async () => { await request('/api/prices', { method: 'PUT', body: JSON.stringify({ overrides: JSON.parse(value(el, 'prices')) }) }); el.querySelector('[role="status"]').textContent = 'Prices saved'; });
  } catch (e) { fail(prices, e); }
  if (!pid) return;
  try {
    const r = await request(base(pid) + '/costs/settings'), s = r.settings;
    budget.innerHTML = field('month', 'Monthly project budget (USD; 0 clears)', s.monthlyUsd, 'number') + field('daily', 'Daily project budget (USD; 0 clears)', s.dailyUsd, 'number') +
      '<div class="mrlabel">Spend alert destinations (configure accounts in Settings)</div>' + ['slack', 'discord', 'email', 'push'].map(c => '<label><input type="checkbox" data-channel="' + esc(c) + '"' + (s.alerts.includes(c) ? ' checked' : '') + '>' + esc(c) + '</label> ').join('') +
      field('alias', 'Saver alias (blank disables)', s.saver?.alias || '') + field('share', 'Saver share of cap (0–1)', s.saver?.share ?? 0.8, 'number') +
      '<label class="mrlabel">Saver period<select data-r4="period"><option value="month">Monthly</option><option value="day">Daily</option></select></label>' + button('budget-save', 'Save spend controls');
    budget.querySelector('[data-r4="period"]').value = s.saver?.period || 'month';
    action(el, 'budget-save', async () => {
      await request(base(pid) + '/costs/settings', { method: 'PUT', body: JSON.stringify({ monthlyUsd: Number(value(el, 'month')), dailyUsd: Number(value(el, 'daily')),
        alerts: [...el.querySelectorAll('[data-channel]:checked')].map(e => e.dataset.channel),
        saver: value(el, 'alias').trim() ? { alias: value(el, 'alias').trim(), share: Number(value(el, 'share')), period: value(el, 'period') } : null }) });
      el.querySelector('[role="status"]').textContent = 'Spend controls saved';
      const panel = document.querySelector('[data-cost-panel="chat"]');
      if (panel) {
        const refresh = chatRefreshes.get(panel); if (refresh) refresh.fetched = -1;
        scheduleChatCosts(panel, pid, state.chat || 'main');
      }
    });
  } catch (e) { fail(budget, e); }
}
export function monthHtml(m){
  return '<div class="snote">Monthly spend ' + esc(money(m.spentUsd)) + ' / ' + esc(m.capUsd ? money(m.capUsd) : 'no cap') + ' · projected ' + esc(money(m.projectedUsd)) + (m.stopped ? ' · Paused' : m.warning ? ' · 80% used' : '') + '</div>' +
    (m.capUsd ? '<progress aria-label="Monthly project budget" max="1" value="' + esc(Math.min(1, m.fraction)) + '"></progress>' : '');
}
export async function renderCostUsage(el, pid, request = api){
  const [s, r] = await Promise.all([request(base(pid) + '/costs/settings'), request(base(pid) + '/costs/export?by=model')]);
  if (!el.isConnected) return;
  el.innerHTML = '<div class="sgrouph">Costs</div>' + monthHtml(s.monthly) + '<label>Export by <select data-r4="by">' + ['agent', 'model', 'chat', 'day'].map(k => '<option>' + esc(k) + '</option>').join('') + '</select></label>' + field('since', 'Since date (optional)', '', 'date') + button('download', 'Download CSV') +
    '<div class="sgrouph">Cache savings · API prices</div>' + r.rows.map(m => '<div class="snote">' + esc(m.model) + ': ' + esc(Math.round((m.cacheShare || 0) * 100)) + '% cached · ' + esc(money(m.cacheSavedUsd)) + ' saved</div>').join('') + '<div role="status"></div>';
  action(el, 'download', async () => {
    const q = new URLSearchParams({ by: value(el, 'by'), since: value(el, 'since'), format: 'csv-json' });
    const out = await request(base(pid) + '/costs/export?' + q);
    const url = URL.createObjectURL(new Blob([out.csv], { type: 'text/csv;charset=utf-8' })), a = document.createElement('a');
    a.href = url; a.download = 'loom-costs.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
const costEvents = new Map();
export function observeCostEvent(project, event){
  if (event.kind === 'run_complete' || (event.kind === 'status' && event.payload?.state === 'turn_cost')) {
    const pid = project?.id || state.pid;
    costEvents.set(pid, Math.max(costEvents.get(pid) || 0, event.id));
  }
}
const chatRefreshes = new WeakMap();
function scheduleChatCosts(el, pid, chat){
  let refresh = chatRefreshes.get(el);
  if (!refresh) { refresh = { fetched: -1, last: 0, pending: false, timer: null }; chatRefreshes.set(el, refresh); }
  const event = costEvents.get(pid) || 0;
  if (refresh.fetched >= event || refresh.pending || refresh.timer) return;
  refresh.timer = setTimeout(async () => {
    refresh.timer = null;
    if (!el.isConnected) return;
    refresh.pending = true; refresh.last = Date.now();
    const fetching = costEvents.get(pid) || 0;
    try { await renderChatCosts(el, pid, chat); refresh.fetched = fetching; }
    catch (e) { fail(el.querySelector('[role="status"]') || el, e); refresh.fetched = fetching; }
    finally { refresh.pending = false; scheduleChatCosts(el, pid, chat); }
  }, Math.max(0, 1000 - (Date.now() - refresh.last)));
}
export async function renderChatCosts(el, pid, chat, request = api){
  const r = await request(base(pid) + '/costs/settings');
  if (!el.isConnected) return;
  const cap = r.chats[chat], paused = cap?.stopped || r.monthly.stopped || r.daily.stopped;
  const first = !el.querySelector('[data-chat-budget]');
  if (first) {
    el.innerHTML = '<div data-budget-alert class="onote" hidden>Needs you · budget reached. Raise the cap to continue.</div>' +
      '<div data-month-raise hidden>' + field('month-cap', 'Monthly cap USD', r.monthly.capUsd, 'number') + button('month-raise', 'Raise monthly cap') + '</div>' +
      '<div data-day-raise hidden>' + field('day-cap', 'Daily cap USD', r.daily.capUsd, 'number') + button('day-raise', 'Raise daily cap') + '</div>' +
      '<details><summary data-chat-budget></summary>' + field('chat-cap', 'Chat cap (USD; 0 clears)', cap?.capUsd || 0, 'number') + button('raise', 'Raise / save chat budget') + '</details>' +
      '<details><summary>On another model</summary>' + field('what-model', 'Alternative model or alias', '') + button('whatif', 'Re-price tokens') + '<span data-what-result></span></details>' +
      '<span data-cost-saver class="ctxm" hidden></span><div role="status"></div>';
    action(el, 'raise', async () => { await request(base(pid) + '/chats/' + encodeURIComponent(chat) + '/budget', { method: 'PUT', body: JSON.stringify({ usd: Number(value(el, 'chat-cap')) }) }); await renderChatCosts(el, pid, chat, request); });
    action(el, 'month-raise', async () => { await request(base(pid) + '/costs/settings', { method: 'PUT', body: JSON.stringify({ monthlyUsd: Number(value(el, 'month-cap')) }) }); await renderChatCosts(el, pid, chat, request); });
    action(el, 'day-raise', async () => { await request(base(pid) + '/costs/settings', { method: 'PUT', body: JSON.stringify({ dailyUsd: Number(value(el, 'day-cap')) }) }); await renderChatCosts(el, pid, chat, request); });
    action(el, 'whatif', async () => { const w = await request(base(pid) + '/costs/whatif?' + new URLSearchParams({ chat, model: value(el, 'what-model') })); el.querySelector('[data-what-result]').textContent = ' On another model: ' + money(w.estimatedUsd) + ' estimated · ' + money(w.actualUsd) + ' recorded'; });
  }
  const alert = el.querySelector('[data-budget-alert]');
  alert.hidden = !paused;
  if (paused) alert.setAttribute('role', 'alert'); else alert.removeAttribute('role');
  el.querySelector('[data-month-raise]').hidden = !r.monthly.stopped;
  el.querySelector('[data-day-raise]').hidden = !r.daily.stopped;
  el.querySelector('[data-chat-budget]').textContent = 'Chat budget' + (cap?.capUsd ? ' · ' + money(cap.spentUsd) + ' / ' + money(cap.capUsd) : '');
  await refreshSaver(el, pid, chat, request);
}
async function refreshSaver(el, pid, chat, request = api){
  const selected = state.selected;
  const estimate = await request(base(pid) + '/estimate', { method: 'POST', body: JSON.stringify({ text: '', chat, ...(selected ? { agentId: selected } : {}) }) }).catch(() => ({}));
  if (!el.isConnected || selected !== state.selected) return;
  const chip = el.querySelector('[data-cost-saver]');
  if (!chip) return;
  chip.hidden = !estimate.saver;
  const text = estimate.saver ? 'Saver · ' + estimate.saver.alias + ' · explicit picks take priority' : '';
  if (chip.textContent !== text) chip.textContent = text;
}
export function renderCompare(el, request = api){
  el.innerHTML = field('models', 'Compare model IDs (comma separated)', '') + button('compare', 'Compare') + '<div data-comparison></div><div role="status"></div>';
  action(el, 'compare', async () => {
    const r = await request('/api/models/compare?' + new URLSearchParams({ models: value(el, 'models') }));
    el.querySelector('[data-comparison]').innerHTML = '<table><thead><tr><th>Model</th><th>Input / output $/M</th><th>Context</th><th>Last latency</th><th>Finish rate</th><th>Avg cost</th></tr></thead><tbody>' + r.models.map(m => '<tr><td>' + esc(m.model) + '</td><td>' + esc(money(m.inputUsdPerMillion) + ' / ' + money(m.outputUsdPerMillion)) + '</td><td>' + esc(m.context ?? 'unknown') + '</td><td>' + esc(m.latencyMs == null ? 'unknown' : m.latencyMs + ' ms') + '</td><td>' + esc(m.finishRate == null ? 'unknown' : Math.round(m.finishRate * 100) + '%') + '</td><td>' + esc(money(m.averageCostUsd)) + '</td></tr>').join('') + '</tbody></table>';
  });
}
export function renderFleetSuggestion(el, request = api){
  el.innerHTML = field('goal', 'Goal for suggested fleet', '') + field('fleet-budget', 'Budget USD (optional)', '', 'number') + field('size', 'Fleet size', 3, 'number') + button('suggest', 'Suggest') + '<div data-picks></div><div role="status"></div>';
  action(el, 'suggest', async () => {
    const r = await request('/api/fleets/suggest', { method: 'POST', body: JSON.stringify({ goal: value(el, 'goal'), size: Number(value(el, 'size')), ...(value(el, 'fleet-budget') ? { budget: Number(value(el, 'fleet-budget')) } : {}) }) });
    const picks = el.querySelector('[data-picks]');
    picks.innerHTML = r.picks.map(p => '<div class="snote">' + esc(p.spec) + ' · ' + esc(p.reason) + '</div>').join('') + '<div class="pd">' + esc(r.note) + '</div>' + (r.picks.length ? field('fleet-name', 'Save suggested fleet as', 'suggested') + button('save-fleet', 'Save suggested fleet') : '');
    action(el, 'save-fleet', async () => { await request('/api/fleets', { method: 'PUT', body: JSON.stringify({ name: value(el, 'fleet-name'), spec: r.spec }) }); el.querySelector('[role="status"]').textContent = 'Saved. Reopen the fleet picker to select @' + value(el, 'fleet-name'); });
  });
}

/** Add independent panels without coupling the shared renderers to another batch. */
export function installCostUI(){
  let queued = false;
  const sockets = new WeakSet();
  const queueRefresh = () => { if (!queued) { queued = true; setTimeout(refresh, 50); } };
  function mount(selector, key, render){
    const target = document.querySelector(selector), host = key === 'chat' ? target?.parentElement : target; if (!host || !state.pid) return;
    const id = state.pid + ':' + (state.chat || 'main');
    let el = host.querySelector(':scope > [data-cost-panel="' + key + '"]');
    if (el?.dataset.context === id) {
      if (key === 'chat') {
        scheduleChatCosts(el, state.pid, state.chat || 'main');
        if (el.dataset.agent !== String(state.selected)) {
          el.dataset.agent = String(state.selected);
          void refreshSaver(el, state.pid, state.chat || 'main');
        }
      }
      return;
    }
    if (el) el.remove(); el = document.createElement('div'); el.dataset.costPanel = key; el.dataset.context = id; el.dataset.agent = String(state.selected); if (key === 'chat') target.insertAdjacentElement('afterend', el); else host.appendChild(el);
    if (key === 'chat') scheduleChatCosts(el, state.pid, state.chat || 'main');
    else Promise.resolve(render(el, state.pid, state.chat || 'main')).catch(e => fail(el, e));
  }
  function refresh(){
    queued = false;
    if (typeof document === "undefined" || !document || !document.body) return;
    if (state.ws && !sockets.has(state.ws)) {
      const pid = state.pid;
      sockets.add(state.ws);
      state.ws.addEventListener('message', message => {
        try {
          const frame = JSON.parse(message.data), event = frame.event;
          if (frame.type === 'event' && event && (event.kind === 'run_complete' || (event.kind === 'status' && event.payload?.state === 'turn_cost'))) {
            observeCostEvent({ id: pid }, event); queueRefresh();
          }
        } catch { /* other socket frames do not carry spend */ }
      });
    }
    mount('#obusage:has(table)', 'usage', (el, pid) => renderCostUsage(el, pid));
    mount('#chat-totals', 'chat', renderChatCosts);
    mount('#cmenu:has(#cfagent)', 'fleet', el => renderFleetSuggestion(el));
    mount('#cmenu.picker:has(#cmsearch)', 'compare', el => renderCompare(el));
    const chip = document.querySelector('[data-cost-panel="chat"] .ctxm:not([hidden])'), composer = document.querySelector('#cform .crow');
    if (composer) {
      const old = composer.querySelector('[data-saver-chip]');
      if (!chip) old?.remove();
      else if (!old) { const clone = chip.cloneNode(true); clone.dataset.saverChip = ''; composer.appendChild(clone); }
      else if (old.textContent !== chip.textContent) old.textContent = chip.textContent;
    }
  }
  const observer = new MutationObserver(queueRefresh);
  observer.observe(document.body, { subtree: true, childList: true }); refresh();
}
