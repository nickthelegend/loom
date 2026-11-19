import { api } from './connection.js';
import { esc } from './format.js';
import { askText, toast } from './notifications.js';

export function toolRows(tools) {
  return tools.map(t => '<label class="prow"><div class="pl"><div class="pt">' + esc(t.name) + '</div><div class="pd">' + esc(t.description) + '</div></div>' +
    '<div class="pc"><input type="checkbox" data-r4-tool="' + esc(t.name) + '" aria-label="' + esc(t.name) + '"' + (t.enabled ? ' checked' : '') + '></div></label>').join('');
}
export function callRows(calls) {
  return calls.length ? calls.slice().reverse().map(c => '<div class="prow"><div class="pl"><div class="pt">' + esc(c.tool) + ' · ' + esc(c.actor) + '</div><div class="pd">' +
    esc(new Date(c.at).toLocaleString()) + ' · ' + esc(c.durationMs) + ' ms · ' + esc(c.ok ? 'Succeeded' : c.error || 'Failed') + '</div></div></div>').join('') : '<div class="snote">No tool calls yet.</div>';
}
export function renderAgenticTools(parent, pid) {
  const root = document.createElement('section');
  root.dataset.r4Tools = '';
  parent.appendChild(root);
  const base = '/api/projects/' + encodeURIComponent(pid) + '/r4';
  let busy = false;
  async function refresh() {
    try {
      const [settings, log, hooks] = await Promise.all([api(base + '/tools'), api(base + '/log'), api(base + '/hooks')]);
      if (!root.isConnected) return;
      root.innerHTML = '<div class="sgrouph">Tools · Agent access</div><div class="snote">Choose the Loom tools agents receive in this project. The project’s Loom tools switch controls ordinary turns.</div>' + toolRows(settings.tools) +
        '<div class="sgrouph">Tool call log <button class="btn outline sm" data-r4-refresh>Refresh</button></div><div data-r4-log>' + callRows(log.calls) + '</div>' +
        '<div class="sgrouph">Project hooks</div><div class="snote">Executable .loom/hooks scripts run on this computer with event JSON on stdin. Enable only for a repository you trust.</div>' +
        '<label class="prow">Run project hooks <input type="checkbox" data-r4-hooks aria-label="Run project hooks"' + (hooks.enabled ? ' checked' : '') + (hooks.canEnable ? '' : ' disabled') + '></label>' +
        hooks.hooks.map(h => '<div class="prow"><div class="pl"><div class="pt">' + esc(h.event) + '</div><div class="pd">' + esc(h.executable ? 'Executable' : 'Missing or not executable') + '</div></div><button class="btn outline sm" data-r4-test="' + esc(h.event) + '"' + (hooks.enabled && hooks.canEnable && h.executable ? '' : ' disabled') + '>Test</button></div>').join('');
      root.querySelector('[data-r4-refresh]').onclick = refresh;
      root.querySelectorAll('[data-r4-tool]').forEach(input => {
        input.onchange = async () => {
          if (busy) return;
          busy = true;
          root.querySelectorAll('[data-r4-tool]').forEach(el => { el.disabled = true; });
          const disabledTools = settings.tools.filter(t => t.name === input.dataset.r4Tool ? !input.checked : !t.enabled).map(t => t.name);
          try { await api(base + '/tools', { method: 'PUT', body: JSON.stringify({ disabledTools }) }); }
          catch (error) { toast(error.message); }
          finally { busy = false; await refresh(); }
        };
      });
      root.querySelector('[data-r4-hooks]').onchange = async function() {
        this.disabled = true;
        try { await api(base + '/hooks', { method: 'PUT', body: JSON.stringify({ enabled: this.checked }) }); }
        catch (error) { toast(error.message); }
        await refresh();
      };
      root.querySelectorAll('[data-r4-test]').forEach(button => {
        button.onclick = async () => {
          button.disabled = true;
          try { const result = await api(base + '/hooks/test', { method: 'POST', body: JSON.stringify({ event: button.dataset.r4Test }) }); toast(result.timedOut ? 'Hook timed out' : 'Hook exit ' + result.code + (result.output ? ': ' + result.output : '')); }
          catch (error) { toast(error.message); }
          finally { if (button.isConnected) button.disabled = false; }
        };
      });
    } catch (error) { if (root.isConnected) root.innerHTML = '<div class="snote">' + esc(error.message) + '</div>'; }
  }
  void refresh();
}

export function saveChatSkillItem(pid, chat) {
  return { label: 'Save as skill', run: async function() {
    const name = await askText('Save as skill', { note: 'Skill name (lowercase words separated by hyphens)', value: '' });
    if (!name) return;
    try {
      const result = await api('/api/projects/' + encodeURIComponent(pid) + '/r4/skills/from-chat', { method: 'POST', body: JSON.stringify({ chat, name }) });
      toast('Draft saved, disabled. Edit ' + result.file);
    } catch (error) { toast(error.message); }
  } };
}
