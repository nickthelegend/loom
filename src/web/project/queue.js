import { labelOf } from '../agents.js';
import { api } from '../connection.js';
import { esc,pageGone } from '../format.js';
import { ICONS } from '../icons.js';
import { askConfirm,toast } from '../notifications.js';
import { state } from '../state.js';

/** queue behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createQueue(view) {


    /** A held prompt's condition, short enough for the row. */
    function whenLabel(w){
      if (!w) return "";
      if (w.kind === "at") {
        var d = new Date(w.at);
        var sameDay = d.toDateString() === new Date().toDateString();
        return (sameDay ? "" : d.toLocaleDateString() + " ") + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }
      if (w.kind === "landed") return "after " + String(w.runId).slice(0, 8) + " lands";
      if (w.kind === "checks-green") return "when " + String(w.runId).slice(0, 8) + " is green";
      return Math.round((w.ms || 0) / 60000) + "m quiet";
    }


    function loadQueue(){
      api("/api/projects/" + view.pid + "/queue").then(applyQueue).catch(function(){});
    }

    function applyQueue(j){
      if (!j || !j.queue) return;
      view.queue.items = j.queue;
      view.queue.paused = !!j.paused;
      view.queue.reason = j.reason || "";
      view.queue.waitingFor = j.waitingFor || "";
      if (view.queue.editing && !view.queue.items.filter(function(i){ return i.id === view.queue.editing; }).length) view.queue.editing = null;
      drawQueue();
    }

    function onQueueFrame(frame){
      if (frame.projectId && frame.projectId !== view.pid) return;
      applyQueue(frame);
    }

    /** Who a queued prompt goes to, in the words the composer uses. */
    function qTargetLabel(t){
      if (!t || t.kind === "auto") return "Auto";
      if (t.kind === "orchestra") return "Orchestrate";
      return labelOf(t.agentId);
    }

    function qTargetValue(t){
      if (!t || t.kind === "auto") return "auto";
      if (t.kind === "orchestra") return "orchestra";
      return t.agentId;
    }

    /** Every action here is the same round trip: act, then redraw from the server's answer. */
    function qAct(path, opts){
      return api("/api/projects/" + view.pid + "/queue" + path, opts)
        .then(applyQueue)
        .catch(function(err){ toast(err.message); loadQueue(); });
    }

    function queueTarget(){
      // what the composer would send right now, as a queue target
      if (state.cmode === "orch") {
        var c = view.orchCfg(), roster = view.orchRoster();
        return { kind: "orchestra", orchestrator: c.orchestrator || undefined,
          workers: roster.filter(function(a){ return !c.off[a.id]; }).map(function(a){ return a.id; }),
          maxParallel: c.parallel };
      }
      if (state.auto && !view.planState) return { kind: "auto" };
      return { kind: "agent", agentId: state.selected || (state.project || {}).holder };
    }

    /**
     * Should this send join the queue instead of going out now?
     *
     * Only when it would otherwise jump the line or be refused. A prompt for a
     * busy agent doesn't need us: /messages queues it itself, in the same
     * queue, and answers with its position. So this is about order (something
     * is already waiting) and about goals (GitHub-style: one runs at a time,
     * and a second start is a 400).
     */
    function wouldQueue(){
      if (state.cmode === "orch") {
        // a goal can't start while one runs, and a new one mustn't overtake
        // goals already lined up — even while the queue is held
        var p = state.project || {};
        var run = (view.orch.runs || []).filter(function(r){ return !isTerminalOrch(r.status); })[0];
        return Boolean(view.queue.items.length || run || (p.orchestra && !isTerminalOrch(p.orchestra.status)));
      }
      // A held queue isn't racing you: it's waiting, often because the agent
      // asked you something. What you type now is the answer, and it goes now.
      return view.queue.items.length > 0 && !view.queue.paused;
    }

    function isTerminalOrch(st){
      return st === "completed" || st === "failed" || st === "aborted" || st === "moved";
    }

    /** Queue what's in the box (the composer's fallback when it can't send now). */
    function queueFromComposer(text, plan){
      var body = { text: text, target: queueTarget(), chat: view.chatId };
      if (plan) body.plan = true;
      return api("/api/projects/" + view.pid + "/queue", { method: "POST", body: JSON.stringify(body) })
        .then(function(j){
          applyQueue(j);
          toast("queued — " + (view.queue.items.length) + " waiting");
        });
    }


    function canSteer(it){
      if (!it.target || it.target.kind !== "agent") return false;
      var here = it.chat || "main";
      return ((state.project || {}).agents || []).some(function(a){
        return a.id === it.target.agentId && a.busy && (!a.chat || a.chat === here) && a.capabilities && a.capabilities.steer;
      });
    }

    function drawQueue(){
      if (pageGone()) return;
      var el = document.getElementById("cqueue");
      if (!el) return;
      if (!view.queue.items.length) { el.style.display = "none"; el.innerHTML = ""; return; }
      el.style.display = "flex";
      var note = view.queue.paused ? (view.queue.reason || "paused") : (view.queue.waitingFor || "");
      var h = '<div class="cqhead"><span>Queue · ' + view.queue.items.length + "</span>" +
        (note ? '<span class="cqwait">' + esc(note) + "</span>" : "") +
        '<span class="sp"></span>' +
        '<button class="cqbtn" type="button" data-q="pause">' + (view.queue.paused ? "Resume" : "Pause") + "</button>" +
        '<button class="cqbtn" type="button" data-q="clear">Clear</button></div>';
      var agents = ((state.project || {}).agents || []).filter(function(a){ return a.tier !== "bridge"; });
      view.queue.items.forEach(function(it, i){
        var editing = view.queue.editing === it.id;
        var opts = '<option value="auto"' + (qTargetValue(it.target) === "auto" ? " selected" : "") + ">Auto</option>" +
          '<option value="orchestra"' + (qTargetValue(it.target) === "orchestra" ? " selected" : "") + ">Orchestrate</option>" +
          agents.map(function(a){
            return '<option value="' + esc(a.id) + '"' + (qTargetValue(it.target) === a.id ? " selected" : "") + ">" + esc(labelOf(a.id)) + "</option>";
          }).join("");
        h += '<div class="cqitem' + (view.queue.paused ? " paused" : "") + '" data-qid="' + esc(it.id) + '" draggable="true">' +
          '<span class="cqn" title="drag to reorder">' + (i + 1) + "</span>" +
          '<div class="cqbody">' +
          (editing
            ? '<textarea class="cqedit" data-qedit="' + esc(it.id) + '">' + esc(it.text) + "</textarea>" +
              '<div class="cqmeta"><button class="cqbtn" type="button" data-q="save">Save</button>' +
              '<button class="cqbtn" type="button" data-q="cancel">Cancel</button>' +
              "<span>⌘⏎ saves · Esc cancels</span></div>"
            : '<div class="cqtext" data-q="edit" title="click to edit">' + esc(it.text) + "</div>" +
              '<div class="cqmeta"><span>to</span><select class="cqto" data-q="target" aria-label="who takes this prompt">' + opts + "</select>" +
              (it.plan ? "<span>· plan mode</span>" : "") +
              (it.editedAt ? "<span>· edited</span>" : "") +
              // held for later: what it's waiting for, and a click to release it
              (it.when ? '<button class="cqwhen" data-q="unhold" title="run as soon as it can">⏱ ' + esc(whenLabel(it.when)) + "</button>" : "") +
              "</div>") +
          "</div>" +
          '<div class="cqacts">' +
          '<button type="button" data-q="up" title="move up" aria-label="move up"' + (i === 0 ? " disabled" : "") + ">↑</button>" +
          '<button type="button" data-q="down" title="move down" aria-label="move down"' + (i === view.queue.items.length - 1 ? " disabled" : "") + ">↓</button>" +
          // promote to a steer when the agent it's for is mid-turn in its chat and can take it (#373)
          (canSteer(it) ? '<button type="button" class="cqsteer" data-q="steer" title="put this into the running turn now" aria-label="steer the running turn with this">Steer</button>' : "") +
          '<button type="button" data-q="rm" title="remove" aria-label="remove">' + ICONS.x + "</button>" +
          "</div></div>";
      });
      el.innerHTML = h;
      bindQueue(el);
    }


    function bindQueue(el){
      el.querySelector('[data-q="pause"]').onclick = function(){
        qAct("/pause", { method: "POST", body: JSON.stringify({ paused: !view.queue.paused }) });
      };
      el.querySelector('[data-q="clear"]').onclick = function(){
        (view.queue.items.length > 1 ? askConfirm("Drop all " + view.queue.items.length + " queued prompts?", { ok: "Drop them", danger: true }) : Promise.resolve(true))
          .then(function(ok){ if (ok) qAct("", { method: "DELETE" }); });
      };
      Array.prototype.forEach.call(el.querySelectorAll(".cqitem"), function(row){
        var id = row.getAttribute("data-qid");
        var at = view.queue.items.map(function(x){ return x.id; }).indexOf(id);
        // Drag to reorder. addEventListener, not ondragstart= : the on* drag
        // properties aren't universally present, and a reorder that silently
        // does nothing is the worst kind of broken. The arrows stay — they're
        // the path for anyone who can't drag.
        row.addEventListener("dragstart", function(ev){
          view.queue.dragging = id;
          row.classList.add("dragging");
          try { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", id); } catch (e) {}
        });
        row.addEventListener("dragend", function(){
          view.queue.dragging = null;
          row.classList.remove("dragging");
          Array.prototype.forEach.call(el.querySelectorAll(".cqitem"), function(x){ x.classList.remove("over"); });
        });
        row.addEventListener("dragover", function(ev){
          if (!view.queue.dragging || view.queue.dragging === id) return;
          ev.preventDefault();
          row.classList.add("over");
        });
        row.addEventListener("dragleave", function(){ row.classList.remove("over"); });
        row.addEventListener("drop", function(ev){
          ev.preventDefault();
          row.classList.remove("over");
          var from = view.queue.dragging;
          view.queue.dragging = null;
          if (!from || from === id) return;
          var to = view.queue.items.map(function(x){ return x.id; }).indexOf(id);
          if (to < 0) return;
          qAct("/" + encodeURIComponent(from), { method: "PATCH", body: JSON.stringify({ to: to }) });
        });
        var find = function(sel){ return row.querySelector(sel); };
        var text = find('[data-q="edit"]');
        if (text) text.onclick = function(){ view.queue.editing = id; drawQueue(); };
        var sel = find('[data-q="target"]');
        if (sel) sel.onchange = function(){
          qAct("/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ target: sel.value }) });
        };
        var box = find("[data-qedit]");
        if (box) {
          box.focus();
          var save = function(){
            var v = box.value.trim();
            view.queue.editing = null;
            if (!v || v === (view.queue.items[at] || {}).text) return drawQueue();
            qAct("/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ text: v }) });
          };
          box.onkeydown = function(e){
            if (e.key === "Escape") { e.preventDefault(); view.queue.editing = null; drawQueue(); }
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          };
          find('[data-q="save"]').onclick = save;
          find('[data-q="cancel"]').onclick = function(){ view.queue.editing = null; drawQueue(); };
        }
        find('[data-q="up"]').onclick = function(){
          qAct("/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ to: Math.max(0, at - 1) }) });
        };
        find('[data-q="down"]').onclick = function(){
          qAct("/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ to: at + 1 }) });
        };
        find('[data-q="rm"]').onclick = function(){ qAct("/" + encodeURIComponent(id), { method: "DELETE" }); };
        var steerBtn = find('[data-q="steer"]');
        if (steerBtn) steerBtn.onclick = function(){
          steerBtn.disabled = true;
          api("/api/projects/" + view.pid + "/queue/" + encodeURIComponent(id) + "/steer", { method: "POST" })
            .then(function(j){ toast(j && j.steered ? "steered into the running turn" : (j && j.reason) || "kept in the queue"); loadQueue(); })
            .catch(function(err){ toast(err.message); loadQueue(); });
        };
        var unhold = find('[data-q="unhold"]');
        if (unhold) unhold.onclick = function(){
          qAct("/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ when: null }) });
        };
      });
    }
return { loadQueue, onQueueFrame, wouldQueue, queueFromComposer };
}
