import { workspaceNative } from "./native.js";
import { isGuest } from "../share-live.js";
import { api } from '../connection.js';
import { esc } from '../format.js';
import { state } from '../state.js';
import { toast,askText } from '../notifications.js';
import { loadWorkspace,saveWorkspace,newPaneId } from '../splits.js';
import { inWorkspace,paneId } from '../workspace.js';
import { dialog,chatLink,openChat } from './panels.js';

export function captureLayout(){
  var split = inWorkspace() || paneId() && window.parent !== window ? loadWorkspace() : null;
  if (split) return split;
  if (!state.pid) throw new Error('Open a chat first');
  var id = newPaneId(), chat = state.currentChat ? state.currentChat() : state.chat || 'main';
  return { layout: { id: id }, panes: { [id]: { hash: chatLink(state.pid, chat) } }, focus: id };
}
export function reopenLayout(layout){
  saveWorkspace(layout.workspace);
  var target = paneId() && window.parent !== window ? window.parent : window;
  target.location.href = '/app?split=1';
}
export function openLayouts(){
  var d = dialog('Saved layouts'), prefs;
  function refresh(){ api('/api/workspace').then(function(p){ prefs = p; draw(); }).catch(function(e){ d.body.textContent = e.message; }); }
  function draw(){
    if (!d.el.isConnected) return;
    d.body.innerHTML = '<button class="btn" data-save>Save current layout</button>' + prefs.layouts.map(function(l, i){ return '<div class="r4-card" data-layout="' + i + '"><button class="btn" data-open>' + esc(l.name) + '</button><button class="btn xs" data-remove>Delete</button><small>' + Object.keys(l.workspace.panes).length + ' panes</small></div>'; }).join('');
    d.body.querySelector('[data-save]').onclick = function(){
      var workspace; try { workspace = captureLayout(); } catch (e) { return toast(e.message); }
      askText('Name this layout', { value: '' }).then(function(name){ if (name) api('/api/workspace', { method: 'PUT', body: JSON.stringify({ revision: prefs.revision, save: { name: name, workspace: workspace } }) }).then(function(p){ prefs = p; draw(); }).catch(function(e){ toast(e.message); refresh(); }); });
    };
    d.body.querySelectorAll('[data-layout]').forEach(function(row){ var l = prefs.layouts[Number(row.dataset.layout)];
      row.querySelector('[data-open]').onclick = function(){ reopenLayout(l); };
      row.querySelector('[data-remove]').onclick = function(){ api('/api/workspace', { method: 'PUT', body: JSON.stringify({ revision: prefs.revision, remove: l.name }) }).then(function(p){ prefs = p; draw(); }).catch(function(e){ toast(e.message); refresh(); }); };
    });
  } refresh();
}
export function popChat(){
  if (!state.pid) return toast('Open a chat first');
  var chat = state.currentChat ? state.currentChat() : state.chat || 'main';
  var url = '/app?pane=popout-' + Date.now().toString(36) + '&popout=1' + chatLink(state.pid, chat);
  var native = workspaceNative();
  if (native && native.popChat) native.popChat(url).catch(function(e){ toast(e.message); });
  else if (!window.open(url, '_blank', 'popup,width=820,height=720')) toast('Allow popups to open this chat');
}
export function recentChats(){ try { return JSON.parse(localStorage.getItem('loomR4Recent') || '[]').filter(function(c){ return c && typeof c.project === 'string' && typeof c.chat === 'string'; }).slice(0, 40); } catch (e) { return []; } }
export function recordChat(projectId, chatId){
  var pid = projectId || state.pid;
  if (!pid) return;
  var chat = chatId || (state.currentChat ? state.currentChat() : state.chat || 'main');
  var project = (state.projects || []).find(function(p){ return p.id === pid; });
  var c = project && (project.chats || []).find(function(c){ return c.id === chat; });
  var row = { project: pid, chat: chat, title: c && c.title || chat, projectName: project && project.name || state.pid };
  var all = recentChats().filter(function(c){ return c.project !== row.project || c.chat !== row.chat; });
  all.unshift(row); try { localStorage.setItem('loomR4Recent', JSON.stringify(all.slice(0, 40))); } catch (e) {}
}
export function installRecentSwitcher(){
  var popup = null, choices = [], index = 0, request = 0;
  function finish(commit){
    if (!popup) return; var c = choices[index]; popup.remove(); popup = null; request++;
    if (commit && c) openChat(c.project, c.chat);
  }
  function draw(){
    popup.innerHTML = '<div role="listbox" aria-label="Recent chats">' + choices.map(function(c, n){ return '<button class="r4-recent-row' + (n === index ? ' selected' : '') + '" role="option" aria-selected="' + (n === index) + '" data-recent="' + n + '">' + esc(c.projectName + ' · ' + c.title) + '</button>'; }).join('') + '</div><p class="r4-preview">Loading preview…</p>';
    popup.querySelectorAll('[data-recent]').forEach(function(b){ b.onclick = function(){ index = Number(b.dataset.recent); finish(true); }; });
    var c = choices[index], seq = ++request;
    api('/api/projects/' + encodeURIComponent(c.project) + '/chats/' + encodeURIComponent(c.chat) + '/messages?limit=1').then(function(j){ if (popup && seq === request) popup.querySelector('.r4-preview').textContent = j.messages.length ? String(j.messages[0].payload.text || '').slice(-300) : 'No messages yet'; }).catch(function(e){ if (popup && seq === request) popup.querySelector('.r4-preview').textContent = e.message; });
  }
  document.addEventListener('keydown', function(e){
    if (e.ctrlKey && e.key === 'Tab' && !e.altKey && !e.metaKey && !e.isComposing) {
      if (!state.token || isGuest()) return; e.preventDefault(); e.stopImmediatePropagation();
      if (!popup) {
        recordChat(); choices = recentChats(); if (!choices.length) return;
        index = 0; popup = document.createElement('div'); popup.className = 'r4-switcher'; document.body.appendChild(popup);
      }
      index = (index + (e.shiftKey ? -1 : 1) + choices.length) % choices.length; draw();
    } else if (popup && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); }
  }, true);
  document.addEventListener('keyup', function(e){ if (e.key === 'Control') finish(true); }, true);
  window.addEventListener('blur', function(){ finish(false); });
}

