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
   * No dependency. The whole input is HTML-escaped FIRST, so every transform
   * below only ever adds tags around already-safe text; nothing an agent
   * prints can inject markup. Backticks are written as \x60 throughout.
   *
   * Blocks: fenced code (``` and ~~~, inside lists and quotes too), ATX
   * headings, rules, blockquotes (nested, with GitHub's [!NOTE] alerts),
   * lists (nested by indentation, with any blocks inside an item, task boxes,
   * the start number kept), tables (with column alignment), paragraphs with
   * soft line breaks. Inline: code spans (never touched by the rest), links,
   * images (as links — Loom doesn't fetch what an agent points at), bare and
   * <angle> URLs, bold, italic, bold-italic (* and _), strikethrough, and
   * backslash escapes.
   */
  function mdInline(s){
    // s is already HTML-escaped. Finished pieces are parked as \u0000n\u0000
    // so a later rule can't reach inside them (a URL's underscores, a code span's stars).
    var parked = [];
    var park = function(html){ parked.push(html); return "\u0000" + (parked.length - 1) + "\u0000"; };
    var link = function(href, label){ return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + "</a>"; };
    s = s.replace(/\\([\\\x60*_{}\[\]()#+\-.!|~>])/g, function(_m, c){ return park(c); });
    s = s.replace(/(\x60+)([^\x60]|[^\x60][\s\S]*?[^\x60])\1(?!\x60)/g, function(_m, _t, code){
      return park('<code class="mdi">' + code.replace(/^ (.*) $/, "$1") + "</code>");
    });
    s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+?)(?:\s+&quot;[^&]*&quot;)?\)/g, function(_m, alt, url){
      return park(link(url, "\ud83d\uddbc " + (alt || "image")));
    });
    s = s.replace(/\[([^\]]+?)\]\((https?:\/\/[^)\s]+?)(?:\s+&quot;[^&]*&quot;)?\)/g, function(_m, label, url){
      return park(link(url, mdInline(label)));
    });
    s = s.replace(/&lt;(https?:\/\/[^\s&]+?)&gt;/g, function(_m, url){ return park(link(url, url)); });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<\u0000]+)/g, function(_m, pre, url){
      var tail = "";
      for (;;) {
        var t = url.match(/(?:[.,;:!?)\]*_]|&quot;|&#39;|&gt;)$/);
        if (!t) break;
        if (t[0] === ")" && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break;
        tail = t[0] + tail; url = url.slice(0, -t[0].length);
      }
      return pre + park(link(url, url)) + tail;
    });
    s = s.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, "<strong><em>$2</em></strong>");
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
    s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    for (var guard = 0; guard < 5 && s.indexOf("\u0000") >= 0; guard++) {
      s = s.replace(/\u0000(\d+)\u0000/g, function(_m, n){ return parked[Number(n)]; });
    }
    return s;
  }

  // Kept for callers that only want URLs linked.
  function autolink(s){ return mdInline(s); }

  var FENCE_OPEN = /^(\s*)(\x60{3,}|~{3,})\s*([^\s\x60]*)[^\x60]*$/;
  var HEAD = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  var RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var QUOTE = /^ {0,3}&gt; ?/;
  var LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
  var LIST_EMPTY = /^(\s*)([-*+]|\d{1,9}[.)])\s*$/;
  var TROW = /^\s*\|?.*\|.*$/;
  var TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  var width = function(ws){ return ws.replace(/\t/g, "    ").length; };
  var startsBlock = function(l){ return FENCE_OPEN.test(l) || HEAD.test(l) || RULE.test(l) || QUOTE.test(l) || LIST.test(l); };

  /** A table row's cells: split on pipes that aren't escaped or inside a code span. */
  function tableCells(l){
    var t = l.trim().replace(/^\|/, "").replace(/\|$/, "");
    var cells = [], cur = "", code = false;
    for (var k = 0; k < t.length; k++) {
      var ch = t.charAt(k);
      if (ch === "\\" && t.charAt(k + 1) === "|") { cur += "\\|"; k++; continue; }
      if (ch === "\x60") code = !code;
      if (ch === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  function fencedCode(body, lang){
    // An orchestrator's plan: a card of tasks, not a page of JSON.
    if (lang === "loom" || (lang === "json" && /&quot;actions&quot;\s*:/.test(body) &&
        /&quot;type&quot;\s*:\s*&quot;(?:spawn|ask|done|send|cancel)&quot;/.test(body))) return planCardHtml(body);
    return '<div class="mdcodewrap"><button class="mdcopy" type="button" title="copy">' + ICONS.copy +
      "</button>" + (lang ? '<span class="mdlang">' + lang + "</span>" : "") +
      (lang === "mermaid" ? '<button class="mddraw" type="button" title="draw it — fetches the Mermaid renderer from jsdelivr the first time">' + ICONS.tree + "Draw diagram</button>" : "") +
      '<pre class="mdcode"><code>' + hlCode(body, lang) + "</code></pre></div>";
  }

  /** Block structure for already-escaped lines. Recursive: list items and quotes are documents too. */
  function mdBlocks(lines){
    var out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) { i++; continue; }

      var fm = line.match(FENCE_OPEN);
      if (fm) {
        var ind = width(fm[1]), mark = fm[2], code = [], j = i + 1;
        var lang = String(fm[3] || "").toLowerCase().replace(/[^a-z0-9+#_-]/g, "");
        var close = new RegExp("^\\s*" + (mark.charAt(0) === "~" ? "~" : "\\x60") + "{" + mark.length + ",}\\s*$");
        while (j < lines.length && !close.test(lines[j])) {
          var cl = lines[j], lead = cl.match(/^\s*/)[0];
          code.push(cl.slice(Math.min(width(lead) === lead.length ? lead.length : 0, ind)));
          j++;
        }
        out.push(fencedCode(code.join("\n"), lang));
        i = j + 1; continue;
      }

      if (TROW.test(line) && line.indexOf("|") >= 0 && i + 1 < lines.length && TSEP.test(lines[i + 1])) {
        var head = tableCells(line);
        var align = tableCells(lines[i + 1]).map(function(c){
          return /^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:-/.test(c) ? "left" : "";
        });
        var cellHtml = function(tag, c, k){ return "<" + tag + (align[k] ? ' style="text-align:' + align[k] + '"' : "") + ">" + mdInline(c) + "</" + tag + ">"; };
        var rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) { rows.push(tableCells(lines[i])); i++; }
        out.push('<div class="mdtablewrap"><table class="mdtable"><thead><tr>' +
          head.map(function(c, k){ return cellHtml("th", c, k); }).join("") + "</tr></thead><tbody>" +
          rows.map(function(r){ return "<tr>" + head.map(function(_h, k){ return cellHtml("td", r[k] || "", k); }).join("") + "</tr>"; }).join("") +
          "</tbody></table></div>");
        continue;
      }

      var h = line.match(HEAD);
      if (h) { out.push('<div class="mdh mdh' + h[1].length + '">' + mdInline(h[2]) + "</div>"); i++; continue; }

      if (RULE.test(line)) { out.push('<hr class="mdhr">'); i++; continue; }

      if (QUOTE.test(line)) {
        var q = [];
        // a quote runs until a blank line; an unmarked line right after a marked one continues it
        while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || (q.length && !startsBlock(lines[i])))) {
          q.push(lines[i].replace(QUOTE, "")); i++;
        }
        var alert = q[0] && q[0].match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i);
        if (alert) q.shift();
        out.push(alert
          ? '<div class="mdalert ' + alert[1].toLowerCase() + '"><div class="mdalerth">' + alert[1].charAt(0) + alert[1].slice(1).toLowerCase() + "</div>" + mdBlocks(q) + "</div>"
          : '<blockquote class="mdq">' + mdBlocks(q) + "</blockquote>");
        continue;
      }

      if (LIST.test(line) || LIST_EMPTY.test(line)) {
        var r = mdList(lines, i);
        out.push(r.html); i = r.i; continue;
      }

      var para = [];
      while (i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines[i])) &&
             !(lines[i].indexOf("|") >= 0 && i + 1 < lines.length && TSEP.test(lines[i + 1]))) {
        para.push(lines[i].trim()); i++;
        if (para.length && i < lines.length && startsBlock(lines[i])) break;
      }
      out.push('<div class="mdp">' + mdInline(para.join("<br>")) + "</div>");
    }
    return out.join("");
  }

  /**
   * One list. An item is its marker line plus every following line indented
   * past the marker (blank lines between them included), rendered as a
   * document of its own: so a code block, a quote or a deeper list inside an
   * item stays inside it. A one-paragraph item renders inline.
   */
  function mdList(lines, i){
    var first = lines[i].match(LIST) || lines[i].match(LIST_EMPTY);
    var indent = width(first[1]);
    var ordered = /\d/.test(first[2]);
    var start = ordered ? parseInt(first[2], 10) : 1;
    var items = [], loose = false;
    while (i < lines.length) {
      var m = lines[i].match(LIST) || lines[i].match(LIST_EMPTY);
      if (!m || width(m[1]) !== indent || /\d/.test(m[2]) !== ordered) break;
      var content = width(m[1]) + m[2].length + Math.min(m[3] ? width(m[3]) : 1, 4);
      var body = [m[4] || ""];
      i++;
      while (i < lines.length) {
        var l = lines[i];
        if (!l.trim()) {
          // a blank line stays in the item only if the item goes on after it
          var k = i + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          if (k < lines.length && width(lines[k].match(/^\s*/)[0]) >= content) { for (; i < k; i++) body.push(""); continue; }
          if (k < lines.length) { var nx = lines[k].match(LIST); if (nx && width(nx[1]) === indent) loose = true; }
          break;
        }
        var lead = width(l.match(/^\s*/)[0]);
        if (lead >= content) { body.push(l.replace(/^\s+/, function(ws){ return " ".repeat(Math.max(0, width(ws) - content)); })); i++; continue; }
        // a deeper marker that isn't indented enough still belongs to this item
        var sub = l.match(LIST);
        if (sub && width(sub[1]) > indent) { body.push(l.replace(/^\s+/, function(ws){ return " ".repeat(Math.max(0, width(ws) - indent - 2)); })); i++; continue; }
        // a lazy continuation of the item's text
        if (!startsBlock(l) && body[body.length - 1].trim()) { body.push(l.trim()); i++; continue; }
        break;
      }
      while (i < lines.length && !lines[i].trim()) {
        var k2 = i + 1;
        while (k2 < lines.length && !lines[k2].trim()) k2++;
        var nx2 = k2 < lines.length && lines[k2].match(LIST);
        if (nx2 && width(nx2[1]) === indent && /\d/.test(nx2[2]) === ordered) { loose = true; i = k2; }
        break;
      }
      items.push(body);
    }
    var html = items.map(function(body){
      var box = body[0].match(/^\[([ xX])\]\s+/);
      if (box) body[0] = body[0].slice(box[0].length);
      var inner = mdBlocks(body);
      var single = inner.match(/^<div class="mdp">([\s\S]*)<\/div>$/);
      if (single && !/<\/?(?:div|ul|ol|blockquote|pre|table)\b/.test(single[1])) inner = single[1];
      // a tight list's item leads with its text inline, then whatever it holds
      else if (!loose) inner = inner.replace(/^<div class="mdp">([\s\S]*?)<\/div>(?=<(?:ul|ol|div class="mdcodewrap"|blockquote|div class="mdalert"|div class="mdtablewrap"))/, "$1");
      return "<li" + (box ? ' class="mdtask"' : "") + ">" +
        (box ? '<input type="checkbox" class="mdcheck" disabled' + (box[1] === " " ? "" : " checked") + "> " : "") + inner + "</li>";
    }).join("");
    var tag = ordered ? "ol" : "ul";
    return { html: "<" + tag + ' class="mdlist' + (loose ? " loose" : "") + '"' + (ordered && start !== 1 ? ' start="' + start + '"' : "") + ">" + html + "</" + tag + ">", i: i };
  }

  function mdToHtml(src){
    return mdBlocks(esc(String(src == null ? "" : src).replace(/\r\n?/g, "\n")).split("\n"));
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