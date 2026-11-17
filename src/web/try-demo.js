/** Browser "Try a demo project" (#402). See README.md for ownership and startup. */
import { api } from './connection.js';
import { toast } from './notifications.js';

  /**
   * POST /api/try makes (or reuses) the demo project — a small todo app with three scripted demo
   * agents — then we open it with the walkthrough armed. The same thing `loom try` does from a
   * terminal, for someone who hasn't opened one.
   */
  function tryDemo(btn){
    if (btn) { btn.disabled = true; btn.textContent = "Setting it up…"; }
    return api("/api/try", { method: "POST", body: "{}" }).then(function(r){
      try { sessionStorage.setItem("loomDemoTour", "1"); } catch (e) {}
      var id = r.project && r.project.id;
      if (id) location.hash = "#p/" + id;
      return r;
    }).catch(function(e){
      toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = "Try a demo project"; }
    });
  }

  /** The button, for any empty state that wants one. */
  var TRY_BTN = '<button type="button" class="btn sm trydemo" data-trydemo>Try a demo project</button>';

  /** Wire every [data-trydemo] under el. */
  function bindTryDemo(el){
    Array.prototype.forEach.call((el || document).querySelectorAll("[data-trydemo]"), function(b){
      b.onclick = function(){ tryDemo(b); };
    });
  }

export { tryDemo, TRY_BTN, bindTryDemo };
