/** Remember the view locally; only top-level windows follow each other's selection. */
import { state } from './state.js';
import { paneId,inWorkspace } from './workspace.js';
import { loadWorkspace } from './splits.js';

var receiving = false;
export function publishSelection(project, chat){
  if (receiving) return;
  if (paneId()) {
    window.parent.postMessage({ loom: "pane", id: paneId(), type: "at", hash: '#p/' + encodeURIComponent(project) + '/c/' + encodeURIComponent(chat || 'main') }, location.origin);
    return;
  }
  try { localStorage.setItem('loomSelection:v1', JSON.stringify({ project: project, chat: chat || 'main', nonce: Date.now() + Math.random() })); } catch (e) {}
}
export function savedTab(pid){ try { return localStorage.getItem('loomTab:' + (paneId() || 'window') + ':' + pid) || 'thread'; } catch (e) { return 'thread'; } }
export function saveTab(pid, tab){ try { localStorage.setItem('loomTab:' + (paneId() || 'window') + ':' + pid, tab); } catch (e) {} }
export function restoreWorkspace(){
  // Explicit links, pairing and pane URLs always take precedence over saved state.
  if (!location.hash && !location.search && loadWorkspace() && window.matchMedia('(min-width:900px), (hover:hover) and (pointer:fine)').matches) {
    history.replaceState(null, '', location.pathname + '?split=1');
  }
}
export function installSelectionSync(){
  window.addEventListener('storage', function(e){
    if (e.key !== 'loomSelection:v1' || !e.newValue || paneId() || inWorkspace() || !state.setChat) return;
    try {
      var next = JSON.parse(e.newValue);
      if (!next || typeof next.chat !== 'string' || !(state.projects || []).some(function(p){ return p.id === next.project; })) return;
      if (state.pid === next.project && state.chat === next.chat) return;
      receiving = true; state.setChat(next.project, next.chat);
    } catch (err) {} finally { receiving = false; }
  });
}
