import { COMMANDS } from '../commands.js';
import { state } from '../state.js';
import { api } from '../connection.js';
import { esc } from '../format.js';
import { isGuest } from '../share-live.js';
import { openHelp, checkWhatsNew } from './panel.js';
import { openProviderGuide } from './settings.js';

export function installHelp() {
  COMMANDS.push({ id: 'help', label: 'Help', keys: '', icon: '?', needsProject: false });
  var checked = false, pending = false;
  function enhance() {
    pending = false;
    if (typeof document === "undefined" || !document || !document.body) return;
    if (isGuest()) return;
    var bar = document.getElementById('statusbar');
    if (bar && !bar.querySelector('[data-open-help]')) {
      var b = document.createElement('button'); b.className = 'btn xs ghost'; b.dataset.openHelp = '1'; b.setAttribute('aria-label','Help'); b.textContent = '?'; b.onclick = function() { openHelp(); }; bar.appendChild(b);
    }
    if (!checked && state.token && (bar || document.querySelector('.home'))) { checked = true; checkWhatsNew(); }
    var setup = document.querySelector('#setnav [data-sec="setup"].on'), pane = document.getElementById('setpane');
    if (setup && pane && !pane.querySelector('[data-provider-guide]')) {
      var key = document.createElement('button'); key.className = 'btn sm'; key.dataset.providerGuide = '1'; key.textContent = 'Provider setup guide · four steps'; key.onclick = openProviderGuide; pane.prepend(key);
    }
    var hero = document.querySelector('#threadempty .tesug');
    if (hero && state.pid && hero.dataset.r4project !== state.pid) {
      var pid = state.pid; hero.dataset.r4project = pid;
      api('/api/projects/' + encodeURIComponent(pid) + '/starter-prompts').then(function(r) {
        if (!hero.isConnected || state.pid !== pid) return;
        hero.innerHTML = r.prompts.map(function(p, i) { return '<button class="tesb" data-starter="' + i + '">' + esc(p.text) + '</button>'; }).join('');
        hero.querySelectorAll('[data-starter]').forEach(function(b) { b.onclick = function() { var box = document.getElementById('box'); if (box) { box.value = r.prompts[Number(b.dataset.starter)].text; box.dispatchEvent(new Event('input', { bubbles: true })); box.focus(); } }; });
      }).catch(function() { /* Older daemons keep their existing generic suggestions. */ });
    }
  }
  new MutationObserver(function() { if (!pending) { pending = true; setTimeout(enhance, 0); } }).observe(document.body, { childList: true, subtree: true });
  enhance();
}
