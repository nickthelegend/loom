import { api } from '../connection.js';
import { esc } from '../format.js';
import { state } from '../state.js';
import { helpDialog } from './panel.js';

export function mountReadiness(el, pid) {
  var card = document.createElement('section'); card.className = 'r4readiness'; card.innerHTML = '<h3>Project readiness</h3><div role="status">Checking…</div>';
  el.prepend(card);
  function draw(r) {
    card.innerHTML = '<h3>Project readiness · ' + esc(r.score) + '/100</h3><ul>' + r.checks.map(function(c) { return '<li>' + (c.ok ? '✓ ' : '○ ') + esc(c.detail) + '</li>'; }).join('') + '</ul>' + (r.checks.some(function(c) { return c.fix && !c.ok; }) ? '<details><summary>Preview fixes · AGENTS.md</summary><pre class="r4guide">' + esc(r.draft) + '</pre><p>Add .loom/ to .gitignore when missing. Existing instruction files are kept.</p></details><button class="btn sm" data-ready-fix>Apply fixes</button>' : '') + '<p role="status">' + esc(r.applied.join(' ')) + '</p>';
    var fix = card.querySelector('[data-ready-fix]'); if (fix) fix.onclick = function() { fix.disabled = true; load(true); };
  }
  function load(fix) { api('/api/projects/' + encodeURIComponent(pid) + '/ready', fix ? { method: 'POST', body: '{"fix":true}' } : undefined).then(draw).catch(function(e) { card.querySelector('[role=status]').textContent = e.message; var b = card.querySelector('button'); if (b) b.disabled = false; }); }
  load(false);
}
export function registerProjectHelp(scrim, pid) {
  var observer = new MutationObserver(function() { var body = scrim.querySelector('#psbody'); if (!scrim.isConnected) { observer.disconnect(); return; } if (body && body.querySelector('input') && !body.querySelector('.r4readiness')) mountReadiness(body, pid); });
  observer.observe(scrim, { childList: true, subtree: true });
}
export function openProviderGuide() {
  var dlg = helpDialog('Provider setup · four steps');
  var provider = '', models = [], model = '';
  function draw(step, error) {
    dlg.body.innerHTML = '<p>Step ' + esc(step) + ' of 4 · ' + esc(['Add a key','Test credentials','Pick a default model','Add a model agent'][step - 1]) + '</p>' +
      (step === 1 ? '<label>Provider id<input id="r4provider" value="openrouter" autocomplete="off"></label><label>API key<input id="r4key" type="password" autocomplete="new-password"></label><label>Custom base URL (optional)<input id="r4url" type="url"></label>' : '') +
      (step === 2 ? '<p>Fetch the provider’s model list using the saved key.</p>' : '') +
      (step === 3 ? '<label>Default model<select id="r4model">' + models.map(function(m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('') + '</select></label>' : '') +
      (step === 4 ? '<p>' + esc(model) + '</p><label>Project<select id="r4project">' + (state.projects || []).map(function(p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('') + '</select></label>' : '') +
      '<p role="status">' + esc(error || '') + '</p><button class="btn primary" data-provider-next>' + esc(['Save key','Test key','Use as default','Add agent'][step - 1]) + '</button>';
    dlg.body.querySelector('[data-provider-next]').onclick = function() {
      var b = this, payload = { provider: provider }, action = ['key','test','default','agent'][step - 1];
      if (step === 1) { provider = dlg.body.querySelector('#r4provider').value.trim(); payload = { provider: provider, key: dlg.body.querySelector('#r4key').value, baseUrl: dlg.body.querySelector('#r4url').value.trim() }; }
      if (step === 3) payload.model = dlg.body.querySelector('#r4model').value;
      if (step === 4) payload.project = dlg.body.querySelector('#r4project').value;
      b.disabled = true;
      api('/api/help/provider/' + action, { method: 'POST', body: JSON.stringify(payload) }).then(function(r) {
        if (!dlg.scrim.isConnected) return;
        if (r.models) models = r.models; if (r.model) model = r.model;
        if (step === 4) dlg.body.innerHTML = '<p role="status">Ready · ' + esc(r.agent.id) + ' is the project’s default agent.</p>';
        else draw(step + 1);
      }).catch(function(e) { if (dlg.scrim.isConnected) { dlg.body.querySelector('[role=status]').textContent = e.message; b.disabled = false; } });
    };
  }
  draw(1);
}
