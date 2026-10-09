import { brandMark,kindOf } from '../agents.js';
import { api } from '../connection.js';
import { esc,rel } from '../format.js';
import { ICONS,LOADER } from '../icons.js';
import { askText,toast } from '../notifications.js';
import { openSettingsModal } from '../settings.js';
import { teamShareHtml,wireTeamShare } from '../team.js';
import { showContinuityOverflow } from './continuity.js';
import { emptyArt } from '../transcript.js';
import { state } from '../state.js';

/** brain behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createBrain(view) {


    function refreshBrain(){
      if (view.brainView === "team") return refreshTeamBrain();
      var el = document.getElementById("pane-brain"); if (!el) return;
      if (!el.querySelector(".brain")) el.innerHTML = '<div class="pane-inner">' + LOADER + "</div>";
      // Two reads: the learned memory units (the star), and the imported ADE
      // sources (context — what Loom pulled in from CLAUDE.md and friends).
      Promise.all([
        api("/api/projects/" + view.pid + "/brain?limit=200"),
        api("/api/projects/" + view.pid + "/memory").catch(function(){ return { memory: {} }; }),
        api("/api/projects/" + view.pid + "/brain/usage").catch(function(){ return { usage: {} }; }),
        api("/api/projects/" + view.pid + "/brain/continuity").catch(function(){ return { enabled: false }; }),
      ]).then(function(r){
        var usage = (r[2] && r[2].usage) || {};
        el = document.getElementById("pane-brain"); if (!el || view.brainView !== "mine") return;
        var memories = (r[0] && r[0].memories) || [];
        var stats = (r[0] && r[0].stats) || { total: 0, byKind: {} };
        var m = (r[1] && r[1].memory) || {};
        var sources = m.sources || [];
        var continuity = r[2] || {};

        // Filter chips — All, then each kind that has memories, with its count.
        var chips = '<button class="bkind' + (view.brainKind === "" ? " on" : "") + '" data-kind="">All <span class="kn">' + (stats.total || 0) + "</span></button>";
        view.BRAIN_KINDS.forEach(function(k){
          var n = (stats.byKind && stats.byKind[k]) || 0;
          if (!n && view.brainKind !== k) return; // hide empty kinds unless selected
          chips += '<button class="bkind bk-' + k + (view.brainKind === k ? " on" : "") + '" data-kind="' + k + '">' + k + ' <span class="kn">' + n + "</span></button>";
        });
        var head = '<div class="bhead">' + brainSwitchHtml() + '<div class="bkinds">' + chips + "</div>" +
          '<div class="bio"><button type="button" class="btn xs ghost" id="bexport" title="download what this project knows, as JSON">' + ICONS.download + "Export</button>" +
          '<button type="button" class="btn xs ghost" id="bimport" title="bring in a brain exported from Loom (duplicates are skipped)">' + ICONS.plus + "Import</button>" +
          '<input type="file" id="bimportf" accept="application/json,.json" hidden></div></div>' +
          '<div class="bsort"><span>Sort</span><button type="button" data-bsort="new" class="' + (state.brainSort !== "used" ? "on" : "") + '">Newest</button>' +
          '<button type="button" data-bsort="used" class="' + (state.brainSort === "used" ? "on" : "") + '" title="how often each memory reached an agent’s prompt">Most used</button>' +
          '<span style="margin-left:auto">View</span><button type="button" data-bgv="list" class="' + (!state.brainGraph ? "on" : "") + '">List</button>' +
          '<button type="button" data-bgv="graph" class="' + (state.brainGraph ? "on" : "") + '" title="memories joined by the files and symbols they share">Graph</button></div>';
        if (continuity.enabled) head += '<div class="bsec">Native continuity <button class="lnk" id="continuity-inspect">Inspect packets and delivery</button></div><div class="bsec">Legacy memories below are retained for compatibility and are not injected by native continuity.</div>';

        // The memory list — the learned units. This is what phase 2 fills.
        var shown = view.brainKind ? memories.filter(function(x){ return x.kind === view.brainKind; }) : memories;
        if (state.brainSort === "used") {
          shown = shown.slice().sort(function(a, b){ return ((usage[b.id] || {}).n || 0) - ((usage[a.id] || {}).n || 0); });
        }
        var list;
        if (!shown.length) {
          list = '<div class="bempty">' + (memories.length ? "" : emptyArt("brain")) + (memories.length
            ? "No " + esc(view.brainKind) + " memories yet."
            : continuity.enabled ? "Your original user messages are protected automatically. Review packets and source-backed checkpoints through native continuity diagnostics." : "Nothing learned yet. As agents finish turns, Loom reads each one and records what's worth keeping — constraints, decisions, and the failures worth not repeating. Add a decision below to seed it, or let an agent take a turn.") + "</div>";
        } else if (state.brainGraph) {
          list = '<div class="bgraph" id="bgraph"></div>';
        } else {
          list = '<div class="bmems">' + shown.map(function(x){
            var ents = (x.entities || []).slice(0, 6).map(function(e){ return '<span class="bent">' + esc(e) + "</span>"; }).join("");
            var conf = Math.round((x.confidence == null ? 1 : x.confidence) * 100);
            var who = (x.provenance && x.provenance.agentId) || "user";
            var when = x.updatedAt ? rel(x.updatedAt) : "";
            var low = conf < 60;
            return '<div class="bmem' + (low ? " low" : "") + '" data-mid="' + esc(x.id) + '">' +
              '<div class="bmrow"><span class="bbadge bk-' + esc(x.kind) + '">' + esc(x.kind) + "</span>" +
              '<span class="bmtext">' + esc(x.text) + "</span>" +
              '<button class="bedit iconbtn xs" data-medit="' + esc(x.id) + '" title="correct this" aria-label="edit this memory">' + ICONS.pencil + "</button>" +
              '<button class="bforget iconbtn xs" data-forget="' + esc(x.id) + '" title="forget this" aria-label="forget this memory">' + ICONS.x + "</button></div>" +
              (ents ? '<div class="bents">' + ents + "</div>" : "") +
              '<div class="bmmeta">' + brandMark(kindOf(who)) + esc(who) +
              (when ? ' <span class="dim">\u00b7 ' + esc(when) + "</span>" : "") +
              (low ? ' <span class="dim">· ' + conf + '% — shown, not injected</span>' : "") +
              (usage[x.id] ? ' <span class="bused" title="reached an agent’s prompt ' + usage[x.id].n + " time" + (usage[x.id].n === 1 ? "" : "s") + ", last " + esc(rel(usage[x.id].at)) + '">used ' + usage[x.id].n + "×</span>" : "") +
              "</div></div>";
          }).join("") + "</div>";
        }

        // Seed box — a decision you type. It dual-writes into the brain, so it's
        // the manual counterpart to what the extractor does automatically.
        var seed = '<form class="bseed" id="decform">' +
          '<input id="decbox" placeholder="Record a decision or fact this project has made\u2026" autocomplete="off">' +
          '<button class="btn primary sm" type="submit">Add</button></form>';

        // Imported ADE memory — secondary, folded under a quiet header.
        var src = '<div class="bsec">Imported from your agents<span class="bhint">their own memory files</span>' +
          '<button class="lnk" id="reimport" style="margin-left:auto">re-import</button></div>';
        src += sources.length
          ? '<div class="bsrcs">' + sources.map(function(s){
              return '<div class="bsrcrow">' + brandMark(s.kind) +
                '<span class="si">' + esc(s.agentId) + "</span>" +
                '<span class="sf mono">' + esc(s.file) + "</span>" +
                '<span class="sc">' + Math.round(s.chars / 1024 * 10) / 10 + "k</span></div>";
            }).join("") + "</div>"
          : '<div class="bempty sm">No native ADE memory found (CLAUDE.md, AGENTS.md, .kiro/steering). Loom reads these but never writes to them.</div>';

        el.innerHTML = '<div class="pane-inner brain">' + head + seed + '<div id="bconflicts"></div>' + list + src + "</div>";
        wireBrainSwitch(el);
        if (state.brainGraph && shown.length) view.drawMemGraph(document.getElementById("bgraph"), shown, usage);
        Array.prototype.forEach.call(el.querySelectorAll("[data-bgv]"), function(b){
          b.onclick = function(){ state.brainGraph = b.getAttribute("data-bgv") === "graph"; refreshBrain(); };
        });
        var inspect = el.querySelector("#continuity-inspect");
        if(inspect) inspect.onclick = function(){
          var scrim = document.createElement("div"); scrim.className = "scrim";
          scrim.innerHTML = '<div class="modal"><div class="modalhead">Continuity delivery<button class="iconbtn" data-close aria-label="close">' + ICONS.x + '</button></div><div class="modalbody"><p>Acceptance records native protocol evidence. Retention and understanding remain unknown. Showing the latest 100 attempts.</p><div data-attempts></div></div></div>';
          function close(){ scrim.remove(); document.removeEventListener("keydown", key); }
          function key(e){ if(e.key === "Escape") close(); }
          document.addEventListener("keydown", key); scrim.querySelector("[data-close]").onclick = close;
          scrim.addEventListener("click", function(e){ if(e.target === scrim) close(); });
          (continuity.receipts || []).slice().reverse().forEach(function(entry){
            var details = document.createElement("details"), title = document.createElement("summary"), pre = document.createElement("pre");
            title.textContent = entry.packet.conversationId + " — " + entry.receipt.status + " / " + entry.receipt.execution + " — ~" + entry.packet.budget.estimatedAddedTokens + " added tokens";
            pre.textContent = JSON.stringify(entry, null, 2); pre.style.cssText = "max-height:280px;overflow:auto;white-space:pre-wrap";
            details.addEventListener("toggle", function(){
              if(!details.open || details.dataset.loaded) return; details.dataset.loaded = "1";
              api("/api/projects/" + view.pid + "/brain/continuity/packets/" + encodeURIComponent(entry.packet.id)).then(function(full){
                pre.textContent = JSON.stringify({ receipt: entry.receipt, packet: full.packet, rendered: full.rendered }, null, 2);
              }).catch(function(e){ pre.textContent = e.message; delete details.dataset.loaded; });
            });
            details.append(title, pre);
            if(entry.receipt.status === "prepared") {
              var resume = document.createElement("button"); resume.className = "btn"; resume.textContent = "Review and resume saved request";
              resume.onclick = function(){ close(); showContinuityOverflow(view, { requestId: entry.receipt.requestId }); }; details.appendChild(resume);
            }
            scrim.querySelector("[data-attempts]").appendChild(details);
          });
          document.body.appendChild(scrim);
        };

        // Contradictions, above the units: two memories that likely disagree
        // are worth more attention than either alone. Quiet when clean.
        api("/api/projects/" + view.pid + "/brain/conflicts").then(function(j){
          var host = document.getElementById("bconflicts");
          if (!host || !j.conflicts || !j.conflicts.length) return;
          host.innerHTML = '<div class="bsec" style="color:var(--err)">\u26a0 ' + j.conflicts.length +
            " likely contradiction" + (j.conflicts.length === 1 ? "" : "s") +
            '<span class="bhint">resolve by forgetting or editing one side</span></div>' +
            j.conflicts.slice(0, 5).map(function(c){
              return '<div class="bconf"><span class="bconfsig">' + esc(c.signal) + "</span>" +
                '<div class="bconfpair"><div>A \u00b7 ' + esc(c.a.text.slice(0, 110)) + "</div>" +
                "<div>B \u00b7 " + esc(c.b.text.slice(0, 110)) + "</div></div></div>";
            }).join("");
        }).catch(function(){});

        Array.prototype.forEach.call(el.querySelectorAll(".bkind"), function(b){
          b.onclick = function(){ view.brainKind = b.getAttribute("data-kind"); refreshBrain(); };
        });
        Array.prototype.forEach.call(el.querySelectorAll("[data-bsort]"), function(b){
          b.onclick = function(){ state.brainSort = b.getAttribute("data-bsort"); refreshBrain(); };
        });
        Array.prototype.forEach.call(el.querySelectorAll("[data-medit]"), function(b){
          b.onclick = function(ev){
            ev.stopPropagation();
            var id = b.getAttribute("data-medit");
            var cur = memories.filter(function(m){ return m.id === id; })[0];
            if (!cur) return;
            askText("Correct this memory", { value: cur.text, multiline: true, required: true, note: "Agents get the new wording from their next turn. The old one stays in its history.", ok: "Save" }).then(function(text){
              if (text === null || !text.trim() || text.trim() === cur.text) return;
              api("/api/projects/" + view.pid + "/brain/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ text: text.trim() }) })
                .then(function(){ toast("updated · the old wording stays in its history"); refreshBrain(); })
                .catch(function(err){ toast(err.message); });
            });
          };
        });
        var bex = document.getElementById("bexport");
        if (bex) bex.onclick = function(){
          api("/api/projects/" + view.pid + "/brain/export").then(function(dump){
            var blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
            var a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = String((state.project && state.project.name) || "loom").replace(/[^\w.-]+/g, "-") + "-brain.json";
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
            toast("exported " + ((dump && dump.memories && dump.memories.length) || 0) + " memories");
          }).catch(function(err){ toast(err.message); });
        };
        var bim = document.getElementById("bimport"), bif = document.getElementById("bimportf");
        if (bim && bif) {
          bim.onclick = function(){ bif.value = ""; bif.click(); };
          bif.onchange = function(){
            var f = bif.files && bif.files[0]; if (!f) return;
            if (f.size > 1900000) { toast("that file is over 2 MB — too big to import in one go"); return; }
            f.text().then(function(txt){
              var body;
              try { body = JSON.parse(txt); } catch (e) { throw new Error("that isn’t a JSON file"); }
              return api("/api/projects/" + view.pid + "/brain/import", { method: "POST", body: JSON.stringify(body) });
            }).then(function(r){
              toast("imported " + (r.added || 0) + " new · " + (r.known || 0) + " already known");
              refreshBrain();
            }).catch(function(err){ toast(err.message); });
          };
        }
        Array.prototype.forEach.call(el.querySelectorAll("[data-forget]"), function(b){
          b.onclick = function(ev){
            ev.stopPropagation();
            var id = b.getAttribute("data-forget");
            askText("Forget this memory — why?", { value: "no longer true", note: "It leaves the brain; its history stays.", ok: "Forget" }).then(function(reason){
              if (reason === null) return;
              api("/api/projects/" + view.pid + "/brain/" + id + "?reason=" + encodeURIComponent(reason.trim() || "forgotten"), { method: "DELETE" })
                .then(function(){ toast("forgotten · its history stays"); refreshBrain(); })
                .catch(function(err){ toast(err.message); });
            });
          };
        });
        var reimp = document.getElementById("reimport");
        if (reimp) reimp.onclick = function(){
          api("/api/projects/" + view.pid + "/memory/import", { method: "POST", body: "{}" })
            .then(function(rr){ toast(rr.imported ? "imported " + rr.imported + " source(s)" : "already current"); refreshBrain(); })
            .catch(function(err){ toast(err.message); });
        };
        // Add is live only when there's something to add — an Add that did
        // nothing on an empty box looked broken.
        var decBtn = document.querySelector("#decform button[type=submit]");
        var decBox = document.getElementById("decbox");
        var decSync = function(){ if (decBtn) decBtn.disabled = !(decBox.value || "").trim(); };
        decBox.addEventListener("input", decSync); decSync();
        document.getElementById("decform").onsubmit = function(ev){
          ev.preventDefault();
          var box = decBox;
          var text = (box.value || "").trim();
          if (!text || (decBtn && decBtn.getAttribute("data-busy"))) return;
          if (decBtn) { decBtn.setAttribute("data-busy", "1"); decBtn.disabled = true; }
          api("/api/projects/" + view.pid + "/decisions", { method: "POST", body: JSON.stringify({ text: text }) })
            .then(function(){ box.value = ""; toast("saved to memory"); refreshBrain(); })
            .catch(function(err){ toast(err.message); })
            .then(function(){ if (decBtn) decBtn.removeAttribute("data-busy"); decSync(); });
        };
      }).catch(function(err){ toast(err.message); });
    }

    function brainSwitchHtml(){
      return '<div class="seg bview" role="group" aria-label="whose brain">' + [["mine", "Mine"], ["team", "Team"]].map(function(o){
        return '<button type="button" data-bview="' + o[0] + '" class="' + (view.brainView === o[0] ? "on" : "") + '">' + o[1] + "</button>";
      }).join("") + "</div>";
    }

    function wireBrainSwitch(el){
      Array.prototype.forEach.call(el.querySelectorAll("[data-bview]"), function(b){
        b.onclick = function(){
          if (view.brainView === b.getAttribute("data-bview")) return;
          view.brainView = b.getAttribute("data-bview"); refreshBrain();
        };
      });
    }

    function refreshTeamBrain(sync){
      var el = document.getElementById("pane-brain"); if (!el) return;
      if (!el.querySelector(".tbrain")) {
        el.innerHTML = '<div class="pane-inner brain tbrain"><div class="bhead">' + brainSwitchHtml() + "</div>" + LOADER + "</div>";
        wireBrainSwitch(el);
      }
      api("/api/projects/" + view.pid + "/team/brain?sync=" + (sync ? 1 : 0) + "&history=" + (view.tbHistory ? 1 : 0))
        .then(drawTeamBrain, function(err){ drawTeamBrain({ error: err.message }); });
    }

    function tbChip(cls, word){ return '<span class="bbadge ' + cls + '">' + esc(word) + "</span>"; }

    function tierWord(t){ return (view.TB_TIERS.filter(function(x){ return x[0] === t; })[0] || [t, t])[1]; }

    function tbBy(m){
      var n = (m.confirmedBy || []).length;
      return (m.mine ? "yours" : m.author ? "by " + esc(m.author) : "") + (n > 1 ? " \u00b7 confirmed by " + n : "") + (m.untrusted ? " \u00b7 untrusted" : "");
    }

    /** An action button; its POST body rides along as JSON. */
    function tbBtn(label, action, body, primary){
      return '<button type="button" class="btn xs ' + (primary ? "primary" : "outline") + '" data-tbact="' + action + '" data-tbbody="' + esc(JSON.stringify(body)) + '">' + label + "</button>";
    }

    function tbSide(tag, m){
      return '<div class="tbside"><span class="tbab">' + tag + "</span>" + tbChip("tbt-" + esc(m.tier), tierWord(m.tier)) +
        '<span class="bmtext">' + esc(m.text) + (tbBy(m) ? " <small>" + tbBy(m) + "</small>" : "") + "</span></div>";
    }

    function tbInboxHtml(it){
      var a = it.a || {}, b = it.b, acts = "";
      if ((it.type === "correction" || it.type === "contradiction") && b) {
        acts = tbBtn("Keep A", "resolve", { winner: a.id, loser: b.id }) + tbBtn("Keep B", "resolve", { winner: b.id, loser: a.id });
      } else if (it.type === "duplicate" && b) acts = tbBtn("Merge", "merge", { keep: a.id, drop: b.id }, true);
      else if (it.type === "untrusted") acts = tbBtn("Trust &amp; share", "trust", { id: a.id }, true) + tbBtn("Keep private", "private", { id: a.id });
      else if (it.type === "promote") acts = tbBtn("Propose as canon", "promote", { ids: [a.id] }, true);
      return '<div class="tbcard ' + esc(it.type) + '" data-tbin="' + esc(it.id) + '"><div class="tbih">' + tbChip("tbi-" + esc(it.type), it.type) +
        "<span>" + esc(it.detail) + "</span></div>" + tbSide(b ? "A" : "", a) + (b ? tbSide("B", b) : "") +
        (acts ? '<div class="tbacts">' + acts + "</div>" : "") + "</div>";
    }

    function tbMemHtml(m){
      var old = m.state && m.state !== "live", acts = "";
      if (!old) {
        if (m.tier !== "canon" && !m.mine) acts += tbBtn("Correct\u2026", "correct", { id: m.id });
        if (m.tier === "confirmed" || m.tier === "own") acts += tbBtn("Propose as canon", "promote", { ids: [m.id] });
        if (m.tier === "own") acts += tbBtn("Private", "private", { id: m.id });
      }
      var hist = !old ? "" : m.supersededBy
        ? "superseded by " + esc(m.supersededBy) + (m.resolvedReason ? " \u2014 " + esc(m.resolvedReason) : "") + (m.resolvedBy ? " (" + esc(m.resolvedBy) + ")" : "")
        : esc(m.state) + (m.resolvedReason ? " \u2014 " + esc(m.resolvedReason) : "") + (m.resolvedBy ? " (" + esc(m.resolvedBy) + ")" : "");
      return '<div class="bmem tbmem' + (old ? " old" : "") + '" data-tbid="' + esc(m.id) + '">' +
        '<div class="bmrow">' + tbChip("tbt-" + esc(m.tier), tierWord(m.tier)) + '<span class="bmtext">' + esc(m.text) + "</span></div>" +
        '<div class="bmmeta">' + tbChip("bk-" + esc(m.kind), m.kind) + (tbBy(m) ? " " + tbBy(m) : "") + "</div>" +
        (hist ? '<div class="tbhist">' + hist + "</div>" : "") +
        (acts ? '<div class="tbacts">' + acts + "</div>" : "") + "</div>";
    }

    function drawTeamBrain(j){
      var el = document.getElementById("pane-brain"); if (!el || view.brainView !== "team") return;
      var st = j.status || {}, h = '<div class="bhead">' + brainSwitchHtml() + "</div>";
      if (j.error) h += '<div class="tberr">' + esc(j.error) + "</div>";
      else if (!st.shared) {
        var share = typeof teamShareHtml === "function" ? teamShareHtml(view.pid, true) : "";
        h += '<div class="bempty">This project isn\u2019t shared with a team. ' + (share
          ? "Share it and its memories reach your teammates, and theirs reach your agents.</div>" + share
          : 'Set up a team in <button type="button" class="lnk" id="tbsetup">Settings \u2192 Team</button>.</div>');
      } else {
        var mems = j.memories || [], inbox = j.inbox || [];
        h += '<div class="tbtop">' + (st.repo ? "<code>" + esc(st.repo) + "</code>" : "") +
          '<span class="tbn">' + (st.canon || 0) + " canon \u00b7 " + (st.team || 0) + " team \u00b7 " + (st.confirmed || 0) + " confirmed \u00b7 " + (st.mine || 0) + " yours</span>" +
          '<span class="tbsp"><button type="button" class="btn xs ghost" id="tbhist">' + (view.tbHistory ? "Hide history" : "Show history") + "</button>" +
          '<button type="button" class="btn xs outline" id="tbsync">Sync</button></span></div>';
        if (st.lastError) h += '<div class="tberr">' + esc(st.lastError) + "</div>";
        if (view.tbPr) h += '<div class="tbpr">' + (view.tbPr.url ? 'Canon PR: <a href="' + esc(view.tbPr.url) + '" target="_blank" rel="noopener">' + esc(view.tbPr.url) + "</a>" : esc(view.tbPr.note)) +
          '<button type="button" class="iconbtn xs" id="tbprx" aria-label="dismiss">' + ICONS.x + "</button></div>";
        if (inbox.length) h += '<div class="bsec">Inbox <span class="bhint">' + inbox.length + " need" + (inbox.length === 1 ? "s" : "") + " a human</span></div>" + inbox.map(tbInboxHtml).join("");
        view.TB_TIERS.forEach(function(t){
          var rows = mems.filter(function(m){ return m.tier === t[0]; });
          if (rows.length) h += '<div class="bsec">' + t[1] + ' <span class="bhint">' + rows.length + '</span></div><div class="bmems">' + rows.map(tbMemHtml).join("") + "</div>";
        });
        if (!mems.length && !inbox.length) h += '<div class="bempty">Nothing shared yet. As you and your teammates\u2019 agents learn, durable memories show up here \u2014 confirmed by two people, they can become canon in AGENTS.md.</div>';
      }
      el.innerHTML = '<div class="pane-inner brain tbrain">' + h + "</div>";
      wireBrainSwitch(el);
      if (typeof wireTeamShare === "function") wireTeamShare(el, function(){ refreshTeamBrain(true); });
      var su = document.getElementById("tbsetup"); if (su) su.onclick = function(){ openSettingsModal("team"); };
      var hb = document.getElementById("tbhist"); if (hb) hb.onclick = function(){ view.tbHistory = !view.tbHistory; refreshTeamBrain(); };
      var sb = document.getElementById("tbsync"); if (sb) sb.onclick = function(){ teamBrainAct("sync", {}, sb); };
      var px = document.getElementById("tbprx"); if (px) px.onclick = function(){ view.tbPr = null; drawTeamBrain(j); };
      Array.prototype.forEach.call(el.querySelectorAll("[data-tbact]"), function(b){
        b.onclick = function(){
          var action = b.getAttribute("data-tbact"), body = JSON.parse(b.getAttribute("data-tbbody") || "{}");
          if (action === "correct") {
            var cur = mems.filter(function(m){ return m.id === body.id; })[0];
            askText("Correct this memory — what’s true instead?", { value: cur ? cur.text : "", note: "Theirs stays in history.", multiline: true, required: true, ok: "Correct" }).then(function(text){
              if (text === null || !text.trim()) return;
              body.text = text.trim();
              teamBrainAct(action, body, b);
            });
            return;
          } else if (action === "resolve") {
            askText("Why keep this one?", { note: "The other stays in history.", ok: "Keep this one" }).then(function(why){
              if (why === null) return;
              body.reason = why.trim();
              teamBrainAct(action, body, b);
            });
            return;
          }
          teamBrainAct(action, body, b);
        };
      });
    }

    function teamBrainAct(action, body, btn){
      if (btn) btn.disabled = true;
      return api("/api/projects/" + view.pid + "/team/brain/" + action, { method: "POST", body: JSON.stringify(body || {}) })
        .then(function(j){
          var r = j.result || {};
          if (action === "promote") {
            view.tbPr = r.prUrl && /^https?:/i.test(r.prUrl) ? { url: r.prUrl } : { note: r.note || ("proposed on " + (r.branch || "loom/canon")) };
            toast(r.prUrl ? "canon PR updated" : "proposed as canon");
          } else toast(action === "sync" ? "synced" : "done");
          if (view.tbHistory) refreshTeamBrain(); else drawTeamBrain(j); // the answer carries the live view only
        }, function(err){ toast(err.message); if (btn) btn.disabled = false; });
    }
return { refreshBrain, refreshTeamBrain };
}
