import { api } from '../connection.js';
import { esc } from '../format.js';
import { toast } from '../notifications.js';

const drafts = new Map();
const forms = new Map();
const comparisons = new Map();
export const r4Plan = (pid, runId) => drafts.get(pid + "/" + runId);
const terminal = run => ['completed', 'failed', 'aborted', 'moved'].includes(run.status);
const button = (action, label) => '<button type="button" class="btn outline sm" data-r4="' + esc(action) + '">' + esc(label) + '</button>';

export function r4Options(el, opts, save) {
  const box = el.querySelector('.orch-options');
  if (!box) return;
  box.insertAdjacentHTML('beforeend', [['check', 'Done check command', 'text'], ['checkRounds', 'Check repair rounds', 'number'], ['taskMinutes', 'Task time limit (minutes)', 'number']].map(([key, label, type]) =>
    '<label>' + esc(label) + '<input data-r4option="' + esc(key) + '" type="' + esc(type) + '" value="' + esc(opts[key] ?? '') + '"></label>').join(''));
  box.querySelectorAll('[data-r4option]').forEach(input => { input.onchange = () => {
    const key = input.dataset.r4option;
    opts[key] = input.value === '' ? undefined : key === 'check' ? input.value : Number(input.value);
    save();
  }; });
}

export function mountR4Orchestra(el, run, pid, action) {
  const root = el.querySelector('.odetail') || el;
  root.querySelector('[data-r4panel]')?.remove();
  const preview = run.planOnly && !run.planApprovedAt && run.status === 'waiting_human';
  const key = pid + '/' + run.id;
  const plan = drafts.get(key) || (run.tasks || []).map(t => ({ id: t.id, title: t.title, prompt: t.prompt, agent: t.agent.includes('@') ? t.agent : t.agent + (t.model ? '@' + t.model : '') + (t.effort ? ':' + t.effort : ''), dependsOn: t.dependsOn }));
  const active = !terminal(run);
  root.insertAdjacentHTML('afterbegin', '<section class="ocard r4-orch" data-r4panel data-r4run="' + esc(key) + '">' +
    (active && run.held ? '<strong class="onote">Held · running workers may finish</strong>' : '') +
    '<div class="r4-actions">' + (active ? button(run.held ? 'release' : 'hold', run.held ? 'Release run' : 'Hold run') : run.status !== 'moved' ? button('rerun', 'Run again') : '') +
    button('report', 'Download report') + '</div>' +
    (active ? '<details><summary>Add task</summary><label>Task<textarea data-r4text></textarea></label><label>Agent@model (optional)<input data-r4agent></label><label>After task<select data-r4after><option value="">No dependency</option>' + run.tasks.filter(t => !t.skippedReason).map(t => '<option value="' + esc(t.id) + '">' + esc(t.id + ': ' + t.title) + '</option>').join('') + '</select></label>' + button('add', 'Add task') + '</details>' +
    '<label>Note to all<textarea data-r4note></textarea></label>' + button('say', 'Send note to all') :
    '<label>Replacement fleet (optional)<input data-r4fleet placeholder="echo@model,echo"></label><label><input type="checkbox" data-r4failed>Only failed tasks</label>') +
    '<details><summary>Compare runs</summary><label>Other run<select data-r4compare><option value="">Choose a run</option></select></label>' + button('compare', 'Compare') + '<div data-r4comparison>' + (comparisons.get(key) || '') + '</div></details>' +
    (preview ? '<details open><summary>Edit plan</summary><div data-r4plan>' + plan.map((t, i) => '<fieldset data-r4row="' + esc(i) + '"><legend>' + esc(t.id) + '</legend><label>Title<input data-planfield="title" value="' + esc(t.title) + '"></label><label>Prompt<textarea data-planfield="prompt">' + esc(t.prompt) + '</textarea></label><label>Agent@model<input data-planfield="agent" value="' + esc(t.agent) + '"></label><span>After: ' + esc(t.dependsOn.join(', ') || 'none') + '</span>' + button('up:' + i, 'Move up') + button('down:' + i, 'Move down') + button('remove:' + i, 'Remove task') + '</fieldset>').join('') + '</div>' + button('plan', 'Save plan') + button('approve', 'Approve edited plan') + '</details>' : '') +
    (active ? run.tasks.filter(t => t.status !== 'done' && !t.skippedReason).map(t => '<details><summary>' + esc(t.id + ': ' + t.title) + ' · Task actions</summary>' +
      button('skip:' + t.id, 'Skip task') + (t.timedOutAt ? '<p>' + esc(t.error || 'Time limit reached') + '</p><label>Extra minutes<input type="number" data-extend="' + esc(t.id) + '" value="' + esc(run.taskMinutes || 10) + '"></label>' + button('extend:' + t.id, 'Extend') + '<label>Reassign to agent@model<input data-reassign="' + esc(t.id) + '"></label>' + button('reassign:' + t.id, 'Reassign') : '') + '</details>').join('') : '') +
    run.tasks.filter(t => t.skippedReason).map(t => '<p>' + esc(t.id + ' · Skipped: ' + t.skippedReason) + '</p>').join('') + '</section>');
  const panel = root.querySelector('[data-r4panel]');
  const values = forms.get(key) || {};
  forms.set(key, values);
  panel.querySelectorAll('details').forEach(detail => {
    const fieldKey = 'open:' + detail.querySelector('summary').textContent;
    if (values[fieldKey] !== undefined) detail.open = values[fieldKey];
    detail.ontoggle = () => { values[fieldKey] = detail.open; };
  });
  panel.querySelectorAll('input:not([data-planfield]),textarea:not([data-planfield]),select').forEach(input => {
    const name = Object.keys(input.dataset)[0], fieldKey = name + ':' + input.dataset[name];
    if (values[fieldKey] !== undefined) {
      if (input.type === 'checkbox') input.checked = values[fieldKey]; else input.value = values[fieldKey];
    }
    input.oninput = input.onchange = () => { values[fieldKey] = input.type === 'checkbox' ? input.checked : input.value; };
  });
  const base = '/api/projects/' + encodeURIComponent(pid) + '/orchestra/';
  api(base).then(j => {
    const select = panel.querySelector('[data-r4compare]');
    select.innerHTML += (j.runs || []).filter(r => r.id !== run.id).map(r => '<option value="' + esc(r.id) + '">' + esc(r.goal + ' · ' + r.id) + '</option>').join('');
    if (values['r4compare:']) select.value = values['r4compare:'];
  }).catch(e => toast(e.message));
  const capture = () => {
    panel.querySelectorAll('[data-r4row]').forEach(row => {
      const t = plan[Number(row.dataset.r4row)];
      row.querySelectorAll('[data-planfield]').forEach(input => { t[input.dataset.planfield] = input.value; });
    });
    drafts.set(key, plan);
  };
  panel.querySelectorAll('[data-planfield]').forEach(input => { input.oninput = capture; });
  panel.querySelectorAll('[data-r4]').forEach(b => { b.onclick = async () => {
    const [op, id] = b.dataset.r4.split(':');
    const value = selector => panel.querySelector(selector)?.value || '';
    try {
      if (['up', 'down', 'remove'].includes(op)) {
        capture(); const i = Number(id), next = op === 'up' ? i - 1 : i + 1;
        if (op === 'remove') { const removed = plan.splice(i, 1)[0]; plan.forEach(t => { t.dependsOn = t.dependsOn.filter(d => d !== removed.id); }); }
        else if (next >= 0 && next < plan.length) [plan[i], plan[next]] = [plan[next], plan[i]];
        mountR4Orchestra(el, run, pid, action); return;
      }
      if (op === 'report') {
        const report = await api(base + encodeURIComponent(run.id) + '/report');
        const url = URL.createObjectURL(new Blob([report.markdown], { type: 'text/markdown' }));
        const link = document.createElement('a'); link.href = url; link.download = run.id + '.md'; link.click(); URL.revokeObjectURL(url); return;
      }
      if (op === 'compare') {
        const other = value('[data-r4compare]'); if (!other) return;
        const result = await api(base + 'compare?a=' + encodeURIComponent(run.id) + '&b=' + encodeURIComponent(other));
        const cell = t => t ? esc(t.status + ' · ' + Math.round(t.durationMs / 1000) + 's · $' + (t.costUsd ?? 'unknown')) + '<br>' + esc(t.result) + '<br>' + esc(t.files.join(', ')) : '—';
        const html = '<div class="r4-compare"><table><thead><tr><th>Task</th>' + [result.a, result.b].map(r => '<th>' + esc(r.id + ' · $' + r.costUsd + ' · ' + Math.round(r.durationMs / 1000) + 's') + '<br>' + esc(r.files.join(', ')) + '</th>').join('') + '</tr></thead><tbody>' + result.tasks.map(t => '<tr><th>' + esc(t.id) + '</th><td>' + cell(t.a) + '</td><td>' + cell(t.b) + '</td></tr>').join('') + '</tbody></table></div>';
        comparisons.set(key, html);
        const current = el.querySelector('[data-r4panel]');
        if (current && current.dataset.r4run === key) current.querySelector('[data-r4comparison]').innerHTML = html;
        return;
      }
      let route = op, body = {};
      if (op === 'add') { route = 'tasks'; body = { text: value('[data-r4text]'), ...(value('[data-r4agent]') ? { agent: value('[data-r4agent]') } : {}), ...(value('[data-r4after]') ? { after: value('[data-r4after]') } : {}) }; }
      if (op === 'say') body = { text: value('[data-r4note]') };
      if (op === 'rerun') body = { onlyFailed: panel.querySelector('[data-r4failed]').checked, ...(value('[data-r4fleet]') ? { workers: value('[data-r4fleet]').split(',').map(s => s.trim()) } : {}) };
      if (op === 'plan' || op === 'approve') { capture(); body = { plan }; route = op; }
      if (['skip', 'extend', 'reassign'].includes(op)) { route = 'tasks/' + encodeURIComponent(id) + '/' + op;
        if (op === 'extend') body = { minutes: Number(value('[data-extend="' + CSS.escape(id) + '"]')) };
        if (op === 'reassign') body = { agent: value('[data-reassign="' + CSS.escape(id) + '"]') };
      }
      await action(run, route, body, b, () => { if (op === 'plan' || op === 'approve') drafts.delete(key); if (op === 'say') delete values['r4note:']; if (op === 'add') delete values['r4text:']; });
    } catch (e) { toast(e.message); }
  }; });
}
