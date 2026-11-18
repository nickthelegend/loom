import { api } from '../connection.js';
import { copyText } from '../clipboard.js';
import { esc } from '../format.js';
import { toast } from '../notifications.js';
import { openMenu } from '../menus.js';
import { state } from '../state.js';

export function createChatComposer(view) {
  var base = '/api/projects/' + encodeURIComponent(view.pid) + '/chats/' + encodeURIComponent(view.chat);
  var pins = [], expanded = {}, revision = 0, draftLoad, writes = Promise.resolve(), blocked = false;
  var initialBox, initialValue;
  function here(){ return typeof document !== 'undefined' && document && state.pid === view.pid && state.chat === view.chat && document.getElementById('box') === initialBox; }
  function loadDraft(){
    if (draftLoad) return draftLoad;
    initialBox = document.getElementById('box'); initialValue = initialBox ? initialBox.value : '';
    draftLoad = api(base + '/draft').then(function(j){
      revision = j.revision;
      if (here() && initialBox.value === initialValue) {
        initialBox.value = j.revision ? j.draft : initialValue;
        view.resize();
        var form = document.getElementById('cform'); if (form) form.classList.toggle('hastext', !!initialBox.value.trim());
        if (!j.revision && initialValue) saveDraft(initialValue);
      }
    }).catch(function(err){ blocked = true; toast('Draft sync: ' + err.message); });
    return draftLoad;
  }
  function saveDraft(text){
    var ready = loadDraft();
    writes = writes.then(function(){ return ready; }).then(function(){
      if (blocked) return;
      return api(base + '/draft', { method: 'PUT', body: JSON.stringify({ draft: text, revision: revision }) }).then(function(j){ revision = j.revision; });
    }).catch(function(err){ blocked = true; toast('Draft kept locally. ' + err.message); });
  }
  function paintExpanded(){
    if (!here()) return;
    document.querySelectorAll('#feed .tool[data-event-id]').forEach(function(el){
      var id = el.getAttribute('data-event-id');
      if (Object.prototype.hasOwnProperty.call(expanded, id)) el.classList.toggle('open', expanded[id]);
      if (expanded[id]) { var group = el.closest('details.acts'); if (group) group.open = true; }
    });
  }
  function refresh(){
    return Promise.all([api(base + '/pins'), api(base + '/presentation')]).then(function(rows){
      if (!here()) return;
      pins = rows[0].pins || []; expanded = rows[1].expanded || {};
      var host = document.getElementById('chat-pins');
      if (host) {
        host.innerHTML = pins.map(function(e){ return '<button class="btn xs ghost" data-pin="' + Number(e.id) + '" title="Go to pinned message">Pinned · ' + esc(String(e.payload.text || '').slice(0, 100)) + '</button>'; }).join('');
        host.querySelectorAll('[data-pin]').forEach(function(b){ b.onclick = function(){ view.jump(Number(b.getAttribute('data-pin'))); }; });
      }
      var totals = document.getElementById('chat-totals'), t = rows[1];
      if (totals) totals.textContent = '$' + Number(t.costUsd).toFixed(4) + ' · ' + t.tokens + ' tokens · ' + t.turns + ' turns';
      paintExpanded();
    }).catch(function(err){ if (here()) toast(err.message); });
  }
  function toggleTool(id, open){
    expanded[id] = open;
    api(base + '/presentation', { method: 'PUT', body: JSON.stringify({ eventId: id, expanded: open }) }).catch(function(err){ toast(err.message); });
  }
  function messageItems(id){
    return [
      { label: pins.some(function(e){ return e.id === id; }) ? 'Unpin message' : 'Pin message', run: function(){
        api(base + '/pins', { method: pins.some(function(e){ return e.id === id; }) ? 'DELETE' : 'POST', body: JSON.stringify({ eventId: id }) }).then(refresh).catch(function(err){ toast(err.message); });
      } },
      { label: 'Copy as Markdown', run: function(){ api(base + '/markdown?eventId=' + id).then(function(j){ copyText(j.markdown); }).catch(function(err){ toast(err.message); }); } },
      { label: 'Quote reply', run: function(){ api(base + '/markdown?eventId=' + id).then(function(j){
        if (!here()) return;
        var box = document.getElementById('box'); box.value = j.quote + box.value; view.resize(); view.save(); box.focus();
      }).catch(function(err){ toast(err.message); }); } },
    ];
  }
  function bookmarks(){
    api('/api/projects/' + encodeURIComponent(view.pid) + '/bookmarks').then(function(j){
      openMenu(100, 90, [{ head: 'Bookmarks' }].concat(j.bookmarks.map(function(b){
        return { label: b.title + ' · ' + String(b.event.payload.text || '').slice(0, 100), run: function(){
          if (b.chat === view.chat) view.jump(b.event.id);
          else location.hash = '#p/' + encodeURIComponent(view.pid) + '/c/' + encodeURIComponent(b.chat) + '/m/' + b.event.id;
        } };
      }), j.bookmarks.length ? [] : [{ head: 'No bookmarks yet' }]));
    }).catch(function(err){ toast(err.message); });
  }
  function copyChat(){ api(base + '/markdown').then(function(j){ copyText(j.markdown); toast('Chat Markdown copied'); }).catch(function(err){ toast(err.message); }); }
  return { loadDraft, saveDraft, refresh, toggleTool, paintExpanded, messageItems, bookmarks, copyChat };
}

/** Named saved prompts use the same library as Prompts; every placeholder gets a field. */
export function useTemplate(name, insert){
  return api('/api/templates').then(function(j){
    var p = j.templates.find(function(t){ return t.title.toLowerCase() === name.toLowerCase() || t.id === name; });
    if (!p) throw new Error('No template named ' + name + '. Save one in Prompts.');
    var scrim = document.createElement('div'); scrim.className = 'scrim';
    scrim.innerHTML = '<form class="modal template-form" role="dialog" aria-label="Template variables"><h3>' + esc(p.title) + '</h3>' +
      p.variables.map(function(v, i){ return '<label class="field">' + esc(v) + '<input name="v' + i + '" required autocomplete="off"></label>'; }).join('') +
      '<button class="btn" type="submit">Use template</button> <button class="btn ghost" type="button" data-cancel>Cancel</button></form>';
    document.body.appendChild(scrim);
    scrim.querySelector('[data-cancel]').onclick = function(){ scrim.remove(); };
    scrim.onclick = function(e){ if (e.target === scrim) scrim.remove(); };
    scrim.onkeydown = function(e){ if (e.key === 'Escape') scrim.remove(); };
    scrim.querySelector('form').onsubmit = function(e){
      e.preventDefault(); var values = {};
      p.variables.forEach(function(v, i){ Object.defineProperty(values, v, { value: scrim.querySelector('[name="v' + i + '"]').value, enumerable: true }); });
      api('/api/templates/' + encodeURIComponent(p.id) + '/render', { method: 'POST', body: JSON.stringify({ values: values }) }).then(function(r){ scrim.remove(); insert(r.text); }).catch(function(err){ toast(err.message); });
    };
    var first = scrim.querySelector('input,button'); if (first) first.focus();
  }).catch(function(err){ toast(err.message); });
}
