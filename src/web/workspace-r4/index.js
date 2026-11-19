import { workspaceRead,WORKSPACE_POLL_MS } from "./poll.js";
import { quickSend } from "./quick-send.js";
import { api } from '../connection.js';
import { state } from '../state.js';
import { ICONS } from '../icons.js';
import { isGuest } from '../share-live.js';
import { openMission,openInbox,openNotes,openFiles,mountMission } from './panels.js';
import { openLayouts,popChat,installRecentSwitcher,recordChat,mountOrganisation,reopenLayout } from './workspace.js';
import { applyCustomTheme } from './appearance.js';
import { paneId,inWorkspace } from '../workspace.js';

export function workspaceCommands(){
  return [
    { label: 'Mission control', run: openMission }, { label: 'Needs-you inbox', run: openInbox },
    { label: 'Saved layouts', run: openLayouts }, { label: 'Pop chat out', run: popChat },
    { label: 'Project notes', run: openNotes }, { label: 'Files from this chat', run: openFiles },
  ].map(function(c){ return Object.assign({ icon: ICONS.chat, sub: 'workspace' }, c); });
}
export function loadLayoutCommands(add){ api('/api/workspace').then(function(p){ add(p.layouts.map(function(l){ return { label: 'Open layout ' + l.name, icon: ICONS.chat, sub: 'saved layout', run: function(){ reopenLayout(l); } }; })); }).catch(function(){}); }
export function mountWorkspaceShell(){
  var nav = document.querySelector('.topnav'), rail = document.querySelector('.railbar'), foot = document.querySelector('.sfoot');
  function button(parent, label, fn, id){ if (!parent) return; var b = document.createElement('button'); b.className = parent === nav ? 'navitem' : 'btn xs'; if (id) b.id = id; b.textContent = label; b.onclick = fn; parent.appendChild(b); }
  button(nav, 'Mission control', openMission, 'r4-mission'); button(nav, 'Needs you', openInbox, 'r4-inbox');
  button(rail, 'Notes', openNotes, 'r4-notes'); button(rail, 'Files', openFiles, 'r4-files');
  button(foot, 'Pop out', popChat, 'r4-popout');
  refreshBadge();
  var list = document.getElementById('slist');
  if (list) { var dispose = mountOrganisation(list); var watcher = new MutationObserver(function(){ if (!list.isConnected) { dispose(); watcher.disconnect(); } }); watcher.observe(document.body, { childList: true, subtree: true }); }
}
export function mountHomeWorkspace(parent){
  var home = parent.querySelector('.home'); if (!home) return;
  var tabs = document.createElement('div'); tabs.className = 'r4-home-tabs';
  tabs.innerHTML = '<button class="btn sm" role="tab" aria-selected="true" data-home>Home</button><button class="btn sm" role="tab" aria-selected="false" data-mission>Mission control</button>';
  var content = document.createElement('section'); content.className = 'r4-home-mission'; content.hidden = true;
  home.prepend(tabs); tabs.after(content); var dispose = null;
  function show(on){ Array.from(home.children).forEach(function(c){ if (c !== tabs && c !== content) c.hidden = on; }); content.hidden = !on; tabs.querySelector('[data-home]').setAttribute('aria-selected', String(!on)); tabs.querySelector('[data-mission]').setAttribute('aria-selected', String(on)); if (dispose) { dispose(); dispose = null; } if (on) dispose = mountMission(content); }
  tabs.querySelector('[data-home]').onclick = function(){ show(false); }; tabs.querySelector('[data-mission]').onclick = function(){ show(true); };
  var watcher = new MutationObserver(function(){ if (!home.isConnected) { if (dispose) dispose(); watcher.disconnect(); } }); watcher.observe(parent, { childList: true });
}
export function installWorkspaceR4(){
  if (/[?&]popout=1(?:&|$)/.test(location.search)) document.documentElement.classList.add('r4-popout');
  applyCustomTheme(); installRecentSwitcher();
  window.addEventListener('storage', function(e){ if (e.key === 'loomR4Theme') applyCustomTheme(); });
  var last = '', quickOpened = false;
  var activity = setInterval(function(){
    if (!state.token || isGuest()) return;
    if (!quickOpened && /[?&]quick=1(?:&|$)/.test(location.search)) { quickOpened = true; quickSend(); }
    var key = state.pid + ':' + (state.currentChat ? state.currentChat() : state.chat);
    if (key !== last) { last = key; recordChat(); }
  }, 2500);
  var timer = setInterval(refreshBadge, WORKSPACE_POLL_MS);
  document.addEventListener('visibilitychange', refreshBadge);
  window.addEventListener('pagehide', function(){ clearInterval(timer); clearInterval(activity); document.removeEventListener('visibilitychange', refreshBadge); });
  function menu(item){
    if (!state.token || isGuest()) return;
    if (item === 'r4:layouts') openLayouts();
    if (item === 'r4:mission') openMission();
    if (item === 'r4:inbox') openInbox();
    if (item === 'r4:popout') popChat();
  }
  if (window.loomNative && window.loomNative.onMenu) window.loomNative.onMenu(function(item){ if (inWorkspace()) return; menu(item); });
  window.addEventListener('message', function(e){ if (paneId() && e.source === window.parent && e.origin === location.origin && e.data && e.data.loom === 'command') menu(e.data.item); });
}

function refreshBadge(){
  if (!state.token || isGuest() || paneId() || document.hidden || !document.getElementById('r4-inbox')) return;
  workspaceRead('/api/inbox').then(function(j){ var b = document.getElementById('r4-inbox'); if (b) { b.textContent = 'Needs you' + (j.count ? ' · ' + j.count : ''); b.setAttribute('aria-label', j.count + ' items need you'); } }).catch(function(){});
}
