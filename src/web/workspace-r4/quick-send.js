import { api } from '../connection.js';
import { esc } from '../format.js';
import { dialog } from './panels.js';

export function quickSend(){
  var d = dialog('Quick send');
  d.body.innerHTML = '<label>Project<select data-project></select></label><label>Chat<select data-chat></select></label><textarea aria-label="Quick message" placeholder="Message" rows="4"></textarea><button class="btn" data-send>Send</button><p role="status"></p>';
  var project = d.body.querySelector('[data-project]'), chat = d.body.querySelector('[data-chat]'), text = d.body.querySelector('textarea'), status = d.body.querySelector('[role=status]');
  var generation = 0;
  function chats(){ var gen = ++generation; chat.innerHTML = ''; api('/api/projects/' + encodeURIComponent(project.value) + '/chats').then(function(j){ if (gen !== generation || !d.el.isConnected) return; chat.innerHTML = j.chats.map(function(c){ return '<option value="' + esc(c.id) + '">' + esc(c.title || c.id) + '</option>'; }).join(''); }).catch(function(e){ status.textContent = e.message; }); }
  project.onchange = chats;
  api('/api/projects').then(function(j){ if (!d.el.isConnected) return; project.innerHTML = j.projects.map(function(p){ return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join(''); if (j.projects.length) chats(); else status.textContent = 'Add a project in Loom first.'; }).catch(function(e){ status.textContent = e.message; });
  d.body.querySelector('[data-send]').onclick = function(){
    var pid = project.value, cid = chat.value, message = text.value.trim(), button = this;
    if (!pid || !cid || !message) return; button.disabled = true;
    api('/api/projects/' + encodeURIComponent(pid) + '/messages', { method: 'POST', body: JSON.stringify({ chat: cid, text: message }) }).then(function(){ if (text.value.trim() === message) text.value = ''; status.textContent = 'Sent'; }).catch(function(e){ status.textContent = e.message; }).finally(function(){ button.disabled = false; });
  };
}
