/** Browser "Open in editor" (#407). See README.md for ownership and startup. */
import { api } from './connection.js';
import { toast } from './notifications.js';

  /**
   * The editors on the daemon's machine (VS Code, Cursor, Zed, JetBrains, Sublime, Xcode…), from
   * GET /api/editors, cached for the page: menus are built synchronously, so the list is fetched
   * ahead of time and a menu shows whatever has arrived. The last one you used comes first.
   */
  var cache = null, loading = null;

  function loadEditors(){
    if (cache || loading) return loading || Promise.resolve(cache);
    loading = api("/api/editors").then(function(r){
      var list = r.editors || [], last = r.lastEditor;
      list.sort(function(a, b){ return (b.id === last) - (a.id === last); });
      cache = list; loading = null; return cache;
    }).catch(function(){ cache = []; loading = null; return cache; });
    return loading;
  }

  function openIn(pid, editor, path, line){
    var body = { editor: editor.id };
    if (path) body.path = path;
    if (line) body.line = line;
    return api("/api/projects/" + pid + "/open-in", { method: "POST", body: JSON.stringify(body) }).then(function(){
      toast("opened in " + editor.label);
      // the one you just used leads next time
      if (cache) cache.sort(function(a, b){ return (b.id === editor.id) - (a.id === editor.id); });
    }).catch(function(e){ toast(e.message); });
  }

  /** Menu rows ({label, icon, run}) for "Open in …", up to `max` editors; [] until the list arrives. */
  function editorItems(pid, path, icon, max){
    loadEditors();
    return (cache || []).slice(0, max || 3).map(function(ed){
      return { label: "Open in " + ed.label, icon: icon, run: function(){ openIn(pid, ed, path); } };
    });
  }

export { loadEditors, editorItems, openIn };
