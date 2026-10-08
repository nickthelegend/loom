/** Browser format module. See README.md for ownership and startup. */
import { ICONS } from './icons.js';
import { planCardHtml,unesc } from './transcript.js';
import { toast } from './notifications.js';


  /**
   * Is this window still here?
   *
   * A reply can land after the window has gone — a closed tab, a torn-down
   * test — and the document is undefined by then. A late redraw that throws
   * turns into an unhandled rejection and blames whatever ran next, so the
   * few redraws that late replies reach ask first.
   */
  function pageGone(){ return typeof document === "undefined" || !document; }


  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); }


  /**
   * A small, safe markdown renderer for agent output.
   *
   * No dependency, no build step — the app has neither. The whole input is
   * HTML-escaped FIRST, so every transform below only ever adds tags around
   * already-safe text; nothing an agent prints can inject markup. Backticks are
   * written as \x60 throughout because a literal backtick would close this
   * template literal and take the app down.
   *
   * Handles: fenced code, inline code, bold/italic/strike, headings, lists,
   * blockquotes, rules, links (http/https only), and paragraphs with soft
   * line breaks — the subset agents actually emit.
   */
  function mdInline(s){
    // s is already HTML-escaped.
    s = s.replace(/\x60([^\x60]+?)\x60/g, '<code class="mdi">$1</code>');
    s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+?)~~/g, "<del>$1</del>");
    // [text](url) — only http(s); the url is already entity-escaped, so &amp; etc. are safe in the attribute.
    s = s.replace(/\[([^\]]+?)\]\((https?:\/\/[^)\s]+?)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return autolink(s);
  }

  /**
   * Bare http(s) URLs become links — outside tags, existing links and code
   * only. Trailing punctuation stays text: "see https://x.dev." links x.dev.
   */
  function autolink(s){
    if (s.indexOf("http") < 0) return s;
    var parts = s.split(/(<[^>]+>)/), skip = 0;
    for (var k = 0; k < parts.length; k++) {
      var p = parts[k];
      if (p.charAt(0) === "<") {
        if (/^<(a|code)\b/i.test(p)) skip++;
        else if (/^<\/(a|code)>/i.test(p)) skip = Math.max(0, skip - 1);
        continue;
      }
      if (skip) continue;
      parts[k] = p.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, function(_m, pre, url){
        var tail = "";
        for (;;) {
          var t = url.match(/(?:[.,;:!?)\]]|&quot;|&#39;|&gt;)$/);
          if (!t) break;
          // a URL with its own "(…)" keeps the closing paren
          if (t[0] === ")" && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break;
          tail = t[0] + tail; url = url.slice(0, -t[0].length);
        }
        return pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>" + tail;
      });
    }
    return parts.join("");
  }

  /**
   * A list, nested by indentation: deeper items become a list inside the item
   * above them; an indented line under an item continues it. "[ ]" and "[x]"
   * at the start of an item are checkboxes (read-only — it's a transcript).
   */
  function mdList(lines, i){
    var ULI = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
    var first = lines[i].match(ULI), indent = first[1].replace(/\t/g, "    ").length;
    var ordered = /\d/.test(first[2]);
    var start = ordered ? Number(first[2].replace(".", "")) || 1 : 1;
    var items = [];
    while (i < lines.length) {
      var m = lines[i].match(ULI);
      if (m) {
        var ind = m[1].replace(/\t/g, "    ").length;
        if (ind < indent) break;
        if (ind > indent && items.length) {
          var sub = mdList(lines, i);
          items[items.length - 1].kids += sub.html; i = sub.i; continue;
        }
        if (/\d/.test(m[2]) !== ordered) break; // a bullet after a number list starts a new list
        items.push({ text: m[3], kids: "" }); i++; continue;
      }
      var line = lines[i];
      // a blank line between items ("loose" list) doesn't end the list
      if (!line.trim()) {
        var nx = lines[i + 1];
        var nm = nx != null && nx.match(ULI);
        if (nm && nm[1].replace(/\t/g, "    ").length >= indent) { i++; continue; }
        break;
      }
      // an indented continuation line belongs to the item above
      if (items.length && /^\s+\S/.test(line) && line.replace(/\t/g, "    ").search(/\S/) > indent) {
        items[items.length - 1].text += " " + line.trim(); i++; continue;
      }
      break;
    }
    var html = "<" + (ordered ? "ol" : "ul") + ' class="mdlist"' + (ordered && start !== 1 ? ' start="' + start + '"' : "") + ">" +
      items.map(function(it){
        var t = it.text, box = t.match(/^\[([ xX])\]\s+/);
        if (box) t = '<input type="checkbox" class="mdcheck" disabled' + (box[1] === " " ? "" : " checked") + "> " + mdInline(t.slice(box[0].length));
        else t = mdInline(t);
        return "<li" + (box ? ' class="mdtask"' : "") + ">" + t + it.kids + "</li>";
      }).join("") + "</" + (ordered ? "ol" : "ul") + ">";
    return { html: html, i: i };
  }

  function mdToHtml(src){
    var lines = esc(String(src == null ? "" : src)).split("\n");
    var out = [], i = 0;
    var FENCE = /^\s*\x60\x60\x60(.*)$/, FENCE_END = /^\s*\x60\x60\x60\s*$/;
    var HEAD = /^(#{1,6})\s+(.*)$/, QUOTE = /^\s*&gt;\s?/, RULE = /^\s*(?:---|\*\*\*|___)\s*$/;
    var ULI = /^\s*[-*+]\s+/, OLI = /^\s*\d+\.\s+/;
    var TROW = /^\s*\|.*\|\s*$/, TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
    while (i < lines.length) {
      var line = lines[i];
      var fm = line.match(FENCE);
      if (fm) {
        var code = [], j = i + 1;
        var lang = String(fm[1] || "").trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9+#_-]/g, "");
        while (j < lines.length && !FENCE_END.test(lines[j])) { code.push(lines[j]); j++; }
        var body = code.join("\n");
        // An orchestrator's plan: a card of tasks, not a page of JSON.
        if (lang === "loom" || (lang === "json" && /&quot;actions&quot;\s*:/.test(body) &&
            /&quot;type&quot;\s*:\s*&quot;(?:spawn|ask|done|send|cancel)&quot;/.test(body))) {
          out.push(planCardHtml(body));
          i = j + 1; continue;
        }
        // A code block used to scroll sideways with no way to reach the end,
        // which is how an orchestrator's whole plan became unreadable. It
        // wraps now, and carries a copy button for the times you want it
        // somewhere else rather than on screen.
        out.push('<div class="mdcodewrap"><button class="mdcopy" type="button" title="copy">' + ICONS.copy +
          "</button>" + (lang ? '<span class="mdlang">' + lang + "</span>" : "") +
          (lang === "mermaid" ? '<button class="mddraw" type="button" title="draw it — fetches the Mermaid renderer from jsdelivr the first time">' + ICONS.tree + "Draw diagram</button>" : "") +
          '<pre class="mdcode"><code>' + hlCode(body, lang) + "</code></pre></div>");
        i = j + 1; continue;
      }
      // A table: a header row, a --- row, then body rows.
      if (TROW.test(line) && i + 1 < lines.length && TSEP.test(lines[i + 1])) {
        var cells = function(l){ return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function(c){ return mdInline(c.trim()); }); };
        var head = cells(line), trs = [];
        i += 2;
        while (i < lines.length && TROW.test(lines[i])) { trs.push(cells(lines[i])); i++; }
        out.push('<div class="mdtablewrap"><table class="mdtable"><thead><tr>' + head.map(function(c){ return "<th>" + c + "</th>"; }).join("") +
          "</tr></thead><tbody>" + trs.map(function(r){ return "<tr>" + r.map(function(c){ return "<td>" + c + "</td>"; }).join("") + "</tr>"; }).join("") +
          "</tbody></table></div>");
        continue;
      }
      var h = line.match(HEAD);
      if (h) { out.push('<div class="mdh mdh' + Math.min(6, h[1].length) + '">' + mdInline(h[2]) + "</div>"); i++; continue; }
      if (QUOTE.test(line)) {
        var q = [];
        while (i < lines.length && QUOTE.test(lines[i])) { q.push(lines[i].replace(QUOTE, "")); i++; }
        out.push('<blockquote class="mdq">' + mdInline(q.join(" ")) + "</blockquote>"); continue;
      }
      if (RULE.test(line)) { out.push('<hr class="mdhr">'); i++; continue; }
      if (ULI.test(line) || OLI.test(line)) {
        // an ordered list keeps its own numbering: "3." after a paragraph is 3, not 1
        var li = mdList(lines, i);
        out.push(li.html); i = li.i; continue;
      }
      if (!line.trim()) { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEAD.test(lines[i]) &&
             !QUOTE.test(lines[i]) && !RULE.test(lines[i]) && !ULI.test(lines[i]) && !OLI.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push('<div class="mdp">' + mdInline(para.join("<br>")) + "</div>");
    }
    return out.join("");
  }

  /**
   * A mermaid code block, drawn on request. The renderer (about 3 MB) comes from
   * jsdelivr the first time you ask and never before — Loom doesn't phone out
   * to draw a diagram you didn't ask to see. Strict mode: labels are text,
   * never markup or script. "Code" flips back to the source.
   */
  var mermaidLoad = null;
  function loadMermaid(){
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (mermaidLoad) return mermaidLoad;
    mermaidLoad = new Promise(function(resolve, reject){
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";
      s.async = true;
      s.onload = function(){ window.mermaid ? resolve(window.mermaid) : reject(new Error("the renderer loaded but didn’t start")); };
      s.onerror = function(){ mermaidLoad = null; reject(new Error("couldn’t fetch the diagram renderer — it needs the internet once")); };
      document.head.appendChild(s);
    });
    return mermaidLoad;
  }
  var mermaidN = 0;
  function drawMermaid(wrap, btn){
    if (!wrap) return;
    var shown = wrap.querySelector(".mmout");
    if (shown) {
      var codeOn = shown.style.display === "none";
      shown.style.display = codeOn ? "" : "none";
      wrap.querySelector(".mdcode").style.display = codeOn ? "none" : "";
      btn.lastChild.textContent = codeOn ? "Code" : "Diagram";
      return;
    }
    var src = (wrap.querySelector("code") || {}).textContent || "";
    btn.disabled = true;
    btn.lastChild.textContent = "Drawing…";
    loadMermaid().then(function(mm){
      var bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [255, 255, 255];
      var dark = (Number(bg[0]) + Number(bg[1]) + Number(bg[2])) / 3 < 128;
      mm.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", fontFamily: "inherit" });
      return mm.render("loommm" + (++mermaidN), src);
    }).then(function(r){
      var out = document.createElement("div");
      out.className = "mmout";
      out.innerHTML = r.svg;
      wrap.insertBefore(out, wrap.querySelector(".mdcode"));
      wrap.querySelector(".mdcode").style.display = "none";
      btn.lastChild.textContent = "Code";
    }).catch(function(err){
      btn.lastChild.textContent = "Draw diagram";
      toast(/fetch|internet/.test(String(err && err.message)) ? err.message : "that diagram doesn’t parse — " + String((err && err.message) || err).split("\n")[0].slice(0, 120));
    }).then(function(){ btn.disabled = false; });
  }

  /**
   * Just enough syntax colour to read code at a glance: comments, strings,
   * numbers, keywords and calls. A tokenizer, not a parser — it walks the
   * UNescaped text and escapes every piece on the way out, so nothing in the
   * code can become markup. Plain text and unknown fences pass through.
   */
  var HL_KW = /^(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|null|undefined|true|false|def|self|None|True|False|elif|pass|lambda|with|as|yield|fn|pub|impl|struct|enum|use|mod|match|mut|func|package|type|interface|public|private|protected|static|void|readonly|echo|then|fi|esac|local|export)$/;
  function hlCode(escaped, lang){
    if (!lang || /^(text|txt|plain|md|markdown|log|output|console|none)$/.test(lang)) return escaped;
    var src = unesc(escaped);
    if (lang === "diff" || lang === "patch") {
      return src.split("\n").map(function(l){
        var c = l.charAt(0) === "+" ? "ha" : l.charAt(0) === "-" ? "hd" : l.indexOf("@@") === 0 ? "hc" : "";
        return c ? '<span class="' + c + '">' + esc(l) + "</span>" : esc(l);
      }).join("\n");
    }
    var hashC = /^(py|python|sh|bash|zsh|shell|yaml|yml|toml|rb|ruby|r|perl|make|makefile|dockerfile|ini|conf|env)$/.test(lang);
    var out = "", i = 0, n = src.length;
    while (i < n) {
      var c = src.charAt(i);
      if ((c === "/" && src.charAt(i + 1) === "/" && !hashC) || (c === "#" && hashC)) {
        var e1 = src.indexOf("\n", i); if (e1 < 0) e1 = n;
        out += '<span class="hc">' + esc(src.slice(i, e1)) + "</span>"; i = e1; continue;
      }
      if (c === "/" && src.charAt(i + 1) === "*") {
        var e2 = src.indexOf("*/", i + 2); e2 = e2 < 0 ? n : e2 + 2;
        out += '<span class="hc">' + esc(src.slice(i, e2)) + "</span>"; i = e2; continue;
      }
      if (c === '"' || c === "'" || c === "\x60") {
        var j = i + 1;
        while (j < n && src.charAt(j) !== c && (src.charAt(j) !== "\n" || c === "\x60")) { if (src.charAt(j) === "\\") j++; j++; }
        j = Math.min(n, j + 1);
        out += '<span class="hs">' + esc(src.slice(i, j)) + "</span>"; i = j; continue;
      }
      if (/[0-9]/.test(c) && !/[A-Za-z0-9_$]/.test(src.charAt(i - 1))) {
        var num = src.slice(i).match(/^(?:0x[0-9a-fA-F]+|[0-9][0-9_]*(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/);
        if (num) { out += '<span class="hn">' + esc(num[0]) + "</span>"; i += num[0].length; continue; }
      }
      if (/[A-Za-z_$]/.test(c)) {
        var w = src.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)[0];
        if (HL_KW.test(w)) out += '<span class="hk">' + esc(w) + "</span>";
        else if (src.charAt(i + w.length) === "(") out += '<span class="hf">' + esc(w) + "</span>";
        else out += esc(w);
        i += w.length; continue;
      }
      out += esc(c); i++;
    }
    return out;
  }
  /**
   * Mark the match inside a line.
   *
   * Module scope, not inside a render function: the code search (renderProject)
   * and the chat search (renderShell) both call it, and when it lived in the
   * first of those the second threw a ReferenceError inside a .then() — the
   * header rendered, the rows silently didn't, and nothing reached the console.
   * That is the fourth time today a function has been called from the wrong
   * scope in this file.
   *
   * esc() first, always: this is a line of someone's source code and it will
   * contain angle brackets. Escaping after inserting the mark would eat the
   * mark; escaping the query too means a search for "<div" highlights rather
   * than injects.
   */
  function highlight(text, q){
    var safe = esc(String(text));
    var needle = esc(String(q));
    var at = safe.toLowerCase().indexOf(needle.toLowerCase());
    if (at < 0) return safe;
    return safe.slice(0, at) + "<mark>" + safe.slice(at, at + needle.length) + "</mark>" + safe.slice(at + needle.length);
  }

  function hue(id){ var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; }

  // Zero is "$0", not "$0.0000" — four decimals of nothing reads as fake
  // precision (and free-model turns genuinely cost nothing). Sub-cent but real
  // costs still show four places; anything that would round to $0.0000 is $0.
  /** A token count at a glance: 950, 12.3k, 1.2M. */
  function tokens(n){ n = Number(n) || 0; if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n < 1e4 ? (n / 1e3).toFixed(1) : String(Math.round(n / 1e3))) + "k"; return (n / 1e6).toFixed(1) + "M"; }
  function money(n){ n = Number(n) || 0; if (n < 0.00005) return "$0"; return "$" + (n >= 0.01 ? n.toFixed(2) : n.toFixed(4)); }

  /** Compact "3m ago" / "2h ago" / "5d ago" from an epoch-ms timestamp. */
  function rel(ts){
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
export { drawMermaid,esc,highlight,hue,mdInline,mdToHtml,money,pageGone,rel,tokens };