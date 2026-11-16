import { api } from '../connection.js';
import { esc } from '../format.js';
import { toast } from '../notifications.js';
import { state } from '../state.js';

/** routes behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createRoutes(view) {


    // ---- routes pane (desktop) / sheet (mobile) -----------------------------
    function routeFormHtml(){
      var names = (state.project && state.project.routeNames) || ["auto"];
      return "<label>pipeline</label>" +
        '<select id="rsel">' +
        names.map(function(n){
          return '<option value="' + esc(n) + '">' + esc(n === "auto" ? "auto \u2014 LLM picks each hop" : n) + "</option>";
        }).join("") +
        '<option value="__custom">custom steps&hellip;</option></select>' +
        '<input id="rsteps" placeholder="steps e.g. planner,executor,reviewer?lines>200" style="display:none">' +
        '<input id="rtask" placeholder="what should they do?">' +
        '<div class="row"><button class="btn primary" id="rgo">Start route</button></div>';
    }

    function bindRouteForm(after){
      var sel = document.getElementById("rsel"); if (!sel) return;
      sel.onchange = function(){
        document.getElementById("rsteps").style.display = this.value === "__custom" ? "" : "none";
      };
      function start(){
        var task = (document.getElementById("rtask").value || "").trim();
        if (!task) return toast("describe the task first");
        var spec = sel.value === "__custom" ? (document.getElementById("rsteps").value || "").trim() : sel.value;
        if (!spec) return toast("give steps like planner,executor");
        api("/api/projects/" + view.pid + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: spec, chat: view.chatId }) })
          .then(function(){ view.refresh(); toast("route started"); if (after) after(); })
          .catch(function(err){ toast(err.message); });
      }
      document.getElementById("rgo").onclick = start;
      // Enter submits from either field, like every other input in the app
      ["rtask", "rsteps"].forEach(function(id){
        var el = document.getElementById(id); if (!el) return;
        el.onkeydown = function(e){ if (e.key === "Enter") { e.preventDefault(); start(); } };
      });
    }
return { routeFormHtml, bindRouteForm };
}
