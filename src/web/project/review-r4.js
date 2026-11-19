import { diffBody } from "../diff.js";
import { api } from '../connection.js';
import { esc } from '../format.js';
import { toast, askConfirm } from '../notifications.js';
import { state } from '../state.js';

var panels = new Map();
function root(pid){ return '/api/projects/' + encodeURIComponent(pid); }
function send(pid, route, body, method){ return api(root(pid) + route, { method: method || 'POST', body: JSON.stringify(body) }); }
function button(text, action){ return '<button type="button" class="btn sm" data-r4="' + esc(action) + '">' + esc(text) + '</button>'; }
export function r4Html(pid, chat){
  return '<details class="scmcommit" data-r4-panel data-pid="' + esc(pid) + '" data-chat="' + esc(chat) + '"><summary>Review changes</summary><div data-r4-conflicts></div>' +
    '<label>Run <select data-r4-run-select><option value="">This chat</option></select></label>' + button('Open review diff', 'open-review') + '<div data-r4-run-diff></div>' +
    '<label>Agent <input data-r4-agent placeholder="Project default"></label>' +
    '<label>Conflict branch (optional)<input data-r4-conflict-branch placeholder="Branch from Apply or land"></label>' + button('Resolve with agent', 'resolve') +
    '<label>Verify before commit <input data-r4-verify placeholder="e.g. npm test"></label>' + button('Save verification', 'save-verify') + button('Run verification', 'verify') + button('Send failure to agent', 'verify-agent') + '<pre data-r4-output></pre>' +
    '<label>Split model (optional)<input data-r4-split-model></label>' + button('Propose split commits', 'split') + '<div data-r4-groups></div>' +
    '<label>PR number or URL <input data-r4-pr></label>' + button('Review pull request', 'pr') + button('Load saved PR reviews', 'pr-list') + '<div data-r4-pr-list></div><div data-r4-draft></div></details>';
}
export function bindR4Panel(host, pid, chat){
  var panel = host.matches && host.matches('[data-r4-panel]') ? host : host.querySelector('[data-r4-panel]'); if (!panel) return;
  var key = pid + '/' + chat, cached = panels.get(key);
  if (cached && cached !== panel) { panel.replaceWith(cached); return; }
  if (panel.dataset.bound) return;
  panel.dataset.bound = '1'; panels.set(key, panel);
  if (panels.size > 20) panels.delete(panels.keys().next().value);
  var alive = function(){ return panel.isConnected; }, proposal;
  var agent = function(){ return panel.querySelector('[data-r4-agent]').value || undefined; };
  var output = panel.querySelector('[data-r4-output]');
  api(root(pid) + '/orchestra').then(function(r){
    if (!alive()) return;
    panel.querySelector('[data-r4-run-select]').innerHTML += (r.runs || []).map(function(run){ return '<option value="' + esc(run.id) + '">' + esc(run.goal) + '</option>'; }).join('');
    if (state.r4Run && (r.runs || []).some(function(run){ return run.id === state.r4Run; })) { panel.querySelector('[data-r4-run-select]').value = state.r4Run; state.r4Run = undefined; panel.open = true; panel.querySelector('[data-r4="open-review"]').click(); }
  }).catch(function(){});
  function config(){
    api(root(pid) + '/git/verify').then(function(r){ if (!alive()) return; panel.querySelector('[data-r4-verify]').value = r.verify || ''; output.textContent = r.last ? (r.last.ok ? 'Passed\n' : 'Commit held\n') + r.last.output : ''; }).catch(function(e){ if (alive()) output.textContent = e.message; });
    api(root(pid) + '/git/conflicts').then(function(r){
      if (!alive()) return;
      var box = panel.querySelector('[data-r4-conflicts]');
      box.innerHTML = (r.files.length ? 'Conflicts in ' + r.files.length + ' files · ' + button('Resolve with agent', 'resolve-current') : '') +
        (r.waitingForReview ? '<p>Resolution waits for your review and manual commit. ' + button('Release hold', 'release-hold') + '</p>' : '');
      if (r.files.length || r.waitingForReview) panel.open = true;
    }).catch(function(){});
  }
  function openChat(r){ if (r.chat) location.hash = '#p/' + encodeURIComponent(pid) + '/c/' + encodeURIComponent(r.chat); }
  function pollPr(id){
    api(root(pid) + '/review/pr/' + encodeURIComponent(id)).then(function(r){
      if (!alive()) return;
      var box = panel.querySelector('[data-r4-draft]');
      if (r.review.status !== 'done') { box.textContent = 'Review running…'; setTimeout(function(){ if (alive()) pollPr(id); }, 1500); return; }
      box.innerHTML = '<label>Draft comments · edit and post yourself<textarea class="scmmsg" rows="10" data-r4-comment>' + esc(r.draft) + '</textarea></label>' + button('Save draft', 'save-draft') + button('Copy comments', 'copy-draft') + (r.target && /^https:\/\//.test(r.target.url) ? '<a class="btn sm" target="_blank" rel="noopener" href="' + esc(r.target.url) + '">Open pull request to post</a>' : 'Open the PR on your forge to post your edited comments.');
      box.dataset.review = id;
    }).catch(function(e){ if (alive()) output.textContent = e.message; });
  }
  panel.addEventListener('click', async function(e){
    var b = e.target.closest('[data-r4]'); if (!b) return;
    b.disabled = true;
    try {
      var action = b.dataset.r4;
      if (action === 'open-review') {
        var run = panel.querySelector('[data-r4-run-select]').value;
        var view = await api(root(pid) + '/review/viewed?' + (run ? 'run=' + encodeURIComponent(run) : 'chat=' + encodeURIComponent(chat)));
        var diff = panel.querySelector('[data-r4-run-diff]');
        diff.innerHTML = view.files.map(function(f){ return '<div class="dfile"><div class="dfh"><span class="p">' + esc(f.path) + '</span></div><div class="dcode">' + diffBody(f.patch.split('\n'), f.path) + '</div></div>'; }).join('');
        mountReviewDiff(diff, pid, chat, { run: run || undefined });
      }
      if (action === 'resolve') openChat(await send(pid, '/git/resolve', { agent: agent(), branch: panel.querySelector('[data-r4-conflict-branch]').value || undefined, run: panel.querySelector('[data-r4-run-select]').value || undefined }));
      if (action === 'resolve-current') { openChat(await send(pid, '/git/resolve', { agent: agent() })); config(); }
      if (action === 'release-hold') { await send(pid, '/git/resolve', {}, 'DELETE'); config(); }
      if (action === 'save-verify') { await send(pid, '/git/verify', { command: panel.querySelector('[data-r4-verify]').value }, 'PUT'); toast('Verification saved'); }
      if (action === 'verify') { await send(pid, '/git/verify', {}); config(); }
      if (action === 'verify-agent') openChat(await send(pid, '/git/verify/agent', { agent: agent() }));
      if (action === 'split') {
        proposal = await api(root(pid) + '/git/split?model=' + encodeURIComponent(panel.querySelector('[data-r4-split-model]').value));
        panel.querySelector('[data-r4-groups]').innerHTML = '<label>Edit groups (subject and files)<textarea class="scmmsg" rows="12" data-r4-split>' + esc(JSON.stringify(proposal.groups, null, 2)) + '</textarea></label>' + button('Apply edited commits', 'apply-split');
      }
      if (action === 'apply-split' && await askConfirm('Commit these file groups in order?', { ok: 'Commit groups' })) {
        var r = await send(pid, '/git/split', { version: proposal.version, groups: JSON.parse(panel.querySelector('[data-r4-split]').value) });
        output.textContent = r.commits.length + ' commits created'; panel.querySelector('[data-r4-groups]').innerHTML = ''; if (state.loadGitStat) state.loadGitStat();
      }
      if (action === 'pr-list') { var saved = await api(root(pid) + '/review/pr'); panel.querySelector('[data-r4-pr-list]').innerHTML = saved.reviews.map(function(r){ return '<button class="btn sm" data-r4="load-pr" data-review-id="' + esc(r.reviewId) + '">' + esc(r.target.url + ' · ' + r.status) + '</button>'; }).join('') || 'No saved PR reviews'; }
      if (action === 'load-pr') pollPr(b.dataset.reviewId);
      if (action === 'pr') { var started = await send(pid, '/review/pr', { pr: panel.querySelector('[data-r4-pr]').value, agents: agent() ? [agent()] : [] }); pollPr(started.review.reviewId); }
      if (action === 'save-draft') { await send(pid, '/review/pr/' + panel.querySelector('[data-r4-draft]').dataset.review, { text: panel.querySelector('[data-r4-comment]').value }, 'PUT'); toast('Draft saved'); }
      if (action === 'copy-draft') { await navigator.clipboard.writeText(panel.querySelector('[data-r4-comment]').value); toast('Comments copied'); }
    } catch (error) { output.textContent = error.message; if (b.dataset.r4 === 'verify') config(); }
    finally { b.disabled = false; }
  });
  config();
}
export function mountReviewDiff(host, pid, chat, options){
  options = options || {};
  var previous = host.querySelector('[data-r4-diff]'); if (previous) previous.remove();
  var bar = document.createElement('section'); bar.className = 'scmcommit'; bar.dataset.r4Diff = '1'; host.prepend(bar);
  var scope = options.run ? '?run=' + encodeURIComponent(options.run) : '?chat=' + encodeURIComponent(chat || 'main');
  var bodyScope = { chat: chat || 'main', ...(options.run ? { run: options.run } : {}) };
  var summaryBox = document.createElement('div'); bar.appendChild(summaryBox);
  function refreshSummary(){ Promise.all([api(root(pid) + '/review/summary' + (options.working ? '' : scope)), api(root(pid) + '/review/viewed' + scope)]).then(function(results){
    if (!bar.isConnected) return;
    var summary = results[0], viewed = results[1];
    summaryBox.innerHTML = '<strong>Change summary</strong><div data-r4-progress>' + esc(viewed.viewed + ' of ' + viewed.total + ' viewed') + '</div>' + summary.files.map(function(f){ return '<p>' + esc(f.summary) + (f.flags.length ? '<br><span class="trbadge">' + esc(f.flags.join(' · ')) + '</span>' : '') + '</p>'; }).join('') + viewed.files.map(function(f, i){ return '<label><input type="checkbox" data-r4-viewed="' + i + '"' + (f.viewed ? ' checked' : '') + '> ' + esc(f.path) + '</label>'; }).join('');
    summaryBox.querySelectorAll('[data-r4-viewed]').forEach(function(input){ input.onchange = async function(){
      var file = viewed.files[Number(input.dataset.r4Viewed)]; input.disabled = true;
      try { var r = await send(pid, '/review/viewed', { ...bodyScope, path: file.path, version: file.version, viewed: input.checked }); summaryBox.querySelector('[data-r4-progress]').textContent = r.viewed + ' of ' + r.total + ' viewed'; }
      catch(e){ input.checked = !input.checked; toast(e.message); } finally { input.disabled = false; }
    }; });
  }).catch(function(e){ if (bar.isConnected) summaryBox.textContent = e.message; }).finally(function(){ if (bar.isConnected) setTimeout(function(){ if (bar.isConnected) refreshSummary(); }, 60000); }); }
  refreshSummary();
  host.querySelectorAll('[data-ask-file]').forEach(function(line){
    if (line.dataset.askSide === 'old') return;
    var b = document.createElement('button'); b.className = 'btn xs ghost'; b.textContent = 'Who wrote this?';
    b.onclick = function(e){ e.stopPropagation(); api(root(pid) + '/review/blame?' + new URLSearchParams({ path: line.dataset.askFile, line: line.dataset.askLine })).then(function(r){ toast(r.agent ? r.agent + ' · chat ' + r.chat + ' · turn ' + r.turn + '\n' + r.prompt : r.reason); }).catch(function(e){ toast(e.message); }); };
    line.appendChild(b);
  });
  if (!options.working) return;
  var paths = Array.from(host.querySelectorAll('.dfh .p')).map(function(el){ return el.textContent; });
  paths.forEach(function(file){
    api(root(pid) + '/git/hunks?path=' + encodeURIComponent(file)).then(function(r){
      if (!bar.isConnected || !r.hunks.length) return;
      var section = document.createElement('details'); section.innerHTML = '<summary>Keep or discard hunks · ' + esc(file) + '</summary>' + r.hunks.map(function(h, i){ return '<pre>' + esc(h.patch) + '</pre><button class="btn sm" data-stage="' + i + '">Keep hunk (stage)</button><button class="btn sm" data-discard="' + i + '">Discard hunk</button>'; }).join('') + button('Undo last discard', 'undo'); bar.appendChild(section);
      section.onclick = async function(e){
        var b = e.target.closest('button'); if (!b) return;
        var action = b.dataset.r4 === 'undo' ? 'undo' : b.hasAttribute('data-stage') ? 'stage' : 'discard';
        if (action === 'discard' && !await askConfirm('Discard only this hunk?', { ok: 'Discard hunk' })) return;
        b.disabled = true;
        try { await send(pid, '/git/hunks', { path: file, version: r.version, id: action === "undo" ? undefined : r.hunks[Number(b.dataset.stage || b.dataset.discard || 0)].id, action }); toast(action === 'discard' ? 'Discarded · Undo is available below' : 'Hunk ' + action + ' complete'); if (state.loadGitStat) state.loadGitStat(); var fresh = await api(root(pid) + '/git/hunks?path=' + encodeURIComponent(file)); r = fresh; if (action !== 'discard') section.remove(); else section.querySelectorAll('[data-stage],[data-discard]').forEach(function(x){ x.disabled = true; }); }
        catch(err){ toast(err.message); b.disabled = false; }
      };
    }).catch(function(e){ toast(e.message); });
  });
}
export function installR4Review(){
  var queued = false, host = document.getElementById('root');
  if (!host) return;
  function scan(){
    queued = false;
    // A queued scan can outlive its document when a window closes.
    if (!host.isConnected) { observer.disconnect(); return; }
    if (!state.token) return;
    document.querySelectorAll('[data-r4-panel]:not([data-bound])').forEach(function(panel){ bindR4Panel(panel, panel.dataset.pid, panel.dataset.chat); });
    var home = document.querySelector('.homegrid') || (!state.pid && document.getElementById('list'));
    if (home && !home.querySelector('[data-r4-inbox]')) {
      var card = document.createElement('section'); card.className = 'hcard'; card.dataset.r4Inbox = '1'; card.innerHTML = '<div class="hct">Review inbox</div><div data-r4-items>Loading…</div>' + button('Refresh inbox', 'refresh'); home.prepend(card);
      var inboxTimer;
      function refresh(){ clearTimeout(inboxTimer); api('/api/review/inbox').then(function(r){
        if (!card.isConnected) return;
        card.querySelector('[data-r4-items]').innerHTML = r.items.length ? r.items.map(function(item){ return '<a class="btn sm" href="#p/' + esc(encodeURIComponent(item.project)) + '/c/' + esc(encodeURIComponent(item.chat)) + '" data-r4-run="' + esc(item.run || '') + '">' + esc(item.projectName + ' · ' + item.title + ' · ' + item.viewed + ' of ' + item.total + ' viewed') + '</a>'; }).join('') : (r.errors || []).length ? 'Some projects could not be loaded' : 'All changes reviewed';
        if ((r.errors || []).length) card.querySelector('[data-r4-items]').innerHTML += '<p>' + esc(r.errors.map(function(e){ return e.error; }).join(' · ')) + '</p>';
        card.querySelectorAll('[data-r4-run]').forEach(function(link){ link.onclick = function(){ state.railView = 'scm'; state.r4Run = link.dataset.r4Run || undefined; }; });
      }).catch(function(e){ if (card.isConnected) card.querySelector('[data-r4-items]').textContent = e.message; }).finally(function(){ if (card.isConnected) inboxTimer = setTimeout(refresh, 60000); }); }
      card.querySelector('button').onclick = refresh; refresh();
    }
  }
  var observer = new MutationObserver(function(){ if (!queued) { queued = true; queueMicrotask(scan); } });
  observer.observe(host, { childList: true, subtree: true });
  scan();
}
