import { api } from '../connection.js';
import { esc } from '../format.js';
import { askText,toast } from '../notifications.js';

export function brainFiltersHtml(filters) {
  return '<form id="brain-filters" class="brain-filters">' +
    [['q','Search memories','search'],['agent','Learned by agent','text'],['since','From date','date'],['until','Through date','date']].map(function(f){
      return '<label>' + esc(f[1]) + '<input name="' + esc(f[0]) + '" type="' + esc(f[2]) + '" value="' + esc(filters[f[0]] || '') + '"></label>';
    }).join('') + '<label><input name="archived" type="checkbox"' + (filters.archived ? ' checked' : '') + '> Include archived</label><button class="btn sm">Search</button></form>';
}

export function memoryToolsHtml(memory) {
  return '<div class="brain-actions">' + (memory.stale ? '<span class="bbadge">Unused for 30 days</span>' : '') +
    '<span>' + esc(memory.scope.chat ? 'Chat: ' + memory.scope.chat : 'Project-wide') + '</span>' +
    [['pin',memory.pinned ? 'Unpin' : 'Pin'],['priority','Priority: ' + (memory.priority || 0)],['scope','Scope'],['archive',memory.archived ? 'Restore' : 'Archive'],['history','History']].map(function(a){
      return '<button type="button" class="btn xs ghost" data-memory-action="' + esc(a[0]) + '" data-id="' + esc(memory.id) + '">' + esc(a[1]) + '</button>';
    }).join('') + '</div>';
}

export function wireMemoryTools(el, view, memories, filters, refresh) {
  var base = '/api/projects/' + encodeURIComponent(view.pid) + '/brain';
  var form = el.querySelector('#brain-filters');
  form.onsubmit = function(e){
    e.preventDefault();
    ['q','agent','since','until'].forEach(function(key){ filters[key] = form.elements[key].value; });
    filters.archived = form.elements.archived.checked; refresh();
  };
  function mutate(url, body, method){ return api(base + url, { method: method || 'POST', body: JSON.stringify(body) }).then(function(result){
    if (result.file) toast("Exported " + result.file);
    else if (typeof result.added === "number") toast("Imported " + result.added + " new · " + result.known + " already known");
    refresh();
  }).catch(function(e){ toast(e.message); }); }
  el.querySelectorAll('[data-memory-action]').forEach(function(button){
    button.onclick = async function(){
      var m = memories.find(function(m){ return m.id === button.dataset.id; }); if (!m) return;
      var action = button.dataset.memoryAction, patch;
      if (action === 'pin') patch = { pinned: !m.pinned };
      if (action === 'archive') patch = { archived: !m.archived };
      if (action === 'priority') {
        var priority = await askText('Injection priority (−1000 to 1000)', { value: String(m.priority || 0), required: true });
        if (priority === null) return;
        if (!/^-?\d+$/.test(priority) || Math.abs(Number(priority)) > 1000) return toast('Enter an integer from −1000 to 1000');
        patch = { priority: Number(priority) };
      }
      if (action === 'scope') {
        var chat = await askText('Memory scope', { value: m.scope.chat || '', note: 'Chat ID, or blank for the whole project. Current chat: ' + (view.chatId || 'main') });
        if (chat === null) return;
        patch = { scope: Object.assign({}, m.scope, { chat: chat.trim() || undefined }) };
      }
      if (action === 'history') {
        try {
          var result = await api(base + '/' + encodeURIComponent(m.id) + '/history');
          var box = document.createElement('div'); box.className = 'bmem brain-history';
          box.innerHTML = '<strong>History</strong><button class="btn xs ghost" data-close>Close</button>' + result.history.map(function(h){
            return '<div><p>' + esc(h.by) + ' · ' + esc(new Date(h.ts).toLocaleString()) + ' · ' + esc(h.op) + '</p><pre>' + esc(JSON.stringify(h.patch || { text: h.text }, null, 2)) + '</pre>' +
              (h.after ? '<button class="btn xs" data-revert="' + esc(h.eventId) + '">Revert to this revision</button>' : '') + '</div>';
          }).join('');
          box.querySelector('[data-close]').onclick = function(){ box.remove(); };
          box.querySelectorAll('[data-revert]').forEach(function(b){ b.onclick = function(){ mutate('/' + encodeURIComponent(m.id) + '/revert', { eventId: Number(b.dataset.revert) }); }; });
          button.closest('.bmem').appendChild(box);
        } catch (error) { toast(error.message); }
        return;
      }
      if (patch) mutate('/' + encodeURIComponent(m.id), patch, 'PATCH');
    };
  });
  var extras = document.createElement('div'); extras.className = 'brain-extras';
  extras.innerHTML = '<div class="brain-actions"><button class="btn xs ghost" data-md>Export Markdown to repo</button><button class="btn xs ghost" data-url>Import Markdown URL</button><button class="btn xs ghost" data-why>Why was this injected?</button></div><div data-duplicates></div><div data-injections></div>';
  el.querySelector('.brain').appendChild(extras);
  extras.querySelector('[data-md]').onclick = async function(){
    var md = await askText('Export brain to Markdown', { value: 'docs/BRAIN.md', note: 'Choose a new file inside the repo. Existing files are preserved.' });
    if (md) mutate('/export', { md: md });
  };
  extras.querySelector('[data-url]').onclick = async function(){
    var url = await askText('Import a public Markdown URL', { required: true });
    if (url) mutate('/import', { url: url });
  };
  extras.querySelector('[data-why]').onclick = function(){
    api(base + '/injections?chat=' + encodeURIComponent(view.chatId || 'main')).then(function(result){
      extras.querySelector('[data-injections]').innerHTML = '<h3>Memories included in each turn</h3>' + (result.injections.length ? result.injections.slice().reverse().map(function(e){
        return '<details><summary>Turn ' + esc(e.payload.turn) + ' · ' + esc(e.agentId) + ' · ' + esc(new Date(e.ts).toLocaleString()) + '</summary>' +
          (e.payload.memories.length ? e.payload.memories.map(function(m){ return '<p>' + esc(m.text) + ' — score ' + esc(m.score.toFixed(3)) + ' · ' + esc(m.reason) + ' · priority ' + esc(m.priority) + '</p><pre>' + esc(JSON.stringify(m.detail || {}, null, 2)) + '</pre>'; }).join('') : '<p>No memories injected.</p>') + '</details>';
      }).join('') : '<p>No recorded turns yet. Native continuity uses its packet inspector.</p>');
    }).catch(function(e){ toast(e.message); });
  };
  api(base + '/duplicates').then(function(result){
    extras.querySelector('[data-duplicates]').innerHTML = result.duplicates.slice(0, 20).map(function(d, i){
      return '<div class="bconf"><strong>Possible duplicate · ' + esc(Math.round(d.similarity * 100)) + '% similar</strong><p>' + esc(d.a.text) + '</p><p>' + esc(d.b.text) + '</p><button class="btn xs" data-merge="' + esc(i) + '">Review merge</button></div>';
    }).join('');
    extras.querySelectorAll('[data-merge]').forEach(function(b){ b.onclick = async function(){
      var d = result.duplicates[Number(b.dataset.merge)];
      var text = await askText('Merge these memories', { value: d.suggestedText, multiline: true, required: true, note: 'Keep this wording and archive the other memory. Both histories remain available.' });
      if (text) mutate('/merge', { keep: d.a.id, other: d.b.id, text: text });
    }; });
  }).catch(function(e){ toast(e.message); });
}
