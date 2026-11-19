import { api } from './connection.js';
import { esc } from './format.js';
import { toast } from './notifications.js';
import { copyText } from './clipboard.js';

export function timeLeft(expiresAt, now){
  var s = Math.max(0, Math.ceil((Number(expiresAt) - (now == null ? Date.now() : now)) / 1000));
  return s ? Math.floor(s / 86400) + 'd ' + Math.floor(s % 86400 / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm ' + s % 60 + 's left' : 'Expired';
}
export function projectPresenceHtml(people){
  if (!people || !people.length) return '';
  var names = people.map(function(p){ return p.name; }).join(', ');
  return '<span class="project-presence" role="status" title="' + esc(names) + '" aria-label="' + esc(names + ' present') + '"><span></span>' + esc(people.length) + '</span>';
}
function dialog(title){
  var old = document.querySelector('.scrim'); if (old) return null;
  var scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = '<div class="modal phonemodal"><div class="modalhead">' + esc(title) + '<button class="btn ghost" data-close>Close</button></div><div class="modalbody sharing-body"></div></div>';
  document.body.appendChild(scrim);
  var timer = setInterval(function(){
    if (!scrim.isConnected) { clearInterval(timer); return; }
    scrim.querySelectorAll('[data-expiry]').forEach(function(e){ e.textContent = timeLeft(e.dataset.expiry); });
  }, 1000);
  function close(){ clearInterval(timer); scrim.remove(); document.removeEventListener('keydown', key); }
  function key(e){ if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', key);
  scrim.querySelector('[data-close]').onclick = close;
  scrim.onclick = function(e){ if (e.target === scrim) close(); };
  return scrim.querySelector('.modalbody');
}
export function exportAudit(){
  return api('/api/audit.csv?format=json&since=0').then(function(r){
    var url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a'); a.href = url; a.download = 'loom-audit.csv'; a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }).catch(function(e){ toast(e.message); });
}
export function openSharing(pid, chat, run){
  var body = dialog('Sharing and approvals'); if (!body) return;
  var base = '/api/projects/' + encodeURIComponent(pid);
  body.innerHTML = '<label class="slfield">Link expiry<select data-expiry-preset><option value="1h">1 hour</option><option value="1d" selected>1 day</option><option value="7d">7 days</option></select></label>' +
    '<label class="slfield">Passcode (optional)<input type="password" data-share-passcode maxlength="128"></label><label><input type="checkbox" data-first-open> Notify me on first open</label><button class="btn" data-create-share>Create read-only ' + (run ? 'run' : 'chat') + ' link</button><div data-share-result></div><div data-links></div>' +
    '<details><summary>Who may approve tool calls</summary><div data-roles>Loading…</div></details>' +
    '<button class="btn outline" data-audit>Export audit CSV</button>';
  body.querySelector('[data-audit]').onclick = exportAudit;
  function links(){
    api(base + '/shares').then(function(r){
      body.querySelector('[data-links]').innerHTML = (r.shares || []).map(function(s){ return '<div class="sharing-row"><span>' + esc(s.title) + ' · ' + esc(s.views || 0) + ' views · ' + esc(s.lastOpenedAt ? new Date(s.lastOpenedAt).toLocaleString() : 'Never opened') + (s.passcodeProtected ? ' · Passcode' : '') + ' · <span data-expiry="' + esc(s.expiresAt) + '">' + esc(timeLeft(s.expiresAt)) + '</span></span><button class="btn ghost" data-revoke="' + esc(s.id) + '">Revoke</button></div>'; }).join('');
      body.querySelectorAll('[data-revoke]').forEach(function(b){ b.onclick = function(){ api(base + '/shares/' + encodeURIComponent(b.dataset.revoke), { method: 'DELETE' }).then(links).catch(function(e){ toast(e.message); }); }; });
    }).catch(function(e){ body.querySelector('[data-links]').textContent = e.message; });
  }
  links();
  body.querySelector('[data-create-share]').onclick = function(){
    var b = this; b.disabled = true;
    api(base + '/teams-r4/shares', { method: 'POST', body: JSON.stringify({ chat: chat || 'main', run: run, preset: body.querySelector('[data-expiry-preset]').value, passcode: body.querySelector('[data-share-passcode]').value, notifyFirstOpen: body.querySelector('[data-first-open]').checked }) }).then(function(r){
      body.querySelector('[data-share-result]').innerHTML = '<input aria-label="Read-only share link" readonly value="' + esc(r.url) + '"><button class="btn ghost" data-copy-link>Copy</button><p data-expiry="' + esc(r.expiresAt) + '">' + esc(timeLeft(r.expiresAt)) + '</p>';
      body.querySelector('[data-copy-link]').onclick = function(){ copyText(r.url); }; links();
    }).catch(function(e){ toast(e.message); }).finally(function(){ b.disabled = false; });
  };
  api(base + '/approval-roles').then(function(r){
    var host = body.querySelector('[data-roles]');
    host.innerHTML = '<p>Owner devices always may approve. Select which other paired devices may approve in this project.</p><label class="slfield">Approval role<select data-mode><option value="everyone">Everyone with existing approval access</option><option value="selected">Selected approvers</option></select></label>' +
      (r.devices || []).map(function(d){ return '<label class="sharing-row"><input type="checkbox" data-approver="' + esc(d.id) + '"' + (d.owner ? ' checked disabled' : r.approvers.indexOf(d.id) >= 0 ? ' checked' : '') + '>' + esc(d.name + (d.owner ? ' · owner device' : '')) + '</label>'; }).join('') + '<button class="btn" data-save-roles>Save approval roles</button>';
    host.querySelector('[data-mode]').value = r.mode;
    host.querySelector('[data-save-roles]').disabled = !r.canApprove;
    host.querySelector('[data-save-roles]').onclick = function(){
      api(base + '/approval-roles', { method: 'PUT', body: JSON.stringify({ mode: host.querySelector('[data-mode]').value, approvers: Array.from(host.querySelectorAll('[data-approver]:checked:not(:disabled)')).map(function(e){ return e.dataset.approver; }) }) }).then(function(){ toast('Approval roles saved'); }).catch(function(e){ toast(e.message); });
    };
  }).catch(function(e){ body.querySelector('[data-roles]').textContent = e.message; });
}
export function openTeamSharing(teamId){
  var body = dialog('Team fleets and invites'); if (!body) return;
  var q = '?teamId=' + encodeURIComponent(teamId);
  body.innerHTML = '<h3>Shared fleets</h3><div data-fleets></div><label class="slfield">Fleet name<input data-fleet-name maxlength="64"></label><label class="slfield">Agent specs<input data-fleet-spec placeholder="echo@modelx2,echo"></label><button class="btn" data-publish>Share fleet</button><h3>Active invites</h3><div data-invites></div><button class="btn outline" data-audit>Export audit CSV</button>';
  function fail(e){ toast(e.message); }
  function fleets(){ api('/api/team/fleets' + q).then(function(r){
    body.querySelector('[data-fleets]').innerHTML = r.fleets.map(function(f){ return '<div class="sharing-row"><span><b>' + esc(f.name) + '</b> ' + esc(f.spec) + '</span><button class="btn ghost" data-import="' + esc(f.name) + '">Save locally</button><button class="btn ghost" data-remove-fleet="' + esc(f.name) + '">Unshare</button></div>'; }).join('') || 'No shared fleets yet.';
    body.querySelectorAll('[data-import]').forEach(function(b){ b.onclick = function(){ var f = r.fleets.find(function(f){ return f.name === b.dataset.import; }); api('/api/fleets', { method: 'PUT', body: JSON.stringify(f) }).then(function(){ toast('Saved @' + f.name + ' for the Orchestra fleet picker'); }).catch(fail); }; });
    body.querySelectorAll('[data-remove-fleet]').forEach(function(b){ b.onclick = function(){ api('/api/team/fleets/' + encodeURIComponent(b.dataset.removeFleet) + q, { method: 'DELETE' }).then(fleets).catch(fail); }; });
  }).catch(fail); }
  function invites(){ api('/api/team/invites' + q).then(function(r){
    body.querySelector('[data-invites]').innerHTML = r.invites.map(function(i){ return '<div class="sharing-row"><span>' + esc(i.id.slice(0, 10)) + ' · <span data-expiry="' + esc(i.expiresAt) + '">' + esc(timeLeft(i.expiresAt)) + '</span></span><button class="btn ghost" data-invite-revoke="' + esc(i.id) + '">Revoke invite</button></div>'; }).join('') || 'No active invites.';
    body.querySelectorAll('[data-invite-revoke]').forEach(function(b){ b.onclick = function(){ api('/api/team/invites/' + encodeURIComponent(b.dataset.inviteRevoke) + q, { method: 'DELETE' }).then(invites).catch(fail); }; });
  }).catch(function(e){ body.querySelector('[data-invites]').textContent = e.message; }); }
  body.querySelector('[data-publish]').onclick = function(){ api('/api/team/fleets', { method: 'PUT', body: JSON.stringify({ teamId: teamId, name: body.querySelector('[data-fleet-name]').value, spec: body.querySelector('[data-fleet-spec]').value }) }).then(fleets).catch(fail); };
  body.querySelector('[data-audit]').onclick = exportAudit;
  fleets(); invites();
}
