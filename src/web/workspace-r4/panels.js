import { workspaceRead,WORKSPACE_POLL_MS } from "./poll.js";
import { api } from '../connection.js';
import { esc,mdToHtml } from '../format.js';
import { state } from '../state.js';
import { toast } from '../notifications.js';
import { copyText } from '../clipboard.js';

export function chatLink(p, c, event) { return '#p/' + encodeURIComponent(p) + '/c/' + encodeURIComponent(c || 'main') + (event ? '/m/' + event : ''); }
export function openChat(p, c, event) {
  if (event || !state.setChat) location.hash = chatLink(p, c, event);
  else state.setChat(p, c);
}
export function dialog(title, rail) {
  var old = document.getElementById('r4-panel'); if (old) old.closePanel();
  var el = document.createElement('div'); el.id = 'r4-panel'; el.className = rail ? 'r4-rail' : 'scrim';
  el.innerHTML = '<section class="modal r4-panel" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><header class="modalhead">' + esc(title) + '<span class="spacer"></span><button class="btn xs" data-close aria-label="Close">×</button></header><div class="modalbody r4-body"></div></section>';
  var focus = document.activeElement, cleanups = [];
  function close(){ cleanups.forEach(function(f){ f(); }); el.remove(); if (focus && focus.isConnected) focus.focus(); }
  function key(e){ if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
  el.closePanel = close; cleanups.push(function(){ document.removeEventListener('keydown', key, true); });
  document.addEventListener('keydown', key, true);
  el.querySelector('[data-close]').onclick = close;
  el.onclick = function(e){ if (e.target === el && !rail) close(); };
  document.body.appendChild(el); el.querySelector('[data-close]').focus();
  return { el: el, body: el.querySelector('.r4-body'), close: close, cleanups: cleanups };
}
export function mountMission(body) {
  var stopped = false, busy = false, signature = '';
  body.innerHTML = '<p role="status">Loading running chats…</p>';
  function refresh(fresh){
    if (stopped || busy || document.hidden || !body.isConnected) return;
    busy = true;
    workspaceRead('/api/mission', fresh === true).then(function(j){
      if (stopped || !body.isConnected) return;
      var sig = JSON.stringify(j.chats.map(function(c){ return [c.project, c.chat, c.lastLine, c.costUsd, c.since]; }));
      if (signature === sig) return; signature = sig;
      // A live refresh must not replace an unfinished steer message.
      if (body.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) { signature = ''; return; }
      body.innerHTML = '<div class="r4-grid">' + j.chats.map(function(c, i){
        return '<article class="r4-card" data-row="' + i + '"><button class="btn ghost" data-open>' + esc(c.projectName + ' · ' + c.title) + '</button><p>' + esc(c.lastLine || 'Working…') + '</p><small><span data-since="' + c.since + '"></span> · ' + (c.costUsd == null ? 'cost not reported' : '$' + c.costUsd.toFixed(4)) + '</small><div class="r4-actions"><button class="btn xs" data-stop>Stop' + (c.stopScope === 'run' ? ' run' : c.stopScope === 'crew' ? ' crew' : '') + '</button><input aria-label="Steer ' + esc(c.title) + '" placeholder="Steer this chat"><button class="btn xs" data-steer>Steer</button></div><span role="status"></span></article>';
      }).join('') + '</div>' + (j.chats.length ? '' : '<p>No chats running.</p>');
      body.querySelectorAll('[data-row]').forEach(function(row){
        var c = j.chats[Number(row.dataset.row)], base = '/api/projects/' + encodeURIComponent(c.project);
        row.querySelector('[data-open]').onclick = function(){ openChat(c.project, c.chat); };
        function send(action, data, button){
          button.disabled = true;
          api(base + '/chats/' + encodeURIComponent(c.chat) + '/workspace/' + (action === 'interrupt' ? 'stop' : action), { method: 'POST', body: JSON.stringify(data) }).then(function(r){
            row.querySelector('[role=status]').textContent = r.reason || (action === 'steer' ? 'Steering sent' : 'Stopped');
            if (action === 'steer') row.querySelector('input').value = '';
            signature = ''; refresh(true);
          }).catch(function(e){ row.querySelector('[role=status]').textContent = e.message; }).finally(function(){ button.disabled = false; });
        }
        row.querySelector('[data-stop]').onclick = function(){ send('interrupt', { chat: c.chat }, this); };
        row.querySelector('[data-steer]').onclick = function(){ var t = row.querySelector('input').value.trim(); if (t) send('steer', { chat: c.chat, text: t }, this); };
      }); tick();
    }).catch(function(e){ if (!stopped) { signature = ''; body.textContent = e.message; } }).finally(function(){ busy = false; });
  }
  function tick(){ body.querySelectorAll('[data-since]').forEach(function(e){ e.textContent = Math.max(0, Math.floor((Date.now() - Number(e.dataset.since)) / 1000)) + 's'; }); }
  refresh(); var poll = setInterval(refresh, WORKSPACE_POLL_MS), clock = setInterval(tick, 1000);
  return function(){ stopped = true; clearInterval(poll); clearInterval(clock); };
}
export function openMission(){ var d = dialog('Mission control'); d.cleanups.push(mountMission(d.body)); }

export function openInbox(){
  var d = dialog('Needs you'), selected = 0, items = [], loading = false, signature = '';
  function paint(){ d.body.querySelectorAll('[data-item]').forEach(function(row, i){ row.classList.toggle('selected', i === selected); }); }
  function refresh(fresh){
    if (loading || document.hidden || !d.el.isConnected) return; loading = true;
    workspaceRead('/api/inbox', fresh === true).then(function(j){
      if (!d.el.isConnected) return;
      var sig = JSON.stringify(j.items); if (sig === signature) return;
      if (d.body.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
      var id = items[selected] && items[selected].id; items = j.items; signature = sig;
      selected = Math.max(0, items.findIndex(function(i){ return i.id === id; }));
      d.body.innerHTML = '<p class="snote">j/k move · a accept or answer · d deny or dismiss</p>' + (items.length ? items.map(function(i, n){
        var questions = i.questions && i.questions.length ? i.questions : [{ id: 'answer', question: 'Reply' }];
        return '<article class="r4-card" tabindex="0" data-item="' + n + '"><small>' + esc(i.projectName + ' · ' + i.kind) + '</small><p>' + esc(i.title) + '</p>' +
          (i.kind === 'question' || i.kind === 'paused' && ['reply','say','message'].includes(i.action) ? questions.map(function(q){ return '<label>' + esc(q.question) + '<input data-answer="' + esc(q.id) + '" aria-label="' + esc(q.question) + '"></label>'; }).join('') : '') +
          '<div class="r4-actions"><button class="btn xs" data-open>Open chat</button>' +
          (i.kind !== 'failed' ? '<button class="btn xs" data-accept>' + (i.kind === 'approval' ? 'Allow' : i.kind === 'question' || ['reply','say','message'].includes(i.action) ? 'Answer' : i.action === 'approve-plan' || i.action === 'approve' ? 'Approve plan' : 'Resume') + '</button>' : '') +
          '<button class="btn xs" data-deny>' + (i.kind === 'approval' ? 'Deny' : i.kind === 'failed' || i.kind === 'question' && !i.requestId ? 'Dismiss' : 'Stop') + '</button></div></article>';
      }).join('') : '<p>Nothing needs you.</p>');
      d.body.querySelectorAll('[data-item]').forEach(function(row, n){
        row.onfocusin = function(){ selected = n; paint(); };
        row.querySelector('[data-open]').onclick = function(){ d.close(); openChat(items[n].project, items[n].chat, items[n].eventId); };
        var accept = row.querySelector('[data-accept]'); if (accept) accept.onclick = function(){ act(n, true); };
        row.querySelector('[data-deny]').onclick = function(){ act(n, false); };
      }); paint();
    }).catch(function(e){ toast(e.message); }).finally(function(){ loading = false; });
  }
  function act(n, yes){
    var i = items[n]; if (!i) return;
    var row = d.body.querySelector('[data-item="' + n + '"]'), suffix, data = { chat: i.chat };
    if (i.kind === 'approval') { suffix = '/approvals/' + encodeURIComponent(i.approvalId); data = { decision: yes ? 'allow' : 'deny' }; }
    else if (i.kind === 'failed') { if (yes) return; suffix = '/inbox/dismiss'; data = { eventId: i.eventId }; }
    else if (!yes) { if (i.kind === 'question' && !i.requestId) { suffix = '/inbox/dismiss'; data = { eventId: i.eventId }; } else suffix = i.runId ? '/orchestra/' + encodeURIComponent(i.runId) + '/abort' : i.crewId ? '/crews/' + encodeURIComponent(i.crewId) + '/stop' : '/interrupt'; }
    else {
      var answers = {}; row.querySelectorAll('[data-answer]').forEach(function(e){ answers[e.dataset.answer] = e.value; });
      var text = Object.values(answers).join('\n').trim();
      if (i.kind === 'question') {
        if (!text) { row.querySelector('input').focus(); return; }
        suffix = i.requestId ? '/agents/' + encodeURIComponent(i.agent) + '/answers' : '/messages';
        data = i.requestId ? { chat: i.chat, requestId: i.requestId, answers: answers } : { chat: i.chat, agentId: i.agent, text: text };
      } else if (i.runId || i.crewId) { if (['reply','say'].includes(i.action) && !text) { row.querySelector('input').focus(); return; } suffix = (i.runId ? '/orchestra/' + encodeURIComponent(i.runId) : '/crews/' + encodeURIComponent(i.crewId)) + '/' + i.action; data = text ? { text: text } : {}; }
      else if (i.action === 'message') { if (!text) { row.querySelector('input').focus(); return; } suffix = '/messages'; data = { chat: i.chat, text: text }; }
      else if (i.id.endsWith(':queue')) { suffix = '/queue/pause'; data = { paused: false }; }
      else { d.close(); openChat(i.project, i.chat); return; }
    }
    row.querySelectorAll('button').forEach(function(b){ b.disabled = true; });
    api('/api/projects/' + encodeURIComponent(i.project) + suffix, { method: 'POST', body: JSON.stringify(data) }).then(function(){ document.activeElement.blur(); signature = ''; refresh(true); }).catch(function(e){ toast(e.message); }).finally(function(){ row.querySelectorAll('button').forEach(function(b){ b.disabled = false; }); });
  }
  function key(e){
    if (!d.el.isConnected || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'j' || e.key === 'k') { e.preventDefault(); selected = Math.max(0, Math.min(items.length - 1, selected + (e.key === 'j' ? 1 : -1))); paint(); var row = d.body.querySelector('[data-item="' + selected + '"]'); if (row) row.focus(); }
    if (e.key === 'a' || e.key === 'd') { e.preventDefault(); act(selected, e.key === 'a'); }
  }
  document.addEventListener('keydown', key); refresh(); var timer = setInterval(refresh, WORKSPACE_POLL_MS);
  d.cleanups.push(function(){ clearInterval(timer); document.removeEventListener('keydown', key); });
}

export function openNotes(){
  var pid = state.pid, chat = state.currentChat ? state.currentChat() : state.chat || 'main';
  if (!pid) return toast('Open a project first');
  var d = dialog('Project notes', true), revision;
  var base = '/api/projects/' + encodeURIComponent(pid) + '/notes';
  d.body.innerHTML = '<div class="r4-actions"><button class="btn xs" data-read>Read</button><button class="btn xs" data-save>Save</button><button class="btn xs" data-reload>Reload</button><button class="btn xs" data-send>Send selection to chat</button></div><textarea aria-label="Project notes" placeholder="Markdown notes"></textarea><div class="r4-markdown" hidden></div><p role="status"></p>';
  var statusRequest = 0;
  var box = d.body.querySelector('textarea'), preview = d.body.querySelector('.r4-markdown'), status = d.body.querySelector('[role=status]');
  box.disabled = true;
  function load(){ var request = ++statusRequest; api(base).then(function(n){ if (!d.el.isConnected || request !== statusRequest) return; box.value = n.text; box.disabled = false; revision = n.revision; preview.innerHTML = mdToHtml(n.text); status.textContent = ''; }).catch(function(e){ if (request === statusRequest) status.textContent = e.message; }); }
  d.body.querySelector('[data-read]').onclick = function(){ preview.innerHTML = mdToHtml(box.value); box.hidden = !box.hidden; preview.hidden = !box.hidden; this.textContent = box.hidden ? 'Edit' : 'Read'; };
  d.body.querySelector('[data-save]').onclick = function(){
    var button = this; if (!revision) return; button.disabled = true; var request = ++statusRequest;
    api(base, { method: 'PUT', body: JSON.stringify({ text: box.value, revision: revision }) }).then(function(n){ revision = n.revision; if (request === statusRequest) status.textContent = 'Saved'; }).catch(function(e){ if (request === statusRequest) status.textContent = e.message; }).finally(function(){ button.disabled = false; });
  };
  d.body.querySelector('[data-reload]').onclick = load;
  d.body.querySelector('[data-send]').onclick = function(){
    var text = box.hidden ? String(window.getSelection() || '') : box.value.slice(box.selectionStart, box.selectionEnd);
    if (!text.trim()) { status.textContent = 'Select some notes first.'; return; }
    var button = this; button.disabled = true; var request = ++statusRequest;
    api('/api/projects/' + encodeURIComponent(pid) + '/messages', { method: 'POST', body: JSON.stringify({ chat: chat, text: text }) }).then(function(){ if (request === statusRequest) status.textContent = 'Sent to ' + chat; }).catch(function(e){ if (request === statusRequest) status.textContent = e.message; }).finally(function(){ button.disabled = false; });
  }; load();
}
export function openFiles(){
  var pid = state.pid, chat = state.currentChat ? state.currentChat() : state.chat || 'main';
  if (!pid) return toast('Open a chat first');
  var d = dialog('Files from this chat', true), base = '/api/projects/' + encodeURIComponent(pid) + '/chats/' + encodeURIComponent(chat) + '/files';
  api(base).then(function(j){
    if (!d.el.isConnected) return;
    d.body.innerHTML = j.files.length ? j.files.map(function(f, n){ return '<article class="r4-card" data-file="' + n + '"><b>' + esc(f.name) + '</b><p>' + esc(f.path) + '</p><small>' + esc(f.kind + ' · ' + f.direction) + '</small><div class="r4-actions"><button class="btn xs" data-open>Open</button><button class="btn xs" data-copy>Copy path</button><button class="btn xs" data-jump>Jump to message</button></div></article>'; }).join('') : '<p>No files in this chat yet.</p>';
    d.body.querySelectorAll('[data-file]').forEach(function(row){
      var f = j.files[Number(row.dataset.file)];
      row.querySelector('[data-copy]').onclick = function(){ copyText(f.path); };
      row.querySelector('[data-jump]').onclick = function(){ d.close(); openChat(pid, chat, f.eventId); };
      row.querySelector('[data-open]').onclick = function(){
        fetch(base + '/open?path=' + encodeURIComponent(f.path), { headers: { Authorization: 'Bearer ' + state.token } }).then(function(r){ if (!r.ok) throw new Error('File no longer available'); return r.blob(); }).then(function(blob){
          var url = URL.createObjectURL(blob);
          if (/^image\/(png|jpeg|gif|webp|avif)$/.test(blob.type)) {
            var view = dialog(f.name), img = document.createElement('img'); img.src = url; img.alt = f.name; img.style.maxWidth = '100%'; view.body.appendChild(img); view.cleanups.push(function(){ URL.revokeObjectURL(url); });
          } else {
            var a = document.createElement('a'); a.href = url; a.download = f.name; a.click(); setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
          }
        }).catch(function(e){ toast(e.message); });
      };
    });
  }).catch(function(e){ if (d.el.isConnected) d.body.textContent = e.message; });
}
