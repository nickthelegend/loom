import { workspaceNative } from "./native.js";
import { applyAppearance } from "../theme.js";
import { esc } from '../format.js';
import { state } from '../state.js';

export var COLOR_TOKENS = ['background','foreground','editor-surface','card','card-foreground','popover','popover-foreground','primary','primary-foreground','secondary','secondary-foreground','muted','muted-foreground','accent','accent-foreground','border','input','ring','sidebar','sidebar-foreground','sidebar-accent','sidebar-accent-foreground','sidebar-border','thread','thread-ink','accentBlue','ok','warn','err'];
function theme(name, bg, panel, fg, muted, line, accent){
  return { name: name, tokens: { background: bg, foreground: fg, 'editor-surface': panel, card: panel, 'card-foreground': fg, popover: panel, 'popover-foreground': fg, primary: fg, 'primary-foreground': bg, secondary: panel, 'secondary-foreground': fg, muted: panel, 'muted-foreground': muted, accent: line, 'accent-foreground': fg, border: line, input: line, ring: accent, sidebar: panel, 'sidebar-foreground': fg, 'sidebar-accent': line, 'sidebar-accent-foreground': fg, 'sidebar-border': line, thread: accent, 'thread-ink': accent, accentBlue: accent } };
}
export var BUNDLED_THEMES = [theme('Graphite', '#0a0a0a', '#171717', '#fafafa', '#a1a1a1', '#303030', '#67e8f9'), theme('Paper', '#ffffff', '#f7f7f5', '#171717', '#666666', '#deded8', '#0e7490'), theme('Forest', '#111b17', '#192820', '#e2efe5', '#9fb4a5', '#354c3d', '#9fdbab'), theme('Midnight', '#101624', '#192237', '#e5eaff', '#a0accb', '#354160', '#b9a5ff')];
export function parseTheme(value){
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || !value.tokens || typeof value.tokens !== 'object' || Array.isArray(value.tokens)) throw new Error('Expected a theme name and colour tokens');
  var keys = Object.keys(value.tokens);
  if (!keys.length || keys.some(function(k){ return !COLOR_TOKENS.includes(k) || typeof value.tokens[k] !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value.tokens[k]); })) throw new Error('Use known colour tokens with #RRGGBB or #RRGGBBAA values');
  return { name: value.name.trim(), tokens: Object.assign({}, value.tokens) };
}
export function savedTheme(){ try { return parseTheme(JSON.parse(localStorage.getItem('loomR4Theme'))); } catch (e) { return null; } }
export function applyCustomTheme(value){
  var t = value === undefined ? savedTheme() : value;
  COLOR_TOKENS.forEach(function(k){ document.documentElement.style.removeProperty('--' + k); });
  applyAppearance();
  if (t) Object.keys(t.tokens).forEach(function(k){ document.documentElement.style.setProperty('--' + k, t.tokens[k]); });
  if (state.retheme) state.retheme();
}
export function mountAppearance(pane){
  var group = document.createElement('div'); group.className = 'r4-appearance';
  group.innerHTML = '<div class="sgrouph">Custom themes · Appearance</div><div class="r4-actions"><select aria-label="Bundled theme"><option value="">Choose a theme</option>' + BUNDLED_THEMES.map(function(t, i){ return '<option value="' + i + '">' + esc(t.name) + '</option>'; }).join('') + '</select><button class="btn xs" data-apply>Apply</button><button class="btn xs" data-cancel>Cancel preview</button><button class="btn xs" data-reset>Default</button><button class="btn xs" data-export>Export JSON</button><label class="btn xs">Import JSON<input type="file" accept="application/json,.json" hidden></label></div><textarea aria-label="Theme JSON" spellcheck="false" rows="5"></textarea><p role="status">Changes preview live. Apply to keep them.</p>';
  var anchor = pane.querySelector('[data-seg="theme"]');
  if (anchor) anchor.closest('.prow').after(group); else pane.appendChild(group);
  var box = group.querySelector('textarea'), status = group.querySelector('[role=status]'), candidate = savedTheme();
  box.value = JSON.stringify(candidate || BUNDLED_THEMES[0], null, 2);
  function preview(){ try { candidate = parseTheme(JSON.parse(box.value)); applyCustomTheme(candidate); status.textContent = 'Preview: ' + candidate.name; } catch (e) { status.textContent = e.message; candidate = null; } }
  box.oninput = preview;
  group.querySelector('select').onchange = function(){ if (this.value === '') return; box.value = JSON.stringify(BUNDLED_THEMES[Number(this.value)], null, 2); preview(); };
  group.querySelector('[data-apply]').onclick = function(){ if (!candidate) return; localStorage.setItem('loomR4Theme', JSON.stringify(candidate)); applyCustomTheme(); status.textContent = 'Saved ' + candidate.name; };
  group.querySelector('[data-cancel]').onclick = function(){ candidate = savedTheme(); box.value = JSON.stringify(candidate || BUNDLED_THEMES[0], null, 2); applyCustomTheme(); status.textContent = 'Preview cancelled'; };
  group.querySelector('[data-reset]').onclick = function(){ localStorage.removeItem('loomR4Theme'); candidate = null; applyCustomTheme(null); status.textContent = 'Default theme'; };
  group.querySelector('input[type=file]').onchange = function(){ var file = this.files[0]; if (!file) return; if (file.size > 20000) { status.textContent = 'Theme file is too large'; return; } file.text().then(function(text){ box.value = text; preview(); }).catch(function(e){ status.textContent = e.message; }); };
  group.querySelector('[data-export]').onclick = function(){
    try { var t = parseTheme(JSON.parse(box.value)), url = URL.createObjectURL(new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' })), a = document.createElement('a'); a.href = url; a.download = 'loom-theme.json'; a.click(); setTimeout(function(){ URL.revokeObjectURL(url); }, 1000); } catch (e) { status.textContent = e.message; }
  };
  var observer = new MutationObserver(function(){ if (!group.isConnected) { observer.disconnect(); applyCustomTheme(); } });
  observer.observe(document.body, { childList: true, subtree: true });
  var native = workspaceNative();
  if (native && native.tray) {
    var tray = document.createElement('label'); tray.className = 'r4-actions'; tray.innerHTML = '<input type="checkbox"> Keep Loom running in the tray when the window closes'; group.appendChild(tray);
    native.tray().then(function(r){ tray.querySelector('input').checked = r.requestedEnabled ?? r.enabled; });
    tray.querySelector('input').onchange = function(){ native.tray(this.checked).then(function(r){ if (!r.available && r.requestedEnabled) status.textContent = 'No tray host available. Loom will quit when the last window closes.'; }).catch(function(e){ status.textContent = e.message; }); };
  }
}
