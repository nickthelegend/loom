import { api } from '../connection.js';
import { esc } from '../format.js';
import { askText, toast } from '../notifications.js';

export function feedbackHtml(memory, injection) {
  if (memory.source) return '<p>Source: ' + esc(memory.source.file) + ':' + esc(memory.source.line) + ' · edit the document to correct it</p>';
  return '<div class="brain-actions">' + ['helpful', 'wrong'].map(function(value){
    return '<button class="btn xs ghost" data-feedback="' + esc(value) + '" data-memory="' + esc(memory.id) + '" data-injection="' + esc(injection) + '">' + (value === 'helpful' ? 'Helpful' : 'Wrong · send to review') + '</button>';
  }).join('') + '</div>';
}

export function wireFeedback(el, base, refresh) {
  el.querySelectorAll('[data-feedback]').forEach(function(button){ button.onclick = async function(){
    button.disabled = true;
    try {
      await api(base + '/' + encodeURIComponent(button.dataset.memory) + '/feedback', { method: 'POST', body: JSON.stringify({ value: button.dataset.feedback, injection: Number(button.dataset.injection) }) });
      toast(button.dataset.feedback === 'wrong' ? 'Memory held for review' : 'Feedback saved');
      refresh();
    } catch (error) { toast(error.message); button.disabled = false; }
  }; });
}

