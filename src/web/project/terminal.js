import { api } from '../connection.js';
import { closeConsole,con,drawConsole,drawErrDot } from '../console.js';
import { esc } from '../format.js';
import { ICONS } from '../icons.js';
import { brow,closeBrowser,ensureBrowserPane,fillBrowserPane } from '../preview.js';
import { state } from '../state.js';

/** terminal behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createTerminal(view) {

    function curTerm(){ for (var i = 0; i < view.terms.length; i++) if (view.terms[i].id === view.activeTerm) return view.terms[i]; return null; }

    function termOpen(){ return view.desktop && localStorage.getItem(view.TERM_KEY) === "1"; }

    function wsSend(msg){
      var ws = state.ws;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    }

    function shortCwd(abs){
      var d = String(abs || "");
      var base = (state.project && state.project.dir) || "";
      if (base && d.indexOf(base) === 0) {
        var rest = d.slice(base.length).replace(/^[\\/]/, "");
        var name = base.split(/[\\/]/).filter(Boolean).pop() || "~";
        return rest ? name + "/" + rest : name;
      }
      var parts = d.split(/[\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : "~";
    }

    /** Map the design tokens onto an xterm palette so it matches the theme. */
    function xtermTheme(){
      var cs = getComputedStyle(document.documentElement);
      var v = function(n, fallback){ var x = cs.getPropertyValue(n).trim(); return x && x.charAt(0) === "#" ? x : fallback; };
      var fg = v("--foreground", "#fafafa");
      var dim = v("--muted-foreground", "#a1a1a1");
      return {
        background: v("--editor-surface", "#141414"),
        foreground: fg,
        cursor: fg,
        cursorAccent: v("--editor-surface", "#141414"),
        selectionBackground: "rgba(103,232,249,0.28)",
        black: dim,
        red: v("--git-del", "#c74e39"),
        green: v("--git-add", "#81b88b"),
        yellow: v("--warn", "#eab308"),
        blue: v("--thread", "#67e8f9"),
        magenta: v("--shuttle", "#e879f9"),
        cyan: v("--thread", "#67e8f9"),
        white: fg,
        brightBlack: dim,
        brightRed: v("--err", "#ff6568"),
        brightGreen: v("--ok", "#10b981"),
        brightYellow: v("--warn", "#eab308"),
        brightBlue: v("--thread", "#67e8f9"),
        brightMagenta: v("--shuttle", "#e879f9"),
        brightCyan: v("--thread", "#67e8f9"),
        brightWhite: fg
      };
    }

    function applyTerm(){
      var dock = document.getElementById("termdock"); if (!dock) return;
      var on = termOpen();
      dock.classList.toggle("open", on);
      var tb = document.getElementById("termbtn");
      if (tb) tb.classList.toggle("active", on);
      if (on) { ensureTerm(); fitActive(); focusTerm(); }
    }

    function toggleTerm(){
      localStorage.setItem(view.TERM_KEY, termOpen() ? "0" : "1");
      applyTerm();
    }

    function ensureTerm(){ if (!view.terms.length) addTerm(); }

    function focusTerm(){
      var t = curTerm(); if (!t || !termOpen()) return;
      setTimeout(function(){
        if (t.xterm) t.xterm.focus();
        else { var i = document.getElementById("terminput"); if (i) i.focus(); }
      }, 0);
    }

    /**
     * Re-measure the active terminal. Refuses to fit a pane with no box —
     * measuring a hidden element yields a 1x1 grid, and the pty gets resized
     * to match, which mangles the shell's line editing.
     */
    function fitActive(){
      var t = curTerm();
      if (!t || !t.fit) return;
      var host = document.querySelector('.termpane[data-t="' + t.id + '"]');
      if (!host || host.clientWidth < 40 || host.clientHeight < 20) return;
      try {
        t.fit.fit();
      } catch (e) {}
    }

    function paneFor(t){
      var el = document.querySelector('.termpane[data-t="' + t.id + '"]');
      if (el) return el;
      el = document.createElement("div");
      el.className = "termpane";
      el.setAttribute("data-t", t.id);
      document.getElementById("termpanes").appendChild(el);
      return el;
    }

    function addTerm(){
      view.termSeq++;
      var id = "t" + view.termSeq;
      var t = { id: id, title: "Terminal " + view.termSeq, html: "", busy: false,
                cwd: (state.project && state.project.dir) || "", hist: [], hi: -1, draft: "" };
      view.terms.push(t);
      view.activeTerm = id;
      // the pane must exist AND be visible before xterm opens into it —
      // measuring a display:none element yields a 1x1 grid, and the pty would
      // be sized to match.
      var host = paneFor(t);
      drawTermTabs();
      showTermPane();
      api("/api/projects/" + view.pid + "/term/open",
          { method: "POST", body: JSON.stringify({ term: id, cols: 80, rows: 24 }) })
        .then(function(r){
          t.cwd = r.cwd || t.cwd;
          view.termMode = r.mode || "pipe";
          if (view.termMode === "pty" && window.Terminal) mountXterm(t, host, r.scrollback || "");
          else mountLines(t, host, r.scrollback || "");
          showTermPane();
          fitActive();
          focusTerm();
        })
        .catch(function(err){
          host.innerHTML = '<div class="termbody"><div class="eo">loom: ' + esc(err.message) + "</div></div>";
        });
    }

    /** A real terminal: xterm.js speaking raw bytes to the pty over the WS. */
    function mountXterm(t, host, scrollback){
      var term = new window.Terminal({
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
        fontSize: 12,
        lineHeight: 1.2,
        theme: xtermTheme(),
        cursorBlink: true,
        scrollback: 10000,
        allowProposedApi: true,
        macOptionIsMeta: true
      });
      var fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      try { term.loadAddon(new window.WebLinksAddon.WebLinksAddon()); } catch (e) {}
      term.open(host);
      t.xterm = term; t.fit = fit;
      fitActive();
      // one more after layout settles — the dock may still be sizing
      requestAnimationFrame(function(){ fitActive(); });
      // scrollback is authoritative up to the open response; only fall back to
      // what we buffered when this is a fresh session with none.
      if (scrollback) term.write(scrollback);
      else if (t.pendingOut) term.write(t.pendingOut);
      t.pendingOut = "";
      // Cmd/Ctrl+C must copy when there's a selection and interrupt when there
      // isn't — the shortcut a terminal user expects, and xterm won't guess.
      // Cmd/Ctrl+V pastes; everything else falls through to the pty.
      term.attachCustomKeyEventHandler(function(e){
        if (e.type !== "keydown") return true;
        var mod = e.metaKey || e.ctrlKey;
        if (mod && e.key === "c" && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(function(){});
          return false;
        }
        if (mod && e.key === "v") {
          navigator.clipboard.readText().then(function(txt){
            if (txt) wsSend({ type: "term-input", term: t.id, data: txt });
          }).catch(function(){});
          return false;
        }
        if (mod && e.shiftKey && e.key.toLowerCase() === "k") { term.clear(); return false; }
        return true;
      });
      term.onData(function(d){ wsSend({ type: "term-input", term: t.id, data: d }); });
      term.onResize(function(size){ wsSend({ type: "term-resize", term: t.id, cols: size.cols, rows: size.rows }); });
      if (term.onTitleChange) term.onTitleChange(function(title){
        if (!title) return;
        t.title = title.length > 22 ? title.slice(0, 21) + "…" : title;
        drawTermTabs();
      });
      // the pty needs to know the real window, not the 80x24 we opened with
      wsSend({ type: "term-resize", term: t.id, cols: term.cols, rows: term.rows });
      if (!t.ro && window.ResizeObserver) {
        t.ro = new ResizeObserver(function(){ if (t.id === view.activeTerm) { try { fit.fit(); } catch (e) {} } });
        t.ro.observe(host);
      }
    }

    /** No pty: render lines ourselves and drive the shell one command at a time. */
    function mountLines(t, host, scrollback){
      host.innerHTML = '<div class="termbody"></div>';
      t.body = host.querySelector(".termbody");
      t.html = '<div class="hintl">shell in ' + esc(shortCwd(t.cwd)) +
        " · ⌃C interrupt · ⌃L clear · ↑ history</div>";
      var replay = scrollback || t.pendingOut || "";
      t.pendingOut = "";
      if (replay) t.html += "<span>" + esc(replay) + "</span>";
      t.body.innerHTML = t.html;
      var form = document.getElementById("termform");
      if (form) form.style.display = "";
      t.body.addEventListener("mousedown", function(ev){
        if (String(window.getSelection() || "")) return;
        if (ev.target.closest && ev.target.closest("a")) return;
        setTimeout(focusTerm, 0);
      });
      drawPrompt();
    }

    function closeTerm(id){
      var idx = -1;
      for (var i = 0; i < view.terms.length; i++) if (view.terms[i].id === id) idx = i;
      if (idx < 0) return;
      var t = view.terms[idx];
      if (t.ro) { try { t.ro.disconnect(); } catch (e) {} }
      if (t.xterm) { try { t.xterm.dispose(); } catch (e) {} }
      var pane = document.querySelector('.termpane[data-t="' + id + '"]');
      if (pane) pane.remove();
      api("/api/projects/" + view.pid + "/term/close", { method: "POST", body: JSON.stringify({ term: id }) }).catch(function(){});
      view.terms.splice(idx, 1);
      if (view.activeTerm === id) view.activeTerm = view.terms.length ? view.terms[Math.max(0, idx - 1)].id : null;
      if (!view.terms.length) { localStorage.setItem(view.TERM_KEY, "0"); applyTerm(); return; }
      drawTermTabs();
      showTermPane();
      focusTerm();
    }

    function drawTermTabs(){
      var box = document.getElementById("termtabs"); if (!box) return;
      var html = view.terms.map(function(t){
        return '<span class="termtab' + (t.id === view.activeTerm ? " active" : "") + '" data-t="' + t.id + '">' +
          (t.busy ? '<span class="busy" style="width:8px;height:8px;color:var(--live)"></span>' : "") +
          esc(t.title) + '<span class="tx" data-close="' + t.id + '">' + ICONS.x + "</span></span>";
      }).join("");
      // The console rides in the same bar as a closeable tab.
      if (con.present) {
        var unseen = con.logs.filter(function(r){ return r.level === "error" && r.id > con.seen; }).length;
        html += '<span class="termtab console' + (view.activeTerm === view.CONSOLE_TAB ? " active" : "") + '" data-console="1">' +
          (unseen ? '<span class="busy" style="width:7px;height:7px;color:var(--err)"></span>' : ICONS.console) +
          '<span class="ctt">Console</span>' +
          '<span class="tx" data-conclose="1" title="close console" aria-label="close console">' + ICONS.x + "</span></span>";
      }
      // And the browser, the same way — a peer tab, not a second drawer.
      if (brow.present) {
        html += '<span class="termtab console' + (view.activeTerm === view.BROWSER_TAB ? " active" : "") + '" data-browser="1">' +
          (brow.running ? '<span class="busy" style="width:7px;height:7px;color:var(--live)"></span>' : ICONS.globe) +
          '<span class="ctt">Browser</span>' +
          '<span class="tx" data-browclose="1" title="close browser" aria-label="close browser">' + ICONS.x + "</span></span>";
      }
      box.innerHTML = html;
      Array.prototype.forEach.call(box.querySelectorAll(".termtab[data-t]"), function(el){
        el.onclick = function(ev){
          var c = ev.target.closest ? ev.target.closest("[data-close]") : null;
          if (c) { closeTerm(c.getAttribute("data-close")); return; }
          // Switching to a terminal just changes which pane shows; the console
          // tab stays in the bar.
          view.activeTerm = el.getAttribute("data-t");
          drawTermTabs(); showTermPane(); drawPrompt(); fitActive(); focusTerm();
        };
      });
      var ct = box.querySelector(".termtab[data-console]");
      if (ct) ct.onclick = function(ev){
        var c = ev.target.closest ? ev.target.closest("[data-conclose]") : null;
        if (c) { closeConsole(); return; }
        view.activeTerm = view.CONSOLE_TAB;
        // seeing the console clears the "unread errors" dot
        con.logs.forEach(function(r){ if (r.id > con.seen) con.seen = r.id; });
        drawTermTabs(); showTermPane(); drawConsole(); drawErrDot();
      };
      var bt = box.querySelector(".termtab[data-browser]");
      if (bt) bt.onclick = function(ev){
        var c = ev.target.closest ? ev.target.closest("[data-browclose]") : null;
        if (c) { closeBrowser(); return; }
        view.activeTerm = view.BROWSER_TAB;
        // A tab carried over from another view comes with this mount's fresh,
        // empty markup: fill it, don't just redraw a list that isn't there.
        drawTermTabs(); showTermPane(); ensureBrowserPane();
      };
    }

    function showTermPane(){
      var conActive = view.activeTerm === view.CONSOLE_TAB;
      var browActive = view.activeTerm === view.BROWSER_TAB;
      var wrap = document.getElementById("conwrap");
      if (wrap) wrap.classList.toggle("on", conActive);
      var bwrap = document.getElementById("browwrap");
      if (bwrap) bwrap.classList.toggle("on", browActive);
      Array.prototype.forEach.call(document.querySelectorAll(".termpane"), function(p){
        p.classList.toggle("active", !conActive && !browActive && p.getAttribute("data-t") === view.activeTerm);
      });
      var t = conActive || browActive ? null : curTerm();
      var form = document.getElementById("termform");
      // the input line belongs to the fallback only — a pty takes keys directly
      if (form) form.style.display = t && !t.xterm && view.termMode === "pipe" ? "" : "none";
      if (t && t.fit) { try { t.fit.fit(); } catch (e) {} }
    }

    // Show the console as the active tab in the dock (called from the console
    // button, which lives at module scope and reaches this via state.showConsole).
    function showConsolePane(){
      con.present = true; con.open = true;
      if (!termOpen()) toggleTerm(); // opens the dock (and ensures a terminal)
      view.activeTerm = view.CONSOLE_TAB;
      drawTermTabs(); showTermPane();
    }

    // Close the console tab; fall back to a terminal, or shut the dock if the
    // console was the only thing in it.
    function hideConsolePane(){
      con.present = false; con.open = false;
      if (view.activeTerm === view.CONSOLE_TAB) view.activeTerm = view.terms.length ? view.terms[view.terms.length - 1].id : null;
      if (!view.terms.length) { localStorage.setItem(view.TERM_KEY, "0"); applyTerm(); return; }
      drawTermTabs(); showTermPane(); focusTerm();
    }
 // so a new error can refresh the tab's dot
    // The browser pane, same shape as the console pair above.
    function showBrowserPane(){
      brow.present = true;
      if (!termOpen()) toggleTerm();
      view.activeTerm = view.BROWSER_TAB;
      drawTermTabs(); showTermPane();
      // Whenever the pane becomes visible — including a dock restored from a
      // previous session, which never went through openBrowser — its contents
      // load. A rail that spins for ever is worse than an empty one.
      fillBrowserPane();
    }

    function hideBrowserPane(){
      brow.present = false;
      if (view.activeTerm === view.BROWSER_TAB) view.activeTerm = view.terms.length ? view.terms[view.terms.length - 1].id : null;
      if (!view.terms.length && !con.present) { localStorage.setItem(view.TERM_KEY, "0"); applyTerm(); return; }
      drawTermTabs(); showTermPane(); focusTerm();
    }

    function drawPrompt(){
      var t = curTerm(); if (!t || t.xterm) return;
      var pr = document.querySelector(".terminput .pr");
      if (pr) pr.innerHTML = esc(shortCwd(t.cwd)) + " <b>❯</b>";
      var row = document.querySelector(".terminput");
      if (row) row.classList.toggle("busy", !!t.busy);
      var st = document.querySelector(".terminput .st");
      if (st) st.textContent = t.busy ? "running · ⌃C to stop" : "";
    }

    function termAppend(t, html){
      t.html += html;
      if (t.id === view.activeTerm && t.body) {
        var atBottom = t.body.scrollHeight - t.body.scrollTop - t.body.clientHeight < 40;
        t.body.insertAdjacentHTML("beforeend", html);
        if (atBottom) t.body.scrollTop = t.body.scrollHeight;
      }
    }

    /**
     * Fallback renderer only: SGR colour/bold/underline become spans, other
     * escapes are dropped. (In pty mode xterm does all of this properly.)
     */
    function ansiToHtml(text, openRef){
      var out = "";
      var i = 0;
      var cls = openRef.cls || [];
      function openSpan(){ return cls.length ? '<span class="' + cls.join(" ") + '">' : ""; }
      function closeSpan(){ return cls.length ? "</span>" : ""; }
      out += openSpan();
      while (i < text.length) {
        var ch = text.charAt(i);
        if (ch === "\u001b") {
          var m = /^\u001b\[([0-9;]*)m/.exec(text.slice(i));
          if (m) {
            out += closeSpan();
            var codes = m[1] === "" ? ["0"] : m[1].split(";");
            codes.forEach(function(c){
              var n = Number(c);
              if (n === 0) cls = [];
              else if (n === 1) { if (cls.indexOf("a-b") < 0) cls.push("a-b"); }
              else if (n === 2) { if (cls.indexOf("a-d") < 0) cls.push("a-d"); }
              else if (n === 3) { if (cls.indexOf("a-i") < 0) cls.push("a-i"); }
              else if (n === 4) { if (cls.indexOf("a-u") < 0) cls.push("a-u"); }
              else if (n === 22) cls = cls.filter(function(x){ return x !== "a-b" && x !== "a-d"; });
              else if (n === 24) cls = cls.filter(function(x){ return x !== "a-u"; });
              else if (n === 39) cls = cls.filter(function(x){ return !/^a-[39]\d$/.test(x); });
              else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
                cls = cls.filter(function(x){ return !/^a-[39]\d$/.test(x); });
                cls.push("a-" + n);
              }
            });
            out += openSpan();
            i += m[0].length;
            continue;
          }
          var other = /^\u001b[\[\]][0-9;?]*[a-zA-Z]?/.exec(text.slice(i));
          i += other ? other[0].length : 1;
          continue;
        }
        if (ch === "\r") { i++; continue; }
        out += esc(ch);
        i++;
      }
      out += closeSpan();
      openRef.cls = cls;
      return out;
    }

    function runCmd(cmd){
      var t = curTerm(); if (!t) return;
      termAppend(t, '<div><span class="pl">' + esc(shortCwd(t.cwd)) + " <b>❯</b></span> " +
        '<span class="cmd">' + esc(cmd) + "</span></div>");
      t.busy = true; drawTermTabs(); drawPrompt();
      api("/api/projects/" + view.pid + "/term/input", { method: "POST", body: JSON.stringify({ term: t.id, data: cmd }) })
        .catch(function(err){
          t.busy = false; drawTermTabs(); drawPrompt();
          termAppend(t, '<div class="eo">loom: ' + esc(err.message) + "</div>");
        });
    }

    function interruptTerm(){
      var t = curTerm(); if (!t || !t.busy) return;
      termAppend(t, '<div class="run">^C</div>');
      api("/api/projects/" + view.pid + "/term/signal", { method: "POST", body: JSON.stringify({ term: t.id }) })
        .catch(function(){});
    }

    function onTermFrame(frame){
      var t = null;
      for (var i = 0; i < view.terms.length; i++) if (view.terms[i].id === frame.term) t = view.terms[i];
      if (!t) return;
      if (frame.chunk !== undefined) {
        // The shell prints its prompt the moment it spawns — before the open
        // response lands and the renderer is mounted. Hold anything that
        // arrives in that window instead of dropping it on the floor.
        if (!t.xterm && !t.body) { t.pendingOut = (t.pendingOut || "") + frame.chunk; return; }
        if (t.xterm) { t.xterm.write(frame.chunk); return; }
        if (!t.ansi) t.ansi = { cls: [] };
        termAppend(t, ansiToHtml(String(frame.chunk), t.ansi));
        return;
      }
      if (frame.title && t.xterm) return; // xterm reports its own title
      if (frame.exit !== undefined) {
        t.busy = false;
        if (frame.cwd) t.cwd = frame.cwd;
        var code = Number(frame.exit);
        if (code !== 0) termAppend(t, '<div class="exbad">└ exit ' + code + "</div>");
        drawTermTabs(); drawPrompt();
      }
      if (frame.closed) {
        t.busy = false;
        if (t.xterm) t.xterm.write("\r\n\u001b[2m└ shell exited\u001b[0m\r\n");
        else termAppend(t, '<div class="ex">└ shell exited</div>');
        drawTermTabs(); drawPrompt();
      }
    }
return { curTerm, termOpen, xtermTheme, applyTerm, toggleTerm, ensureTerm, focusTerm, fitActive, addTerm, drawTermTabs, showTermPane, showConsolePane, hideConsolePane, showBrowserPane, hideBrowserPane, runCmd, interruptTerm, onTermFrame };
}
