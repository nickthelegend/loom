import { brandMark } from '../agents.js';
import { api } from '../connection.js';
import { renderDiffLines } from '../diff.js';
import { esc } from '../format.js';
import { ICONS,LOADER } from '../icons.js';
import { askText,modalErr,toast } from '../notifications.js';
import { state } from '../state.js';
import { openBoardTaskModal,openTaskModal } from '../tasks.js';
import { openMenu } from '../menus.js';
import { copyText } from '../clipboard.js';

/** board behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createBoard(view) {

    function boardPins(){
      if (view.board.pins) return view.board.pins;
      try { view.board.pins = JSON.parse(localStorage.getItem(view.PINKEY) || "{}"); }
      catch (e) { view.board.pins = {}; }
      return view.board.pins;
    }

    function savePins(){ try { localStorage.setItem(view.PINKEY, JSON.stringify(view.board.pins || {})); } catch (e) {} }

    function loadBoard(){
      view.board.loading = true;
      drawBoardPane();
      api("/api/projects/" + view.pid + "/board" + (view.board.q ? "?search=" + encodeURIComponent(view.board.q) : ""))
        .then(function(r){ view.board.data = r; view.board.loading = false; drawBoardPane(); })
        .catch(function(err){
          view.board.data = { available: false, reason: "error", detail: err.message };
          view.board.loading = false; drawBoardPane();
        });
    }

    // One board, three sources. GitHub is the live kanban; Projects browses the
    // owner's GitHub Project boards; Linear lists and files issues.
    function boardSourceBar(){
      var srcs = [["github", "GitHub", ICONS.github], ["projects", "Projects", ICONS.board], ["linear", "Linear", ICONS.linear]];
      return '<div class="bsrc" role="tablist">' + srcs.map(function(s){
        return '<button class="bsrcb' + (view.board.source === s[0] ? " on" : "") + '" data-src="' + s[0] +
          '" type="button" role="tab" aria-selected="' + (view.board.source === s[0]) + '">' + s[2] + "<span>" + s[1] + "</span></button>";
      }).join("") + "</div>";
    }

    function wireSourceBar(){
      Array.prototype.forEach.call(document.querySelectorAll("#pane-board [data-src]"), function(b){
        b.onclick = function(){
          var s = b.getAttribute("data-src");
          if (s === view.board.source) return;
          view.board.source = s; view.board.ghProject = null;
          drawBoardPane();
          if (s === "github" && !view.board.data) loadBoard();
          else if (s === "projects" && !view.board.ghProjects) loadGhProjects();
          else if (s === "linear" && (!view.board.linear || !view.board.linearTeams)) loadLinear();
        };
      });
    }

    function drawBoardPane(){
      if (view.board.source === "projects") return drawProjectsView();
      if (view.board.source === "linear") return drawLinearView();
      drawGithubBoard();
    }

    function drawGithubBoard(){
      var el = document.getElementById("pane-board"); if (!el) return;
      var d = view.board.data;
      var head = '<div class="bhead">' + boardSourceBar() +
        '<span class="spacer"></span>' +
        // gh's own query language, straight through — same box the Tasks tab had
        '<div class="qbox bq">' + ICONS.search +
          '<input id="bq" value="' + esc(view.board.q) + '" spellcheck="false" autocomplete="off"' +
          ' placeholder="search issues and PRs \u2014 is:pr is:open author:@me" aria-label="search issues and PRs"></div>' +
        '<button class="btn outline xs" id="bnew" title="add a card of your own">+ Task</button>' +
        '<button class="iconbtn' + (view.board.loading ? " spin" : "") + '" id="brefresh" title="refresh" aria-label="refresh">' + ICONS.refresh + "</button></div>";
      // Wire the head even while loading: the gh round-trip is slow enough that
      // a dead search box is dead for exactly as long as anyone would use it.
      if (!d) {
        el.innerHTML = '<div class="boardview">' + head + LOADER + "</div>";
        wireBoardHead();
        return;
      }
      if (!d.available) {
        el.innerHTML = '<div class="boardview">' + head +
          '<div class="tsetup"><div class="th">Couldn\u2019t build the board</div>' +
          '<div class="td">' + esc(d.detail) + "</div></div></div>";
        wireBoardHead();
        return;
      }

      var pins = boardPins();
      var cards = (d.cards || []).slice();
      // a pin only moves a card; it never edits what the card reports
      cards.forEach(function(c){ c.shown = pins[c.id] || c.column; });

      var cols = view.BCOLS.map(function(col){
        var key = col[0];
        var mine = cards.filter(function(c){ return c.shown === key; });
        var lim = (d.limits || {})[key];
        var over = lim && mine.length > lim;
        return '<div class="bcol' + (over ? " over" : "") + '" data-col="' + key + '">' +
          '<div class="bch"><span class="bdot" style="background:' + col[2] + '"></span>' + esc(col[1]) +
            '<button type="button" class="bn bwip" data-wip="' + key + '" title="' + (lim ? "limit " + lim + (over ? " — over it" : "") + " · click to change" : "set a work-in-progress limit") + '">' +
              mine.length + (lim ? " / " + lim : "") + "</button></div>" +
          '<div class="bcb" data-drop="' + key + '">' +
            (mine.length ? mine.map(boardCard).join("") : '<div class="bempty">nothing here</div>') +
            '<button class="badd" data-add="' + key + '" title="add a card here">+</button>' +
          "</div></div>";
      }).join("");

      el.innerHTML = '<div class="boardview">' + head +
        '<div class="bcols">' + cols + "</div>" +
        (d.ghError
          ? '<div class="bnote">' + ICONS.info + " Pull requests aren\u2019t shown: " + esc(d.ghError.detail) + "</div>"
          : "") +
        "</div>";
      wireBoardHead();
      wireBoardDnd();
      wireBoardTasks(el);
      wireCardMeta(el);
    }

    function boardCard(c){
      var st = view.BSTATES[c.state] || [c.state, "var(--muted-foreground)"];
      var pinned = (view.board.pins || {})[c.id];
      // Review a PR, or open a worktree from any task — the "no context switch"
      // half of the board. A PR worktree checks the branch out for you (forks
      // included); an issue worktree cuts a fresh branch to start it.
      var acts = "";
      if (c.pr) {
        acts = '<div class="bca">' +
          '<button class="btn outline xs" data-review="' + c.pr.number + '" data-rtitle="' + esc(c.title) + '">Review</button>' +
          '<button class="btn ghost xs" data-wtpr="' + c.pr.number + '" title="open a worktree on this PR\u2019s branch">' + ICONS.branch + " Worktree</button></div>";
      } else if (c.issue) {
        acts = '<div class="bca"><button class="btn ghost xs" data-wtissue="' + c.issue.number +
          '" title="cut a fresh branch for this issue in its own worktree">' + ICONS.branch + " Worktree</button></div>";
      } else if (c.own && c.column === "in-review") {
        // Your own card, in review, with no PR yet: offer to open one. It shows
        // what would be pushed first — publishing is never implicit.
        acts = '<div class="bca"><button class="btn outline xs" data-openpr="' + esc(c.id) +
          '" title="open a pull request for this card">' + ICONS.branch + " Open PR</button></div>";
      }
      return '<div class="bcard' + (c.own ? " own" : "") + '" draggable="true" data-card="' + esc(c.id) +
        '" data-home="' + esc(c.column) + '"' + (c.own ? ' data-own="1"' : "") + ">" +
        '<div class="bcr1"><span class="bdot" style="background:' + st[1] + '"></span>' +
          '<span class="st" style="color:' + st[1] + '">' + esc(st[0]) + "</span>" +
          '<span class="who">' + brandMark(c.kind) + esc(c.agent || "\u2014") + "</span></div>" +
        '<div class="bct"' + (c.own ? ' data-edit="' + esc(c.id) + '" title="click to edit"' : "") + ">" +
          esc(c.title) + "</div>" +
        (c.branch ? '<div class="bcbr">' + esc(c.branch) + "</div>" : "") +
        '<div class="bcf">' +
          (c.own
            ? cardMeta(c) + (c.blocked ? '<span class="bblocked" title="waiting on ' + c.blocked + ' other card' + (c.blocked === 1 ? "" : "s") + '">⛔ ' + c.blocked + "</span> yours" : "yours")
            : c.pr
              ? '<a href="' + esc(c.pr.url) + '" target="_blank" rel="noreferrer">PR #' + c.pr.number + "</a> \u00b7 " +
                esc(c.pr.draft ? "draft" : c.pr.state)
              : c.issue
                ? '<a href="' + esc(c.issue.url) + '" target="_blank" rel="noreferrer">#' + c.issue.number + "</a>" +
                  '<button class="btn outline xs bstart" data-start="' + c.issue.number +
                  '" title="hand this issue to an agent">Start \u2192</button>'
                : "no PR yet") +
          (c.own
            ? '<button class="bpin del" data-deltask="' + esc(c.id) + '" title="delete this card" aria-label="delete card">' + ICONS.x + "</button>"
            : pinned
              ? '<span class="bpin" data-unpin="' + esc(c.id) + '" title="you moved this card \u2014 click to let its real state place it">pinned</span>'
              : "") +
        "</div>" + acts + "</div>";
    }
    /** A card's priority and due date, each a chip you can click to change. */
    function cardMeta(c){
      var pr = c.priority ? '<button type="button" class="bmchip prio ' + esc(c.priority) + '" data-prio="' + esc(c.id) + '" title="priority — click to change">' + esc(c.priority) + "</button>"
        : '<button type="button" class="bmchip prio none" data-prio="' + esc(c.id) + '" title="set a priority">+ priority</button>';
      var due = "";
      if (c.due) {
        var d = new Date(c.due + "T00:00:00"), t = new Date(); t.setHours(0, 0, 0, 0);
        var days = Math.round((d - t) / 86400000);
        var label = days === 0 ? "due today" : days === 1 ? "due tomorrow" : days === -1 ? "due yesterday" : days < 0 ? Math.abs(days) + "d overdue" : days < 7 ? "due " + d.toLocaleDateString([], { weekday: "short" }) : "due " + d.toLocaleDateString([], { month: "short", day: "numeric" });
        due = '<button type="button" class="bmchip due' + (days < 0 && c.column !== "ready" ? " late" : days <= 1 ? " soon" : "") + '" data-due="' + esc(c.id) + '" title="' + esc(c.due) + ' — click to change">' + esc(label) + "</button>";
      } else due = '<button type="button" class="bmchip due none" data-due="' + esc(c.id) + '" title="set a due date">+ due</button>';
      return '<span class="bmeta">' + pr + due + "</span>";
    }
    function patchCard(id, body){
      // the board names your cards task-<id>; the task itself is just <id>
      return api("/api/projects/" + view.pid + "/board/tasks/" + encodeURIComponent(String(id).replace(/^task-/, "")), { method: "POST", body: JSON.stringify(body) })
        .then(function(){ loadBoard(); })
        .catch(function(err){ toast(err.message); });
    }
    function wireCardMeta(el){
      Array.prototype.forEach.call(el.querySelectorAll("[data-prio]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var id = b.getAttribute("data-prio"), r = b.getBoundingClientRect();
          openMenu(Math.round(r.left), Math.round(r.bottom + 4), [{ head: "Priority" }].concat(["high", "medium", "low"].map(function(v){
            return { label: v.charAt(0).toUpperCase() + v.slice(1), run: function(){ patchCard(id, { priority: v }); } };
          })).concat([{ sep: true }, { label: "None", run: function(){ patchCard(id, { priority: null }); } }]));
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-due]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var id = b.getAttribute("data-due");
          var cur = ((view.board.data && view.board.data.cards) || []).filter(function(c){ return c.id === id; })[0] || {};
          askText("When is it due?", { value: cur.due || new Date(Date.now() + 86400000).toISOString().slice(0, 10), placeholder: "YYYY-MM-DD — blank clears it", ok: "Set" }).then(function(v){
            if (v === null) return;
            v = v.trim();
            if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { toast("a date looks like 2026-10-01"); return; }
            patchCard(id, { due: v || null });
          });
        };
      });
      // a column's limit: click its count
      Array.prototype.forEach.call(el.querySelectorAll("[data-wip]"), function(b){
        b.onclick = function(){
          var col = b.getAttribute("data-wip"), lim = ((view.board.data && view.board.data.limits) || {})[col];
          askText("Work-in-progress limit for this column", { value: lim ? String(lim) : "", placeholder: "e.g. 3 — blank for none", note: "The column warns when it holds more than this.", ok: "Set" }).then(function(v){
            if (v === null) return;
            api("/api/projects/" + view.pid + "/board/limits", { method: "PUT", body: JSON.stringify({ column: col, limit: v.trim() === "" ? 0 : Number(v) }) })
              .then(function(){ loadBoard(); })
              .catch(function(err){ toast(err.message); });
          });
        };
      });
    }

    function wireBoardHead(){
      wireSourceBar();
      var r = document.getElementById("brefresh");
      if (r) r.onclick = loadBoard;
      var q = document.getElementById("bq");
      if (q) q.onkeydown = function(e){
        if (e.key !== "Enter") return;
        e.preventDefault();
        view.board.q = this.value.trim();
        loadBoard();
      };
      var n = document.getElementById("bnew");
      if (n) n.onclick = function(){ addTask("working"); };
      // add straight into a column — including Ready, if that's where it is
      Array.prototype.forEach.call(document.querySelectorAll("[data-add]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); addTask(b.getAttribute("data-add")); };
      });
    }

    /** A card of your own — same modal as Create task, minus the ceremony. */
    function addTask(column){
      openBoardTaskModal(view.pid, column, loadBoard);
    }

    function wireBoardTasks(el){
      // retitle in place — it's your card
      Array.prototype.forEach.call(el.querySelectorAll("[data-edit]"), function(t){
        t.onclick = function(ev){
          ev.stopPropagation();
          if (t.querySelector("input")) return;
          var id = t.getAttribute("data-edit");
          var was = t.textContent;
          var inp = document.createElement("input");
          inp.className = "bcedit";
          inp.value = was;
          inp.maxLength = 200;
          t.textContent = "";
          t.appendChild(inp);
          inp.focus(); inp.select();
          var done = false;
          function finish(save){
            if (done) return; done = true;
            var next = inp.value.trim();
            if (!save || !next || next === was) { drawBoardPane(); return; }
            api("/api/projects/" + view.pid + "/board/tasks/" + id.replace(/^task-/, ""),
                { method: "POST", body: JSON.stringify({ title: next }) })
              .then(function(){ loadBoard(); })
              .catch(function(err){ toast(err.message); drawBoardPane(); });
          }
          inp.onkeydown = function(e){
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            else if (e.key === "Escape") { e.preventDefault(); finish(false); }
          };
          inp.onblur = function(){ finish(true); };
          // a card is draggable; don't let selecting text start a drag
          inp.ondragstart = function(e){ e.preventDefault(); e.stopPropagation(); };
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-deltask]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var id = b.getAttribute("data-deltask");
          api("/api/projects/" + view.pid + "/board/tasks/" + id.replace(/^task-/, ""), { method: "DELETE" })
            .then(loadBoard)
            .catch(function(err){ toast(err.message); });
        };
      });
      // Start an issue — the same brief the Tasks tab used to draft, now here
      Array.prototype.forEach.call(el.querySelectorAll("[data-start]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var n = Number(b.getAttribute("data-start"));
          var card = (view.board.data.cards || []).filter(function(c){
            return c.issue && c.issue.number === n;
          })[0];
          if (!card) return;
          openTaskModal(view.pid, null,
            "issue #" + n + ": " + card.title + "\n" + card.issue.url +
            "\n\nRead the issue, then implement it.");
        };
      });
      // Review a PR in-app
      Array.prototype.forEach.call(el.querySelectorAll("[data-review]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          openPrReview(Number(b.getAttribute("data-review")), b.getAttribute("data-rtitle") || "");
        };
      });
      // Open a worktree from a PR (checks the branch out) or an issue (fresh branch)
      Array.prototype.forEach.call(el.querySelectorAll("[data-wtpr]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); openWorktree(b, { pr: Number(b.getAttribute("data-wtpr")) }); };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-wtissue]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); openWorktree(b, { issue: Number(b.getAttribute("data-wtissue")) }); };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-openpr]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); askOpenPr(b.getAttribute("data-openpr")); };
      });
    }


    /**
     * Open a PR for a card — after showing exactly what would be pushed.
     *
     * Pushing publishes, so the order matters: look, then decide, then act.
     * The plan comes from the daemon (the branch, its commits, its files and
     * the command), and nothing happens until the button in this dialog.
     */
    function askOpenPr(id){
      if (!id || document.querySelector(".scrim")) return;
      api("/api/projects/" + state.pid + "/tasks/" + encodeURIComponent(id) + "/pr").then(function(plan){
        var scrim = document.createElement("div");
        scrim.className = "scrim";
        var body = plan.ready
          ? '<div class="prpsub">' + plan.commits.length + " commit" + (plan.commits.length === 1 ? "" : "s") +
            " on <code>" + esc(plan.branch) + "</code> that <code>" + esc(plan.base) + "</code> doesn’t have, touching " +
            plan.files.length + " file" + (plan.files.length === 1 ? "" : "s") + ".</div>" +
            '<div class="prplist">' + plan.commits.slice(0, 12).map(function(c){ return "<div>" + esc(c) + "</div>"; }).join("") + "</div>" +
            '<div class="prpsub">Files</div><div class="prplist">' +
            plan.files.slice(0, 20).map(function(f){ return "<div>" + esc(f) + "</div>"; }).join("") + "</div>" +
            '<div class="prpsub">This runs</div><code class="scmd">git push -u origin ' + esc(plan.branch) + "\n" + esc(plan.command) + "</code>"
          : '<div class="prpsub">' + esc(plan.why || "there’s nothing to open a PR for") + "</div>";
        scrim.innerHTML = '<div class="modal prplan"><div class="modalhead">Open a pull request' +
          '<button class="iconbtn" id="prpx" aria-label="close">' + ICONS.x + "</button></div>" +
          '<div class="prpbody">' + body + "</div>" +
          '<div class="modalfoot">' +
          (plan.ready ? '<button class="btn primary" id="prpgo">Push and open the PR</button>' : "") +
          '<button class="btn ghost" id="prpcancel">Close</button></div></div>';
        document.body.appendChild(scrim);
        var close = function(){ scrim.remove(); };
        scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
        document.getElementById("prpx").onclick = close;
        document.getElementById("prpcancel").onclick = close;
        var go = document.getElementById("prpgo");
        if (go) go.onclick = function(){
          go.disabled = true;
          go.textContent = "Opening\u2026";
          api("/api/projects/" + state.pid + "/tasks/" + encodeURIComponent(id) + "/pr", { method: "POST", body: "{}" })
            .then(function(r){ close(); toast("opened " + r.url); loadBoard(); })
            .catch(function(e){ go.disabled = false; go.textContent = "Push and open the PR"; toast(e.message); });
        };
      }).catch(function(e){ toast(e.message); });
    }


    /**
     * Open a worktree from a task and say where it landed. A worktree is a real
     * directory on the daemon host, so the honest confirmation is its path — you
     * cd there, or point a fresh Loom project at it.
     */
    function openWorktree(btn, body){
      if (btn) { btn.disabled = true; btn.textContent = "Opening\u2026"; }
      api("/api/projects/" + view.pid + "/worktrees", { method: "POST", body: JSON.stringify(body) })
        .then(function(r){
          toast("worktree ready \u00b7 " + (r.branch || r.source || "") + " \u2192 " + r.path);
          loadBoard();
        })
        .catch(function(err){ toast(err.message); if (btn) { btn.disabled = false; btn.textContent = "Worktree"; } });
    }

    // ---- Projects (GitHub Projects v2), browsed in-app ----------------------
    function loadGhProjects(){
      view.board.ghProjects = null; drawProjectsView();
      api("/api/projects/" + view.pid + "/gh/projects")
        .then(function(r){ view.board.ghProjects = r; drawProjectsView(); })
        .catch(function(err){ view.board.ghProjects = { available: false, detail: err.message }; drawProjectsView(); });
    }

    function loadGhProjectItems(num){
      view.board.ghItems = null; view.board.ghItemsLoading = true; drawProjectsView();
      api("/api/projects/" + view.pid + "/gh/projects/" + num + "/items")
        .then(function(r){ view.board.ghItems = r; view.board.ghItemsLoading = false; drawProjectsView(); })
        .catch(function(err){ view.board.ghItems = { available: false, detail: err.message }; view.board.ghItemsLoading = false; drawProjectsView(); });
    }

    function drawProjectsView(){
      var el = document.getElementById("pane-board"); if (!el) return;
      var head = '<div class="bhead">' + boardSourceBar() + '<span class="spacer"></span>' +
        '<button class="iconbtn" id="brefresh" title="refresh" aria-label="refresh">' + ICONS.refresh + "</button></div>";
      var d = view.board.ghProjects, body;
      if (view.board.ghProject) body = drawProjectItems();
      else if (!d) body = LOADER;
      else if (!d.available) body = '<div class="tsetup"><div class="th">Couldn\u2019t list projects</div><div class="td">' + esc(d.detail) + "</div></div>";
      else if (!d.projects.length) body = '<div class="bempty2">No GitHub Projects for ' + esc(d.owner) + " yet.</div>";
      else body = '<div class="prjlist">' + d.projects.map(function(p){
        return '<button class="prjrow" data-prj="' + p.number + '" data-prjt="' + esc(p.title) + '">' +
          ICONS.board + '<span class="prjt">' + esc(p.title) + "</span>" +
          '<span class="prjn">' + p.items + " item" + (p.items === 1 ? "" : "s") + "</span>" +
          '<a class="prja" href="' + esc(p.url) + '" target="_blank" rel="noreferrer" title="open on GitHub">' + ICONS.external + "</a></button>";
      }).join("") + "</div>";
      el.innerHTML = '<div class="boardview">' + head + body + "</div>";
      wireBoardHead();
      Array.prototype.forEach.call(el.querySelectorAll("[data-prj]"), function(b){
        b.onclick = function(ev){
          if (ev.target.closest(".prja")) return; // the GitHub link is its own action
          view.board.ghProject = { number: Number(b.getAttribute("data-prj")), title: b.getAttribute("data-prjt") };
          loadGhProjectItems(view.board.ghProject.number);
        };
      });
      var back = document.getElementById("prjback");
      if (back) back.onclick = function(){ view.board.ghProject = null; view.board.ghItems = null; drawProjectsView(); };
    }

    function drawProjectItems(){
      var pr = view.board.ghProject;
      var head2 = '<div class="prjhead"><button class="btn ghost xs" id="prjback">' + ICONS.chevronLeft + " Projects</button>" +
        '<span class="prjtitle">' + esc(pr.title) + "</span></div>";
      var d = view.board.ghItems;
      if (view.board.ghItemsLoading || !d) return head2 + LOADER;
      if (!d.available) return head2 + '<div class="tsetup"><div class="td">' + esc(d.detail) + "</div></div>";
      var items = d.items || [];
      if (!items.length) return head2 + '<div class="bempty2">This project has no items.</div>';
      var groups = {}, order = [];
      items.forEach(function(it){ if (!groups[it.status]) { groups[it.status] = []; order.push(it.status); } groups[it.status].push(it); });
      var cols = order.map(function(s){
        return '<div class="bcol"><div class="bch">' + esc(s) + '<span class="bn">' + groups[s].length + "</span></div>" +
          '<div class="bcb">' + groups[s].map(function(it){
            var tag = it.type === "PullRequest" ? "PR #" + (it.number || "") : it.type === "Issue" ? "#" + (it.number || "") : "note";
            return '<div class="bcard"><div class="bct">' + esc(it.title) + "</div><div class=\"bcf\">" +
              (it.url ? '<a href="' + esc(it.url) + '" target="_blank" rel="noreferrer">' + esc(tag) + "</a>" : '<span class="who">' + esc(tag) + "</span>") + "</div></div>";
          }).join("") + "</div></div>";
      }).join("");
      return head2 + '<div class="bcols pcols">' + cols + "</div>";
    }


    // ---- Linear — list issues, and file a new one with a team selector ------
    function loadLinear(){
      view.board.linearLoading = true; drawLinearView();
      Promise.all([
        api("/api/projects/" + view.pid + "/linear/teams").catch(function(e){ return { available: false, detail: e.message }; }),
        api("/api/projects/" + view.pid + "/linear/issues").catch(function(e){ return { available: false, detail: e.message }; }),
      ]).then(function(res){
        view.board.linearTeams = res[0]; view.board.linear = res[1]; view.board.linearLoading = false; drawLinearView();
      });
    }

    function drawLinearView(){
      var el = document.getElementById("pane-board"); if (!el) return;
      var configured = view.board.linearTeams && view.board.linearTeams.available;
      var head = '<div class="bhead">' + boardSourceBar() + '<span class="spacer"></span>' +
        (configured ? '<button class="btn primary xs" id="lnew">+ New issue</button>' : "") +
        '<button class="iconbtn" id="brefresh" title="refresh" aria-label="refresh">' + ICONS.refresh + "</button></div>";
      var body;
      if (view.board.linearLoading || (!view.board.linearTeams && !view.board.linear)) body = LOADER;
      else if (!configured) {
        var det = (view.board.linearTeams && view.board.linearTeams.detail) || "Set LINEAR_API_KEY to enable Linear.";
        body = '<div class="tsetup"><div class="th">Linear isn\u2019t connected</div>' +
          '<div class="td">' + esc(det) + "</div>" +
          '<code class="scmd">export LINEAR_API_KEY=lin_api_\u2026\nloom up --restart</code>' +
          '<div class="td" style="margin-top:8px">Loom reads the key from its own environment and never stores it \u2014 the same bet it makes with the GitHub CLI.</div></div>';
      } else {
        var issues = (view.board.linear && view.board.linear.available) ? view.board.linear.issues : [];
        body = issues.length
          ? '<div class="lnlist">' + issues.map(function(it){
              return '<a class="lnrow" href="' + esc(it.url) + '" target="_blank" rel="noreferrer">' +
                '<span class="lnid">' + esc(it.identifier) + "</span>" +
                '<span class="lnt">' + esc(it.title) + "</span>" +
                (it.state ? '<span class="lnst">' + esc(it.state) + "</span>" : "") + "</a>";
            }).join("") + "</div>"
          : '<div class="bempty2">No recent issues \u2014 file one with + New issue.</div>';
      }
      el.innerHTML = '<div class="boardview">' + head + body + "</div>";
      wireBoardHead();
      var nb = document.getElementById("lnew");
      if (nb) nb.onclick = openLinearForm;
    }

    function openLinearForm(){
      if (document.querySelector(".scrim")) return;
      var teams = (view.board.linearTeams && view.board.linearTeams.teams) || [];
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal"><div class="modalhead">New Linear issue<button class="iconbtn" id="lx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="modalbody">' +
          '<div class="field"><label>Team</label><select id="lteam">' +
            teams.map(function(t){ return '<option value="' + esc(t.id) + '">' + esc(t.key) + " \u00b7 " + esc(t.name) + "</option>"; }).join("") + "</select></div>" +
          '<div class="field"><label>Title</label><input id="ltitle" spellcheck="false" autocomplete="off" placeholder="what needs doing"></div>' +
          '<div class="field"><label>Description <span class="opt">optional</span></label><textarea id="ldesc" spellcheck="false" placeholder="details, acceptance criteria\u2026"></textarea></div>' +
        "</div>" +
        '<div class="modalfoot"><button class="btn ghost" id="lcancel">Cancel</button><button class="btn primary" id="lcreate">Create issue</button></div></div>';
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
      function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
      document.addEventListener("keydown", onKey);
      scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
      document.getElementById("lx").onclick = close;
      document.getElementById("lcancel").onclick = close;
      setTimeout(function(){ var t = document.getElementById("ltitle"); if (t) t.focus(); }, 30);
      document.getElementById("lcreate").onclick = function(){
        var teamId = document.getElementById("lteam").value;
        var title = (document.getElementById("ltitle").value || "").trim();
        var desc = (document.getElementById("ldesc").value || "").trim();
        if (!title) return modalErr(scrim, "Give the issue a title.", document.getElementById("ltitle"));
        var btn = this; btn.disabled = true;
        api("/api/projects/" + view.pid + "/linear/issues", { method: "POST", body: JSON.stringify({ teamId: teamId, title: title, description: desc }) })
          .then(function(r){ close(); toast("created " + (r.issue ? r.issue.identifier : "issue")); loadLinear(); })
          .catch(function(err){ btn.disabled = false; modalErr(scrim, err.message); });
      };
    }


    /**
     * Review a PR without leaving the board: its diff, and the three things a
     * reviewer does — comment, request changes, approve. The review is posted
     * through the user's own gh, signed as them; approve asks first, because it
     * publishes to GitHub.
     */
    function openPrReview(num, title){
      if (document.querySelector(".scrim")) return;
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal prmodal"><div class="modalhead">Review PR #' + num +
        '<button class="iconbtn" id="prx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="modalbody prbody" id="prbody">' + LOADER + "</div>" +
        '<div class="modalfoot prfoot" id="prfoot"></div></div>';
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
      function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
      document.addEventListener("keydown", onKey);
      scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
      document.getElementById("prx").onclick = close;
      api("/api/projects/" + view.pid + "/prs/" + num).then(function(r){
        var bodyEl = document.getElementById("prbody");
        if (!r.available) { bodyEl.innerHTML = '<div class="snote">' + esc(r.detail) + "</div>"; return; }
        var p = r.pr;
        var dec = p.reviewDecision ? " \u00b7 " + esc(p.reviewDecision.toLowerCase().replace(/_/g, " ")) : "";
        var meta = '<div class="prmeta"><div class="prttl">' + esc(p.title) + "</div>" +
          '<div class="prsub"><span class="prbr">' + esc(p.headRefName) + " \u2192 " + esc(p.baseRefName) + "</span>" +
          " \u00b7 " + esc(p.author) +
          ' \u00b7 <span style="color:var(--git-add)">+' + p.additions + '</span> <span style="color:var(--git-del)">\u2212' + p.deletions + "</span>" +
          " \u00b7 " + p.changedFiles + " file" + (p.changedFiles === 1 ? "" : "s") + dec + "</div></div>";
        var diff = r.diff
          ? '<div class="dcode prdiff">' + renderDiffLines(r.diff.split("\n")) + "</div>" +
            (r.diffCapped ? '<div class="prcap">\u2026 diff truncated \u2014 open on GitHub for the rest.</div>' : "")
          : '<div class="snote">No diff to show.</div>';
        bodyEl.innerHTML = meta + diff +
          '<textarea class="prcomment" id="prcomment" spellcheck="false" placeholder="Comment (required to request changes or comment)"></textarea>';
        var foot = document.getElementById("prfoot");
        foot.innerHTML = '<a class="btn ghost" href="' + esc(p.url) + '" target="_blank" rel="noreferrer">Open on GitHub</a><span class="spacer"></span>' +
          '<button class="btn outline" id="prcmt">Comment</button>' +
          '<button class="btn outline prdanger" id="prreq">Request changes</button>' +
          '<button class="btn primary" id="prapp">Approve</button>';
        function review(action){
          var body = (document.getElementById("prcomment").value || "").trim();
          if ((action === "request-changes" || action === "comment") && !body) return toast("add a comment first");
          if (action === "approve" && !window.confirm("Approve PR #" + num + "? This posts an approval to GitHub under your gh identity.")) return;
          Array.prototype.forEach.call(foot.querySelectorAll("button"), function(x){ x.disabled = true; });
          api("/api/projects/" + view.pid + "/prs/" + num + "/review", { method: "POST", body: JSON.stringify({ action: action, body: body }) })
            .then(function(){
              toast(action === "approve" ? "approved PR #" + num : action === "request-changes" ? "requested changes on #" + num : "commented on #" + num);
              close(); loadBoard();
            })
            .catch(function(err){ toast(err.message); Array.prototype.forEach.call(foot.querySelectorAll("button"), function(x){ x.disabled = false; }); });
        }
        document.getElementById("prapp").onclick = function(){ review("approve"); };
        document.getElementById("prreq").onclick = function(){ review("request-changes"); };
        document.getElementById("prcmt").onclick = function(){ review("comment"); };
      }).catch(function(err){
        var bodyEl = document.getElementById("prbody"); if (bodyEl) bodyEl.innerHTML = '<div class="snote">' + esc(err.message) + "</div>";
      });
    }


    /**
     * Drag to move a card. This pins it where you dropped it — it does not tell
     * GitHub anything. A PR is "ready" when a human approved it and CI passed,
     * and dragging a card can't make either true, so the badge keeps saying what
     * is actually so and the card just wears a "pinned" mark.
     */
    function moveCard(id, target){
      var card = (view.board.data.cards || []).filter(function(c){ return c.id === id; })[0];
      if (!card) return;
      if (card.own) {
        // your card: the column IS its state, so this is a real move —
        // persisted, and it survives everyone else's refresh
        card.column = target;
        card.state = view.OWN_STATE[target] || "working";
        drawBoardPane();
        api("/api/projects/" + view.pid + "/board/tasks/" + id.replace(/^task-/, ""),
            { method: "POST", body: JSON.stringify({ column: target }) })
          .catch(function(err){ toast(err.message); loadBoard(); });
        return;
      }
      // derived card: we can move where you SEE it, not what it is
      var pins = boardPins();
      if (target === card.column) delete pins[id]; else pins[id] = target;
      savePins();
      drawBoardPane();
    }

    /** Right-click a card: everything its buttons do, plus moving it without a drag. */
    function cardMenu(el, x, y){
      var id = el.getAttribute("data-card");
      var c = (view.board.data.cards || []).filter(function(k){ return k.id === id; })[0];
      if (!c) return;
      var press = function(sel){ return function(){ var b = el.querySelector(sel); if (b) b.click(); }; };
      var items = [];
      if (c.own && el.querySelector("[data-edit]")) items.push({ label: "Edit title", icon: ICONS.pencil, run: press("[data-edit]") });
      items.push({ label: "Ask in chat", icon: ICONS.chat || ICONS.spark, run: function(){
        var box = document.getElementById("box"); if (!box) { toast("open the chat first"); return; }
        if (state.showTab) state.showTab("thread");
        box.value = (box.value.replace(/\s+$/, "") ? box.value.replace(/\s+$/, "") + "\n\n" : "") +
          "Card: " + c.title + (c.pr ? " (PR #" + c.pr.number + ")" : c.issue ? " (issue #" + c.issue.number + ")" : "") + "\n";
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.focus(); box.setSelectionRange(box.value.length, box.value.length);
      } });
      if (el.querySelector("[data-start]")) items.push({ label: "Hand to an agent", icon: ICONS.agents, run: press("[data-start]") });
      if (el.querySelector("[data-review]")) items.push({ label: "Review PR", icon: ICONS.check, run: press("[data-review]") });
      if (el.querySelector("[data-openpr]")) items.push({ label: "Open a PR", icon: ICONS.branch, run: press("[data-openpr]") });
      if (el.querySelector("[data-wtpr],[data-wtissue]")) items.push({ label: "Open a worktree", icon: ICONS.branch, run: press("[data-wtpr],[data-wtissue]") });
      if (c.own && el.querySelector("[data-prio]")) items.push({ label: "Priority\u2026", icon: ICONS.flag || ICONS.up, run: press("[data-prio]") });
      items.push({ sep: true }, { head: c.own ? "Move to" : "Show in" });
      view.BCOLS.forEach(function(col){
        if (col[0] !== c.column) items.push({ label: col[1], icon: "", run: function(){ moveCard(id, col[0]); } });
      });
      items.push({ sep: true });
      items.push({ label: "Copy title", icon: ICONS.copy, run: function(){ copyText(c.title); } });
      var url = c.pr ? c.pr.url : c.issue ? c.issue.url : null;
      if (url) items.push({ label: "Copy link", icon: ICONS.copy, run: function(){ copyText(url); } });
      if (el.querySelector("[data-unpin]")) items.push({ label: "Unpin (let its state place it)", icon: ICONS.x, run: press("[data-unpin]") });
      if (c.own && el.querySelector("[data-deltask]")) items.push({ sep: true }, { label: "Delete card", icon: ICONS.x, danger: true, run: press("[data-deltask]") });
      openMenu(x, y, items);
    }

    function wireBoardDnd(){
      var el = document.getElementById("pane-board"); if (!el) return;
      var dragging = null;
      Array.prototype.forEach.call(el.querySelectorAll(".bcard"), function(card){
        card.ondragstart = function(ev){
          dragging = card.getAttribute("data-card");
          card.classList.add("drag");
          ev.dataTransfer.effectAllowed = "move";
          // Firefox won't start a drag without payload
          ev.dataTransfer.setData("text/plain", dragging);
        };
        card.ondragend = function(){ card.classList.remove("drag"); dragging = null; };
      });
      Array.prototype.forEach.call(el.querySelectorAll(".bcb"), function(body){
        var col = body.closest(".bcol");
        body.ondragover = function(ev){ ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; col.classList.add("over"); };
        body.ondragleave = function(){ col.classList.remove("over"); };
        body.ondrop = function(ev){
          ev.preventDefault();
          col.classList.remove("over");
          var id = dragging || ev.dataTransfer.getData("text/plain");
          if (id) moveCard(id, body.getAttribute("data-drop"));
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll(".bcard"), function(card){
        card.oncontextmenu = function(ev){
          if (String(window.getSelection ? window.getSelection() : "").trim()) return; // copying text: the native menu
          ev.preventDefault();
          cardMenu(card, ev.clientX, ev.clientY);
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-unpin]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          delete boardPins()[b.getAttribute("data-unpin")];
          savePins();
          drawBoardPane();
        };
      });
    }
return { loadBoard, drawBoardPane };
}