export function mountBrainR4(el, view, refresh) {
  var base = '/api/projects/' + encodeURIComponent(view.pid) + '/brain';
  var panel = document.createElement('section'); panel.className = 'brain-extras'; panel.setAttribute('aria-label', 'Brain knowledge');
  panel.innerHTML = '<form class="brain-filters" data-ask><label>Ask the brain<input name="question" placeholder="What do we know about…?" required></label><label><input type="checkbox" name="helper"> Use helper model (optional)</label><button class="btn sm">Ask</button></form><div data-answer role="status"></div>' +
    '<details><summary>Project inbox <span data-inbox-count></span></summary><label><input type="checkbox" data-review> Review extracted memories before saving</label><div data-inbox></div></details>' +
    '<details><summary>What changed <span data-change-summary></span></summary><form class="brain-filters" data-changes-form><label>Since<input name="since" value="7d"></label><button class="btn xs">Show changes</button></form><div data-changes></div></details>' +
    '<details><summary>Teach the brain</summary><form class="brain-filters" data-teach>' + [['tests', 'How do you run tests?'], ['conventions', 'What conventions should agents follow?'], ['avoid', 'Which areas should agents leave alone?']].map(function(q){ return '<label>' + esc(q[1]) + '<input name="' + esc(q[0]) + '"></label>'; }).join('') + '<button class="btn sm">Save answers</button></form><p data-teach-result></p></details>' +
    '<details><summary>Brain packs</summary><form class="brain-filters" data-pack-save><label>Pack name<input name="name" required></label><label>Only tag (optional)<input name="tag"></label><button class="btn xs">Save pack</button></form><form class="brain-filters" data-pack-install><label>Public pack URL<input name="url" type="url"></label><label>Or pack file<input name="file" type="file" accept="application/json,.json"></label><button class="btn xs">Install pack</button></form><div data-packs></div></details>' +
    '<details><summary>Docs as knowledge</summary><form class="brain-filters" data-source-add><label>Repo document glob<input name="pattern" value="docs/**/*.md" required></label><button class="btn xs">Index documents</button></form><div data-sources></div></details>';
  el.querySelector('.brain').insertBefore(panel, el.querySelector('#brain-filters'));
  var write = (suffix, body, method) => api(base + suffix, { method: method || 'POST', body: JSON.stringify(body) });
  var report = function(error){ toast(error.message); };
  var ask = panel.querySelector('[data-ask]');
  ask.onsubmit = async function(event){
    event.preventDefault(); var button = ask.querySelector('button'); button.disabled = true;
    try {
      var result = await write('/ask', { question: ask.elements.question.value, helper: ask.elements.helper.checked, chat: view.chatId || 'main' });
      panel.querySelector('[data-answer]').innerHTML = '<p>' + esc(result.answer).replace(/\n/g, '<br>') + '</p><div class="brain-actions">' + result.citations.map(function(c){
        return '<button class="btn xs ghost" data-citation="' + esc(c.id) + '">' + esc(c.id) + (c.source ? ' · ' + esc(c.source.file) + ':' + esc(c.source.line) : '') + '</button>';
      }).join('') + '</div>';
      panel.querySelectorAll('[data-citation]').forEach(function(b){ b.onclick = function(){
        var memory = Array.from(el.querySelectorAll('[data-mid]')).find(function(row){ return row.dataset.mid === b.dataset.citation; });
        if (memory) memory.scrollIntoView({ block: 'center' }); else toast(result.citations.find(function(c){ return c.id === b.dataset.citation; }).text);
      }; });
    } catch (error) { report(error); } finally { button.disabled = false; }
  };
  function inbox() {
    return api(base + '/inbox').then(function(result){
      panel.querySelector('[data-inbox-count]').textContent = '(' + result.proposals.length + ')';
      panel.querySelector('[data-inbox]').innerHTML = result.proposals.length ? result.proposals.map(function(p){
        return '<div class="bmem"><p>' + esc(p.input.text) + '</p><p>' + esc(p.reason || '') + (p.input.untrusted ? ' · Outside content · untrusted' : '') + '</p><div class="brain-actions">' + ['approve', 'edit', 'reject'].map(function(action){
          return '<button class="btn xs" data-proposal="' + esc(p.id) + '" data-review-action="' + esc(action) + '">' + esc(action) + '</button>';
        }).join('') + '</div></div>';
      }).join('') : '<p>No memories waiting for review.</p>';
      panel.querySelectorAll('[data-review-action]').forEach(function(b){ b.onclick = async function(){
        var action = b.dataset.reviewAction, body = { action: action };
        if (action === 'edit') {
          var p = result.proposals.find(function(p){ return p.id === b.dataset.proposal; });
          var text = await askText('Edit proposal', { value: p.input.text, multiline: true, required: true });
          if (text === null) return; body.text = text;
        }
        try { await write('/inbox/' + encodeURIComponent(b.dataset.proposal), body); refresh(); } catch (error) { report(error); }
      }; });
    });
  }
  var review = panel.querySelector('[data-review]'), touched = false;
  api(base + '/settings').then(function(result){ if (!touched) review.checked = result.reviewBeforeSaving; }).catch(report);
  review.onchange = function(){
    touched = true; var checked = review.checked; review.disabled = true;
    write('/settings', { reviewBeforeSaving: checked }, 'PATCH').then(function(result){ review.checked = result.reviewBeforeSaving; })
      .catch(function(error){ review.checked = !checked; report(error); }).finally(function(){ review.disabled = false; });
  };
  inbox().catch(report);
  function changes(since) { return api(base + '/changes?since=' + encodeURIComponent(since)).then(function(result){
    panel.querySelector('[data-change-summary]').textContent = result.changes.length ? '· ' + result.changes.length + ' changes · latest: ' + result.changes[result.changes.length - 1].action : '· no changes';
    panel.querySelector('[data-changes]').innerHTML = result.changes.length ? result.changes.slice(-30).reverse().map(function(c){ return '<p>' + esc(c.action) + ' · ' + esc(c.text) + ' <small>' + esc(c.id) + ' · ' + esc(new Date(c.ts).toLocaleString()) + '</small></p>'; }).join('') : '<p>No memory changes in this period.</p>';
  }); }
  changes('7d').catch(report);
  panel.querySelector('[data-changes-form]').onsubmit = function(event){ event.preventDefault(); changes(event.target.elements.since.value).catch(report); };
  panel.querySelector('[data-teach]').onsubmit = async function(event){
    event.preventDefault(); var form = event.target, answers = {};
    ['tests', 'conventions', 'avoid'].forEach(function(key){ if (form.elements[key].value.trim()) answers[key] = form.elements[key].value.trim(); });
    try { var result = await write('/teach', answers); toast('Saved ' + result.memories.length + ' interview answers'); refresh(); } catch (error) { report(error); }
  };
  function download(doc) {
    var a = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
    a.href = url; a.download = doc.pack + '.json'; a.click(); setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }
  api(base + '/packs').then(function(result){
    panel.querySelector('[data-packs]').innerHTML = result.packs.map(function(p, i){ return '<p>' + esc(p.name) + ' · ' + esc(p.installed) + ' installed <button class="btn xs ghost" data-pack-rm="' + esc(p.name) + '">Remove pack</button>' + (p.saved ? '<button class="btn xs ghost" data-pack-download="' + esc(i) + '">Download</button>' : '') + '</p>'; }).join('');
    panel.querySelectorAll('[data-pack-rm]').forEach(function(b){ b.onclick = function(){ write('/packs/' + encodeURIComponent(b.dataset.packRm), {}, 'DELETE').then(refresh).catch(report); }; });
    panel.querySelectorAll('[data-pack-download]').forEach(function(b){ b.onclick = function(){ download(result.packs[Number(b.dataset.packDownload)].saved); }; });
  }).catch(report);
  panel.querySelector('[data-pack-save]').onsubmit = function(event){ event.preventDefault(); var f = event.target; write('/packs', { name: f.elements.name.value, ...(f.elements.tag.value ? { tag: f.elements.tag.value } : {}) }).then(function(){ refresh(); }).catch(report); };
  panel.querySelector('[data-pack-install]').onsubmit = async function(event){
    event.preventDefault(); var f = event.target, file = f.elements.file.files[0];
    try {
      if (file && file.size > 1_000_000) throw new Error('Pack files must be at most 1 MB');
      var body = file ? { pack: JSON.parse(await file.text()) } : { url: f.elements.url.value };
      await write('/packs/install', body); refresh();
    } catch (error) { report(error); }
  };
  api(base + '/sources').then(function(result){
    panel.querySelector('[data-sources]').innerHTML = result.sources.map(function(s){ return '<p>' + esc(s.pattern) + ' · ' + esc(s.chunks) + ' read-only chunks ' + ['refresh', 'rm'].map(function(action){ return '<button class="btn xs ghost" data-source="' + esc(s.pattern) + '" data-source-action="' + esc(action) + '">' + (action === 'rm' ? 'Remove' : 'Refresh') + '</button>'; }).join('') + '</p>'; }).join('');
    panel.querySelectorAll('[data-source-action]').forEach(function(b){ b.onclick = function(){ write('/sources', { action: b.dataset.sourceAction, pattern: b.dataset.source }).then(refresh).catch(report); }; });
  }).catch(report);
  panel.querySelector('[data-source-add]').onsubmit = function(event){ event.preventDefault(); write('/sources', { action: 'add', pattern: event.target.elements.pattern.value }).then(refresh).catch(report); };
}
