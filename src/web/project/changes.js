import { api } from '../connection.js';
import { diffBody,diffToggle,isLoomInternal,renderDiffFiles,renderDiffLines,splitPatch } from '../diff.js';
import { esc,mdToHtml } from '../format.js';
import { ICONS,LOADER } from '../icons.js';
import { askConfirm,toast } from '../notifications.js';
import { state } from '../state.js';

/** changes behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createChanges(view) {


    function reviewBar(){
      var bar = document.getElementById("reviewbar");
      if (!state.review.length) { if (bar) bar.remove(); return; }
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "reviewbar";
        bar.className = "reviewbar";
        var host = document.getElementById("dockpane");
        if (host) host.appendChild(bar);
      }
      bar.innerHTML = '<span>' + state.review.length + " review comment" + (state.review.length === 1 ? "" : "s") + "</span>" +
        '<button class="btn" id="reviewsend">stage in composer</button>' +
        '<button class="iconbtn" id="reviewclear" title="discard">' + ICONS.x + "</button>";
      var send = document.getElementById("reviewsend");
      if (send) send.onclick = function(){
        var box = document.getElementById("box");
        if (!box) return;
        box.value = "Review comments on your changes:\n\n" + state.review.map(function(c){
          return "- " + c.file + ":" + c.line + " \u2014 " + c.text;
        }).join("\n") + "\n\nAddress each one, or say why it should stay as it is.";
        box.focus();
        state.review = [];
        reviewBar();
        Array.prototype.forEach.call(document.querySelectorAll(".dl.commented"), function(el){
          el.classList.remove("commented");
        });
        toast("comments staged \u2014 pick the agent and send");
      };
      var clear = document.getElementById("reviewclear");
      if (clear) clear.onclick = function(){
        state.review = [];
        reviewBar();
        Array.prototype.forEach.call(document.querySelectorAll(".dl.commented"), function(el){
          el.classList.remove("commented");
        });
      };
    }


    function bindReviewClicks(){
      var pane = document.getElementById("pane-changes");
      if (!pane || pane.dataset.reviewBound) return;
      pane.dataset.reviewBound = "1";
      pane.addEventListener("click", function(ev){
        var row = ev.target.closest ? ev.target.closest(".dl.cmt") : null;
        if (!row) return;
        // An open editor on this row means the click is inside it — let it be.
        if (row.nextElementSibling && row.nextElementSibling.classList.contains("cmteditor")) return;
        var ed = document.createElement("div");
        ed.className = "cmteditor";
        ed.innerHTML = '<input placeholder="what\u2019s wrong with this line? \u21b5 to add" spellcheck="false">' +
          '<button class="iconbtn xs" title="cancel">' + ICONS.x + "</button>";
        row.after(ed);
        var input = ed.querySelector("input");
        input.focus();
        ed.querySelector("button").onclick = function(){ ed.remove(); };
        input.onkeydown = function(e){
          if (e.key === "Escape") { ed.remove(); return; }
          if (e.key !== "Enter") return;
          e.preventDefault();
          var text = input.value.trim();
          if (!text) { ed.remove(); return; }
          state.review.push({
            file: row.getAttribute("data-cfile"),
            line: row.getAttribute("data-cline"),
            text: text,
          });
          row.classList.add("commented");
          ed.remove();
          reviewBar();
        };
      });
    }


    // ---- diff/preview dock (right of the chat, opens on click) --------------
    function openDock(){ var d = document.getElementById("dockpane"); if (d) d.classList.add("open"); bindReviewClicks(); }

    function closeDock(){ var d = document.getElementById("dockpane"); if (d) d.classList.remove("open"); }

    function dockTitle(icon, label){
      var i = document.getElementById("dockicon"); if (i) i.innerHTML = icon || "";
      var h = document.getElementById("dockpath"); if (h) h.textContent = label || "";
    }

    // Show a working-tree file's diff (from the tree patch), or the whole tree.
    function openChangesDock(focusPath){
      openDock();
      dockTitle(focusPath ? ICONS.tree : ICONS.branch, focusPath || "Source control");
      var render = function(){
        var el = document.getElementById("pane-changes"); if (!el) return;
        var t = state.tree;
        if (!t) { el.innerHTML = LOADER; return; }
        if (!t.git) { el.innerHTML = '<div class="diffwrap"><div class="sys">not a git repository</div></div>'; return; }
        el.innerHTML = '<div class="diffwrap">' + renderDiffFiles(t) + "</div>";
        if (focusPath) {
          var files = splitPatch(t.patch).filter(function(f){ return !isLoomInternal(f.path); });
          var idx = -1;
          files.forEach(function(f, i){ if (f.path === focusPath) idx = i; });
          if (idx >= 0) { var tgt = document.getElementById("df-" + idx); if (tgt) tgt.scrollIntoView({ block: "start" }); }
        }
      };
      if (state.tree) render();
      else { document.getElementById("pane-changes").innerHTML = LOADER; api("/api/projects/" + view.pid + "/tree").then(function(j){ state.tree = j.tree || {}; render(); view.drawRail(); }).catch(function(){}); }
    }

    // Show a turn's combined patch (from a turn_diff card in the thread).
    function openPatchDock(patch, label, cp){
      openDock();
      dockTitle(ICONS.tree, label || "changes");
      var el = document.getElementById("pane-changes");
      var files = splitPatch(patch);
      el.innerHTML = diffToggle() + '<div class="diffwrap">' + (files.length
        ? files.map(function(f, i){
            return '<div class="dfile" id="df-' + i + '"><div class="dfh">' + ICONS.tree +
              '<span class="p">' + esc(f.path || "patch") + "</span>" +
              '<span class="cadd">+' + f.add + '</span><span class="cdel">−' + f.del + "</span>" +
              (cp && f.path ? '<button type="button" class="btn xs ghost dfrevert" data-rvfile="' + esc(f.path) + '" title="put just this file back the way it was before this turn">' + ICONS.rewind + "Revert file</button>" : "") +
              "</div>" +
              '<div class="dcode">' + diffBody(f.lines, f.path) + "</div></div>";
          }).join("")
        : '<div class="dcode">' + diffBody(String(patch).split("\n")) + "</div>") + "</div>";
      Array.prototype.forEach.call(el.querySelectorAll("[data-dv]"), function(b){
        b.onclick = function(){ try { localStorage.setItem("loomDiffView", b.getAttribute("data-dv")); } catch (e) {} openPatchDock(patch, label, cp); };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-rvfile]"), function(b){
        b.onclick = function(){
          var file = b.getAttribute("data-rvfile");
          askConfirm("Put " + file + " back the way it was before this turn?\n\nOnly this file changes. The version it replaces is saved first, so this can be undone from Rewind.", { ok: "Revert file" }).then(function(yes){
            if (!yes) return;
            b.disabled = true;
            api("/api/projects/" + view.pid + "/checkpoints/" + encodeURIComponent(cp) + "/rewind-file", { method: "POST", body: JSON.stringify({ path: file }) })
              .then(function(r){ b.textContent = r.removed ? "Removed" : "Reverted"; b.classList.add("done"); toast(file + (r.removed ? " removed — this turn created it" : " is back to how it was before this turn")); if (state.loadGitStat) state.loadGitStat(); })
              .catch(function(err){ b.disabled = false; toast(err.message); });
          });
        };
      });
      var sc = el; if (sc) sc.scrollTop = 0;
    }

    // Show a read-only file preview (from Explorer clicks).
    function openFileDock(relPath){
      openDock();
      dockTitle(ICONS.file, relPath);
      var el = document.getElementById("pane-changes"); el.innerHTML = LOADER;
      api("/api/projects/" + view.pid + "/file?path=" + encodeURIComponent(relPath)).then(function(j){
        var lines = String(j.content || "").split("\n");
        el.innerHTML = '<div class="filepreview">' + lines.map(function(line, i){
          return '<div class="fl"><span class="ln">' + (i + 1) + '</span><span class="lc">' + (esc(line) || " ") + "</span></div>";
        }).join("") + (j.truncated ? '<div class="sys">\u2026 file truncated at 400KB</div>' : "") + "</div>";
        el.scrollTop = 0;
      }).catch(function(err){ el.innerHTML = '<div class="sys err">' + esc(err.message) + "</div>"; });
    }
    /**
     * An artifact, shown as itself: a page or SVG or PDF in a sandboxed frame
     * (served from a short-lived preview link, so its own CSS, scripts and
     * images load — and it can't reach Loom), an image as an image, markdown
     * rendered. Anything else falls back to the source view.
     */
    function openArtifactDock(relPath){
      var ext = String(relPath).split(".").pop().toLowerCase();
      if (!/^(html?|svg|pdf|png|jpe?g|gif|webp|avif|md|markdown)$/.test(ext)) return openFileDock(relPath);
      openDock();
      dockTitle(/^(html?)$/.test(ext) ? ICONS.globe : /^(md|markdown|pdf)$/.test(ext) ? ICONS.file : ICONS.image, relPath);
      var el = document.getElementById("pane-changes"); el.innerHTML = LOADER;
      var bar = function(extra){
        return '<div class="artbar"><span class="artpath">' + esc(relPath) + '</span><span class="spacer"></span>' + (extra || "") +
          '<button type="button" class="btn xs ghost" data-artsrc title="show the source">' + ICONS.code + "Source</button></div>";
      };
      var wireBar = function(url){
        var src = el.querySelector("[data-artsrc]"); if (src) src.onclick = function(){ openFileDock(relPath); };
        var re = el.querySelector("[data-artreload]"); if (re) re.onclick = function(){ openArtifactDock(relPath); };
        var ex = el.querySelector("[data-artopen]"); if (ex && url) ex.onclick = function(){ window.open(url, "_blank", "noopener"); };
      };
      if (/^(md|markdown)$/.test(ext)) {
        api("/api/projects/" + view.pid + "/file?path=" + encodeURIComponent(relPath)).then(function(j){
          el.innerHTML = bar() + '<div class="artdoc md">' + mdToHtml(String(j.content || "")) + "</div>";
          wireBar(null);
        }).catch(function(err){ el.innerHTML = '<div class="sys err">' + esc(err.message) + "</div>"; });
        return;
      }
      if (/^(png|jpe?g|gif|webp|avif)$/.test(ext)) {
        el.innerHTML = bar() + '<div class="artimg"><img data-projimg="' + esc(relPath) + '" alt="' + esc(relPath) + '"></div>';
        wireBar(null);
        return;
      }
      api("/api/projects/" + view.pid + "/preview", { method: "POST", body: JSON.stringify({ path: relPath }) }).then(function(j){
        el.innerHTML = bar('<button type="button" class="btn xs ghost" data-artreload title="reload">' + ICONS.refresh + "Reload</button>" +
            '<button type="button" class="btn xs ghost" data-artopen title="open in your browser">' + ICONS.external + "Open</button>") +
          '<iframe class="artframe" src="' + esc(j.url) + '" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" referrerpolicy="no-referrer" title="' + esc(relPath) + '"></iframe>';
        wireBar(location.origin + j.url);
      }).catch(function(err){ el.innerHTML = '<div class="sys err">' + esc(err.message) + "</div>"; });
    }

    /** An html/svg code block from the thread, rendered in the same sandbox (no file, so no relative assets). */
    function openCodePreview(code, lang){
      openDock();
      dockTitle(ICONS.globe, (lang || "html") + " preview");
      var el = document.getElementById("pane-changes");
      var doc = lang === "svg" || lang === "xml"
        ? '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}svg{max-width:100%;max-height:100vh}</style>' + code
        : code;
      el.innerHTML = '<div class="artbar"><span class="artpath">' + esc((lang || "html").toUpperCase()) + ' from the thread \u00b7 sandboxed</span></div>' +
        '<iframe class="artframe" sandbox="allow-scripts allow-forms allow-popups allow-modals" referrerpolicy="no-referrer" title="preview"></iframe>';
      el.querySelector("iframe").srcdoc = doc;
    }
return { closeDock, openChangesDock, openPatchDock, openFileDock, openArtifactDock, openCodePreview };
}
