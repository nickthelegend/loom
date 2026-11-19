import { api } from '../connection.js';
import { esc, mdToHtml } from '../format.js';
import { state } from '../state.js';
import { toast } from '../notifications.js';
import { startFeatureTour, tourProgress } from './tours.js';
import { openStartupDialog } from '../startup-dialogs.js';

// Capture prior use before this startup writes its own setup/tour preferences.
var usedBefore = false;
try { usedBefore = Object.keys(localStorage).some(function(key) { return key.startsWith('loom') && !/token/i.test(key) && key !== 'loomReleaseSeen'; }); } catch (e) {}

export function helpDialog(title) {
  var previous = document.activeElement;
  var scrim = document.createElement('div'); scrim.className = 'scrim r4help';
  scrim.innerHTML = '<section class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="modalhead">' + esc(title) + '<button class="iconbtn" aria-label="Close help">×</button></div><div class="modalbody r4body"></div></section>';
  function close() { var connected = scrim.isConnected; scrim.remove(); document.removeEventListener('keydown', key, true); if (connected && previous && previous.isConnected) previous.focus(); }
  function key(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      var fields = Array.from(scrim.querySelectorAll('button:not(:disabled),input,select,a[href]'));
      if (!fields.length) return;
      if (e.shiftKey && document.activeElement === fields[0]) { e.preventDefault(); fields[fields.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === fields[fields.length - 1]) { e.preventDefault(); fields[0].focus(); }
    }
  }
  document.addEventListener('keydown', key, true);
  scrim.querySelector('.iconbtn').onclick = close;
  scrim.onclick = function(e) { if (e.target === scrim) close(); };
  document.body.appendChild(scrim); scrim.querySelector('button').focus();
  return { body: scrim.querySelector('.r4body'), close: close, scrim: scrim };
}
export function runHelpCommand(id) { if (id !== 'help') return false; openHelp(); return true; }
export function openHelp(topic) {
  var dlg = helpDialog('Help');
  dlg.body.innerHTML = '<label>Search guides<input type="search" data-help-search placeholder="Search help" /></label><div class="r4actions"><button class="btn sm" data-whatsnew>What’s new</button></div><div data-help-results>Loading guides…</div><h3>Feature tours</h3><div data-tours class="r4actions"></div>';
  dlg.body.querySelector('[data-whatsnew]').onclick = function() { dlg.close(); openWhatsNew(); };
  var all = [], tours = [];
  function draw(q) {
    var words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    var filtered = all.filter(function(g) { return words.every(function(w) { return (g.title + ' ' + g.body).toLowerCase().includes(w); }); });
    dlg.body.querySelector('[data-help-results]').innerHTML = filtered.length ? filtered.map(function(g) {
      return '<details' + (topic === g.id ? ' open' : '') + '><summary>' + esc(g.title) + '</summary><div class="r4guide">' + mdToHtml(g.body) + '</div></details>';
    }).join('') : '<p>No guides match. Try “memory” or “templates”.</p>';
  }
  api('/api/help').then(function(r) {
    if (!dlg.scrim.isConnected) return;
    all = r.guides; tours = r.tours; draw('');
    dlg.body.querySelector('[data-tours]').innerHTML = tours.map(function(t) { return '<button class="btn sm" data-tour="' + esc(t.id) + '">' + esc(t.title) + ' · ' + esc(tourProgress(t.id) >= t.steps.length ? 'Replay' : tourProgress(t.id) ? 'Resume' : 'Start') + '</button><button class="btn xs ghost" data-replay="' + esc(t.id) + '">Restart ' + esc(t.title) + '</button>'; }).join('');
    dlg.body.querySelectorAll('[data-tour],[data-replay]').forEach(function(b) { b.onclick = function() { var id = b.dataset.tour || b.dataset.replay; var t = tours.find(function(t) { return t.id === id; }); dlg.close(); startFeatureTour(t, Boolean(b.dataset.replay) || tourProgress(id) >= t.steps.length); }; });
  }).catch(function(e) { dlg.body.querySelector('[data-help-results]').textContent = e.message; });
  var search = dlg.body.querySelector('[data-help-search]'); search.oninput = function() { draw(search.value); }; search.focus();
}
export function openWhatsNew(release) {
  return (release ? Promise.resolve(release) : api('/api/help/whatsnew')).then(showWhatsNew).catch(function(e) { toast(e.message); });
}
function showWhatsNew(r) {
  var dlg = helpDialog('What’s new · Loom ' + r.version);
  dlg.body.innerHTML = r.highlights.map(function(h, i) { return '<article><p>' + esc(h.text) + '</p><button class="btn sm" data-highlight="' + i + '">Show me</button></article>'; }).join('');
  dlg.body.querySelectorAll('[data-highlight]').forEach(function(b) { b.onclick = function() { var h = r.highlights[Number(b.dataset.highlight)]; dlg.close(); openHelp(h.topic); }; });
  try { localStorage.setItem('loomReleaseSeen', r.version); } catch (e) {}
  return dlg.close;
}
export function checkWhatsNew() {
  return api('/api/help/whatsnew').then(function(r) {
    var previous; try { previous = localStorage.getItem('loomReleaseSeen'); } catch (e) { return; }
    // Existing devices predate release tracking in 2.2; their baseline is 2.1,
    // so running that same version is not an update.
    if (!previous && usedBefore) previous = '2.1.0';
    if ((!previous && !usedBefore) || previous === r.version) { localStorage.setItem('loomReleaseSeen', r.version); return; }
    function show() {
      if ((state.demoTourWanted && state.demoTourWanted()) || !openStartupDialog(function(){ return showWhatsNew(r); })) setTimeout(show, 1000);
    }
    show();
  }).catch(function() {});
}
export function mountExamples(el, openProject) {
  var box = document.createElement('section'); box.className = 'hcard r4examples'; box.innerHTML = '<h3>Examples library</h3><p>Recipes, fleets, triggers and prompts you can inspect and install.</p><div data-examples>Loading…</div><h3>Offline demo scenarios</h3><div class="r4actions">' + ['fleet','review','memory'].map(function(s) { return '<button class="btn sm" data-scenario="' + esc(s) + '">' + esc(s) + '</button>'; }).join('') + '</div>';
  el.appendChild(box);
  api('/api/help/examples').then(function(r) {
    box.querySelector('[data-examples]').innerHTML = r.examples.map(function(e) { return '<article><b>' + esc(e.title) + '</b><p>' + esc(e.description) + '</p>' + (e.kind === 'trigger' ? '<label>Project<select data-example-project>' + (state.projects || []).map(function(p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('') + '</select></label>' : '') + '<button class="btn sm" data-example="' + esc(e.name) + '" data-kind="' + esc(e.kind) + '">Install example</button><span role="status"></span></article>'; }).join('');
    box.querySelectorAll('[data-example]').forEach(function(b) { b.onclick = function() {
      var project = b.closest('article').querySelector('select');
      if (project && !project.value) { toast('Create or open a project first.'); return; }
      var route = project ? '/api/projects/' + encodeURIComponent(project.value) + '/examples/' : '/api/help/examples/';
      b.disabled = true;
      api(route + encodeURIComponent(b.dataset.example) + '/install', { method: 'POST', body: '{}' }).then(function(r) { b.nextElementSibling.textContent = r.installed ? ' Installed' : ' Already installed'; }).catch(function(e) { b.nextElementSibling.textContent = e.message; }).finally(function() { b.disabled = false; });
    }; });
  }).catch(function(e) { box.querySelector('[data-examples]').textContent = e.message; });
  box.querySelectorAll('[data-scenario]').forEach(function(b) { b.onclick = function() {
    b.disabled = true;
    api('/api/try', { method: 'POST', body: '{}' }).then(function(r) { var pid = r.project.id;
      return api('/api/projects/' + encodeURIComponent(pid) + '/demo-scenarios/' + b.dataset.scenario, { method: 'POST', body: '{}' }).then(function(result) { var chat = result.chat || (result.review && result.review.chat) || (result.run && result.run.chat); if (chat) { try { localStorage.setItem('loomChat:' + pid, chat); } catch (e) {} } if (openProject) openProject(pid); else location.hash = '#p/' + pid + (chat ? '/c/' + chat : ''); toast('Offline ' + result.scenario + ' demo started'); });
    }).catch(function(e) { toast(e.message); }).finally(function() { b.disabled = false; });
  }; });
}
