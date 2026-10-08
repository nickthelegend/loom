/** Browser transcript module. See README.md for ownership and startup. */
import { AGENT_LABELS,agentGlyph,agentLabel,brandMark,hasBrand,kindOf,labelOf } from './agents.js';
import { approvalCard } from './approvals.js';
import { esc,hue,mdToHtml,money,tokens } from './format.js';
import { ICONS } from './icons.js';
import { toast } from './notifications.js';
import { state } from './state.js';
import { orchGoalName } from './team.js';
import { shortModel } from './permissions.js';


  // ---- event rendering -----------------------------------------------------
  // ---- thread presentation ------------------------------------------------
  // A reply reads like a document with a byline, not a chat bubble: who wrote
  // it (their mark, their name, the model), when, then the words at full
  // measure. Tool use folds into one quiet "activity" line per stretch, and a
  // turn ends on a footer that says how long it took and what it cost.
  /** "just now", "12m ago" for the last hour; the clock after that. */
  function relClock(ts){
    var t = Number(ts) || Date.now(), s = (Date.now() - t) / 1000;
    if (s < 45) return "just now";
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    return clock(t);
  }
  function clock(ts){
    var d = new Date(Number(ts) || Date.now());
    var h = d.getHours(), m = d.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }
  function durfmt(ms){
    ms = Number(ms) || 0;
    if (ms < 1000) return Math.max(0, Math.round(ms)) + "ms";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    return m + "m" + (s % 60 ? " " + (s % 60) + "s" : "");
  }
  /** The agent's mark in a small tile — its logo, or a monogram in its hue. */
  function avatarFor(id){
    var s = String(id || "?"), k = kindOf(s) || (AGENT_LABELS[s] ? s : null);
    // a picture you gave this agent wins over its brand mark
    var mine = state.project && (state.project.agents || []).filter(function(a){ return a.id === s && a.avatar; })[0];
    if (mine && /^data:image\/(png|jpeg|webp);base64,/.test(mine.avatar)) return '<span class="av pic"><img src="' + mine.avatar + '" alt=""></span>';
    if (s.indexOf("ask:") === 0) k = "model";
    if (hasBrand(k)) return '<span class="av">' + brandMark(k) + "</span>";
    var h = hue(s);
    return '<span class="av mono" style="background:color-mix(in srgb, hsl(' + h + ',60%,50%) 22%, transparent);color:hsl(' + h + ',60%,var(--agent-l))">' +
      esc(labelOf(s).replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "?") + "</span>";
  }
  function whoHtml(e, extra){
    var p = e.payload || {};
    return '<div class="who">' + avatarFor(e.agentId) + '<span class="wn">' + esc(labelOf(e.agentId)) + "</span>" +
      (p.model ? '<span class="wm">' + esc(shortModel(p.model)) + "</span>" : "") + (extra || "") +
      '<span class="wt"' + (e.id ? ' data-rel="' + Number(e.ts || 0) + '"' : "") + ' title="' + esc(new Date(Number(e.ts) || Date.now()).toLocaleString()) + '">' + (e.id ? relClock(e.ts) : clock(e.ts)) + "</span>" +
      (e.id && state.starSet && state.starSet[e.id] ? '<span class="wstar" title="starred">' + ICONS.star + "</span>" : "") +
      (e.id ? (function(){
        var rv = state.rateMap && state.rateMap[e.id] ? state.rateMap[e.id].v : 0;
        return '<button type="button" class="msgrate' + (rv === 1 ? " on" : "") + '" data-rate="1" title="Good reply — counts on the Insights leaderboard" aria-label="good reply" aria-pressed="' + (rv === 1) + '">' + ICONS.thumbsUp + "</button>" +
          '<button type="button" class="msgrate' + (rv === -1 ? " on down" : "") + '" data-rate="-1" title="Bad reply" aria-label="bad reply" aria-pressed="' + (rv === -1) + '">' + ICONS.thumbsDown + "</button>";
      })() : "") +
      '<button type="button" class="msgcopy" title="copy this reply" aria-label="copy this reply">' + ICONS.copy + "</button>" +
      (e.id ? '<button type="button" class="msgmore" title="More: retry, star, quote, make a card, link" aria-label="more actions">' + ICONS.dots + "</button>" : "") +
      "</div>";
  }
  /** Which icon a tool call gets, and which bucket it counts in. */
  function toolKind(p){
    var t = String(p.tool || p.name || "").toLowerCase(), s = String(p.summary || "").toLowerCase();
    if (/bash|shell|exec|command|terminal|run_|^run/.test(t) || /^(shell|bash|\$)[: ]/.test(s)) return "run";
    if (/edit|write|patch|apply|notebook|create_file|str_replace/.test(t)) return "edit";
    if (/grep|glob|search|find|ls$|list/.test(t)) return "search";
    if (/web|fetch|browse|url/.test(t)) return "web";
    if (/read|view|open|cat/.test(t)) return "read";
    if (/task|agent/.test(t)) return "agent";
    return "tool";
  }
  var TOOL_ICON = { run: "terminal", edit: "pencil", search: "search", web: "globe", read: "file", agent: "agents", tool: "gear" };
  /** "Ran 2 commands, read 3 files" — what a folded stretch of tool use did. */
  function actSummary(rows){
    var n = { run: 0, edit: 0, search: 0, web: 0, read: 0, agent: 0, tool: 0 };
    rows.forEach(function(r){ var k = r.getAttribute("data-tk") || "tool"; n[k] = (n[k] || 0) + 1; });
    var out = [];
    function one(k, verb, noun){ if (n[k]) out.push(verb + " " + n[k] + " " + noun + (n[k] === 1 ? "" : "s")); }
    one("run", "ran", "command"); one("read", "read", "file"); one("edit", "edited", "file");
    one("search", "searched", "time"); one("web", "fetched", "page"); one("agent", "started", "sub-agent"); one("tool", "used", "tool");
    var s = out.join(", ");
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : rows.length + " actions";
  }

  /**
   * An orchestrator's plan block as a plan, not a page of JSON.
   *
   * The engine reads the "loom" fence; people shouldn't have to. Parsed here
   * from the already-escaped text (so it's unescaped first, then every field
   * is escaped again on the way out). A fence that doesn't parse — a reply cut
   * off mid-block — keeps its raw form, folded, rather than vanishing.
   */
  function unesc(s){
    return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }
  /** A message as one line of plain words: no heading marks, fences or runs of space. */
  function plainPreview(s, max){
    var t = String(s || "").replace(/\x60{3}[\s\S]*?(\x60{3}|$)/g, " ").replace(/^\s*#{1,6}\s*/gm, "").replace(/[*_\x60]+/g, "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }
  function planCardHtml(escapedCode){
    var raw = unesc(escapedCode), data = null;
    try { data = JSON.parse(raw); } catch (e) { data = null; }
    var acts = data && (Array.isArray(data) ? data : data.actions);
    var rawFold = '<details class="pcraw"><summary>Raw plan</summary><div class="mdcodewrap"><button class="mdcopy" type="button" title="copy">' + ICONS.copy +
      '</button><pre class="mdcode"><code>' + escapedCode + "</code></pre></div></details>";
    if (!Array.isArray(acts)) {
      return '<div class="plancard bad"><div class="pch">' + ICONS.orchestra + "<span>Plan block that didn\u2019t parse</span></div>" + rawFold + "</div>";
    }
    // A round with nothing in it is legal — the orchestrator is still reading.
    if (!acts.length) return '<div class="planquiet">' + ICONS.orchestra + "<span>No tasks this round \u2014 still looking</span></div>";
    var spawns = [], rows = [];
    acts.forEach(function(a){ if (a && a.type === "spawn") spawns.push(a); });
    acts.forEach(function(a){
      if (!a || typeof a !== "object") return;
      if (a.type === "spawn") {
        var meta = [];
        if (a.dependsOn && a.dependsOn.length) meta.push("after " + a.dependsOn.map(esc).join(", "));
        if (a.touches && a.touches.length) meta.push('<span class="pctouch">' + a.touches.slice(0, 4).map(esc).join(" \u00b7 ") + (a.touches.length > 4 ? " \u2026" : "") + "</span>");
        rows.push('<li class="pcrow"><span class="pcid">' + esc(a.id || "task") + '</span><div class="pcbody"><div class="pct">' + esc(a.title || "untitled task") + "</div>" +
          (meta.length ? '<div class="pcmeta">' + meta.join(" \u00b7 ") + "</div>" : "") + "</div>" +
          '<span class="pcag">' + agentGlyph(kindOf(a.agent) || (AGENT_LABELS[a.agent] ? a.agent : null), a.agent) + esc(labelOf(a.agent)) + "</span></li>");
      } else if (a.type === "send") {
        rows.push('<li class="pcrow note"><span class="pcid">' + esc(a.task || "") + '</span><div class="pcbody"><div class="pct">Follow-up</div><div class="pcmeta">' +
          esc(plainPreview(a.message, 220)) + "</div></div></li>");
      } else if (a.type === "cancel") {
        rows.push('<li class="pcrow note"><span class="pcid">' + esc(a.task || "") + '</span><div class="pcbody"><div class="pct">Cancelled</div></div></li>');
      } else if (a.type === "ask") {
        rows.push('<li class="pcask">' + ICONS.help + "<span>" + esc(a.question || "") + "</span></li>");
      } else if (a.type === "done") {
        rows.push('<li class="pcdone">' + ICONS.check + "<span>" + esc(a.summary || "Done") + "</span></li>");
      }
    });
    var head = spawns.length ? spawns.length + " task" + (spawns.length === 1 ? "" : "s") :
      acts.some(function(a){ return a && a.type === "done"; }) ? "Wrapping up" :
      acts.some(function(a){ return a && a.type === "ask"; }) ? "A question for you" : "Next steps";
    return '<div class="plancard"><div class="pch">' + ICONS.orchestra + '<span>Plan</span><span class="pcn">' + esc(head) + "</span></div>" +
      '<ol class="pclist">' + rows.join("") + "</ol>" + rawFold + "</div>";
  }

  /**
   * How long a provider says to wait, from its own words: "try again in 23s",
   * "retry after 2 minutes", "Retry-After: 60", "resets in 1h 5m". 0 when it
   * doesn't say — no guessing a countdown.
   */
  function retryUntil(text, at){
    var ms = retryAfterMs(text);
    if (ms) return at + ms;
    // OpenRouter and friends say when, not how long: X-RateLimit-Reset (epoch s or ms)
    var m = String(text || "").match(/ratelimit-reset["':\s]+(\d{10,13})/i);
    if (!m) return 0;
    var n = Number(m[1]); if (n < 1e12) n *= 1000;
    return n > at && n - at < 48 * 3600000 ? n : 0;
  }
  function retryAfterMs(text){
    var t = String(text || "");
    var m = t.match(/retry-after["':\s]+(\d{1,6})/i);
    if (m) return Number(m[1]) * 1000;
    m = t.match(/(?:try again|retry|resets?|available again)[^0-9]{0,24}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b(?:\s*(\d+)\s*(m|mins?|minutes?|s|secs?|seconds?)\b)?/i);
    if (!m) return 0;
    function unit(n, u){
      u = u.toLowerCase();
      if (/^ms|^milli/.test(u)) return n;
      if (/^s/.test(u)) return n * 1000;
      if (/^m/.test(u)) return n * 60000;
      return n * 3600000;
    }
    var ms = unit(Number(m[1]), m[2]) + (m[3] ? unit(Number(m[3]), m[4]) : 0);
    return ms > 0 && ms < 48 * 3600000 ? ms : 0;
  }
  function untilText(until){
    var s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (s <= 0) return "Retry now";
    var h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return "Retry in " + (h ? h + ":" + String(mm).padStart(2, "0") : mm) + ":" + String(ss).padStart(2, "0");
  }
  /**
   * The empty-state mark: threads on a loom, warp and weft, with one bright
   * thread for the thing that isn't there yet. Drawn, not an image, so it
   * follows the theme.
   */
  function emptyArt(tone){
    var c = tone === "brain" ? "var(--shuttle)" : "var(--thread)";
    var warp = "", weft = "";
    for (var i = 0; i < 7; i++) warp += '<line x1="' + (20 + i * 16) + '" y1="14" x2="' + (20 + i * 16) + '" y2="86" stroke="currentColor" stroke-opacity=".22" stroke-width="2" stroke-linecap="round"/>';
    for (var j = 0; j < 4; j++) {
      var y = 26 + j * 16, d = "M12 " + y;
      for (var k = 0; k < 7; k++) d += " Q" + (20 + k * 16) + " " + (y + (k % 2 === j % 2 ? -5 : 5)) + " " + (28 + k * 16) + " " + y;
      weft += '<path d="' + d + '" fill="none" stroke="' + (j === 2 ? c : "currentColor") + '" stroke-opacity="' + (j === 2 ? "1" : ".32") + '" stroke-width="' + (j === 2 ? "2.6" : "2") + '" stroke-linecap="round"' + (j === 2 ? ' class="eaglow"' : "") + "/>";
    }
    return '<svg class="emptyart" viewBox="0 0 136 100" aria-hidden="true">' + warp + weft + "</svg>";
  }
  function lineFor(e){
    var p = e.payload || {};
    if (e.kind === "message") {
      if (!e.agentId) {
        // Loom briefing an orchestrator is a page of instructions, not a line:
        // fold it, headed by its first line, so the plan it produced stays in view.
        if (p.author === "loom" && p.orchestra) {
          return '<details class="orchbrief"><summary>\u25b8 Loom \u2192 orchestrator: ' + esc(String(p.text || "").split("\n")[0].slice(0, 120)) + "</summary>" +
            '<div class="md">' + mdToHtml(p.text) + "</div></details>";
        }
        if (p.author === "loom") return '<div class="sys">\u25b8 ' + esc(String(p.text).split("\n")[0]) + "</div>";
        // The orchestrator's brief to a worker opens every task thread. It is
        // not yours, so it must not wear your bubble.
        if (p.author === "orchestrator") {
          return '<div class="msg agent orchbriefmsg"><div class="who"><span class="av orch">' + ICONS.orchestra + '</span><span class="wn">Orchestrator</span>' +
            (p.orchestra && p.orchestra.taskId ? '<span class="thinktag">brief \u00b7 ' + esc(p.orchestra.taskId) + "</span>" : "") +
            '<span class="wt">' + clock(e.ts) + "</span></div>" +
            '<div class="bubble md" style="border-left-color:var(--thread)">' + mdToHtml(p.text) +
            (tview() === "verbose" ? rawBlock(p) : "") + "</div></div>";
        }
        // Your own messages: markdown too, so a pasted snippet or list reads right.
        // Attachments lead the text as "[image] path" lines: pictures, not paths.
        var att = splitAttachments(String(p.text || ""));
        return '<div class="msg user" data-id="' + Number(e.id || 0) + '" data-ts="' + Number(e.ts || 0) + '" data-raw="' + esc(encodeURIComponent(String(p.text || ""))) + '">' +
          (att.html ? '<div class="uatts">' + att.html + "</div>" : "") +
          (att.text.trim() || !att.html ? '<div class="bubble md">' + mdToHtml(att.text) + "</div>" : "") +
          '<div class="mt"><button type="button" class="uact uedit" title="Edit and send again" aria-label="edit and send again">' + ICONS.pencil + "</button>" +
          '<button type="button" class="uact ucopy" title="Copy" aria-label="copy your message">' + ICONS.copy + "</button>" +
          (e.id && state.starSet && state.starSet[e.id] ? '<span class="wstar" title="starred">' + ICONS.star + "</span>" : "") +
          '<button type="button" class="uact ustar" title="Star" aria-label="star your message">' + ICONS.star + "</button>" +
          '<span class="wt" data-rel="' + Number(e.ts || 0) + '" title="' + esc(new Date(Number(e.ts) || Date.now()).toLocaleString()) + '">' + relClock(e.ts) + "</span></div></div>";
      }
      var h = hue(e.agentId);
      // Reasoning / thinking (codex, grok, and now claude) renders as a distinct
      // collapsible block above the reply — dimmed, folded by default, so it's
      // there when you want it and out of the way when you don't.
      if (p.reasoning) {
        // At Normal the reasoning isn't the transcript — it's the working out.
        // Thinking folds it in; Verbose opens it.
        var tv = tview();
        if (tv === "normal") return "";
        return '<div class="msg agent thinking" data-agent="' + esc(e.agentId) + '">' +
          '<details class="thinkbox"' + (tv === "verbose" ? " open" : "") + "><summary>" + ICONS.spark + "Thought for a moment</summary><div class=\"md\">" +
          mdToHtml(p.text) + "</div></details></div>";
      }
      return '<div class="msg agent' + (p.partial ? " partial" : "") + '" data-agent="' + esc(e.agentId) + '" data-id="' + Number(e.id || 0) + '" data-ts="' + Number(e.ts || 0) + '">' +
        whoHtml(e, p.partial ? '<span class="thinktag stopped">stopped</span>' : "") +
        '<div class="bubble md" style="border-left-color:hsl(' + h + ',50%,var(--selvage-l))">' + mdToHtml(p.text) + "</div>" +
        (p.partial ? '<div class="msgfoot"><button type="button" class="btn xs outline" data-continue="' + esc(e.agentId) + '">' + ICONS.play + "Continue</button>" +
          '<span class="mfh">ask ' + esc(labelOf(e.agentId)) + " to pick up where it stopped</span></div>" : "") +
        "</div>";
    }
    if (e.kind === "tool_call") {
      var tk = toolKind(p);
      return '<div class="tool" data-tk="' + tk + '" data-agent="' + esc(e.agentId || "") + '"><span class="ti">' + (ICONS[TOOL_ICON[tk]] || ICONS.gear) + "</span>" +
        '<span class="tx">' + esc(p.summary || p.tool || p.name) + "</span>" +
        (p.ok === false ? '<span class="tbad">failed</span>' : "") +
        (tview() === "verbose" ? rawBlock(p) : "") + "</div>";
    }
    if (e.kind === "file_edit") {
      return '<div class="tool" data-tk="edit" data-agent="' + esc(e.agentId || "") + '"><span class="ti">' + ICONS.pencil + '</span><span class="tx">' + esc(p.path) + "</span></div>";
    }
    if (e.kind === "turn_diff") {
      var fl = (p.files || []).map(function(f){ return f.path; });
      var enc = p.patch ? encodeURIComponent(String(p.patch)) : "";
      var lbl = "Edited " + fl.length + " file" + (fl.length === 1 ? "" : "s");
      return '<div class="turncard" data-patch="' + enc + '" data-label="' + esc(lbl) + '">' +
        '<div class="tch"><span class="tci">' + ICONS.pencil + "</span><span>" + lbl + "</span>" +
        '<span class="tca">+' + Number(p.added || 0) + '</span><span class="tcd">\u2212' + Number(p.removed || 0) + "</span>" +
        (p.checkpoint ? '<button class="tcrw" type="button" data-rewind="' + esc(p.checkpoint) +
            '" title="put these files back the way they were before this turn">' + ICONS.rewind + "Rewind</button>" : "") +
        '<span class="tchev">\u25b8</span></div>' +
        '<div class="tcf">' + esc(fl.slice(0, 4).join(", ")) + (fl.length > 4 ? " \u2026" : "") + "</div>" +
        '<div class="tcdiff" style="display:none"></div></div>';
    }
    if (e.kind === "checkpoint") {
      if (p.reason !== "rewound") return tview() === "verbose" ? '<div class="sys" style="opacity:.6">\u21ba checkpoint \u00b7 ' + esc(p.label || p.id) + "</div>" : "";
      return '<div class="sys ok">\u21ba Rewound to \u201c' + esc(String(p.label || p.id).slice(0, 80)) + '\u201d \u00b7 ' +
        Number(p.files || 0) + " file" + (Number(p.files || 0) === 1 ? "" : "s") +
        (p.undo ? ' <button class="btn xs outline" type="button" data-rewind="' + esc(p.undo) + '">Undo the rewind</button>' : "") + "</div>";
    }
    if (e.kind === "handoff") return '<div class="handoff"><span class="a">' + esc(p.from || "\u2014") + '</span><span class="shuttle">\u27ff</span><span class="b">' + esc(p.to || "\u2014") + "</span></div>";
    // Sub-agents: indent under the turn, marked as borrowed hands — the parent
    // kept the baton, and the thread should read that way.
    if (e.kind === "subtask_started") return '<div class="sys" style="padding-left:22px">\u21b3 ' + esc(e.agentId) + " picks up a subtask for " + esc(p.parent) + ": " + esc(String(p.task || "").slice(0, 90)) + "</div>";
    if (e.kind === "subtask_done") return '<div class="sys" style="padding-left:22px;color:var(--live)">\u21b3 ' + esc(e.agentId) + " finished its subtask</div>";
    if (e.kind === "subtask_failed") return '<div class="sys err" style="padding-left:22px">\u21b3 ' + esc(e.agentId) + " subtask failed: " + esc(String(p.message || "").slice(0, 90)) + "</div>";
    if (e.kind === "suggestion") return '<div class="sys warn">\u2726 ' + esc(p.reason || "handoff suggested") + "</div>";
    if (e.kind === "needs_input") {
      // The one moment Loom exists to surface — an agent blocked on a human —
      // used to be a line of text with nothing to click. Worse in an orchestra
      // thread, where the composer aims at the orchestrator, so typing the
      // answer sent it to the wrong agent entirely (#106).
      var q = String(p.question || "what next?");
      var who = String(e.agentId || "agent");
      // A structured question the turn is waiting on: its own options, and the
      // answer goes back to that request rather than as a new message.
      if (p.requestId && p.responseMode !== "message" && Array.isArray(p.questions) && p.questions.length) {
        return '<div class="nicard" data-niask="' + esc(who) + '" data-nichat="' + esc(e.chat || "") + '" data-nireq="' + esc(p.requestId) + '">' +
          '<div class="nih">' + brandMark(kindOf(who)) + '<span class="niwho">' + esc(who) + "</span>" +
          '<span class="nitag">needs you</span></div>' +
          p.questions.map(function(qq){
            return '<div class="niqb" data-niqid="' + esc(qq.id) + '">' + (qq.header ? '<div class="nitag">' + esc(qq.header) + "</div>" : "") +
              '<div class="niq">' + esc(qq.question) + "</div>" +
              ((qq.options || []).length ? '<div class="niopts">' + qq.options.map(function(o){
                return '<button class="nio" type="button" data-nipick="' + esc(o.label) + '" data-niqid="' + esc(qq.id) + '" title="' + esc(o.description || "") + '">' + esc(o.label) + "</button>";
              }).join("") + "</div>" : "") + "</div>";
          }).join("") +
          '<div class="nirow"><input class="nitext" placeholder="or answer in your words…" spellcheck="false">' +
          '<button class="btn primary xs nisend" type="button">Send</button></div>' +
          '<div class="nidone"></div></div>';
      }
      var opts = questionChoices(q);
      return '<div class="nicard" data-niask="' + esc(who) + '" data-nichat="' + esc(e.chat || "") + '">' +
        '<div class="nih">' + brandMark(kindOf(who)) + '<span class="niwho">' + esc(who) + "</span>" +
        '<span class="nitag">needs you</span></div>' +
        '<div class="niq">' + esc(q) + "</div>" +
        (opts.length ? '<div class="niopts">' + opts.map(function(o){
          return '<button class="nio" type="button" data-nipick="' + esc(o) + '">' + esc(o) + "</button>";
        }).join("") + "</div>" : "") +
        '<div class="nirow"><input class="nitext" placeholder="answer ' + esc(who) + '…" spellcheck="false">' +
        '<button class="btn primary xs nisend" type="button">Send</button></div>' +
        '<div class="nidone"></div></div>';
    }
    if (e.kind === "decision") return '<div class="sys">\u2605 ' + esc(p.text) + "</div>";
    if (e.kind === "memory_import") return '<div class="sys" style="color:var(--thread-ink)">\u25c8 imported ' + esc(p.file) + " into the shared brain</div>";
    if (e.kind === "error") {
      // An error is a card: what happened in words, who it happened to, and
      // the provider's raw payload folded underneath — not a red wall of JSON.
      var msg = String(p.message || "something went wrong");
      var cutAt = msg.search(/[\[{]/);
      var head = (cutAt > 12 ? msg.slice(0, cutAt) : msg).replace(/[\s:\-—(]+$/, "");
      var rest = cutAt > 12 ? msg.slice(cutAt) : "";
      if (head.length > 240) { rest = head.slice(240) + rest; head = head.slice(0, 240) + "\u2026"; }
      var detail = rest || (p.stderr ? String(p.stderr) : "");
      // A limit that says when it lifts gets a countdown and a retry that waits for it.
      var until = retryUntil(msg + " " + detail, Number(e.ts || Date.now()));
      var limited = /quota|rate.?limit|429|too many requests|credit|insufficient|billing|exceeded/i.test(msg);
      return '<div class="sys err errcard"' + (e.agentId ? ' data-agent="' + esc(e.agentId) + '"' : "") + ' data-ts="' + Number(e.ts || 0) + '">' +
        '<div class="errh">' + ICONS.alert + "<span>" + (e.agentId ? "<b>" + esc(labelOf(e.agentId)) + "</b> · " : "") + esc(head) + "</span></div>" +
        (detail ? '<details class="errd"><summary>Details</summary><pre>' + esc(detail.slice(0, 4000)) + "</pre></details>" : "") +
        '<div class="erra">' +
          (e.agentId ? '<button type="button" class="btn xs' + (limited ? " primary" : " outline") + '" data-errother="' + esc(e.agentId) + '">' + ICONS.agents + "Send to another agent</button>" : "") +
          (until && until > Date.now() ? '<button type="button" class="btn xs outline" data-errwait="' + esc(e.agentId || "") + '" data-until="' + until + '">' + ICONS.clock + '<span class="errcd" data-until="' + until + '">' + untilText(until) + "</span></button>" : "") +
          '<button type="button" class="btn xs ghost" data-errcopy="1">' + ICONS.copy + "Copy details</button>" +
        "</div></div>";
    }
    if (e.kind === "route_started") {
      if (p.mode === "dynamic") return '<div class="sys">\u25b8 route "auto" started \u2014 ' + esc(p.router) + " picks each hop</div>";
      return '<div class="sys">\u25b8 route started: ' + esc((p.steps || []).join(" \u2192 ")) + "</div>";
    }
    if (e.kind === "route_step") {
      var pos = p.of ? "step " + (Number(p.step) + 1) + "/" + Number(p.of) : "hop " + (Number(p.step) + 1);
      if (p.skipped) {
        return '<div class="sys" style="opacity:.65">\u2937 ' + pos + " \u2192 " + esc(p.agent) +
          " " + esc(p.reason || "skipped") + "</div>";
      }
      return '<div class="sys">\u25b8 ' + pos + " \u2192 " + esc(p.agent) +
        (p.reason ? ' <span style="opacity:.7">(' + esc(p.reason) + ")</span>" : "") + "</div>";
    }
    if (e.kind === "route_paused") return '<div class="sys warn">\u23f8 route paused \u2014 ' + esc(p.agent) + " asks: " + esc(p.question) + "</div>";
    if (e.kind === "route_resumed") return '<div class="sys">\u25b8 route resumed</div>';
    if (e.kind === "route_completed") return '<div class="sys ok">\u2713 route completed</div>';
    if (e.kind === "route_failed") return '<div class="sys ' + (p.aborted ? "warn" : "err") + '">\u2298 ' + esc(p.reason || "route ended") + "</div>";
    if (e.kind === "run_complete") {
      // The end of a turn: how long it took, what it ran on, what it cost —
      // the three things you'd otherwise go to the Observatory to find out.
      var bits = [esc(labelOf(e.agentId))];
      if (p.durationMs) bits.push(durfmt(p.durationMs));
      if (p.model) bits.push(esc(shortModel(p.model)));
      if (p.costUsd) bits.push(money(p.costUsd));
      var outTok = Number(p.outputTokens || 0);
      if (outTok) bits.push(outTok >= 1000 ? (outTok / 1000).toFixed(1) + "k tokens out" : outTok + " tokens out");
      return '<div class="turnend" data-agent="' + esc(e.agentId || "") + '">' + ICONS.check + "<span>" + bits.join(" \u00b7 ") + "</span></div>";
    }
    if (e.kind === "orchestra") return orchLine(p);
    // An agent in "always ask" waiting on you: a card with the two answers.
    // Its answer arrives as a second event, which folds the card (append()),
    // so this line only shows when the card itself is out of the window.
    // Native harness housekeeping. Compaction is shown while it runs (the
    // row folds when it ends, see thread.js) and once it is done; the rest of
    // the usage reports feed the agent's context meter, not the thread.
    if (e.kind === "status") {
      if (p.state === "compacting") return '<div class="sys live compacting" data-agent="' + esc(e.agentId || "") + '"><span class="busy"></span> ' +
        esc(labelOf(e.agentId)) + " is compacting its context\u2026</div>";
      if (p.state === "native_compacted") return '<div class="sys">\u21bb ' + esc(labelOf(e.agentId)) + " compacted its context" +
        (p.preTokens ? " \u00b7 " + tokens(p.preTokens) + (p.postTokens ? " \u2192 " + tokens(p.postTokens) : "") + " tokens" : "") + "</div>";
      if (p.state === "notice" && p.message) return '<div class="sys warn">! ' + esc(String(p.message).slice(0, 300)) + (p.retrying ? " \u2014 retrying" : "") + "</div>";
      return "";
    }
    if (e.kind === "approval") {
      if (p.phase === "requested") return approvalCard({ approvalId: p.approvalId, agent: e.agentId, tool: p.tool, input: p.input, ts: e.ts });
      if (p.phase === "decided") return '<div class="sys apl">' + (p.behavior === "allow" ? '<span class="ok">\u2713 allowed</span> ' : '<span class="no">\u2715 denied</span> ') +
        esc(p.tool || "tool") + " for " + esc(labelOf(e.agentId)) + (p.message ? " \u2014 " + esc(p.message) : "") + "</div>";
    }
    return "";
  }


  /**
   * One orchestra step as a thread line. Every phase gets words; an unknown
   * one still reads as a sentence, never as the payload it came in.
   */
  var ORCH_TASK_ST = { pending: ["pending", "off"], running: ["running", "live"], done: ["done", "ok"],
    conflict: ["conflict", "warn"], needs_input: ["needs input", "warn"], failed: ["failed", "err"], cancelled: ["cancelled", "off"] };

  var ORCH_RUN_ST = { starting: ["starting", "live"], planning: ["planning", "live"], running: ["running", "live"],
    reviewing: ["reviewing", "live"], waiting_human: ["needs you", "warn"], completed: ["completed", "ok"],
    failed: ["failed", "err"], aborted: ["aborted", "off"], moved: ["moved", "off"] };

  // Loom Teams, Phase 4: a goal PR's way to main (LandingState.state, D52\u2013D63)
  var LAND_ST = { open: ["PR open", "off"], pending: ["checks running", "live"], green: ["green", "ok"], failing: ["failing", "err"],
    fixing: ["fixing", "live"], needs_human: ["needs you", "warn"], queued: ["queued", "off"], landing: ["landing", "live"], merged: ["merged", "ok"], closed: ["closed", "off"] };

  function landPill(l){
    var s = LAND_ST[l && l.state] || [(l && l.state) || "\u2014", "off"];
    return '<span class="opill ' + s[1] + '" data-lstate="' + esc(l && l.state) + '"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + "</span>";
  }

  function orchLine(p){
    var ph = p.phase;
    var tone = { ok: " ok", warn: " warn", err: " err" };
    function row(cls, html, attrs){ return '<div class="sys orch' + (cls || "") + '"' + (attrs || "") + ">" + html + "</div>"; }
    function names(list){ return (list || []).map(function(id){ return esc(labelOf(id)); }).join(", "); }
    if (ph === "started") {
      var o = p.orchestrator || {};
      if (p.race) return row(" start", ICONS.play + "Race started \u2014 " + (names(p.workers) || "every agent") + " each take the same goal, side by side") +
        (p.note ? row(" warn", "\u26a0 " + esc(p.note)) : "");
      return row(" start", ICONS.orchestra + "Orchestra started \u2014 " + esc(agentLabel(o.kind, o.agent)) + " is orchestrating " +
        (names(p.workers) || "its workers") + (p.maxParallel ? " (" + Number(p.maxParallel) + " in parallel)" : "")) +
        (p.note ? row(" warn", "\u26a0 " + esc(p.note)) : "");
    }
    if (ph === "plan") {
      var acts = {};
      (p.actions || []).forEach(function(a){ acts[a] = (acts[a] || 0) + 1; });
      var said = [];
      if (acts.spawn) said.push(acts.spawn + " new task" + (acts.spawn === 1 ? "" : "s"));
      if (acts.send) said.push(acts.send + " follow-up" + (acts.send === 1 ? "" : "s"));
      if (acts.cancel) said.push(acts.cancel + " cancelled");
      if (acts.ask) said.push("a question for you");
      if (acts.done) said.push("done");
      return row("", "Round " + Number(p.round || 1) + ": orchestrator planned \u2014 " + (said.join(", ") || "no changes")) +
        (p.rejected && p.rejected.length ? row(" warn", "\u26a0 not applied: " + esc(p.rejected.join("; ").slice(0, 240))) : "");
    }
    if (ph === "task" && p.task) {
      var t = p.task, st = ORCH_TASK_ST[t.status] || [t.status || "", "off"];
      // Each task runs in its own thread. The row that announces it is the
      // way in — otherwise the orchestrator names threads you can only find
      // by hunting the sidebar for a title you half remember (#100).
      var inner = esc(t.id) + " \u00b7 " + esc(String(t.title || "").slice(0, 80)) + " \u2192 " +
        agentGlyph(t.kind, t.agent) + esc(agentLabel(t.kind, t.agent)) + " \u00b7 " + esc(st[0]);
      return row(tone[st[1]] || "", t.chat
        ? '<button class="tlink" type="button" data-gochat="' + esc(t.chat) + '" title="open ' + esc(t.id) + '\u2019s thread">' +
            inner + '<span class="tlinkgo">' + ICONS.thread + "</span></button>"
        : inner, ' data-otask="' + esc((p.runId || "") + "/" + t.id) + '"');
    }
    if (ph === "task_started") return row("", "\u25b8 " + esc(p.taskId) + " started \u2014 " + esc(String(p.title || "").slice(0, 90)) + (p.agent ? " \u00b7 " + esc(labelOf(p.agent)) : ""));
    if (ph === "task_finished") {
      var fs = ORCH_TASK_ST[p.status] || [p.status || "finished", "off"], nf = (p.files || []).length;
      return row(tone[fs[1]] || "", (fs[1] === "ok" ? "\u2713 " : "\u25a0 ") + esc(p.taskId) + " finished \u00b7 " + esc(fs[0]) +
        (nf ? " \u00b7 " + nf + " file" + (nf === 1 ? "" : "s") + " changed" : ""));
    }
    if (ph === "reviewing") return row("", "Round " + Number(p.round || 1) + ": orchestrator reviewing results");
    if (ph === "waiting") return row(" warn", "\u23f8 Orchestrator asks: " + esc(p.question || "what next?"));
    if (ph === "completed" && p.race) {
      var rn = (p.tasks || []).length;
      return '<div class="sys orch ok odone">' +
        '<div class="odh">' + ICONS.check + '<b>Race finished</b><span class="odm">' + rn + " entrant" + (rn === 1 ? "" : "s") + " · " + money(p.costUsd) + "</span></div>" +
        '<div class="oda"><button class="btn xs primary" type="button" data-orch-compare="' + esc(p.runId) + '">Compare &amp; pick</button></div></div>';
    }
    if (ph === "completed") {
      // The end of a run is a result, not a status line: what it did, what it
      // cost, where it is, and the one button that matters next.
      var n = (p.tasks || []).length;
      var meta = [n + " task" + (n === 1 ? "" : "s"), money(p.costUsd)];
      if (p.branch) meta.push('<code class="obr">' + esc(p.branch) + "</code>");
      return '<div class="sys orch ok odone">' +
        '<div class="odh">' + ICONS.check + '<b>Orchestra complete</b><span class="odm">' + meta.join(" \u00b7 ") + "</span></div>" +
        (p.summary ? '<div class="ods">' + esc(plainPreview(p.summary, 600)) + "</div>" : "") +
        (p.runId ? '<div class="oda"><button class="btn xs primary" type="button" data-orch-apply="' + esc(p.runId) + '">Apply to your branch</button></div>' : "") +
        "</div>";
    }
    if (ph === "failed") return row(" err", "\u2717 Orchestra failed \u2014 " + esc(p.error || "stopped") +
      (p.runId ? ' <button class="btn xs outline" type="button" data-orch-apply="' + esc(p.runId) + '">Apply what finished</button>' : ""));
    if (ph === "aborted") return row(" warn", "⊘ Orchestra aborted" + (p.reason ? " — " + esc(p.reason) : "") +
      (p.runId && /restart|shutdown/i.test(String(p.reason || "")) ? ' <button class="btn xs primary" type="button" data-orch-resume="' + esc(p.runId) + '">Resume</button>' : ""));
    if (ph === "resumed") return row(" start", ICONS.play + "Orchestra resumed" + (p.tasks ? " — " + Number(p.tasks) + " interrupted task" + (Number(p.tasks) === 1 ? "" : "s") + " picking up where " + (Number(p.tasks) === 1 ? "it" : "they") + " left off" : " — the orchestrator reviews where things stand"));
    if (ph === "applied") return row(" ok", "\u2713 " + (p.agent ? esc(labelOf(p.agent)) + "\u2019s take merged into " : "Orchestra merged into ") + esc(p.into || "your branch"));
    if (ph === "cleaned") return row("", "Orchestra worktrees cleaned up");
    // Plan mode: the orchestrator's plan, on the run's branch, as files.
    if (ph === "plan_written") {
      var specs = Math.max(0, Number(p.files || 0) - 1);
      return row(" ok", "\u270e " + (p.final ? "Plan updated with the results" : "Plan written") + " \u2014 " + esc(p.dir || "plans") + "/PLAN.md" +
        (specs ? " + " + specs + " task spec" + (specs === 1 ? "" : "s") : ""));
    }
    if (ph === "plan_failed") return row(" err", "\u2717 Couldn\u2019t write the plan \u2014 " + esc(p.error || "unknown error"));
    // Git delivery: what the project's policy did with the finished run.
    if (ph === "delivered") {
      if (p.mode === "pr") {
        var num = String(p.prUrl || "").match(/\/pull\/(\d+)/);
        return row(" ok", /^https?:\/\//.test(String(p.prUrl || ""))
          ? "\u2713 Opened " + '<a href="' + esc(p.prUrl) + '" target="_blank" rel="noopener noreferrer">' + (num ? "PR #" + esc(num[1]) : "a PR") + " \u2197</a>" + (p.pushed ? " from " + esc(p.pushed) : "")
          : "\u2713 Pushed " + esc(p.pushed || "the run\u2019s branch"));
      }
      return row(" ok", "\u2713 Merged into " + esc(p.into || "your branch") + (p.mode === "push" ? " and pushed" : ""));
    }
    // Loom Teams, Phase 2: what the team made a task wait for, and what it changed.
    if (ph === "task_held") {
      var hd = p.hold || {}, tid = esc(p.taskId || "a task");
      if (hd.kind === "wait") return row(" live", "\u23f8 " + tid + " waits for " + orchGoalName(hd.runId) + "\u2019s PR to merge before it starts");
      if (hd.kind === "zone") return row(" warn", "\u23f8 " + tid + " is queued behind " + esc(hd.holder || "a teammate") + "\u2019s hard zone <code>" + esc(hd.zone || "") + "</code>");
      if (hd.kind === "capacity") return row("", "\u23f8 " + tid + " is queued \u2014 " + esc(String(hd.reason || "the team is at its agent limit").slice(0, 200)));
      return row(" warn", "\u23f8 " + tid + " needs the orchestrator \u2014 " + esc(String(hd.reason || "a teammate overlaps it").slice(0, 240)));
    }
    // Phase 4: the PR's own state lives on the run card (every poll emits
    // one); an alert is the sentence worth keeping in the thread.
    if (ph === "landing") return "";
    if (ph === "alert") return row(" warn", "\u26a0 " + esc(String(p.text || "").slice(0, 240)));
    // Phase 5: the goal moving to a runner and back (D75, D76)
    if (ph === "moving") return row(" live", "\u21e2 Moving to " + esc(p.to || "a runner") + " \u2014 running turns finish first (up to 2 min)");
    if (ph === "moved") return row("", "\u21e2 Moved to " + esc(p.to || "a runner") + " \u2014 it carries on there; this copy is read-only");
    if (ph === "imported") return row(" ok", "\u21e0 Picked up from " + esc(p.from || "another machine") + (p.tasks ? " \u00b7 " + Number(p.tasks) + " task" + (p.tasks === 1 ? "" : "s") : ""));
    if (ph === "synced") return row("","\u21bb Brought the goal up to date with " + esc(p.with || "main") + " before a waiting task started");
    if (ph === "delivery_policy") return row(" warn", "\u26a0 " + esc(p.branch || "the base branch") + " is protected by team policy \u2014 delivering as a PR instead of " +
      (p.from === "push" ? "merging and pushing" : "merging"));
    if (ph === "delivery_failed") return row(" err", "\u2717 Delivery (" + esc(p.mode || "git") + ") failed \u2014 " + esc(String(p.error || "").slice(0, 200)) +
      (p.runId ? ' <button class="btn xs outline" type="button" data-orch-deliver="' + esc(p.runId) + '">Retry delivery</button>' : ""));
    return row("", ICONS.orchestra + "Orchestra \u00b7 " + esc(String(ph || "update").replace(/_/g, " ")));
  }


  /**
   * How much of a turn the thread shows.
   *
   *   normal   — what an agent said and did: prose, edits, one line per tool
   *   thinking — plus the reasoning it streamed, which Loom already receives
   *   verbose  — plus the raw material: the full payload behind each tool
   *              call, and nothing folded
   *
   * Per project, because "show me everything" is a thing you want while
   * reading one project's run and not while reading another's.
   */
  var TVIEWS = ["normal", "thinking", "verbose"];

  function tview(){
    try {
      var v = localStorage.getItem("loomTView:" + state.pid);
      return TVIEWS.indexOf(v) >= 0 ? v : "normal";
    } catch (e) { return "normal"; }
  }

  function setTView(v){
    if (TVIEWS.indexOf(v) < 0) return;
    try { localStorage.setItem("loomTView:" + state.pid, v); } catch (e) {}
    if (state.redrawFeed) state.redrawFeed();
    toast("transcript: " + v);
  }


  /**
   * The options an agent's question offers, when it plainly offers some.
   *
   * "Want me to dig into the DBC integration, or get the tree committable?"
   * is two choices and should be two buttons. This only fires when the split
   * is unambiguous — a question mark, an "or" joining clauses of a sensible
   * length — because a wrong guess puts words in your mouth and sends them to
   * an agent. When unsure it returns nothing and you get the text box, which
   * is never wrong.
   */
  function questionChoices(q){
    var text = String(q || "").trim();
    // The last SENTENCE, not the last question — splitting only on "?" left
    // "I found three failing tests." glued to the front of the first option.
    var ask = text.split(/(?<=[.?!])\s+/).filter(Boolean).pop() || text;
    if (ask.indexOf("?") < 0) return [];
    // "Pick one — A or B?" / "Which is it: A or B?": the lead-in before a
    // dash or colon is the question, not part of the first answer.
    ask = ask.replace(/^[^?]{0,60}?(?:\s[\u2014\u2013-]\s|:\s)(?=[^?]*\bor\b)/i, "");
    var parts = ask.replace(/\?+\s*$/, "").split(/,\s+or\s+|\s+or\s+/i);
    if (parts.length < 2 || parts.length > 3) return [];
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i]
        .replace(/^(?:so\s+)?(?:do you want me to|would you like me to|want me to|should i|shall i|do you want|i can)\s+/i, "")
        .replace(/^[\s,;:\-\u2014]+|[\s,;:.]+$/g, "")
        .trim();
      // "npm" is a real answer; two characters is where it stops being one.
      if (c.length < 2 || c.length > 70) return [];
      // The agent's own casing. Capitalising turned "npm" into "Npm".
      out.push(c);
    }
    return out;
  }


  /** Raw payload, for verbose — the thing the summary was made from. */
  function rawBlock(payload){
    var text = "";
    try { text = JSON.stringify(payload, null, 2); } catch (e) { text = String(payload); }
    if (!text || text === "{}") return "";
    return '<details class="rawbox"><summary>raw</summary><div class="mdcodewrap">' +
      '<button class="mdcopy" type="button" title="copy">' + ICONS.copy + '</button>' +
      '<pre class="mdcode"><code>' + esc(text) + "</code></pre></div></details>";
  }
/**
 * A sent message's leading "[image] path" / "[file] path" lines (composer.js
 * writes them so the agent reads the file first) as thumbnails and chips;
 * the rest is the message. Images load through the API with your token
 * (an <img src> can't send one), once each, when they appear.
 */
function splitAttachments(text){
  var lines = text.split("\n"), html = "", n = 0;
  while (n < lines.length) {
    var m = lines[n].match(/^\[(image|file)\] (\.loom\/attachments\/[\w.-]+)$/);
    if (!m) break;
    var name = m[2].split("/").pop();
    html += m[1] === "image"
      ? '<button type="button" class="uatt" title="' + esc(m[2]) + '" aria-label="attached image ' + esc(name) + '"><img data-att="' + esc(m[2]) + '" alt=""></button>'
      : '<span class="uattf">' + ICONS.file + "<span>" + esc(name) + "</span></span>";
    n++;
  }
  if (!html) return { html: "", text: text };
  while (n < lines.length && !lines[n].trim()) n++;
  return { html: html, text: lines.slice(n).join("\n") };
}

var attCache = {};
function loadAttachment(img){
  img.setAttribute("data-loading", "1");
  var key = state.pid + "|" + img.getAttribute("data-att");
  var done = function(url){ if (url) img.src = url; else img.parentNode && img.parentNode.classList.add("gone"); };
  if (attCache[key]) { attCache[key].then(done); return; }
  attCache[key] = fetch("/api/projects/" + state.pid + "/attachment?path=" + encodeURIComponent(img.getAttribute("data-att")), {
    headers: { Authorization: "Bearer " + state.token },
  }).then(function(r){ return r.ok ? r.blob() : null; }).then(function(b){ return b ? URL.createObjectURL(b) : null; }).catch(function(){ return null; });
  attCache[key].then(done);
}
if (typeof document !== "undefined" && document.addEventListener && typeof MutationObserver !== "undefined") {
  var attScan = function(){
    Array.prototype.forEach.call(document.querySelectorAll("img[data-att]:not([data-loading])"), loadAttachment);
  };
  var attQueued = false;
  new MutationObserver(function(){
    if (attQueued) return;
    attQueued = true;
    requestAnimationFrame(function(){ attQueued = false; attScan(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  // a tap makes a thumbnail big, and back
  document.addEventListener("click", function(ev){
    var b = ev.target && ev.target.closest && ev.target.closest(".uatt");
    if (b) b.classList.toggle("big");
  });
}

export { splitAttachments,actSummary,avatarFor,durfmt,emptyArt,LAND_ST,landPill,lineFor,ORCH_RUN_ST,ORCH_TASK_ST,orchLine,plainPreview,planCardHtml,questionChoices,rawBlock,relClock,setTView,tview,TVIEWS,unesc,untilText,whoHtml };