export function mountOrganisation(list){
  var prefs = null, dead = false, last = '', applying = false;
  function load(){ api('/api/workspace').then(function(p){ if (dead) return; prefs = p; apply(); }).catch(function(){}); }
  function save(sidebar){ api('/api/workspace', { method: 'PUT', body: JSON.stringify({ revision: prefs.revision, sidebar: sidebar }) }).then(function(p){ prefs = p; last = ''; apply(); }).catch(function(e){ toast(e.message); load(); }); }
  function apply(){
    if (!prefs || !list.isConnected || applying) return;
    var rows = Array.from(list.querySelectorAll(':scope > .sgroup'));
    var key = JSON.stringify(prefs.sidebar) + rows.map(function(r){ return r.querySelector('[data-id]')?.dataset.id; }).join(',');
    if (key === last && list.querySelector('[data-r4-organise]')) return;
    applying = true;
    list.querySelectorAll('[data-r4-group],[data-r4-organise]').forEach(function(e){ e.remove(); });
    var data = prefs.sidebar;
    function meta(id){ return data.projects.find(function(p){ return p.id === id; }) || { id: id, pinned: false, section: null }; }
    rows.sort(function(a,b){
      var x = meta(a.querySelector('[data-id]').dataset.id), y = meta(b.querySelector('[data-id]').dataset.id);
      if (x.pinned !== y.pinned) return x.pinned ? -1 : 1;
      var xi = data.projects.findIndex(function(p){ return p.id === x.id; }), yi = data.projects.findIndex(function(p){ return p.id === y.id; });
      return (xi < 0 ? 10000 : xi) - (yi < 0 ? 10000 : yi);
    });
    var groups = [{ id: 'pinned', name: 'Pinned' }].concat(data.sections).concat([{ id: '', name: 'Projects' }]);
    groups.forEach(function(g){
      var members = rows.filter(function(r){ var m = meta(r.querySelector('[data-id]').dataset.id); return (m.pinned ? 'pinned' : m.section || '') === g.id; });
      if (!members.length && !g.id) return;
      if (!members.length && g.id === 'pinned') return;
      var head = document.createElement('button'); head.className = 'stitle r4-section'; head.dataset.r4Group = g.id; head.textContent = (g.collapsed ? '▸ ' : '▾ ') + g.name; head.setAttribute('aria-expanded', String(!g.collapsed)); list.appendChild(head);
      head.onclick = function(){ if (g.id === 'pinned' || !g.id) return; var next = JSON.parse(JSON.stringify(data)); next.sections.find(function(s){ return s.id === g.id; }).collapsed = !g.collapsed; save(next); };
      members.forEach(function(row){
        var id = row.querySelector('[data-id]').dataset.id, m = meta(id); row.hidden = !!g.collapsed; list.appendChild(row);
        var top = row.querySelector('.srow'); if (!top) return;
        top.draggable = true;
        top.ondragstart = function(e){ if (e.target !== top && e.target.closest('.crow')) return; e.dataTransfer.setData('application/x-loom-project', id); e.dataTransfer.effectAllowed = 'move'; };
        top.ondragover = function(e){ if (Array.from(e.dataTransfer.types).includes('application/x-loom-project')) e.preventDefault(); };
        top.ondrop = function(e){
          var source = e.dataTransfer.getData('application/x-loom-project'); if (!source || source === id) return; e.preventDefault(); e.stopPropagation();
          var next = JSON.parse(JSON.stringify(data)), ids = rows.map(function(r){ return r.querySelector('[data-id]').dataset.id; }).filter(function(k){ return k !== source; }); ids.splice(ids.indexOf(id), 0, source);
          next.projects = ids.map(function(k){ var p = Object.assign({}, meta(k)); if (k === source) { p.section = m.section; p.pinned = m.pinned; } return p; }); save(next);
        };
      });
    });
    var button = document.createElement('button'); button.className = 'btn xs'; button.dataset.r4Organise = '1'; button.textContent = 'Organise projects'; button.onclick = function(){ edit(); }; list.appendChild(button);
    last = JSON.stringify(prefs.sidebar) + Array.from(list.querySelectorAll(':scope > .sgroup')).map(function(r){ return r.querySelector('[data-id]')?.dataset.id; }).join(','); applying = false;
  }
  function edit(){
    var d = dialog('Organise projects'), next = JSON.parse(JSON.stringify(prefs.sidebar));
    function draw(){
      d.body.innerHTML = '<button class="btn xs" data-add>Add section</button>' + next.sections.map(function(s, n){ return '<div class="r4-actions"><input data-section="' + n + '" aria-label="Section name" value="' + esc(s.name) + '"><button class="btn xs" data-delete="' + n + '">Remove section</button></div>'; }).join('') + (state.projects || []).map(function(p){
        var m = next.projects.find(function(r){ return r.id === p.id; }); if (!m) { m = { id: p.id, pinned: false, section: null }; next.projects.push(m); }
        return '<div class="r4-card" data-project="' + esc(p.id) + '"><b>' + esc(p.name) + '</b><label><input type="checkbox"' + (m.pinned ? ' checked' : '') + '>Pinned</label><select aria-label="Section for ' + esc(p.name) + '"><option value="">Projects</option>' + next.sections.map(function(s){ return '<option value="' + esc(s.id) + '"' + (s.id === m.section ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select></div>';
      }).join('') + '<button class="btn" data-save>Save organisation</button>';
      d.body.querySelector('[data-add]').onclick = function(){ next.sections.push({ id: 'section-' + Date.now().toString(36), name: 'New section', collapsed: false }); draw(); };
      d.body.querySelectorAll('[data-section]').forEach(function(i){ i.oninput = function(){ next.sections[Number(i.dataset.section)].name = i.value; }; });
      d.body.querySelectorAll('[data-delete]').forEach(function(b){ b.onclick = function(){ var removed = next.sections.splice(Number(b.dataset.delete), 1)[0]; next.projects.forEach(function(p){ if (p.section === removed.id) p.section = null; }); draw(); }; });
      d.body.querySelectorAll('[data-project]').forEach(function(row){ var m = next.projects.find(function(p){ return p.id === row.dataset.project; }); row.querySelector('input').onchange = function(){ m.pinned = this.checked; }; row.querySelector('select').onchange = function(){ m.section = this.value || null; }; });
      d.body.querySelector('[data-save]').onclick = function(){ save(next); d.close(); };
    } draw();
  }
  var observer = new MutationObserver(apply); observer.observe(list, { childList: true }); load(); var poll = setInterval(load, 3000);
  return function(){ dead = true; observer.disconnect(); clearInterval(poll); };
}
