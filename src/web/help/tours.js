import { state } from '../state.js';
import { devMode, setDevMode } from '../mode.js';
import { openTriggers } from '../triggers-ui.js';
import { toast } from '../notifications.js';

var launch;
export function registerWalkthroughEngine(engine) { launch = engine; }
export function tourProgress(id) { try { return Number(localStorage.getItem('loomFeatureTour:' + id) || 0); } catch (e) { return 0; } }
export async function startFeatureTour(tour, replay) {
  if (!launch || !state.pid) { toast('Open a project to take this tour.'); return; }
  if (document.getElementById('tourcard')) return;
  var index = replay ? 0 : Math.min(tourProgress(tour.id), tour.steps.length - 1);
  var originalFocus = document.activeElement;
  var rail = document.querySelector('.dshell'), railWasOpen = rail && rail.classList.contains('railopen');
  function save() { try { localStorage.setItem('loomFeatureTour:' + tour.id, String(index)); } catch (e) {} }
  function goTarget(target) {
    if (target === 'triggers') { openTriggers(state.pid); }
    else if (target === 'review') {
      if (rail) rail.classList.add('railopen');
      if (state.showRail) state.showRail('scm');
    } else {
      if (target === 'orchestra' && !devMode()) {
        setDevMode(true);
        if (state.rerender) state.rerender();
        toast('Developer mode on — Orchestra lives there');
      }
      if (state.showTab) state.showTab(target);
    }
  }
  function anchor(target) {
    var selector = { orchestra: '.tab[data-tab="orchestra"]', brain: '.tab[data-tab="brain"]', triggers: '.scrim .triggersmodal', review: '.rail' }[target];
    var el = selector && document.querySelector(selector);
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) if (getComputedStyle(n).display === 'none') return '#statusbar';
    if (el && document.documentElement.getBoundingClientRect().width && !el.getBoundingClientRect().width) return '#statusbar';
    return el ? selector : '#statusbar';
  }
  save();
  goTarget(tour.steps[index].target);
  // Switching to Developer mode rebuilds the workspace asynchronously.
  for (var waited = 0; !state.showTab && waited < 100; waited++) await new Promise(function(resolve) { setTimeout(resolve, 50); });
  goTarget(tour.steps[index].target);
  var steps = tour.steps.slice(index).map(function(s) { return { get sel() { return anchor(s.target); }, title: s.title, body: s.body }; });
  launch({ steps: steps, label: tour.title, offset: index });
  var card = document.getElementById('tourcard');
  if (!card) return;
  card.addEventListener('click', function(e) {
    if (e.target.closest('#tournext')) {
      index++; save();
      if (tour.steps[index]) goTarget(tour.steps[index].target);
    }
  }, true);
  function enhance() {
    if (!card.isConnected) {
      observer.disconnect();
      if (rail && !railWasOpen) rail.classList.remove('railopen');
      if (originalFocus && originalFocus.isConnected) originalFocus.focus();
      return;
    }
    if (!card.querySelector('[data-show-feature]')) {
      var b = document.createElement('button'); b.className = 'btn xs outline'; b.dataset.showFeature = '1'; b.textContent = 'Show me';
      b.onclick = function() { goTarget(tour.steps[index].target); };
      card.querySelector('.toura').prepend(b);
    }
  }
  var observer = new MutationObserver(enhance); observer.observe(document.body, { childList: true, subtree: true }); enhance();
}
