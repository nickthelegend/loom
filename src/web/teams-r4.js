import { api } from './connection.js';
import { esc } from './format.js';
import { state } from './state.js';
import { toast } from './notifications.js';
import { copyText } from './clipboard.js';

const base = pid => '/api/projects/' + encodeURIComponent(pid) + '/teams-r4';
function modal(title){
  if (document.querySelector('.scrim')) return null;
  var scrim = document.createElement('div'); scrim.className = 'scrim';
  scrim.innerHTML = '<div class="modal phonemodal"><div class="modalhead">' + esc(title) + '<button class="btn ghost" data-close>Close</button></div><div class="modalbody r4-team-body"></div></div>';
  document.body.appendChild(scrim);
  function close(){ scrim.remove(); document.removeEventListener('keydown', key); }
  function key(e){ if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', key);
  scrim.querySelector('[data-close]').onclick = close;
  scrim.onclick = function(e){ if (e.target === scrim) close(); };
  return scrim.querySelector('.modalbody');
}
function error(host, e){ var el = host.querySelector('[data-error]'); if (el) el.textContent = e.message; else toast(e.message); }
export function openR4Share(pid, chat, mode){
  var body = modal(mode === 'pass' ? 'Pass to a teammate' : mode === 'review' ? 'Request review' : 'Share changes'); if (!body) return;
  body.innerHTML = (mode === 'pass' || mode === 'review' ? '<label class="slfield">Teammate<input data-login placeholder="@login" maxlength="40"></label><label class="slfield">Note<textarea data-note maxlength="4000"></textarea></label>' : '<p>Share a snapshot of the current working-tree changes.</p>') +
    '<label class="slfield">Expiry<select data-preset><option value="1h">1 hour</option><option value="1d" selected>1 day</option><option value="7d">7 days</option></select></label><label class="slfield">Passcode (optional)<input type="password" data-passcode maxlength="128"></label><label><input type="checkbox" data-notify> Notify me on first open</label><button class="btn" data-create>' + esc(mode === 'pass' ? 'Pass' : mode === 'review' ? 'Request review' : 'Share changes') + '</button><p role="alert" data-error></p><div data-result></div>';
  body.querySelector('[data-create]').onclick = async function(){
    this.disabled = true;
    try {
      var input = { chat: chat || 'main', preset: body.querySelector('[data-preset]').value, passcode: body.querySelector('[data-passcode]').value, notifyFirstOpen: body.querySelector('[data-notify]').checked };
      if (mode === 'pass' || mode === 'review') { input[mode] = body.querySelector('[data-login]').value; input.note = body.querySelector('[data-note]').value; } else input.changes = true;
      var r = await api(base(pid) + '/shares', { method: 'POST', body: JSON.stringify(input) });
      body.querySelector('[data-result]').innerHTML = '<input readonly aria-label="Share link" value="' + esc(r.url) + '"><button class="btn ghost" data-copy>Copy</button><p>Expires ' + esc(new Date(r.expiresAt).toLocaleString()) + '</p>' + (r.warning ? '<p role="status">' + esc(r.warning) + '</p>' : '');
      body.querySelector('[data-copy]').onclick = function(){ copyText(r.url); };
    } catch (e) { error(body, e); } finally { this.disabled = false; }
  };
}
export function openTeamLibrary(pid){
  var body = modal('Templates and Orchestra recipes'); if (!body) return;
  body.innerHTML = '<p>Team entries travel through .loom/shared in git. Commit and push published files; use git add -f if .loom is ignored.</p><div data-library></div><div data-fill></div><p data-error role="alert"></p>';
  async function load(){
    var results = await Promise.all(['templates', 'recipes'].map(k => api(base(pid) + '/library/' + k)));
    if (!body.isConnected) return;
    body.querySelector('[data-library]').innerHTML = results.map(function(r, i){
      var kind = i ? 'recipes' : 'templates';
      return '<h3>' + esc(i ? 'Orchestra recipes' : 'Prompt templates') + '</h3>' + r.entries.concat(r.personal || []).map(function(e){
        return '<div class="sharing-row"><span>' + esc(e.name) + (e.source === 'team' ? ' <span class="trole">Team</span>' : ' <small>Personal</small>') + '</span>' + (e.source === 'team' ? '<button class="btn ghost" data-use="' + esc(e.name) + '" data-kind="' + esc(kind) + '">' + (i ? 'Run' : 'Use') + '</button>' : '<button class="btn ghost" data-publish="' + esc(e.name) + '" data-kind="' + esc(kind) + '">Publish to repo</button>') + '</div>';
      }).join('') + (r.entries.length || r.personal.length ? '' : '<p>No entries yet.</p>') + r.errors.map(e => '<p role="alert">' + esc(e.name + ': ' + e.error) + '</p>').join('');
    }).join('');
    body.querySelectorAll('[data-publish]').forEach(function(b){ b.onclick = async function(){
      b.disabled = true;
      try { await api(base(pid) + '/library/' + b.dataset.kind + '/' + encodeURIComponent(b.dataset.publish) + '/publish', { method: 'POST', body: '{}' }); await load(); } catch (e) { error(body, e); b.disabled = false; }
    }; });
    body.querySelectorAll('[data-use]').forEach(function(b){ b.onclick = async function(){
      var name = b.dataset.use;
      if (b.dataset.kind === 'recipes') {
        b.disabled = true;
        try { var r = await api(base(pid) + '/library/recipes/' + encodeURIComponent(name) + '/run', { method: 'POST', body: '{}' }); toast('Started ' + name); body.closest('.scrim').querySelector('[data-close]').click(); location.hash = '#p/' + encodeURIComponent(pid) + '/c/' + encodeURIComponent(r.run.chat); } catch (e) { error(body, e); b.disabled = false; }
        return;
      }
      var entry = results[0].entries.find(e => e.name === name), fill = body.querySelector('[data-fill]');
      fill.innerHTML = '<h3>' + esc(name) + '</h3>' + entry.variables.map(v => '<label class="slfield">' + esc(v) + '<input data-variable="' + esc(v) + '"></label>').join('') + '<button class="btn" data-insert>Insert into composer</button>';
      fill.querySelector('[data-insert]').onclick = async function(){
        try {
          var values = Object.create(null); fill.querySelectorAll('[data-variable]').forEach(el => { values[el.dataset.variable] = el.value; });
          var rendered = await api(base(pid) + '/library/templates/' + encodeURIComponent(name) + '/render', { method: 'POST', body: JSON.stringify({ values }) });
          var box = document.getElementById('box');
          if (box && state.pid === pid) { box.value = rendered.text; box.dispatchEvent(new Event('input', { bubbles: true })); body.closest('.scrim').querySelector('[data-close]').click(); box.focus(); }
          else { await copyText(rendered.text); toast('Template copied'); }
        } catch (e) { error(body, e); }
      };
    }; });
  }
  load().catch(e => error(body, e));
}
function standup(host, pid){
  host.innerHTML = '<div class="tchd"><b>Standup</b></div><div class="r4-team-body"><label class="slfield">Project<select data-project>' + (state.projects || []).map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('') + '</select></label><label class="slfield">Since<input data-since value="1d" aria-label="Standup since"></label><div><button class="btn ghost" data-refresh>Refresh</button><button class="btn ghost" data-post="slack">Post to Slack</button><button class="btn ghost" data-post="discord">Post to Discord</button><button class="btn ghost" data-library-open>Templates and recipes</button></div><pre data-report></pre><p data-error role="alert"></p></div>';
  var select = host.querySelector('[data-project]'); if (pid) select.value = pid;
  async function refresh(post){
    if (!select.value) { host.querySelector('[data-report]').textContent = 'Open a project to build a standup.'; return; }
    try {
      host.querySelector('[data-error]').textContent = '';
      var r = await api(base(select.value) + '/standup', { method: 'POST', body: JSON.stringify({ since: host.querySelector('[data-since]').value, ...(post ? { post } : {}) }) });
      if (host.isConnected) host.querySelector('[data-report]').textContent = r.markdown + (r.posted ? '\nPosted to ' + r.posted : '');
    } catch (e) { error(host, e); }
  }
  host.querySelector('[data-refresh]').onclick = () => refresh(); select.onchange = () => refresh();
  host.querySelectorAll('[data-post]').forEach(b => { b.onclick = () => refresh(b.dataset.post); });
  host.querySelector('[data-library-open]').onclick = () => { if (select.value) openTeamLibrary(select.value); };
  refresh();
}
export function annotationHtml(a){
  return '<aside class="r4-annotation" data-annotation="' + esc(a.id) + '"><b>' + esc(a.name) + '</b>' + (a.verdict ? ' · ' + esc(a.verdict === 'approve' ? 'Approved' : 'Changes requested') : '') + (a.messageId ? ' · message #' + esc(a.messageId) : '') + '<p>' + esc(a.text) + '</p>' + (a.reply ? '<p><b>Owner reply:</b> ' + esc(a.reply) + '</p>' : '') + '<button class="btn ghost" data-reply>Reply</button><button class="btn ghost" data-remove>Remove</button></aside>';
}
export function registerTeamsR4(){
  var scheduled = false, key = '', annotations = [], loading = false, lastLoad = 0, socket = null;
  function inject(){
    scheduled = false;
    if (!state.token || document.querySelector('.guest')) return;
    var pid = state.pid, chat = state.chat || 'main';
    if (state.ws && state.ws !== socket) { socket = state.ws; socket.addEventListener('message', function(e){ try { var f = JSON.parse(e.data); if (f.type === 'share-opened') toast('Share opened: ' + f.title); if (f.type === 'share-annotation') lastLoad = 0; } catch (e) {} }); }
    var presence = document.getElementById('presence');
    if (presence && !document.getElementById('r4-chat-actions')) {
      var actions = document.createElement('span'); actions.id = 'r4-chat-actions'; actions.className = 'r4-chat-actions';
      actions.innerHTML = '<button class="btn ghost xs" data-pass>Pass</button><button class="btn ghost xs" data-team-review>Review</button><button class="btn ghost xs" data-library>Team library</button>';
      presence.after(actions);
      actions.querySelector('[data-pass]').onclick = () => openR4Share(state.pid, state.chat, 'pass');
      actions.querySelector('[data-team-review]').onclick = () => openR4Share(state.pid, state.chat, 'review');
      actions.querySelector('[data-library]').onclick = () => openTeamLibrary(state.pid);
    }
    var scm = document.querySelector('.scmcommit');
    if (scm && !scm.querySelector('[data-share-changes]')) { var b = document.createElement('button'); b.className = 'btn ghost'; b.type = 'button'; b.dataset.shareChanges = ''; b.textContent = 'Share changes'; b.onclick = () => openR4Share(state.pid, state.chat, 'changes'); scm.appendChild(b); }
    var team = document.querySelector('.teampane');
    if (team && !team.querySelector('[data-standup]')) { var card = document.createElement('section'); card.className = 'tcard'; card.dataset.standup = ''; team.prepend(card); standup(card, pid); }
    var feed = document.getElementById('feed');
    if (!pid || !feed || state.tab !== 'thread') return;
    var nextKey = pid + '/' + chat;
    if (key !== nextKey) { key = nextKey; annotations = []; lastLoad = 0; document.querySelectorAll('.r4-annotation').forEach(el => el.remove()); }
    if (!loading && Date.now() - lastLoad > 4000) {
      loading = true; lastLoad = Date.now();
      api(base(pid) + '/annotations/' + encodeURIComponent(chat)).then(r => { if (key !== nextKey) return; annotations = r.annotations; document.querySelectorAll('.r4-annotation').forEach(el => { if (!el.querySelector('textarea')) el.remove(); }); render(); }).catch(() => {}).finally(() => { loading = false; });
    }
    render();
    function render(){
      annotations.forEach(a => {
        if (document.querySelector('[data-annotation="' + a.id + '"]')) return;
        var target = a.messageId ? feed.querySelector('.msg[data-id="' + Number(a.messageId) + '"]') : feed;
        if (!target) target = feed;
        var wrap = document.createElement('div'); wrap.innerHTML = annotationHtml(a); var el = wrap.firstElementChild; target.appendChild(el);
        var route = base(pid) + '/annotations/' + encodeURIComponent(a.shareId) + '/' + encodeURIComponent(a.id);
        el.querySelector('[data-remove]').onclick = async () => { try { await api(route, { method: 'DELETE' }); annotations = annotations.filter(x => x.id !== a.id); el.remove(); } catch (e) { toast(e.message); } };
        el.querySelector('[data-reply]').onclick = () => {
          if (el.querySelector('textarea')) return;
          var input = document.createElement('textarea'); input.maxLength = 4000; input.setAttribute('aria-label', 'Reply to comment'); el.appendChild(input);
          var save = document.createElement('button'); save.className = 'btn'; save.textContent = 'Save reply'; el.appendChild(save);
          save.onclick = async () => { try { await api(route, { method: 'PUT', body: JSON.stringify({ reply: input.value }) }); annotations = annotations.map(row => row.id === a.id ? { ...row, reply: input.value } : row); el.remove(); render(); } catch (e) { toast(e.message); } };
        };
      });
    }
  }
  var observer = new MutationObserver(function(){ if (!scheduled) { scheduled = true; setTimeout(inject, 100); } });
  observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
  var timer = setInterval(inject, 5000);
  window.addEventListener('beforeunload', function(){ observer.disconnect(); clearInterval(timer); });
  inject();
}
