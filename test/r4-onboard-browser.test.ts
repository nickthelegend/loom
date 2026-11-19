import fs from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import { featureTours } from "../src/core/help/catalog.js";

// Run the actual browser modules with only their UI/API dependencies replaced.
// These checks need no HTTP listener and give the spotlight measurable targets.
const mounted: JSDOM[] = [];
afterEach(() => { for (const dom of mounted.splice(0)) dom.window.close(); });
function browser(saved: Record<string, string> = {}, search = "") {
  const dom = new JSDOM('<div class="dshell"><button class="tab" data-tab="orchestra"></button><button class="tab" data-tab="brain"></button><aside class="rail"></aside><div id="statusbar"></div><textarea id="box"></textarea><div id="pane-thread"></div><button class="tab" data-tab="fleet"></button><button id="setupbtn"></button></div>', { url: `http://loom.test/app${search}`, runScripts: "outside-only", pretendToBeVisual: true });
  mounted.push(dom); const w = dom.window;
  for (const [key, value] of Object.entries(saved)) w.localStorage.setItem(key, value);
  w.eval(`var state = { pid: 'project', showTab: function(target) { state.tab = target; }, showRail: function(target) { state.railView = target; }, rerender: function() { state.renders = (state.renders || 0) + 1; } };
    var messages = [], esc = function(s) { return s; }, toast = function(s) { messages.push(s); };
    var api = function() { return Promise.resolve({ version: '2.2.0', highlights: [{ text: 'Update', topic: 'brain' }] }); };
    var openTriggers = function() { if (document.querySelector('.scrim')) return; var el = document.createElement('div'); el.className = 'scrim'; el.innerHTML = '<div class="modal triggersmodal"></div>'; document.body.appendChild(el); };
  `);
  for (const file of ['mode.js', 'startup-dialogs.js', 'help/tours.js', 'navigation.js', 'help/panel.js']) {
    const source = fs.readFileSync(new URL(`../src/web/${file}`, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export \{.*\};?$/gm, '').replace(/export (async )?function /g, '$1function ');
    w.eval(source);
  }
  const original = w.HTMLElement.prototype.getBoundingClientRect;
  w.HTMLElement.prototype.getBoundingClientRect = function() {
    const left = this.matches('.tab,.triggersmodal,.rail') ? 100 : this.id === 'statusbar' ? 500 : 0;
    return left ? { left, right: left + 100, top: 200, bottom: 240, x: left, y: 200, width: 100, height: 40, toJSON() {} } : original.call(this);
  };
  return w;
}
function click(w: JSDOM['window'], selector: string) { w.document.querySelector<HTMLElement>(selector)!.click(); }
it.each(featureTours)('opens and anchors $title without changing Simple mode except for Orchestra', async tour => {
  const w = browser({ loomDevMode: '0' });
  await w.startFeatureTour(tour, true);
  expect(w.document.querySelector('.tourstep')!.textContent).toBe(`${tour.title} · 1 of 2`);
  expect(w.document.querySelector<HTMLElement>('#tourshade')!.style.left).toBe('94px');
  expect(w.localStorage.getItem('loomDevMode')).toBe(tour.id === 'orchestra' ? '1' : '0');
  expect(w.state.renders ?? 0).toBe(tour.id === 'orchestra' ? 1 : 0);
  if (tour.id === 'orchestra') expect(w.messages).toEqual(['Developer mode on — Orchestra lives there']);
  if (['brain', 'orchestra'].includes(tour.id)) expect(w.state.tab).toBe(tour.id);
  if (tour.id === 'review') expect(w.state.railView).toBe('scm');
  if (tour.id === 'triggers') expect(w.document.querySelector('.triggersmodal')).not.toBeNull();
  click(w, '#tournext'); expect(w.localStorage.getItem('loomFeatureTour:' + tour.id)).toBe('1');
  click(w, '#tourskip'); await Promise.resolve();
  await w.startFeatureTour(tour, false);
  expect(w.document.querySelector('.tourstep')!.textContent).toBe(`${tour.title} · 2 of 2`);
  click(w, '#tournext'); expect(w.localStorage.getItem('loomFeatureTour:' + tour.id)).toBe('2');
});
it('uses each step target, including its Show me action and the hidden-target fallback', async () => {
  const w = browser();
  await w.startFeatureTour({ id: 'mixed', title: 'Mixed', steps: [{ title: 'Memory', target: 'brain', body: 'one' }, { title: 'Changes', target: 'review', body: 'two' }] }, true);
  expect(w.state.tab).toBe('brain');
  click(w, '#tournext'); expect(w.state.railView).toBe('scm');
  await Promise.resolve(); w.state.railView = 'other'; click(w, '[data-show-feature]'); expect(w.state.railView).toBe('scm');
  click(w, '#tourskip'); await Promise.resolve();
  w.document.querySelector<HTMLElement>('[data-tab="brain"]')!.style.display = 'none';
  await w.startFeatureTour(featureTours.find(t => t.id === 'brain'), true);
  expect(w.document.querySelector<HTMLElement>('#tourshade')!.style.left).toBe('494px');
});
it('records a fresh install silently even if this startup has written a tour marker', async () => {
  const w = browser({ loomClientToken: 'token' });
  w.localStorage.setItem('loomTourDone', '1');
  await w.checkWhatsNew();
  expect(w.localStorage.getItem('loomReleaseSeen')).toBe('2.2.0');
  expect(w.document.querySelector('.r4help')).toBeNull();
});
it('recognizes prior use without a release marker', async () => {
  const w = browser({ loomDevMode: '0' }); await w.checkWhatsNew();
  expect(w.document.querySelector('[data-highlight]')).not.toBeNull();
});
it('defers an upgrade until the requested demo starts and its card closes', async () => {
  const w = browser({ loomDevMode: '0' }, '?tour=1');
  // Capture the retry without sleeping; exercise it before and after the tour.
  let retry: (() => void) | undefined;
  w.setTimeout = ((fn: () => void) => { retry = fn; return 1; }) as typeof w.setTimeout;
  await w.checkWhatsNew(); expect(w.document.querySelector('.r4help')).toBeNull();
  expect(w.location.search).toBe('?tour=1');
  w.state.startDemoTour(); expect(w.document.querySelector('.tourstep')!.textContent).toBe('Try Loom · 1 of 5');
  retry!(); expect(w.document.querySelector('.r4help')).toBeNull();
  click(w, '#tourskip'); retry!(); await Promise.resolve();
  expect(w.document.querySelector('[data-highlight]')).not.toBeNull();
  expect(w.localStorage.getItem('loomReleaseSeen')).toBe('2.2.0');
});
it('keeps the navigation export bytes unchanged and registers beside startTour', () => {
  const source = fs.readFileSync(new URL('../src/web/navigation.js', import.meta.url), 'utf8');
  expect(source.endsWith('export { bootstrapAdmin,openShortcuts,route,setFocusMode,takePermalink,typingInField };')).toBe(true);
  expect(source).toContain('state.startTour = startTour;\n  registerWalkthroughEngine(');
});
