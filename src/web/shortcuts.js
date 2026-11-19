/** Device-local bindings shared by Settings, the palette and native menus. */
import { isGuest } from './share-live.js';
import { COMMANDS,runCommand } from './commands.js';
import { esc } from './format.js';
import { state } from './state.js';
import { inWorkspace,workspaceCommand } from './workspace.js';

var KEY = 'loomShortcuts:v1';
function overrides(){ try { var v = JSON.parse(localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; } }
function validBinding(k){ return typeof k === 'string' && (k === '' || /^(?:(?:mod|ctrl|alt|shift)\+)+(?:[a-z0-9.,/;\[\]`-]|arrowup|arrowdown)$/.test(k)); }
function normalKey(s){ return String(s || '').replace(/⌥/g, 'Alt+').replace(/⌘/g, 'Mod+').replace(/⇧/g, 'Shift+').toLowerCase(); }
export function shortcutFor(c){ var o = overrides(); return Object.prototype.hasOwnProperty.call(o, c.id) && validBinding(o[c.id]) ? o[c.id] : normalKey(c.keys); }
export function shortcutLabel(c){ return shortcutFor(c).replace(/mod/g, /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl').replace(/shift/g, 'Shift').replace(/alt/g, 'Alt').replace(/ctrl/g, 'Ctrl').replace(/\+([a-z])$/, function(_, key){ return '+' + key.toUpperCase(); }); }
function eventKey(e){
  var mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  var key = e.key.toLowerCase();
  if (/^Key[A-Z]$/.test(e.code || '')) key = e.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(e.code || '')) key = e.code.slice(5);
  else key = ({ Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Backquote: '`', BracketLeft: '[', BracketRight: ']', Minus: '-' })[e.code] || key;
  return ((mac ? e.metaKey : e.ctrlKey) ? 'mod+' : '') + (mac && e.ctrlKey ? 'ctrl+' : '') + (!mac && e.metaKey ? 'meta+' : '') + (e.altKey ? 'alt+' : '') + (e.shiftKey ? 'shift+' : '') + key;
}
function comparable(k){ if (!/Mac|iPhone|iPad/.test(navigator.platform || '')) k = k.replace(/ctrl/g, 'mod'); return k.split('+').sort().join('+'); }
export function saveShortcut(id, key){
  var cmd = COMMANDS.find(function(c){ return c.id === id; });
  if (!cmd) return 'Unknown command';
  if (!validBinding(key)) return 'Use a modifier and a letter, number or punctuation key.';
  if (key && /^(mod|ctrl)\+[cxvazqwrhm0]$/.test(key)) return 'That shortcut belongs to text editing or the window. Choose another.';
  var other = key && COMMANDS.find(function(c){ return c.id !== id && comparable(shortcutFor(c)) === comparable(key); });
  if (other) return 'Already used by ' + other.label;
  var o = overrides(); o[id] = key;
  try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { return 'Could not save shortcuts on this device.'; }
  syncNativeShortcuts(); return '';
}
export function syncNativeShortcuts(){
  if (!window.loomNative || !window.loomNative.setShortcuts) return;
  var bindings = {};
  COMMANDS.forEach(function(c){ bindings[c.id] = shortcutFor(c).replace(/mod/g, 'CmdOrCtrl').replace(/ctrl/g, 'Ctrl').replace(/shift/g, 'Shift').replace(/alt/g, 'Alt').replace(/arrowup/g, 'Up').replace(/arrowdown/g, 'Down'); });
  window.loomNative.setShortcuts(bindings).catch(function(){});
}
export function renderShortcuts(pane){
  pane.innerHTML = '<div class="setphead">Shortcuts</div><p class="snote">Saved on this device. Focus a binding and press the new shortcut. Backspace disables it.</p>' +
    COMMANDS.map(function(c){ return '<label class="shortcutrow"><span>' + esc(c.label) + '</span><input readonly aria-label="' + esc(c.label) + ' shortcut" data-shortcut="' + esc(c.id) + '" value="' + esc(shortcutLabel(c)) + '"></label>'; }).join('') +
    '<p id="shortcut-error" role="status"></p><button class="btn outline" id="shortcut-reset">Restore defaults</button>';
  pane.querySelectorAll('[data-shortcut]').forEach(function(input){
    input.onkeydown = function(e){
      if (e.key === 'Tab' || e.key === 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      if (['Meta','Control','Alt','Shift'].indexOf(e.key) >= 0) return;
      var error = saveShortcut(input.dataset.shortcut, e.key === 'Backspace' ? '' : eventKey(e));
      pane.querySelector('#shortcut-error').textContent = error;
      if (!error) input.value = shortcutLabel(COMMANDS.find(function(c){ return c.id === input.dataset.shortcut; }));
    };
  });
  pane.querySelector('#shortcut-reset').onclick = function(){ try { localStorage.removeItem(KEY); } catch (e) {} syncNativeShortcuts(); renderShortcuts(pane); };
}
export function installShortcuts(){
  syncNativeShortcuts();
  window.addEventListener('storage', function(e){ if (e.key === KEY) syncNativeShortcuts(); });
  document.addEventListener('keydown', function(e){
    if (!state.token || isGuest() || e.isComposing || e.repeat || document.querySelector('.scrim')) return;
    var k = eventKey(e);
    var command = COMMANDS.find(function(c){ var binding = shortcutFor(c); return binding && comparable(binding) === comparable(k); });
    // Consume replaced defaults too: the older contextual listeners must not revive them.
    var old = COMMANDS.some(function(c){ return c.keys && comparable(normalKey(c.keys)) === comparable(k); });
    if (!command && !old) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (command) { if (inWorkspace()) workspaceCommand(command.id); else runCommand(command.id); }
  }, true);
}
