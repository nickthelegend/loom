import { api } from './connection.js';
import { esc } from './format.js';
import { askConfirm, toast } from './notifications.js';

export function safeGit(pid, operation, body){
  var url = '/api/projects/' + encodeURIComponent(pid) + '/git/' + operation;
  function send(override){ return api(url, { method: 'POST', body: JSON.stringify(Object.assign({}, body || {}, { overrideSecrets: override })) }); }
  return send(false).catch(function(e){
    if (!/Secret scan blocked/.test(e.message)) throw e;
    return askConfirm(e.message + '\nOverride the secret scan for this ' + operation + '?', { title: 'Secrets detected', ok: 'Override and ' + operation, danger: true }).then(function(yes){
      if (!yes) throw e;
      return send(true);
    });
  });
}

export function openSafety(pid){
  return api('/api/projects/' + encodeURIComponent(pid) + '/safety').then(function(data){
    var p = data.policy;
    var scrim = document.createElement('div'); scrim.className = 'scrim';
    var fields = [['allow', 'Allow tools (globs)'], ['deny', 'Deny tools (globs; deny wins)'], ['protectedPaths', 'Protected paths (relative globs)'], ['shellDeny', 'Shell command denylist (globs)']];
    scrim.innerHTML = '<section class="modal safety-modal" role="dialog" aria-modal="true" aria-label="Project safety">' +
      '<h2>Project safety</h2><p>Rules apply to this project. Protected paths disable shells and tools that cannot enforce them. Hard rules require a supported agent.</p>' +
      '<label>Permission preset<select id="safety-preset">' + ['strict', 'normal', 'trusting'].map(function(v){ return '<option value="' + esc(v) + '"' + (v === p.preset ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select></label>' +
      fields.map(function(f){ return '<label>' + esc(f[1]) + '<textarea id="safety-' + esc(f[0]) + '" rows="2" placeholder="One pattern per line">' + esc(p[f[0]].join('\n')) + '</textarea></label>'; }).join('') +
      '<label>Auto-deny after minutes<input id="safety-timeout" type="number" min="0.001" max="1440" step="any" value="' + esc(p.approvalTimeoutMin) + '"></label>' +
      '<p>Secrets are scanned before Loom commits and pushes. Transcripts and exports redact credentials. Changing the preset applies its permission mode to every agent.</p>' +
      '<p id="safety-error" role="alert"></p><div class="safety-actions"><button class="btn outline" id="safety-close">Close</button><button class="btn outline" id="safety-audit">Risky audit</button><button class="btn" id="safety-save">Save policy</button></div><pre id="safety-report"></pre></section>';
    document.body.appendChild(scrim);
    scrim.querySelector('#safety-close').onclick = function(){ scrim.remove(); };
    scrim.addEventListener('keydown', function(e){ if (e.key === 'Escape') scrim.remove(); });
    scrim.querySelector('#safety-preset').onchange = function(e){
      var v = e.target.value;
      fields.forEach(function(f){ scrim.querySelector('#safety-' + f[0]).value = f[0] === 'protectedPaths' && v === 'strict' ? '.env\n.env.*\n.git/**\n.loom/**' : ''; });
      scrim.querySelector('#safety-timeout').value = { strict: 5, normal: 30, trusting: 60 }[v];
    };
    scrim.querySelector('#safety-save').onclick = function(){
      var btn = this; btn.disabled = true;
      var policy = { preset: scrim.querySelector('#safety-preset').value, approvalTimeoutMin: Number(scrim.querySelector('#safety-timeout').value) };
      fields.forEach(function(f){ policy[f[0]] = scrim.querySelector('#safety-' + f[0]).value.split('\n').map(function(v){ return v.trim(); }).filter(Boolean); });
      api('/api/projects/' + encodeURIComponent(pid) + '/safety', { method: 'PUT', body: JSON.stringify(policy) }).then(function(){ toast('Project safety saved'); scrim.remove(); }).catch(function(e){ scrim.querySelector('#safety-error').textContent = e.message; }).finally(function(){ btn.disabled = false; });
    };
    scrim.querySelector('#safety-audit').onclick = function(){
      api('/api/audit?risky=true').then(function(j){
        var entries = j.entries.filter(function(e){ return e.project === pid; });
        scrim.querySelector('#safety-report').textContent = entries.length ? entries.map(function(e){ return new Date(e.at).toLocaleString() + ' · ' + e.who + ' · ' + e.what + (e.detail ? '\n' + e.detail : ''); }).join('\n\n') : 'No risky activity recorded.';
      }).catch(function(e){ scrim.querySelector('#safety-error').textContent = e.message; });
    };
    scrim.querySelector('#safety-preset').focus();
  }).catch(function(e){ toast(e.message); });
}
