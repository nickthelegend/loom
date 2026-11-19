import { api } from '../connection.js';
import { state } from '../state.js';

export var WORKSPACE_POLL_MS = 10000;
var caches = new Map();
function pageCaches(){
  try {
    var owner = window.top || window;
    if (owner.opener && owner.opener.location.origin === location.origin) owner = owner.opener.top;
    if (!owner.__loomR4PollCaches) owner.__loomR4PollCaches = new Map();
    return owner.__loomR4PollCaches;
  } catch (e) { return caches; }
}
/** Same-page callers share a promise; Web Locks serialize windows and panes of this origin.
 * The shared snapshot is keyed by a digest of the credential, never shared across scopes.
 * A user action may explicitly invalidate it; background reads are at most once per 10s.
 */
export async function workspaceRead(endpoint, fresh) {
  var token = state.token;
  var localKey = token + ':' + endpoint;
  var shared = pageCaches();
  var cache = shared.get(localKey);
  if (!cache) { cache = {}; shared.set(localKey, cache); }
  if (cache.pending) { await cache.pending; if (!fresh) return cache.value; }
  if (!fresh && cache.at && Date.now() - cache.at < WORKSPACE_POLL_MS) return cache.value;
  async function read(key) {
    if (!fresh && key) {
      try {
        var saved = JSON.parse(localStorage.getItem(key));
        if (saved && Date.now() - saved.at < WORKSPACE_POLL_MS) { cache.at = saved.at; cache.value = saved.value; return cache.value; }
      } catch (e) {}
    }
    var value = await api(endpoint);
    cache.value = value; cache.at = Date.now();
    if (key) { try { localStorage.setItem(key, JSON.stringify({ at: cache.at, value: value })); } catch (e) {} }
    return value;
  }
  cache.pending = (async function(){
    if (navigator.locks && window.crypto && window.crypto.subtle) {
      var digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      var key = 'loomR4Poll:' + Array.from(new Uint8Array(digest)).map(function(n){ return n.toString(16).padStart(2, '0'); }).join('') + ':' + endpoint;
      return navigator.locks.request(key, function(){ return read(key); });
    }
    // Older embedded browsers can still share one in-flight request within this page.
    return read(null);
  })();
  try { return await cache.pending; } finally { cache.pending = null; }
}
