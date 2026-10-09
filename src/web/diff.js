/** Browser diff module. See README.md for ownership and startup. */
import { esc } from './format.js';
import { ICONS } from './icons.js';


  // ---- diff parsing (changes pane + rail) ---------------------------------
  // Loom's own state dir is workspace noise, not the user's change set.
  function isLoomInternal(path){ return String(path || "").indexOf(".loom/") === 0; }

  function visibleFiles(t){ return (t && t.files ? t.files : []).filter(function(f){ return !isLoomInternal(f.path); }); }

  function splitPatch(patch){
    var parts = [];
    var cur = null;
    String(patch || "").split("\n").forEach(function(line){
      var m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) { cur = { path: m[2], lines: [], add: 0, del: 0 }; parts.push(cur); return; }
      // a file the turn created, reported without a git diff of its own
      var nf = line.match(/^\?\? new file: (.+?)( \(binary\))?$/);
      if (nf) { cur = { path: nf[1], lines: [line], add: 0, del: 0, created: true, binary: !!nf[2] }; parts.push(cur); return; }
      if (!cur) { cur = { path: "", lines: [], add: 0, del: 0 }; parts.push(cur); }
      cur.lines.push(line);
      if (line.charAt(0) === "+" && line.slice(0, 3) !== "+++") cur.add++;
      if (line.charAt(0) === "-" && line.slice(0, 3) !== "---") cur.del++;
    });
    return parts.filter(function(f){ return f.path || f.lines.join("").trim(); });
  }

  function diffLineClass(line){
    if (line.slice(0, 3) === "+++" || line.slice(0, 3) === "---" || line.slice(0, 5) === "index" || line.slice(0, 3) === "new" || line.slice(0, 7) === "deleted") return "meta";
    if (line.charAt(0) === "+") return "add";
    if (line.charAt(0) === "-") return "del";
    if (line.slice(0, 2) === "@@") return "hunk";
    return "";
  }

  // Unified diff lines with an old/new line-number gutter (Orca diff view).
  function renderDiffLines(lines, commentFile){
    var oldN = 0, newN = 0, out = "";
    lines.forEach(function(line){
      var m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldN = Number(m[1]); newN = Number(m[2]);
        out += '<div class="dl hunk full">' + esc(line) + "</div>";
        return;
      }
      var c = diffLineClass(line);
      if (c === "meta") { out += '<div class="dl meta full">' + (esc(line) || " ") + "</div>"; return; }
      var ch = line.charAt(0);
      if (!oldN && !newN && ch !== "+" && ch !== "-") {
        out += '<div class="dl full">' + (esc(line) || " ") + "</div>";
        return;
      }
      var lo = "", ln = "", mark = "";
      if (c === "add") { ln = String(newN++); mark = "+"; }
      else if (c === "del") { lo = String(oldN++); mark = "\u2212"; }
      else { lo = String(oldN++); ln = String(newN++); }
      var content = ch === "+" || ch === "-" || ch === " " ? line.slice(1) : line;
      // Reviewable rows carry their location, so a click can turn into a
      // comment that names file:line instead of "that bit somewhere".
      var loc = commentFile && ln ? ' data-cfile="' + esc(commentFile) + '" data-cline="' + ln + '"' : "";
      out += '<div class="dl' + (c ? " " + c : "") + (loc ? " cmt" : "") + '"' + loc + ">" +
        '<span class="ln">' + lo + '</span><span class="ln">' + ln + "</span>" +
        '<span class="lm">' + mark + "</span>" +
        '<span class="lc">' + (esc(content) || " ") + "</span></div>";
    });
    return out;
  }
  /** Old on the left, new on the right: removals and additions paired row by row within a hunk. */
  function renderSplitLines(lines){
    var oldN = 0, newN = 0, out = "", dels = [], adds = [];
    function cell(n, text, cls){ return '<span class="ln">' + (n || "") + '</span><span class="sc' + (cls ? " " + cls : "") + '">' + (text === null ? "" : (esc(text) || " ")) + "</span>"; }
    function flush(){
      var n = Math.max(dels.length, adds.length);
      for (var i = 0; i < n; i++) {
        var d = dels[i], a = adds[i];
        out += '<div class="sl">' + (d ? cell(d[0], d[1], "del") : cell("", null, "empty")) + (a ? cell(a[0], a[1], "add") : cell("", null, "empty")) + "</div>";
      }
      dels = []; adds = [];
    }
    lines.forEach(function(line){
      var m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { flush(); oldN = Number(m[1]); newN = Number(m[2]); out += '<div class="sl hunk">' + esc(line) + "</div>"; return; }
      var c = diffLineClass(line);
      if (c === "meta" || (!oldN && !newN && line.charAt(0) !== "+" && line.charAt(0) !== "-")) { flush(); if (line) out += '<div class="sl meta">' + esc(line) + "</div>"; return; }
      var body = /^[+\- ]/.test(line) ? line.slice(1) : line;
      if (c === "del") { dels.push([oldN++, body]); return; }
      if (c === "add") { adds.push([newN++, body]); return; }
      flush();
      out += '<div class="sl">' + cell(oldN++, body, "") + cell(newN++, body, "") + "</div>";
    });
    flush();
    return out;
  }
  function diffView(){ try { return localStorage.getItem("loomDiffView") === "split" ? "split" : "unified"; } catch (e) { return "unified"; } }
  function diffBody(lines, path){ return diffView() === "split" ? '<div class="dsplit">' + renderSplitLines(lines) + "</div>" : renderDiffLines(lines, path); }
  function diffToggle(){
    var v = diffView();
    return '<div class="dvtoggle" role="group" aria-label="diff layout"><button type="button" data-dv="unified" class="' + (v === "unified" ? "on" : "") + '">Unified</button>' +
      '<button type="button" data-dv="split" class="' + (v === "split" ? "on" : "") + '">Side by side</button></div>';
  }

  function renderDiffFiles(tree){
    var files = splitPatch(tree.patch).filter(function(f){ return !isLoomInternal(f.path); });
    files.forEach(function(f){
      f.lines = f.lines.filter(function(l){ return !/^\?\? new file: \.loom\//.test(l); });
    });
    files = files.filter(function(f){ return f.path || f.lines.join("").trim(); });
    if (!files.length) return '<div class="sys">working tree is clean</div>';
    return files.map(function(f, i){
      // the card's title already names the file; git's header lines only repeat it
      var lines = f.lines.filter(function(l){ return !/^(index |--- |\+\+\+ |new file mode |deleted file mode )/.test(l); });
      var newImage = f.created && /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(f.path);
      var body = newImage
        ? '<div class="dnewimg"><img data-projimg="' + esc(f.path) + '" alt="' + esc(f.path) + '"></div>'
        : f.created && f.binary ? '<div class="dl meta full">new binary file</div>'
        : diffBody(lines, f.path);
      return '<div class="dfile" id="df-' + i + '">' +
        '<div class="dfh">' + ICONS.tree + '<span class="p">' + esc(f.path || "patch") + "</span>" +
        (f.created ? '<span class="dnew">new</span>' : '<span class="cadd">+' + f.add + "</span><span class=\"cdel\">\u2212" + f.del + "</span>") + "</div>" +
        '<div class="dcode">' + body + "</div></div>";
    }).join("");
  }
export { diffBody,diffLineClass,diffToggle,isLoomInternal,renderDiffFiles,renderDiffLines,splitPatch,visibleFiles };