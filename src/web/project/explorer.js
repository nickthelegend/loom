import { brandMark,wireRoleEditors } from '../agents.js';
import { api } from '../connection.js';
import { visibleFiles } from '../diff.js';
import { esc,highlight,hue } from '../format.js';
import { ICONS,LOADER } from '../icons.js';
import { openMenu,openScmMenu } from '../menus.js';
import { copyText } from '../clipboard.js';
import { toast } from '../notifications.js';
import { state } from '../state.js';
import { openTaskModal } from '../tasks.js';
import { relClock } from '../transcript.js';

/** explorer behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createExplorer(view) {


    // ---- right rail (source control) ----------------------------------------
    // ---- right rail: Explorer / Search / Source Control / Tasks ------------
    function railTitle(html){ var h = document.getElementById("railtitle"); if (h) h.innerHTML = html; }

    function openFileFromTree(relPath){
      var t = state.tree;
      var changed = t && t.git && visibleFiles(t).some(function(f){ return f.path === relPath; });
      // pages, pictures and docs open as themselves (Source is one click away); a changed text file opens its diff
      if (/\.(html?|svg|png|jpe?g|gif|webp|avif|pdf|md|markdown)$/i.test(relPath) && view.openArtifactDock) view.openArtifactDock(relPath);
      else if (changed) view.openChangesDock(relPath); else view.openFileDock(relPath);
    }

    function drawRail(){
      var el = document.getElementById("railbody"); if (!el) return;
      var bar = document.querySelector(".railbar");
      if (bar) Array.prototype.forEach.call(bar.querySelectorAll(".rvbtn"), function(b){
        b.classList.toggle("active", b.getAttribute("data-view") === state.railView);
      });
      el.className = "rbody" + (state.railView === "explorer" || state.railView === "search" ? "" : " pad");
      if (state.railView === "search") return drawSearch(el);
      if (state.railView === "scm") return drawScm(el);
      if (state.railView === "tasks") return drawAgentsView(el);
      if (state.railView === "outline") return drawOutline(el);
      return drawExplorer(el);
    }
    /** The chat at a glance: each of your prompts, click to go there. */
    function drawOutline(el){
      railTitle('<span class="b">Outline</span>');
      var mine = Array.prototype.slice.call(document.querySelectorAll("#feed > .msg.user[data-raw]"));
      var more = !!document.getElementById("loadearlier");
      if (!mine.length) { el.innerHTML = '<div class="olempty">Nothing asked in this chat yet — your prompts will line up here.</div>'; return; }
      el.innerHTML = '<div class="olhead">This chat · ' + mine.length + " prompt" + (mine.length === 1 ? "" : "s") + (more ? " loaded" : "") + "</div>" +
        mine.map(function(n, i){
          var t = decodeURIComponent(n.getAttribute("data-raw") || "").replace(/\s+/g, " ").trim();
          var ts = Number(n.getAttribute("data-ts")) || 0;
          return '<button type="button" class="olrow" data-olid="' + esc(n.getAttribute("data-id") || "") + '"><span class="oln">' + (i + 1) + "</span>" +
            '<span class="olt">' + esc(t.slice(0, 140) || "(attachment)") + '</span><span class="olw">' + (ts ? esc(relClock(ts)) : "") + "</span></button>";
        }).join("") +
        (more ? '<button type="button" class="olmore" id="olmore">Load earlier prompts</button>' : "");
      Array.prototype.forEach.call(el.querySelectorAll("[data-olid]"), function(b){
        b.onclick = function(){ view.jumpToMessage(Number(b.getAttribute("data-olid"))); };
      });
      var om = document.getElementById("olmore");
      if (om) om.onclick = function(){ view.loadEarlier().then(function(){ drawRail(); }); };
    }

    function renderTreeLevel(rel, depth){
      var kids = view.expl.kids[rel]; if (!kids) return "";
      return kids.map(function(e){
        var pad = 6 + depth * 12;
        if (e.dir) {
          var isOpen = !!view.expl.open[e.path];
          return '<div class="trow dir' + (isOpen ? " open" : "") + '" data-dir="' + esc(e.path) + '" style="padding-left:' + pad + 'px">' +
            '<span class="tw">' + ICONS.chevron + '</span><span class="ti">' + ICONS.folder + '</span><span class="tn">' + esc(e.name) + "</span></div>" +
            (isOpen ? '<div class="tchild">' + renderTreeLevel(e.path, depth + 1) + "</div>" : "");
        }
        return '<div class="trow file" data-file="' + esc(e.path) + '" style="padding-left:' + (pad + 12) + 'px">' +
          '<span class="ti">' + ICONS.file + '</span><span class="tn">' + esc(e.name) + "</span></div>";
      }).join("");
    }

    function loadDir(rel){
      api("/api/projects/" + view.pid + "/files?dir=" + encodeURIComponent(rel)).then(function(j){
        view.expl.kids[rel] = j.entries || [];
        if (state.railView === "explorer") drawExplorer(document.getElementById("railbody"));
      }).catch(function(err){ toast(err.message); });
    }

    function drawExplorer(el){
      railTitle('<span class="b">' + esc(state.project ? state.project.name : "Explorer") + "</span>");
      if (!view.expl.kids["."]) { el.innerHTML = LOADER; loadDir("."); return; }
      el.innerHTML = renderTreeLevel(".", 0) || '<div class="rempty">this project has no files yet</div>';
      Array.prototype.forEach.call(el.querySelectorAll(".trow"), function(row){
        row.onclick = function(){
          var d = row.getAttribute("data-dir");
          if (d) {
            view.expl.open[d] = !view.expl.open[d];
            if (view.expl.open[d] && !view.expl.kids[d]) loadDir(d);
            else drawExplorer(el);
            return;
          }
          var f = row.getAttribute("data-file");
          if (f) openFileFromTree(f);
        };
        row.oncontextmenu = function(ev){
          ev.preventDefault();
          treeMenu(row.getAttribute("data-file"), row.getAttribute("data-dir"), ev.clientX, ev.clientY, el);
        };
      });
    }

    /** Put text into the composer (appended), focus it, and keep the draft. */
    function toComposer(text){
      var box = document.getElementById("box"); if (!box) { toast("open the chat to use the composer"); return; }
      if (state.showTab) state.showTab("thread");
      var cur = box.value.replace(/\s+$/, "");
      box.value = (cur ? cur + " " : "") + text;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.focus(); box.setSelectionRange(box.value.length, box.value.length);
    }

    /** Right-click a file or folder in the tree. */
    function treeMenu(file, dir, x, y, el){
      var rel = file || dir;
      if (!rel) return;
      var root = (state.project && state.project.dir) || "";
      var abs = root ? root.replace(/\/$/, "") + "/" + rel.replace(/^\.\//, "") : rel;
      var items = [{ head: rel.split("/").pop() || rel }];
      if (file) {
        items.push({ label: "Open", icon: ICONS.file, run: function(){ openFileFromTree(file); } });
        items.push({ label: "Mention in chat", icon: ICONS.chat, hint: "@" + file.split("/").pop(), run: function(){ toComposer("@" + file + " "); } });
        items.push({ label: "Ask an agent about it", icon: ICONS.sparkles, run: function(){ toComposer("Explain what @" + file + " does and how it fits into the project."); } });
        items.push({ label: "Make a card for it", icon: ICONS.board, run: function(){ openTaskModal(view.pid, null, "Work on " + file); } });
      } else {
        var open = !!view.expl.open[dir];
        items.push({ label: open ? "Collapse" : "Expand", icon: ICONS.folder, run: function(){
          view.expl.open[dir] = !open;
          if (!open && !view.expl.kids[dir]) loadDir(dir); else drawExplorer(el);
        } });
        items.push({ label: "Mention in chat", icon: ICONS.chat, hint: "@" + dir.split("/").pop() + "/", run: function(){ toComposer("@" + dir + "/ "); } });
      }
      items.push({ sep: true });
      items.push({ label: "Copy relative path", icon: ICONS.copy, run: function(){ copyText(rel); toast("copied " + rel); } });
      if (root) items.push({ label: "Copy full path", icon: ICONS.copy, run: function(){ copyText(abs); toast("copied"); } });
      if (window.loomNative && window.loomNative.reveal && root) {
        items.push({ label: navigator.platform.indexOf("Mac") >= 0 ? "Reveal in Finder" : "Show in folder", icon: ICONS.folder, run: function(){ window.loomNative.reveal(abs); } });
      }
      if (state.termRun && root) {
        items.push({ label: "Open in terminal", icon: ICONS.terminal, run: function(){ state.termRun("cd " + JSON.stringify(file ? abs.replace(/\/[^\/]*$/, "") : abs)); } });
      }
      openMenu(x, y, items);
    }

    /**
     * Search this project: its files, and its code.
     *
     * Finding a file by name was all of it, which is the half you need least —
     * you remember a line, not a filename. Two modes, one box; the mode you
     * chose persists, because whichever one you use, you use it repeatedly.
     */
    function drawSearch(el){
      railTitle('<span class="b">Search</span>');
      var mode = state.railSearchMode || "code";
      el.innerHTML = '<div class="rsearch">' +
        '<input id="rsearchi" placeholder="' + (mode === "code" ? "search the code…" : "find files by name…") + '" autocomplete="off" spellcheck="false"></div>' +
        '<div class="smodes">' +
        '<span class="lvl' + (mode === "code" ? " on" : "") + '" data-mode="code">Code</span>' +
        '<span class="lvl' + (mode === "files" ? " on" : "") + '" data-mode="files">Files</span>' +
        '<span style="flex:1"></span><span class="scount" id="scount"></span>' +
        "</div>" +
        '<div class="sres" id="sres"></div>' +
        '<div class="rempty" id="shint">' +
        (mode === "code" ? "type to search inside every file in this project" : "type to find files by name") +
        "</div>";
      var inp = document.getElementById("rsearchi");
      if (state.railSearchQ) inp.value = state.railSearchQ;
      var to;
      inp.oninput = function(){ state.railSearchQ = this.value; clearTimeout(to); to = setTimeout(runSearch, 220); };
      inp.onkeydown = function(e){ if (e.key === "Enter") { clearTimeout(to); runSearch(); } };
      Array.prototype.forEach.call(el.querySelectorAll("[data-mode]"), function(b){
        b.onclick = function(){
          state.railSearchMode = b.getAttribute("data-mode");
          drawRail();
        };
      });
      setTimeout(function(){ inp.focus(); }, 20);
      if (state.railSearchQ) runSearch();
    }


    function runSearch(){
      var q = (state.railSearchQ || "").trim();
      var res = document.getElementById("sres"); if (!res) return;
      var hint = document.getElementById("shint");
      var cnt = document.getElementById("scount");
      if (hint) hint.style.display = q ? "none" : "";
      if (cnt) cnt.textContent = "";
      if (!q) { res.innerHTML = ""; return; }
      res.innerHTML = '<div class="rempty">searching…</div>';

      if ((state.railSearchMode || "code") === "files") {
        api("/api/projects/" + view.pid + "/find?q=" + encodeURIComponent(q)).then(function(j){
          res = document.getElementById("sres"); if (!res) return;
          var m = j.matches || [];
          if (cnt) cnt.textContent = m.length ? m.length + (m.length === 200 ? "+" : "") + " files" : "";
          if (!m.length) { res.innerHTML = '<div class="rempty">no file names match “' + esc(q) + '”</div>'; return; }
          res.innerHTML = m.map(function(f){
            return '<div class="frow" data-open="' + esc(f) + '"><span class="fp">' + esc(f) + "</span></div>";
          }).join("");
          wireSearchRows(res);
        }).catch(function(e){ res.innerHTML = '<div class="rempty">' + esc(e.message) + "</div>"; });
        return;
      }

      api("/api/projects/" + view.pid + "/grep?q=" + encodeURIComponent(q)).then(function(j){
        res = document.getElementById("sres"); if (!res) return;
        var hits = j.hits || [];
        if (cnt) cnt.textContent = hits.length ? hits.length + (j.truncated ? "+" : "") + " hits" : "";
        if (!hits.length) { res.innerHTML = '<div class="rempty">nothing in this project contains “' + esc(q) + '”</div>'; return; }
        // Grouped by file: twenty hits in one file is one answer, not twenty.
        var byFile = {};
        var order = [];
        hits.forEach(function(h){
          if (!byFile[h.path]) { byFile[h.path] = []; order.push(h.path); }
          byFile[h.path].push(h);
        });
        res.innerHTML = order.map(function(f){
          var rows = byFile[f].map(function(h){
            return '<div class="hitrow" data-open="' + esc(f) + '" data-line="' + h.line + '">' +
              '<span class="hn">' + h.line + "</span>" +
              '<span class="ht">' + highlight(h.text, q) + "</span></div>";
          }).join("");
          return '<div class="hitfile"><span class="fp">' + esc(f) + '</span><span class="hc">' + byFile[f].length + "</span></div>" + rows;
        }).join("");
        wireSearchRows(res);
      }).catch(function(e){ res.innerHTML = '<div class="rempty">' + esc(e.message) + "</div>"; });
    }


    function wireSearchRows(res){
      Array.prototype.forEach.call(res.querySelectorAll("[data-open]"), function(row){
        row.onclick = function(){ openFileFromTree(row.getAttribute("data-open")); };
      });
    }



    function drawScm(el){
      railTitle('<span class="b">Source control</span>');
      var p = state.project, r = p && p.route;
      var g = state.git;
      var html = "";
      if (p && p.needsInput) {
        html += '<div class="railcard warnc"><div class="rt"><span class="dot hot"></span>needs input</div>' +
          '<div class="rm">' + esc(state.lastQuestion || (r && r.pendingQuestion) || "an agent is waiting for you") + "</div></div>";
      }
      if (r && (r.status === "running" || r.status === "waiting_human")) {
        html += '<div class="railcard threadc"><div class="rt">' + esc(r.name || "route") + " · " +
          (r.mode === "dynamic" ? "hop " + (r.current + 1) : "step " + (r.current + 1) + "/" + r.steps.length) +
          '</div><div class="rm">▸ ' + esc(r.steps[r.current] || "") + "</div></div>";
      }
      if (!g) { el.innerHTML = html + '<div class="rempty">loading…</div>'; refreshGit(); return; }
      if (!g.branch) {
        // Not a repo yet — offer to make one, rather than a dead end.
        el.innerHTML = html +
          '<div class="ginit"><div class="rempty">not a git repository</div>' +
          '<button class="btn primary sm" id="gitinit">' + ICONS.branch + " Initialise repository</button></div>";
        var ib = document.getElementById("gitinit");
        if (ib) ib.onclick = function(){
          ib.disabled = true;
          api("/api/projects/" + view.pid + "/git/init", { method: "POST", body: "{}" })
            .then(function(r){ toast("initialised on " + r.branch); refreshGit(); view.refreshTree(false); })
            .catch(function(e){ toast(e.message); ib.disabled = false; });
        };
        return;
      }

      // Branch and distance from upstream: "3 ahead" is the difference between
      // "I pushed" and "I thought I pushed". The branch name is a picker when
      // there's more than one; Push sets the upstream on the first push.
      var brs = state.gitBranches;
      var branchEl;
      if (brs && brs.all && brs.all.length > 1) {
        // your branches first; the ones Loom's crews and orchestra runs cut, in their own groups
        var opt = function(b){ return '<option value="' + esc(b) + '"' + (b === g.branch ? " selected" : "") + ">" + esc(b) + "</option>"; };
        var mine = brs.all.filter(function(b){ return b.indexOf("loom/") !== 0; });
        var crewB = brs.all.filter(function(b){ return b.indexOf("loom/crew/") === 0; });
        var runB = brs.all.filter(function(b){ return b.indexOf("loom/") === 0 && b.indexOf("loom/crew/") !== 0; });
        branchEl = '<select class="gbranchsel" id="gcheckout" aria-label="switch branch">' + mine.map(opt).join("") +
          (crewB.length ? '<optgroup label="Crew goals">' + crewB.map(opt).join("") + "</optgroup>" : "") +
          (runB.length ? '<optgroup label="Orchestra runs">' + runB.map(opt).join("") + "</optgroup>" : "") +
          "</select>";
      } else {
        branchEl = '<span class="bn">' + esc(g.branch) + "</span>";
      }
      html += '<div class="gbranch">' + ICONS.branch + branchEl +
        (g.ahead ? '<span class="gcount">↑' + g.ahead + "</span>" : "") +
        (g.behind ? '<span class="gcount">↓' + g.behind + "</span>" : "") +
        (g.upstream ? "" : '<span class="gcount dim" title="this branch isn\u2019t on a remote yet \u2014 Push publishes it">local</span>') +
        '<span style="flex:1"></span>' +
        '<button class="iconbtn xs" id="gitpush" title="push to the remote" aria-label="push">' + ICONS.up + "</button>" +
        "</div>";

      var staged = g.staged || [], unstaged = g.unstaged || [], untracked = g.untracked || [];
      // Loom's own working files (.loom/: the event log, sessions, memory) are
      // not your changes. Folded into one row, with the fix: ignore them.
      var isLoom = function(pth){ return /^\.loom(\/|$)/.test(pth); };
      var loomFiles = untracked.filter(isLoom).concat(unstaged.filter(function(f){ return isLoom(f.path); }).map(function(f){ return f.path; }));
      untracked = untracked.filter(function(f){ return !isLoom(f); });
      unstaged = unstaged.filter(function(f){ return !isLoom(f.path); });
      var changeCount = staged.length + unstaged.length + untracked.length;

      // The commit box — always at the top, VS Code style: a message field with
      // a Generate button, then a full-width Commit with a split menu. Kept even
      // when the tree is clean, so the panel's shape doesn't jump around.
      html += '<div class="scmcommit">' +
        '<div class="scmmsgwrap">' +
        '<textarea id="gmsg" class="scmmsg" rows="1" placeholder="Message (\u2318\u21b5 to commit)"></textarea>' +
        '<button class="scmgen" id="gitgen" type="button" title="Draft a message from the staged diff">' + ICONS.spark + " Generate</button>" +
        "</div>" +
        '<div class="scmcommitrow">' +
        '<button class="btn primary scmcommitbtn" id="gcommitbtn"' + (staged.length ? "" : ' disabled title="stage a file (+) to commit it"') + '>Commit' + (staged.length ? " " + staged.length : "") + "</button>" +
        '<button class="btn primary scmsplit" id="gcommitmore" type="button" aria-label="more commit actions">' + ICONS.chevron + "</button>" +
        "</div></div>";

      var loomRow = loomFiles.length
        ? '<div class="scmloom" title="' + esc(loomFiles.slice(0, 30).join("\n")) + '">' + ICONS.gear +
            '<span class="scmloomt">Loom\u2019s working files<small>.loom/ \u00b7 ' + loomFiles.length + " file" + (loomFiles.length === 1 ? "" : "s") + "</small></span>" +
            '<button class="btn ghost xs" id="gitignoreloom" title="add .loom/ to .gitignore \u2014 the log, sessions and memory Loom keeps here aren\u2019t project changes">Ignore</button></div>'
        : "";
      if (!changeCount) {
        html += loomRow + '<div class="rempty">No changes \u2014 the working tree is clean.</div>';
        el.innerHTML = html + gitLogHtml();
        wireGitRows(el);
        return;
      }

      // One file row, VS Code style: name (with dimmed directory), hover actions,
      // and the porcelain status letter as a coloured badge on the right.
      function fileRow(f, kind){
        var st = String(f.status || "?").trim() || "?";
        var pth = f.path, base = pth.split("/").pop(), dir = pth.slice(0, pth.length - base.length);
        var letter = st === "?" ? "U" : st.charAt(0);
        var bc = letter === "D" ? "del" : (letter === "U" || letter === "A" ? "add" : "mod");
        // the name first, the folder after it, dimmed: a narrow panel cuts the folder, never the name
        return '<div class="scmrow" data-file="' + esc(pth) + '" title="' + esc(pth) + '">' +
          '<span class="scmname" data-open="' + esc(pth) + '"><span class="scmbase">' + esc(base) + "</span>" +
            (dir ? '<span class="scmdir">' + esc(dir.replace(/\/$/, "")) + "</span>" : "") + "</span>" +
          '<span class="scmacts">' +
          (kind === "staged"
            ? '<button class="iconbtn xs" data-unstage="' + esc(pth) + '" title="unstage" aria-label="unstage">' + ICONS.minus + "</button>"
            : '<button class="iconbtn xs" data-discard="' + esc(pth) + '" data-untracked="' + (kind === "untracked" ? "1" : "") + '" title="discard changes" aria-label="discard changes">' + ICONS.refresh + "</button>" +
              '<button class="iconbtn xs" data-stage="' + esc(pth) + '" title="stage" aria-label="stage">' + ICONS.plus + "</button>") +
          "</span>" +
          '<span class="scmbadge ' + bc + '" title="' + esc(st) + '">' + esc(letter) + "</span>" +
          "</div>";
      }

      if (staged.length) {
        html += '<div class="scmsec">Staged Changes<span class="scmn">' + staged.length + "</span>" +
          '<button class="lnk" id="unstageall">' + ICONS.minus + "</button></div>";
        html += '<div class="scmlist">' + staged.map(function(f){ return fileRow(f, "staged"); }).join("") + "</div>";
      }
      if (unstaged.length) {
        html += '<div class="scmsec">Changes<span class="scmn">' + unstaged.length + "</span>" +
          '<button class="lnk" id="stageall">' + ICONS.plus + "</button></div>";
        html += '<div class="scmlist">' + unstaged.map(function(f){ return fileRow(f, "unstaged"); }).join("") + "</div>";
      }
      if (untracked.length) {
        html += '<div class="scmsec">Untracked<span class="scmn">' + untracked.length + "</span>" +
          '<button class="lnk" id="stageuntracked">' + ICONS.plus + "</button></div>";
        html += '<div class="scmlist">' + untracked.map(function(f){ return fileRow({ path: f, status: "?" }, "untracked"); }).join("") + "</div>";
      }
      el.innerHTML = html + loomRow + gitLogHtml();
      wireGitRows(el);
    }


    /** The commit history, newest first — shown at the foot of the SCM panel. */
    function gitLogHtml(){
      var log = state.gitLog || [];
      if (!log.length) return "";
      return '<div class="rsec gcommits-h">Commits</div>' +
        '<div class="gcommits">' + log.map(function(c){
          return '<div class="gclog" title="' + esc(c.sha) + '">' +
            '<span class="gcsha">' + esc(c.short) + "</span>" +
            '<span class="gcsub">' + esc(c.subject) + "</span>" +
            '<span class="gcmeta">' + esc(c.author) + " \u00b7 " + esc(c.relative) + "</span></div>";
        }).join("") + "</div>";
    }


    /** Every control in the Source control view. */
    function wireGitRows(el){
      function act(path, body, said){
        return api("/api/projects/" + view.pid + "/git/" + path, { method: "POST", body: JSON.stringify(body) })
          .then(function(){ refreshGit(); if (said) toast(said); })
          .catch(function(e){ toast(e.message); });
      }
      Array.prototype.forEach.call(el.querySelectorAll("[data-stage]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); act("stage", { paths: [b.getAttribute("data-stage")] }); };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-unstage]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); act("unstage", { paths: [b.getAttribute("data-unstage")] }); };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-discard]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var f = b.getAttribute("data-discard");
          // The only control in Loom that destroys work, so it's the only one
          // that asks first.
          // The newline escape below is doubled. This whole file is one TS
          // template literal: a single backslash is eaten here and the browser
          // receives a real newline inside a string literal, which is a syntax
          // error that takes the entire app down — not just this button.
          // (Writing the un-doubled form even in THIS comment broke it once.)
          if (!confirm("Discard your changes to " + f + "?\n\nThis cannot be undone.")) return;
          var un = b.getAttribute("data-untracked") === "1";
          act("discard", un ? { untracked: [f] } : { paths: [f] }, "discarded " + f);
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-open]"), function(f){
        f.onclick = function(){ view.openChangesDock(f.getAttribute("data-open")); };
      });
      var ig = document.getElementById("gitignoreloom");
      if (ig) ig.onclick = function(){
        ig.disabled = true;
        api("/api/projects/" + view.pid + "/git/ignore", { method: "POST", body: JSON.stringify({ pattern: ".loom/" }) })
          .then(function(r){ toast(r.added ? ".loom/ added to .gitignore" : ".loom/ was already ignored"); refreshGit(); })
          .catch(function(e){ toast(e.message); ig.disabled = false; });
      };
      var sa = document.getElementById("stageall");
      if (sa) sa.onclick = function(){
        var g = state.git || {};
        var all = (g.unstaged || []).map(function(f){ return f.path; });
        if (all.length) act("stage", { paths: all });
      };
      var su = document.getElementById("stageuntracked");
      if (su) su.onclick = function(){
        var all = ((state.git && state.git.untracked) || []).filter(function(f){ return !/^\.loom(\/|$)/.test(f); });
        if (all.length) act("stage", { paths: all });
      };
      var ua = document.getElementById("unstageall");
      if (ua) ua.onclick = function(){
        var g = state.git || {};
        var all = (g.staged || []).map(function(f){ return f.path; });
        if (all.length) act("unstage", { paths: all });
      };

      // Commit box. The message is a textarea now; ⌘/Ctrl+Enter commits, and the
      // split button opens a small menu of the fuller actions.
      var msgbox = document.getElementById("gmsg");
      function autosizeMsg(){ if (!msgbox) return; msgbox.style.height = "auto"; msgbox.style.height = Math.min(160, msgbox.scrollHeight) + "px"; }
      if (msgbox) { msgbox.addEventListener("input", autosizeMsg); autosizeMsg(); }
      function doCommit(alsoStageAll, alsoPush){
        var msg = ((msgbox && msgbox.value) || "").trim();
        if (!msg) { toast("a commit needs a message"); if (msgbox) msgbox.focus(); return; }
        var btn = document.getElementById("gcommitbtn");
        if (btn) btn.disabled = true;
        var pre = Promise.resolve();
        if (alsoStageAll) {
          var g = state.git || {};
          var all = (g.unstaged || []).map(function(f){ return f.path; }).concat(g.untracked || []);
          if (all.length) pre = api("/api/projects/" + view.pid + "/git/stage", { method: "POST", body: JSON.stringify({ paths: all }) });
        }
        pre.then(function(){
          return api("/api/projects/" + view.pid + "/git/commit", { method: "POST", body: JSON.stringify({ message: msg }) });
        }).then(function(r){
          if (msgbox) { msgbox.value = ""; autosizeMsg(); }
          toast("committed " + r.sha + " · " + r.files + " file" + (r.files === 1 ? "" : "s"));
          if (alsoPush) {
            toast("pushing\u2026");
            return api("/api/projects/" + view.pid + "/git/push", { method: "POST", body: "{}" })
              .then(function(pr){ toast("pushed " + pr.branch); });
          }
        }).then(function(){ refreshGit(); view.refreshTree(false); })
          .catch(function(e){ toast(e.message); })
          .then(function(){ if (btn) btn.disabled = false; });
      }
      var cbtn = document.getElementById("gcommitbtn");
      if (cbtn) cbtn.onclick = function(){ doCommit(false, false); };
      if (msgbox) msgbox.addEventListener("keydown", function(e){
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); doCommit((state.git && !state.git.staged.length) || false, false); }
      });
      var more = document.getElementById("gcommitmore");
      if (more) more.onclick = function(ev){
        ev.stopPropagation();
        openScmMenu(more, [
          { label: "Commit & Push", run: function(){ doCommit(false, true); } },
          { label: "Stage all & Commit", run: function(){ doCommit(true, false); } },
          { label: "Stage all, Commit & Push", run: function(){ doCommit(true, true); } },
        ]);
      };
      // Generate a commit message from the diff (the ✨ button).
      var gen = document.getElementById("gitgen");
      if (gen) gen.onclick = function(){
        gen.disabled = true; gen.classList.add("busy");
        api("/api/projects/" + view.pid + "/git/suggest-message", { method: "POST", body: "{}" })
          .then(function(r){ if (msgbox) { msgbox.value = r.message; autosizeMsg(); msgbox.focus(); } })
          .catch(function(e){ toast(e.message); })
          .then(function(){ gen.disabled = false; gen.classList.remove("busy"); });
      };
      // Push — network-bound, so show it working and surface git's own words.
      var pushBtn = document.getElementById("gitpush");
      if (pushBtn) pushBtn.onclick = function(){
        pushBtn.disabled = true;
        toast("pushing\u2026");
        api("/api/projects/" + view.pid + "/git/push", { method: "POST", body: "{}" })
          .then(function(r){ toast("pushed " + r.branch); refreshGit(); })
          .catch(function(e){ toast(e.message); })
          .then(function(){ pushBtn.disabled = false; });
      };
      // Checkout — git refuses on its own if it would lose work; we relay that.
      var co = document.getElementById("gcheckout");
      if (co) co.onchange = function(){
        var ref = co.value;
        api("/api/projects/" + view.pid + "/git/checkout", { method: "POST", body: JSON.stringify({ ref: ref }) })
          .then(function(r){ toast("on " + r.branch); refreshGit(); view.refreshTree(false); })
          .catch(function(e){ toast(e.message); refreshGit(); });
      };
    }


    /** What git thinks, then redraw if that's what you're looking at. */
    function refreshGit(){
      return api("/api/projects/" + view.pid + "/git/status").then(function(g){
        state.git = g;
        if (state.railView === "scm") drawRail();
        // The log and branch list come alongside — cheap, and the panel shows
        // both. Failures are non-fatal: a repo with no commits has neither.
        if (g && g.branch) {
          api("/api/projects/" + view.pid + "/git/log?limit=30")
            .then(function(j){ state.gitLog = j.commits || []; if (state.railView === "scm") drawRail(); })
            .catch(function(){ state.gitLog = []; });
          api("/api/projects/" + view.pid + "/git/branches")
            .then(function(j){ state.gitBranches = j; if (state.railView === "scm") drawRail(); })
            .catch(function(){ state.gitBranches = null; });
        } else { state.gitLog = []; state.gitBranches = null; }
      }).catch(function(){ /* not a repo, or the daemon went away — drawScm says so */ });
    }



    // The agent roster. Keeps the internal "tasks" key so a persisted
    // loomRailView from an older build still resolves to a real view.
    function drawAgentsView(el){
      railTitle('<span class="b">Agents</span>');
      var p = state.project;
      var adapters = p ? p.agents.filter(function(a){ return a.tier === "adapter"; }) : [];
      var r = p && p.route;
      var live = r && (r.status === "running" || r.status === "waiting_human");
      var html = '<button class="btn primary sm taskbtn" id="railnewtask">+ New task</button>';
      if (live) {
        html += '<div class="railcard threadc"><div class="rt">' + esc(r.name || "route") + " \u00b7 " +
          (r.mode === "dynamic" ? "hop " + (r.current + 1) : "step " + (r.current + 1) + "/" + r.steps.length) +
          '</div><div class="rm">\u25b8 ' + esc(r.steps[r.current] || "") +
          (r.status === "waiting_human" ? " \u2014 \u23f8 " + esc(r.pendingQuestion || "waiting") : "") + "</div></div>";
      }
      // The agents live here now — the sidebar belongs to the project's chats.
      // Agents work the whole project, not one conversation, so this is the
      // honest place for them.
      html += '<div class="rsec">Agents</div>';
      if (!adapters.length) html += '<div class="rempty">no agents configured</div>';
      else adapters.forEach(function(a){
        var hh = hue(a.id);
        var curA = a.id === state.selected;
        html += '<div class="frow agentrow' + (curA ? " cur" : "") + '" data-agent="' + esc(a.id) + '"' +
          ' title="click to aim your next message at ' + esc(a.id) + '">' +
          '<span class="adot' + (a.busy ? " busy" : "") + '"></span>' +
          brandMark(a.kind) +
          '<span class="fp" style="color:hsl(' + hh + ',55%,var(--agent-l))">' + esc(a.id) + "</span>" +
          (a.id === p.holder ? ' <span class="abadge">baton</span>' : "") +
          // your project decides what jobs exist — click and type
          '<span class="role edit' + (!a.role || a.role === a.id || a.role === a.kind ? " same" : "") + '" data-role-p="' + esc(view.pid) + '" data-role-a="' + esc(a.id) +
          '" title="click to rename this job">' + esc(a.role || "\u2026") + "</span></div>";
      });
      var bridges = p ? p.agents.filter(function(a){ return a.tier === "bridge"; }) : [];
      bridges.forEach(function(a){
        html += '<div class="frow bridge" title="' + esc(a.id) +
          ' is a bridge \u2014 Loom reads it, but it never holds the baton">' +
          '<span class="adot"></span>' + brandMark(a.kind) +
          '<span class="fp">' + esc(a.id) + '</span> <span class="abadge">bridge</span>' +
          '<span class="role" style="margin-left:auto">' + esc(a.role) + "</span>" +
          '<span class="gacts"><button class="iconbtn xs" data-remove="' + esc(a.id) +
          '" title="remove from this project">' + ICONS.x + "</button></span></div>";
      });
      // Add an agent. A project's roster used to be frozen at creation: install
      // a new ADE and your existing projects never heard of it, so a machine
      // with six agents had a board offering two. That looked like a bug in the
      // board; the board was telling the truth about a config that couldn't
      // learn.
      html += '<div class="rsec">Add<button class="lnk" id="agentrefresh">rescan</button></div>';
      html += '<div id="addagents"><div class="rempty">looking\u2026</div></div>';

      el.innerHTML = html;
      document.getElementById("railnewtask").onclick = function(){ openTaskModal(view.pid); };
      Array.prototype.forEach.call(el.querySelectorAll(".frow[data-agent]"), function(row){
        row.onclick = function(ev){
          if (ev.target.closest("[data-remove]") || ev.target.closest(".role")) return;
          state.selected = row.getAttribute("data-agent");
          drawRail();
          view.drawStatus();
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-remove]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var id = b.getAttribute("data-remove");
          api("/api/projects/" + view.pid + "/agents/" + encodeURIComponent(id), { method: "DELETE" })
            .then(function(){
              toast(id + " removed \u00b7 its history stays in the thread");
              state.avail = null;
              view.refresh();
            })
            .catch(function(e){ toast(e.message); });
        };
      });
      var rescan = document.getElementById("agentrefresh");
      if (rescan) rescan.onclick = function(){ state.avail = null; drawAddAgents(); };
      wireRoleEditors(el, function(){ drawRail(); });
      drawAddAgents();
    }


    /**
     * What you could add: every ADE Loom can drive that isn't in this project.
     *
     * Installed and in-project are different questions and the daemon answers
     * both — an ADE you haven't installed is offered greyed out with the reason,
     * because "Codex isn't in the list" and "Codex isn't installed" send you to
     * very different places.
     */
    function drawAddAgents(){
      var box = document.getElementById("addagents");
      if (!box) return;
      function render(){
        // Adapters stay listed once they're here, because a second session of
        // the same kind is a thing you can want: two Claude Code sessions on one
        // repo, both reading the one brain. Bridges drop off — they're
        // read-mostly and never hold the baton, so a second one buys nothing.
        var list = (state.avail || []).filter(function(a){
          return !a.inProject || a.canAddAnother;
        });
        if (!list.length) {
          box.innerHTML = '<div class="rempty">every agent Loom can drive is already here</div>';
          return;
        }
        box.innerHTML = list.map(function(a){
          var can = a.installed !== false; // bridges report null: presence is live
          var n = a.instances || 0;
          var tip = !can ? esc(a.label) + " isn\u2019t installed"
            : n ? "add another " + esc(a.label) + " session \u2014 same brain, its own context"
                : "add " + esc(a.label) + " to this project";
          return '<div class="frow addrow' + (can ? "" : " off") + '" data-add="' + esc(a.kind) + '"' +
            ' title="' + tip + '">' +
            brandMark(a.kind) +
            '<span class="fp">' + esc(a.label) + "</span>" +
            (a.tier === "bridge" ? '<span class="abadge">bridge</span>' : "") +
            (n ? '<span class="abadge" title="sessions already in this project">' + n + "\u00d7</span>" : "") +
            (can ? '<span class="gacts"><button class="iconbtn xs" title="' + (n ? "add another" : "add") + '">' + ICONS.plus + "</button></span>"
                 : '<span class="role" style="margin-left:auto">not installed</span>') +
            "</div>";
        }).join("");
        Array.prototype.forEach.call(box.querySelectorAll(".addrow:not(.off)"), function(row){
          row.onclick = function(){
            var kind = row.getAttribute("data-add");
            api("/api/projects/" + view.pid + "/agents", { method: "POST", body: JSON.stringify({ kind: kind }) })
              .then(function(a){
                // The role is the kind until you say otherwise — a description,
                // not an opinion. Click it to name the job you actually have.
                toast(a.id + " added \u00b7 click its role to name the job");
                state.avail = null;
                view.refresh();
              })
              .catch(function(e){ toast(e.message); });
          };
        });
      }
      if (state.avail) return render();
      api("/api/projects/" + view.pid + "/agents/available")
        .then(function(j){ state.avail = j.ades || []; render(); })
        .catch(function(){ box.innerHTML = '<div class="rempty">couldn\u2019t ask the daemon what\u2019s installed</div>'; });
    }
return { openFileFromTree, drawRail, loadDir, drawExplorer };
}
