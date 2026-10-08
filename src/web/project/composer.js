import { usageMeter } from '../usage.js';
import { agentGlyph,agentLabel,agentSub,labelOf } from '../agents.js';
import { api } from '../connection.js';
import { copyText } from '../clipboard.js';
import { clog } from '../console.js';
import { esc,pageGone,rel } from '../format.js';
import { ICONS,LOADER } from '../icons.js';
import { openMenu } from '../menus.js';
import { askConfirm,askText,fitMenu,toast } from '../notifications.js';
import { KMOD,loadPermProfiles,PERM_MODES,PERM_NAMES,PERM_SHORT,permOf,permProfile,permSplit,shortModel } from '../permissions.js';
import { state } from '../state.js';
import { showContinuityOverflow } from './continuity.js';
import { openTaskModal } from '../tasks.js';
import { openProjectSettings } from '../settings.js';
import { setTView,tview } from '../transcript.js';

/** composer behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createComposer(view) {
    /** The last send's requests, so the next one goes after them. Never rejects. */
    var lastSend = Promise.resolve();
    var pendingSubmission;


    function send(){
      if (state.cmode === "orch") return view.sendOrchestra();
      var box = document.getElementById("box");
      var text = (box.value || "").trim();
      // A message can be pure attachments — "look at this" with an image.
      if (!text && !view.attach.length) return;
      if (view.attach.some(function(a){ return a.uploading; })) { toast("still uploading\u2026"); return; }

      // Path references go first, so an agent reads the file before the ask.
      var refs = view.attach.map(function(a){
        return (a.kind === "image" ? "[image] " : "[file] ") + a.path;
      });
      var full = refs.length ? refs.join("\n") + (text ? "\n\n" + text : "") : text;

      // Loom isn't answering: keep the words and send them when it's back,
      // rather than clearing the box for a request that can't land.
      if (state.daemonUp === false) { view.holdForReconnect(full); return; }

      box.value = ""; autosizeBox(); view.attach = []; drawAttach(); view.clearDraft(); view.recall.i = -1;
      var p = state.project || {};
      var plan = view.planState;
      // what you just sent should be on screen, wherever you'd scrolled to
      view.wantScroll();
      var hero = document.getElementById("threadempty"); if (hero) hero.remove();

      // An orchestra's own thread talks to its orchestrator: a reply answers
      // its question, or steers the run mid-flight (and reopens a finished
      // one). Sending it to an agent instead would run that agent in the
      // project checkout, outside the run's worktrees.
      var orun = view.orchRunForChat();
      if (orun && orun.status !== "aborted") {
        api("/api/projects/" + view.pid + "/orchestra/" + encodeURIComponent(orun.id) + "/reply", {
          method: "POST", body: JSON.stringify({ text: full }),
        }).then(function(j){ if (j && j.run) view.mergeOrchRun(j.run); view.refresh(); })
          .catch(function(err){ toast(err.message); });
        return;
      }

      // A bridge is driven, not handed a turn: Loom types into Antigravity's or
      // Kiro's own window and waits for the panel to settle. No handoff, because
      // it never takes the baton — whichever adapter holds it keeps it.
      var sel = (p.agents || []).filter(function(a){ return a.id === state.selected; })[0];
      if (sel && sel.tier === "bridge") {
        // A bridge types into someone else's window; Loom can't brief it into
        // plan mode, so say so rather than let the switch quietly lie.
        toast(plan ? "plan mode doesn\u2019t reach bridges \u2014 typing into " + sel.id + " as-is" : "typing into " + sel.id + "\u2026");
        api("/api/projects/" + view.pid + "/bridge/" + encodeURIComponent(sel.id) + "/ask", {
          method: "POST", body: JSON.stringify({ text: full, chat: view.chatId }),
        }).then(function(){ view.refresh(); }).catch(function(err){
          // The bridge's own words ("log in from its window", "launch it
          // with…") are the actionable part; don't bury them.
          toast(err.message);
          view.refresh();
        });
        view.refresh();
        return;
      }

      // AUTO mode: don't pick an agent — let the dynamic router decide who takes
      // this turn (planner/builder/reviewer) based on the prompt + hop history.
      // (Plan mode skips the router: a route hops between agents doing the work,
      // and a plan is one agent's to write — the baton holder's.)
      if (state.auto && !plan) {
        var achip = document.getElementById("cagent");
        if (achip) achip.classList.add("routing");
        api("/api/projects/" + view.pid + "/route", { method: "POST", body: JSON.stringify({ task: full, spec: "auto" }) })
          .then(view.refresh).catch(function(err){ toast(err.message); })
          .then(function(){ if (achip) achip.classList.remove("routing"); });
        return;
      }

      // Something is already running, or prompts are already lined up: this
      // one joins the queue rather than being refused or jumping the line.
      if (view.wouldQueue()) {
        view.queueFromComposer(full, plan).catch(function(err){
          toast(err.message);
          box.value = full; autosizeBox(); view.saveDraft(); // a refused queue leaves what you wrote where you wrote it
        });
        return;
      }

      // One send on the wire at a time. Each is a handoff and then a message,
      // so a second prompt typed before the first reached the daemon could
      // overtake it and run first; now it waits for the one before it.
      var chain = lastSend.then(function(){
        if (!p.continuity && !state.auto && state.selected && state.selected !== p.holder) {
          return api("/api/projects/" + view.pid + "/handoff", { method: "POST", body: JSON.stringify({ to: state.selected }) });
        }
      });
      lastSend = chain.then(function(){
        // into the chat you're looking at — the agent's reply comes back here
        var body = { text: full, agentId: (state.auto ? undefined : state.selected) || undefined, chat: view.chatId, plan: plan || undefined, length: view.replyLength() || undefined };
        if(p.continuity) {
          var key = JSON.stringify(body);
          if(!pendingSubmission || pendingSubmission.key !== key) pendingSubmission = { key: key, id: crypto.randomUUID() };
          body.requestId = pendingSubmission.id;
        }
        return api("/api/projects/" + view.pid + "/messages", { method: "POST", body: JSON.stringify(body) });
      }).then(function(result){
        pendingSubmission = null;
        // Show who's on it straight away; the first thing the agent logs or
        // types takes the line over from here.
        var who = (!state.auto && state.selected) || (state.project && state.project.holder) || p.holder;
        if (who && view.historyLoaded && !(result && result.queued)) { view.liveFor(who); view.drawEmpty(); view.stickOrFlag(true); }
        view.refresh();
        if (result && result.continuityStatus === "overflow") showContinuityOverflow(view, result);
        else if (result && result.continuityStatus === "outcome_unknown") toast("Native delivery outcome is uncertain. Review Brain continuity diagnostics before retrying.");
      }).catch(function(err){
        if (err && err.offline) { var bx = document.getElementById("box"); if (bx && !bx.value) { bx.value = full; autosizeBox(); } view.holdForReconnect(full); return; }
        toast(err.message);
        if (p.continuity && !box.value) { box.value = full; autosizeBox(); }
      });
    }




    // ---- composer plumbing -------------------------------------------------

    function autosizeBox(){
      var box = document.getElementById("box"); if (!box) return;
      box.style.height = "auto";
      // floor at two lines (48px), grow to a cap, then let it scroll
      box.style.height = Math.max(48, Math.min(200, box.scrollHeight)) + "px";
      // send lights up only when there's something to send
      var cf = document.getElementById("cform"); if (cf) cf.classList.toggle("hastext", !!box.value.trim());
      // a long prompt says roughly how long (about four characters a token)
      var ct = document.getElementById("ctok");
      if (ct) {
        var n = Math.round(box.value.length / 4);
        ct.textContent = n >= 250 ? "~" + (n >= 1000 ? (n / 1000).toFixed(1) + "k" : n) + " tokens" : "";
        ct.title = n >= 250 ? "a rough count: about four characters a token" : "";
      }
    }


    function drawAttach(){
      var wrap = document.getElementById("cchips"); if (!wrap) return;
      if (!view.attach.length) { wrap.style.display = "none"; wrap.innerHTML = ""; return; }
      wrap.style.display = "flex";
      wrap.innerHTML = view.attach.map(function(a, i){
        var thumb = a.thumb ? '<img src="' + a.thumb + '" alt="">' : ICONS.file;
        return '<span class="cchip' + (a.uploading ? " up" : "") + '">' + thumb +
          '<span class="nm">' + esc(a.uploading ? a.name + "\u2026" : (a.path || a.name)) + "</span>" +
          '<button class="rm" type="button" data-rm="' + i + '" aria-label="remove attachment">' + ICONS.x + "</button></span>";
      }).join("");
      Array.prototype.forEach.call(wrap.querySelectorAll("[data-rm]"), function(b){
        b.onclick = function(){ view.attach.splice(Number(b.getAttribute("data-rm")), 1); drawAttach(); };
      });
    }


    function uploadFile(file){
      var isImg = /^image\//.test(file.type);
      var rec = { name: file.name || (isImg ? "pasted-image" : "file"), kind: isImg ? "image" : "file", uploading: true, thumb: null, path: null };
      view.attach.push(rec); drawAttach();
      var reader = new FileReader();
      reader.onload = function(){
        var dataUrl = reader.result;
        if (isImg) rec.thumb = dataUrl;
        api("/api/projects/" + view.pid + "/attachments", {
          method: "POST", body: JSON.stringify({ name: rec.name, dataUrl: dataUrl }),
        }).then(function(j){
          rec.uploading = false; rec.path = j.path; drawAttach();
        }).catch(function(err){
          var i = view.attach.indexOf(rec); if (i >= 0) view.attach.splice(i, 1);
          drawAttach(); toast("attach failed: " + err.message);
        });
      };
      reader.onerror = function(){
        var i = view.attach.indexOf(rec); if (i >= 0) view.attach.splice(i, 1);
        drawAttach(); toast("could not read that file");
      };
      reader.readAsDataURL(file);
    }


    /** "2 on" / "none yet" — what the Skills row says without opening it. */
  function skillHint(){
    if (!state.skillsTotal) return "none yet";
    return state.skillsOn ? state.skillsOn + " on" : "off";
  }


  function closeMenu(){
      view.menuState = null;
      document.removeEventListener("mousedown", menuAway);
      document.removeEventListener("keydown", pickerKeys, true);
      // the prompt manager dresses #cmenu up as a bigger glass panel; undress it
      var m = document.getElementById("cmenu"); if (m) { m.style.display = "none"; m.innerHTML = ""; m.className = "cmenu"; m.removeAttribute("role"); m.removeAttribute("aria-label"); }
      var pb = document.getElementById("promptbtn"); if (pb) pb.classList.remove("on");
    }

    /**
     * Arrow keys, Enter and Escape for a picker opened from a button (the
     * agent menu): focus stays where it was, so the keys are caught here and
     * walk the rows that have a mousedown action.
     */
    function pickerKeys(e){
      var m = document.getElementById("cmenu");
      if (!m || m.style.display === "none" || !view.menuState || view.menuState.kind !== "agentmenu") return;
      var rows = Array.prototype.slice.call(m.querySelectorAll("[data-auto],[data-ai]"));
      if (!rows.length) return;
      var at = rows.findIndex(function(r){ return r.classList.contains("sel"); });
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        at = at < 0 ? rows.findIndex(function(r){ return r.classList.contains("cur"); }) : at;
        var next = (at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
        rows.forEach(function(r, i){ r.classList.toggle("sel", i === next); r.setAttribute("aria-selected", i === next ? "true" : "false"); });
        rows[next].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && at >= 0) {
        e.preventDefault(); e.stopPropagation();
        rows[at].onmousedown({ preventDefault: function(){} });
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        closeMenu();
        var box = document.getElementById("box"); if (box) box.focus();
      }
    }

    // The model/agent pickers open from a button, not the textarea, so a blur
    // won't close them — a click anywhere outside the card does.
    function menuAway(e){
      // A click that re-rendered its own row (pinning a prompt) leaves a
      // detached target, which no card "contains" — that isn't a click away.
      if (e.target && e.target.isConnected === false) return;
      var cb = document.querySelector(".cbox");
      if (cb && !cb.contains(e.target)) closeMenu();
    }


    function renderMenu(items, head){
      var m = document.getElementById("cmenu"); if (!m) return;
      if (!items.length) { closeMenu(); return; }
      view.menuState.items = items; if (view.menuState.sel == null) view.menuState.sel = 0;
      if (view.menuState.sel >= items.length) view.menuState.sel = items.length - 1;
      m.style.display = "block"; fitMenu(m); m.className = "cmenu";
      m.innerHTML = (head ? '<div class="cmhead">' + esc(head) + "</div>" : "") +
        items.map(function(it, i){
          return '<div class="cmi' + (i === view.menuState.sel ? " sel" : "") + '" data-i="' + i + '">' +
            '<span class="ic">' + (it.icon || ICONS.file) + "</span>" +
            "<span>" + esc(it.label) + "</span>" +
            (it.sub ? '<span class="sub">' + esc(it.sub) + "</span>" : "") + "</div>";
        }).join("");
      Array.prototype.forEach.call(m.querySelectorAll(".cmi"), function(row){
        row.onmousedown = function(ev){ ev.preventDefault(); acceptMenu(Number(row.getAttribute("data-i"))); };
      });
    }


    function acceptMenu(i){
      if (!view.menuState || !view.menuState.items) return;
      var it = view.menuState.items[i]; if (!it) return;
      var act = view.menuState.kind;
      if (act === "file") {
        var box = document.getElementById("box");
        var v = box.value, from = view.menuState.at, to = box.selectionStart;
        box.value = v.slice(0, from) + it.value + " " + v.slice(to);
        var caret = from + it.value.length + 1;
        box.setSelectionRange(caret, caret); box.focus(); autosizeBox();
        closeMenu();
      } else if (act === "cmd") {
        // A command consumes the whole "/word" it matched.
        var box2 = document.getElementById("box");
        box2.value = box2.value.slice(0, view.menuState.at) + box2.value.slice(box2.selectionStart);
        box2.setSelectionRange(view.menuState.at, view.menuState.at); autosizeBox();
        closeMenu();
        it.run();
      }
    }


    // Static, and every one runs something real — no decorative commands.
    function slashCommands(){
      return [
        { label: "New task", sub: "hand work to one or more agents", icon: ICONS.tasks, run: function(){ openTaskModal(view.pid); } },
        { label: "Record a decision", sub: "save it to the brain", icon: ICONS.memory, run: function(){
            var box = document.getElementById("box");
            var t = (box.value || "").trim();
            if (!t) { toast("type the decision first, then /"); return; }
            box.value = ""; autosizeBox();
            api("/api/projects/" + view.pid + "/decisions", { method: "POST", body: JSON.stringify({ text: t }) })
              .then(function(){ toast("decision saved to the brain"); if (typeof view.refreshBrain === "function") view.refreshBrain(); })
              .catch(function(err){ toast(err.message); });
          } },
        { label: "Pick a model", sub: "for " + (state.selected || "this agent"), icon: ICONS.gear, run: openModelMenu },
        { label: "Attach a file", sub: "any file, up to 12 MB", icon: ICONS.file, run: function(){ var f = document.getElementById("cfile"); if (f) f.click(); } },
        { label: "Browse skills", sub: "install one, or turn one on", icon: ICONS.spark, run: function(){ openSkillsModal(view.pid); } },
        { label: "MCP servers", sub: "browse the registry and install", icon: ICONS.plug, run: function(){ openMcpModal(view.pid); } },
        { label: "Saved prompts", sub: "insert one (\u2318\u21e7V)", icon: ICONS.clipboard, run: function(){ setTimeout(function(){ if (state.openPrompts) state.openPrompts(); }, 0); } },
        { label: "Plan mode", sub: "write a plan, change no code", icon: ICONS.plan, run: function(){ var b = document.getElementById("planbtn"); if (b) b.click(); } },
        { label: "New chat", sub: "a fresh thread in this project", icon: ICONS.chat, run: function(){ var row = document.querySelector('[data-newchat="' + view.pid + '"]'); if (row) row.click(); else toast("open the project in the sidebar to start a chat"); } },
        { label: "Find in this chat", sub: "\u2318F", icon: ICONS.search, run: function(){ if (state.openFind) state.openFind(); } },
        { label: "Export this chat", sub: "as Markdown", icon: ICONS.download, run: function(){ if (state.exportThread) state.exportThread(); } },
      ].concat(skillSlashItems());
    }

    /**
     * Every skill, right in the "/" menu.
     *
     * Enabling a skill is the thing you want mid-sentence — you start typing,
     * realise this turn needs the triage skill, and you should not have to leave
     * the composer to say so. The list is the same catalog the modal browses; it
     * is cached on the composer so typing "/" doesn't refetch on every keystroke.
     */
    function skillSlashItems(){
      var list = state.skillCache || [];
      return list.map(function(s){
        return {
          label: (s.enabled ? "\u2713 " : "") + (s.name || s.id),
          sub: s.enabled ? "skill \u00b7 on \u2014 select to turn off" : "skill \u00b7 " + ((s.description || "").slice(0, 54) || "turn on for this project"),
          icon: ICONS.spark,
          run: function(){
            api("/api/projects/" + view.pid + "/skills/" + encodeURIComponent(s.id), { method: "PUT", body: JSON.stringify({ enabled: !s.enabled }) })
              .then(function(){
                s.enabled = !s.enabled;
                toast((s.enabled ? "enabled " : "disabled ") + (s.name || s.id));
                refreshSkillCount();
              })
              .catch(function(err){ toast(err.message); });
          }
        };
      });
    }

    /** Keep the "/" menu's skill list fresh without refetching per keystroke. */
    function loadSkillCache(){
      api("/api/projects/" + view.pid + "/skills/catalog")
        .catch(function(){ return api("/api/projects/" + view.pid + "/skills"); })
        .then(function(r){ state.skillCache = r.skills || []; })
        .catch(function(){ state.skillCache = []; });
    }


    function openFileMenu(q, at){
      view.menuState = { kind: "file", at: at, sel: 0, items: [] };
      api("/api/projects/" + view.pid + "/find?q=" + encodeURIComponent(q))
        .then(function(j){
          if (!view.menuState || view.menuState.kind !== "file") return;
          var items = (j.matches || []).slice(0, 40).map(function(pth){
            var base = pth.split("/").pop();
            return { label: base, sub: pth, value: "@" + pth, icon: ICONS.file };
          });
          renderMenu(items, j.recent ? "recent files" : "files");
        })
        .catch(function(){ closeMenu(); });
    }

    /**
     * What a model is for, in a few words — the pickers used to be a column of
     * bare slugs, and "which one do I want" was left to memory. Only claims we
     * can stand behind: the families' published positioning, nothing measured.
     */
    function modelBlurb(m){
      var s = String(m || "").toLowerCase();
      if (/(^|\/)pool:free$/.test(s)) return "every free model, in turn \u00b7 spreads the load";
      if (/opus/.test(s)) return "most capable \u00b7 deepest reasoning";
      if (/sonnet/.test(s)) return "balanced \u00b7 fast and capable";
      if (/haiku/.test(s)) return "fastest \u00b7 lightest";
      if (/fable/.test(s)) return "frontier \u00b7 long, hard tasks";
      if (/mini|flash|lite|nano|small/.test(s)) return "fast \u00b7 inexpensive";
      if (/:free$/.test(s)) return "free tier";
      if (/codex/.test(s)) return "tuned for coding";
      if (/pro|max|large|ultra/.test(s)) return "high capability";
      return "";
    }
    /** "anthropic/claude-sonnet-4" → name "claude-sonnet-4", from "anthropic". */
    function modelParts(m){
      var v = String(m || ""), cut = v.lastIndexOf("/");
      return cut > 0 ? { name: v.slice(cut + 1), from: v.slice(0, cut) } : { name: v, from: "" };
    }

    function openModelMenu(who){
      // Orchestrate has no "selected" agent — it has a cast — so the caller
      // names the one it means. Chat still means whoever the composer is aimed at.
      var agentId = who || state.selected;
      var p = state.project || {};
      var cur = (p.agents || []).filter(function(a){ return a.id === agentId; })[0];
      if (!cur || cur.tier === "bridge") { toast("pick an adapter first \u2014 bridges choose their own model"); return; }
      var m = document.getElementById("cmenu"); if (!m) return;
      view.menuState = { kind: "modelmenu", agent: agentId, at: 0, sel: 0, items: [] };
      m.style.display = "block"; fitMenu(m); m.className = "cmenu picker";
      m.innerHTML = '<div class="cmhead">' + agentGlyph(cur.kind, cur.id) + "<span>Model for " + esc(agentLabel(cur.kind, cur.id)) + "</span></div>" +
        '<div class="cmsearchwrap">' + ICONS.search + '<input class="cmsearch" id="cmsearch" placeholder="Search models\u2026" spellcheck="false" autocomplete="off"></div>' +
        '<div class="cmlist" id="cmlist">' + LOADER + '</div>';
      setTimeout(function(){ document.addEventListener("mousedown", menuAway); }, 0);
      var active = cur.model || "";
      var allModels = [], rowsNow = [], hi = 0;
      function choose(val){
        if (val === "__custom__"){
          closeMenu();
          askText("Model for " + cur.id, { value: active, placeholder: "blank = the agent’s default", ok: "Use this model" }).then(function(typed){
            if (typed === null) return;
            choose(typed.trim() || "");
          });
          return;
        }
        else closeMenu();
        if (val === active || (cur.kind === "model" && active && val.slice(val.indexOf("/") + 1) === active)) return;
        // A model agent's list spans every provider, each id led by the one
        // it's from; send that apart, so the provider gets a name it knows.
        if (cur.kind === "model" && allModels.indexOf(val) >= 0 && val.indexOf("/") > 0) {
          setModel(agentId, val.slice(val.indexOf("/") + 1), val.slice(0, val.indexOf("/")));
          return;
        }
        setModel(agentId, val);
      }
      function mark(){
        var list = document.getElementById("cmlist"); if (!list) return;
        Array.prototype.forEach.call(list.querySelectorAll("[data-mv]"), function(r, i){ r.classList.toggle("sel", i === hi); });
        var on = list.querySelectorAll("[data-mv]")[hi];
        if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
      }
      // The real models the tool itself reports (opencode ~500 across providers,
      // grok its own); codex/claude are their shipped sets.
      function render(filter){
        var f = (filter || "").trim().toLowerCase();
        var shown = f ? allModels.filter(function(mm){ return mm.toLowerCase().indexOf(f) >= 0; }) : allModels;
        var cap = 200; // don't paint 500 rows — the search narrows it
        // While you search, Default only shows if you're searching for it — it used
        // to sit first and soak up the Enter meant for the model you typed.
        var head = cur.kind === "model" || (f && "default".indexOf(f) < 0) ? []
          : [{ label: "Default", sub: "whatever " + agentLabel(cur.kind, cur.id) + " picks", value: "" }];
        // Free models first: on a provider's free tier they cost nothing, and
        // "which of these 300 is free" shouldn't take a search to answer.
        var free = shown.filter(function(mm){ return /:free$/.test(mm); });
        var paid = shown.filter(function(mm){ return !/:free$/.test(mm); });
        var ordered = free.concat(paid).slice(0, cap);
        rowsNow = head.concat(ordered.map(function(mm){ return { label: mm, value: mm, group: /:free$/.test(mm) ? "Free" : (free.length ? "Paid" : "") }; }));
        if (!f) rowsNow.push({ label: "Custom model\u2026", value: "__custom__", plus: true });
        // A model agent stores "vendor/model" apart from its provider, while
        // the list leads with the provider: match either way.
        var isCur = function(v){ return !!v && (v === active || (cur.kind === "model" && !!active && v.slice(v.indexOf("/") + 1) === active)); };
        hi = Math.max(0, rowsNow.map(function(r){ return isCur(r.value) || (r.value === "" && active === ""); }).indexOf(true));
        if (f) hi = 0;
        var list = document.getElementById("cmlist"); if (!list) return;
        var lastGroup = "";
        list.innerHTML = rowsNow.map(function(it){
          var tick = !it.plus && (isCur(it.value) || (it.value === "" && active === ""));
          var gh = it.group && it.group !== lastGroup ? '<div class="cmgroup">' + esc(it.group) + "</div>" : "";
          if (it.group) lastGroup = it.group;
          var parts = it.plus || it.value === "" ? { name: it.label, from: "" } : modelParts(it.label);
          var blurb = it.sub || (it.plus ? "type any id the tool accepts" : modelBlurb(it.value));
          return gh + '<div class="cmi mrow' + (tick ? " cur" : "") + '" data-mv="' + esc(String(it.value)) + '">' +
            '<span class="ic">' + (it.plus ? ICONS.plus : it.value === "" ? ICONS.sparkles : '<span class="mdot"></span>') + "</span>" +
            '<span class="mtx"><span class="mnm">' + esc(parts.name) + (parts.from ? '<span class="mfrom">' + esc(parts.from) + "</span>" : "") + "</span>" +
            (blurb ? '<span class="mbl">' + esc(blurb) + "</span>" : "") + "</span>" +
            (tick ? '<span class="tick">' + ICONS.check + "</span>" : "") + "</div>";
        }).join("") +
          (shown.length > cap ? '<div class="cmmore">' + (shown.length - cap) + ' more \u2014 keep typing to narrow</div>' : "") +
          (f && !shown.length ? '<div class="cmmore">No match \u00b7 Enter uses \u201c' + esc(filter) + '\u201d as typed</div>' : "");
        Array.prototype.forEach.call(list.querySelectorAll("[data-mv]"), function(row, i){
          row.onmousedown = function(ev){ ev.preventDefault(); choose(row.getAttribute("data-mv")); };
          row.onmousemove = function(){ if (hi !== i) { hi = i; mark(); } };
        });
        mark();
      }
      api("/api/projects/" + view.pid + "/agents/" + encodeURIComponent(agentId) + "/models").then(function(j){
        allModels = (j && j.models) || [];
        // Say where the list came from. "asked the tool" and "the aliases we
        // ship" are different claims, and only one of them goes stale silently.
        var mn = document.getElementById("cmenu");
        if (mn && j && j.source){
          var note = j.source === "cli" ? "Listed by " + esc(agentLabel(cur.kind, cur.id)) + " itself"
            : j.source === "api" ? "From every provider with a key \u00b7 " + (j.count || 0) + " models"
            : j.source === "builtin" ? esc(agentLabel(cur.kind, cur.id)) + " can\u2019t list its models \u2014 these are its documented aliases"
            : "No model list for this agent";
          var ft = document.createElement("div");
          ft.className = "cmfoot"; ft.textContent = note;
          mn.appendChild(ft);
        }
        var sb = document.getElementById("cmsearch");
        if (sb){
          sb.oninput = function(){ render(sb.value); };
          sb.onkeydown = function(e){
            if (e.key === "ArrowDown") { e.preventDefault(); hi = Math.min(rowsNow.length - 1, hi + 1); mark(); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(0, hi - 1); mark(); return; }
            if (e.key === "Enter"){
              e.preventDefault();
              var v = sb.value.trim();
              var match = rowsNow[hi];
              // nothing listed matches: the id as typed, as the footer promises
              if (v && !rowsNow.length) choose(v);
              else if (match) choose(match.value);
              return;
            }
            if (e.key === "Escape"){ e.preventDefault(); closeMenu(); var box = document.getElementById("box"); if (box) box.focus(); }
          };
          sb.focus();
        }
        render("");
      }).catch(function(err){
        var list = document.getElementById("cmlist"); if (list) list.innerHTML = '<div class="cmmore">Couldn\u2019t list models \u2014 ' + esc(err && err.message || "") + "</div>";
        clog("error", "models", "list failed: " + (err && err.message), err && err.stack);
      });
    }


    /**
     * Ask several models the same thing, and read the answers side by side —
     * a thread each (POST /ask). It lived only in the CLI; this is the same
     * call from the composer: tick the models, and what's in the box goes to
     * all of them. Free models first, and the ticks are remembered.
     */
    function openAskSeveral(){
      var m = document.getElementById("cmenu"); if (!m) return;
      view.menuState = { kind: "askmenu", at: 0, sel: 0, items: [] };
      var picked = state.askPicked || (state.askPicked = {});
      m.style.display = "block"; m.className = "cmenu picker askpick"; fitMenu(m);
      m.innerHTML = '<div class="cmhead">' + ICONS.sparkles + "<span>Ask several models</span></div>" +
        '<div class="cmsearchwrap">' + ICONS.search + '<input class="cmsearch" id="asksearch" placeholder="Search models…" spellcheck="false" autocomplete="off"></div>' +
        '<div class="cmlist" id="asklist">' + LOADER + "</div>" +
        '<div class="askfoot"><span id="askn" class="askn"></span><button class="btn xs primary" id="askgo" type="button" disabled>Ask</button></div>';
      setTimeout(function(){ document.addEventListener("mousedown", menuAway); }, 0);
      var all = [];
      function count(){ return Object.keys(picked).filter(function(k){ return picked[k]; }).length; }
      function foot(){
        var n = count(), go = document.getElementById("askgo"), nn = document.getElementById("askn");
        if (nn) nn.textContent = n ? n + " model" + (n === 1 ? "" : "s") + " · one thread each" : "Tick the models to ask";
        if (go) { go.disabled = !n; go.textContent = n ? "Ask " + n : "Ask"; }
      }
      function render(f){
        f = String(f || "").trim().toLowerCase();
        var shown = all.filter(function(x){ return !f || x.key.toLowerCase().indexOf(f) >= 0; });
        shown.sort(function(a, b){ return (b.free - a.free) || (picked[b.key] ? 1 : 0) - (picked[a.key] ? 1 : 0); });
        var list = document.getElementById("asklist"); if (!list) return;
        var cap = 150, lastG = "";
        list.innerHTML = shown.slice(0, cap).map(function(x){
          var g = x.free ? "Free" : "Paid", gh = g !== lastG ? '<div class="cmgroup">' + g + "</div>" : "";
          lastG = g;
          return gh + '<div class="cmi mrow askrow' + (picked[x.key] ? " cur" : "") + '" data-ak="' + esc(x.key) + '">' +
            '<span class="cwon">' + (picked[x.key] ? ICONS.check : "") + "</span>" +
            '<span class="mtx"><span class="mnm">' + esc(x.id.split("/").pop()) + '<span class="mfrom">' + esc(x.provider + (x.id.indexOf("/") > 0 ? " · " + x.id.split("/")[0] : "")) + "</span></span>" +
            (modelBlurb(x.id) ? '<span class="mbl">' + esc(modelBlurb(x.id)) + "</span>" : "") + "</span></div>";
        }).join("") + (shown.length > cap ? '<div class="cmmore">' + (shown.length - cap) + " more — keep typing to narrow</div>" : "") +
          (!shown.length ? '<div class="cmmore">' + (all.length ? "No match" : "No provider has a key yet — add one in Settings") + "</div>" : "");
        Array.prototype.forEach.call(list.querySelectorAll("[data-ak]"), function(r){
          r.onmousedown = function(ev){
            ev.preventDefault();
            var k = r.getAttribute("data-ak");
            picked[k] = !picked[k];
            r.classList.toggle("cur", !!picked[k]);
            r.querySelector(".cwon").innerHTML = picked[k] ? ICONS.check : "";
            foot();
          };
        });
        foot();
      }
      var go = document.getElementById("askgo");
      if (go) go.onmousedown = function(ev){
        ev.preventDefault();
        var box = document.getElementById("box");
        var text = box ? box.value.trim() : "";
        var keys = Object.keys(picked).filter(function(k){ return picked[k]; });
        if (!text) { toast("type the question first, then pick the models"); if (box) box.focus(); return; }
        if (!keys.length) return;
        go.disabled = true; go.textContent = "Asking…";
        api("/api/projects/" + view.pid + "/ask", { method: "POST", body: JSON.stringify({ text: text, models: keys }) })
          .then(function(j){
            closeMenu();
            if (box) { box.value = ""; autosizeBox(); }
            var asked = (j && j.asked) || [];
            toast("asked " + asked.length + " model" + (asked.length === 1 ? "" : "s") + " — a thread each");
            if (state.refreshShell) state.refreshShell();
            if (asked[0] && asked[0].chat && state.setChat) state.setChat(view.pid, asked[0].chat);
          })
          .catch(function(err){ toast(err.message); go.disabled = false; foot(); });
      };
      api("/api/models").then(function(j){
        all = ((j && j.models) || []).map(function(x){ return { key: x.provider + "/" + x.id, id: x.id, provider: x.provider, free: x.free ? 1 : 0 }; });
        var sb = document.getElementById("asksearch");
        if (sb) { sb.oninput = function(){ render(sb.value); }; sb.focus(); }
        render("");
      }).catch(function(err){
        var list = document.getElementById("asklist"); if (list) list.innerHTML = '<div class="cmmore">Couldn’t list models — ' + esc(err.message || "") + "</div>";
      });
    }

    /**
     * Who this chat talks to: every agent in the project with its mark, the
     * model it's on and what it may do, the current one ticked. Selecting one
     * aims the composer (state.selected); send then hands it the baton.
     */
    function openAgentMenu(){
      var p = state.project || {};
      var agents = p.agents || [];
      if (!agents.length) { toast("no agents in this project yet"); return; }
      view.menuState = { kind: "agentmenu", at: 0, sel: 0, items: [] };
      var m = document.getElementById("cmenu"); if (!m) return;
      m.style.display = "block"; fitMenu(m); m.className = "cmenu picker";
      function row(a, i){
        var tick = !state.auto && a.id === state.selected;
        var lbl = agentLabel(a.kind, a.id);
        var bits = [];
        // the roster id, only when it tells two agents apart ("antigravity"
        // for kind "antigravity-cli" doesn't)
        if (a.id !== lbl && a.id !== a.kind && String(a.kind || "").indexOf(a.id) !== 0) bits.push(a.id);
        if (a.tier === "bridge") bits.push("drives its own window");
        else {
          bits.push(a.model ? shortModel(a.model) : (a.kind === "model" ? "no model yet" : "default model"));
          var pm = permOf(a); if (pm) bits.push(PERM_NAMES[pm] || pm);
        }
        return '<div class="cmi arow2' + (tick ? " cur" : "") + '" data-ai="' + i + '"><span class="ic">' + agentGlyph(a.kind, a.id, "brand lg") + "</span>" +
          '<span class="mtx"><span class="mnm">' + esc(lbl) + (a.id === p.holder ? '<span class="mfrom">baton</span>' : "") + '</span><span class="mbl">' + esc(bits.join(" \u00b7 ")) + "</span></span>" +
          (a.busy ? '<span class="cmbusy">working</span>' : "") +
          (tick ? '<span class="tick">' + ICONS.check + "</span>" : "") + "</div>";
      }
      var live = agents.map(function(a, i){ return { a: a, i: i }; }).filter(function(x){ return x.a.enabled !== false; });
      var adapters = live.filter(function(x){ return x.a.tier !== "bridge"; });
      var bridges = live.filter(function(x){ return x.a.tier === "bridge"; });
      // AUTO leads the list — it's the "let the system choose" option, not an agent.
      m.innerHTML = '<div class="cmhead"><span>Who takes this turn</span></div>' +
        '<div class="cmi arow2 cmauto' + (state.auto ? " on cur" : "") + '" data-auto="1"><span class="ic"><span class="autodot"></span></span>' +
          '<span class="mtx"><span class="mnm">Auto</span><span class="mbl">Loom routes each turn to the right agent</span></span>' +
          (state.auto ? '<span class="tick">' + ICONS.check + "</span>" : "") + "</div>" +
        '<div class="cmsep"></div>' +
        adapters.map(function(x){ return row(x.a, x.i); }).join("") +
        (bridges.length ? '<div class="cmgroup">Windows Loom drives</div>' + bridges.map(function(x){ return row(x.a, x.i); }).join("") : "") +
        // Cursor is on its way; listing it (inert) says so where you'd look for it.
        '<div class="cmsep"></div><div class="cmi soon" aria-disabled="true"><span class="ic">' + agentGlyph("", "cursor") +
          '</span><span>Cursor</span><span class="sub">coming soon</span></div>';
      var auto = m.querySelector("[data-auto]");
      if (auto) auto.onmousedown = function(ev){ ev.preventDefault(); closeMenu(); setAuto(true); var box = document.getElementById("box"); if (box) box.focus(); };
      Array.prototype.forEach.call(m.querySelectorAll("[data-ai]"), function(r){
        r.onmousedown = function(ev){
          ev.preventDefault();
          var a = agents[Number(r.getAttribute("data-ai"))];
          closeMenu();
          if (!a) return;
          if (a.id === state.selected && !state.auto) return;
          state.auto = false; // picking an agent turns routing off
          state.selected = a.id;
          view.drawStatus(); // repaints the selector, the model label, and the hint
          var box = document.getElementById("box"); if (box) box.focus();
        };
      });
      m.setAttribute("role", "listbox"); m.setAttribute("aria-label", "Who takes this turn");
      Array.prototype.forEach.call(m.querySelectorAll("[data-auto],[data-ai]"), function(r){ r.setAttribute("role", "option"); });
      setTimeout(function(){ document.addEventListener("mousedown", menuAway); document.addEventListener("keydown", pickerKeys, true); }, 0);
    }


    function setModel(agentId, model, provider){
      api("/api/projects/" + view.pid + "/agents/" + encodeURIComponent(agentId) + "/model", {
        method: "POST", body: JSON.stringify(provider ? { model: model, provider: provider } : { model: model }),
      }).then(function(){
        toast(model ? (agentId + " \u2192 " + shortModel(model)) : (agentId + " \u2192 default model"));
        // The Orchestrate cast wears each agent's model on its chip; the
        // status poll doesn't redraw it, so a pick looked like it hadn't taken.
        return view.refresh().then(function(){ view.drawOrchControls(); updateModelLabel(); });
      }).catch(function(err){ toast(err.message); });
    }


    // What's under the caret: an @file token, or a /command at a word start.
    function scanTrigger(){
      var box = document.getElementById("box");
      if (!box || box.selectionStart !== box.selectionEnd) return closeMenu();
      var upto = box.value.slice(0, box.selectionStart);
      var at = upto.match(/(^|\s)@([\w./-]*)$/);
      if (at) { openFileMenu(at[2], box.selectionStart - at[2].length - 1); return; }
      var sl = upto.match(/(^|\s)\/(\w*)$/);
      if (sl) {
        var start = box.selectionStart - sl[2].length - 1;
        view.menuState = { kind: "cmd", at: start, sel: 0, items: [] };
        var q = sl[2].toLowerCase();
        renderMenu(slashCommands().filter(function(c){ return c.label.toLowerCase().indexOf(q) >= 0; }), "actions");
        return;
      }
      if (view.menuState && (view.menuState.kind === "file" || view.menuState.kind === "cmd")) closeMenu();
    }


    function bindComposer(){
      var box = document.getElementById("box");
      var form = document.getElementById("cform");
      if (!box || !form || box.getAttribute("data-bound")) return;
      box.setAttribute("data-bound", "1");
      autosizeBox();

      box.addEventListener("input", function(){ autosizeBox(); scanTrigger(); scheduleSkillSuggest(box.value); form.classList.toggle("hastext", !!box.value.trim()); view.saveDraft(); view.recall.i = -1; });
      view.restoreDraft();
      loadSkillCache();
      box.addEventListener("keydown", function(e){
        // Menu open: arrows move, Enter/Tab accept, Esc closes.
        if (view.menuState && view.menuState.items && view.menuState.items.length && (view.menuState.kind === "file" || view.menuState.kind === "cmd")) {
          if (e.key === "ArrowDown") { e.preventDefault(); view.menuState.sel = (view.menuState.sel + 1) % view.menuState.items.length; renderMenu(view.menuState.items, view.menuState.kind === "cmd" ? "actions" : "files"); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); view.menuState.sel = (view.menuState.sel - 1 + view.menuState.items.length) % view.menuState.items.length; renderMenu(view.menuState.items, view.menuState.kind === "cmd" ? "actions" : "files"); return; }
          if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptMenu(view.menuState.sel); return; }
          if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
        }
        // ↑/↓ in an empty composer walk back through what you sent here.
        if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
          var untouched = box.value === "" || (view.recall.i >= 0 && box.value === view.recall.shown);
          var mine = untouched ? view.myPrompts() : [];
          if (mine.length && (e.key === "ArrowUp" ? view.recall.i < mine.length - 1 : view.recall.i >= 0)) {
            e.preventDefault();
            view.recall.i += e.key === "ArrowUp" ? 1 : -1;
            view.recall.shown = view.recall.i >= 0 ? mine[view.recall.i] : "";
            box.value = view.recall.shown; autosizeBox();
            box.setSelectionRange(box.value.length, box.value.length);
            form.classList.toggle("hastext", !!box.value.trim());
            return;
          }
        }
        // Enter sends; Shift+Enter is a newline.
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      });
      box.addEventListener("paste", function(e){
        var items = (e.clipboardData && e.clipboardData.items) || [];
        var imgs = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === "file" && /^image\//.test(items[i].type)) {
            var f = items[i].getAsFile(); if (f) imgs.push(f);
          }
        }
        if (imgs.length) { e.preventDefault(); imgs.forEach(uploadFile); }
      });
      // Blur closes only the menus the textarea drives (@ and /). The pickers
      // opened from buttons move focus into their own search box on purpose,
      // and closing them on that blur shut the prompt manager as it opened.
      box.addEventListener("blur", function(){ setTimeout(function(){ if (view.menuState && (view.menuState.kind === "file" || view.menuState.kind === "cmd")) closeMenu(); }, 120); });

      form.addEventListener("submit", function(ev){ ev.preventDefault(); send(); });
      // Escape closes whichever picker is open, wherever focus is — the
      // permission and agent menus have no input of their own to catch it.
      // One document listener for the page's life; each project view points
      // it at its own menu (a listener per view would pile up).
      state.escMenu = function(){ if (!view.menuState) return false; closeMenu(); return true; };
      if (!state.escBound) {
        state.escBound = true;
        document.addEventListener("keydown", function(ev){
          if (ev.key !== "Escape" || !state.escMenu) return;
          var mm = document.getElementById("cmenu");
          if (!mm || mm.style.display === "none") return;
          if (state.escMenu()) { ev.preventDefault(); var bx = document.getElementById("box"); if (bx) bx.focus(); }
        });
      }

      var attachBtn = document.getElementById("attach");
      var fileInput = document.getElementById("cfile");
      if (attachBtn && fileInput) {
        attachBtn.onclick = function(){ fileInput.click(); };
        fileInput.onchange = function(){
          Array.prototype.forEach.call(fileInput.files || [], uploadFile);
          fileInput.value = "";
        };
      }
      var mp = document.getElementById("modelpick");
      if (mp) mp.onclick = function(){
        if (view.menuState && view.menuState.kind === "modelmenu") { closeMenu(); return; }
        openModelMenu();
      };
      // One selector, both jobs: AUTO (the router) sits at the top of the menu,
      // the agents below it.
      var ap = document.getElementById("cagent");
      if (ap) ap.onclick = function(){
        if (view.menuState && view.menuState.kind === "agentmenu") { closeMenu(); return; }
        openAgentMenu();
      };
      // Right-click the chip: the agent's other knobs, without hunting for them.
      if (ap) ap.oncontextmenu = function(ev){
        ev.preventDefault();
        var a = ((state.project || {}).agents || []).filter(function(x){ return x.id === state.selected; })[0];
        var items = [
          { label: "Choose agent", icon: ICONS.agents, hint: "\u2318\u21e7A", run: openAgentMenu },
          { label: state.auto ? "Turn Auto off" : "Auto-route turns", icon: ICONS.spark, run: function(){ setAuto(!state.auto); } },
        ];
        if (a && !state.auto) {
          items.push({ sep: true }, { head: agentLabel(a.kind, a.id) });
          if (a.tier !== "bridge") items.push({ label: "Change model\u2026", icon: ICONS.gear, run: function(){ openModelMenu(); } });
          if (document.getElementById("cperm")) items.push({ label: "Permissions\u2026", icon: ICONS.shield, run: function(){ openPermMenu(a.id); } });
          if (a.busy) items.push({ label: "Interrupt", icon: ICONS.x, run: function(){
            api("/api/projects/" + view.pid + "/interrupt", { method: "POST", body: JSON.stringify({ chat: view.chatId || undefined }) }).catch(function(err){ toast(err.message); });
          } });
          items.push({ label: "Copy agent id", icon: ICONS.copy, run: function(){ copyText(a.id); } });
        }
        items.push({ sep: true }, { label: "Project settings\u2026", icon: ICONS.gear, run: function(){ openProjectSettings(view.pid); } });
        var r = ap.getBoundingClientRect();
        openMenu(Math.round(ev.clientX || r.left), Math.round(ev.clientY || r.bottom), items);
      };
      Array.prototype.forEach.call(document.querySelectorAll("#cmode [data-cmode]"), function(b){
        b.onclick = function(){ view.setComposerMode(b.getAttribute("data-cmode")); var bx = document.getElementById("box"); if (bx) bx.focus(); };
      });
      var osend = document.getElementById("orchsend");
      if (osend) osend.onclick = view.sendOrchestra;
      var pc = document.getElementById("cperm");
      if (pc) pc.onclick = function(){
        if (view.menuState && view.menuState.kind === "permmenu") { closeMenu(); return; }
        openPermMenu(state.selected);
      };
      var pb = document.getElementById("promptbtn");
      if (pb) pb.onclick = openPrompts;
      state.openPrompts = openPrompts; // ⌘⇧V, from the global key handler
      var plb = document.getElementById("planbtn");
      if (plb) plb.onclick = function(){ setPlan(!view.planState); var bx = document.getElementById("box"); if (bx) bx.focus(); };
      drawPlan();
      view.drawLengthPill();
      // the page may be gone by the time profiles arrive (a closed tab, a torn-down test window)
      loadPermProfiles().then(function(){ if (typeof document === "undefined" || !document) return; updateModelLabel(); view.drawOrchControls(); });
      var moreB = document.getElementById("morebtn");
      if (moreB) moreB.onclick = function(ev){
        ev.stopPropagation();
        if (document.getElementById("loommenu")) { closeMenu(); return; } // click again to close
        var r = moreB.getBoundingClientRect();
        var items = [
          { label: "MCP servers", icon: ICONS.plug, hint: "connect", run: function(){ toggleComposerPanel("mcp"); } },
          { label: "Skills", icon: ICONS.spark, hint: skillHint(), run: function(){ toggleComposerPanel("skills"); } },
          { sep: true },
          { head: "transcript" },
          { label: "Normal", icon: tview() === "normal" ? ICONS.check : "", hint: "what it said and did",
            run: function(){ setTView("normal"); } },
          { label: "Thinking", icon: tview() === "thinking" ? ICONS.check : "", hint: "+ reasoning",
            run: function(){ setTView("thinking"); } },
          { label: "Verbose", icon: tview() === "verbose" ? ICONS.check : "", hint: "+ raw payloads",
            run: function(){ setTView("verbose"); } },
          { sep: true },
          { label: "Ask several models…", icon: ICONS.sparkles, hint: "a thread each", run: function(){ openAskSeveral(); } },
          { sep: true },
          { label: "Find in this chat", icon: ICONS.search, hint: KMOD + "F", run: function(){ view.openFind(); } },
          { head: "reply length" },
          { label: "Brief", icon: view.replyLength() === "brief" ? ICONS.check : "", hint: "the answer first", run: function(){ view.setReplyLength("brief"); } },
          { label: "Normal", icon: !view.replyLength() ? ICONS.check : "", run: function(){ view.setReplyLength(""); } },
          { label: "Detailed", icon: view.replyLength() === "detailed" ? ICONS.check : "", hint: "reasoning, trade-offs", run: function(){ view.setReplyLength("detailed"); } },
          { sep: true },
          { label: "Starred messages", icon: ICONS.star, hint: String(Object.keys(state.starSet || {}).length || ""), run: function(){ state.showStarred(); } },
          { label: "Export as Markdown", icon: ICONS.download, hint: ".md", run: function(){ view.exportThread(); } },
          { sep: true },
          { label: "Rewind…", icon: ICONS.rewind, hint: "put the files back", run: function(){ view.openRewindMenu(); } },
          { sep: true },
          { label: "Prompts", icon: ICONS.clipboard, hint: KMOD + "⇧V", run: function(){ openPrompts(); } },
          { label: "Attach a file", icon: ICONS.plus, run: function(){ var a = document.getElementById("attach"); if (a) a.click(); } },
        ];
        // The menu opens upward from a button that sits at the bottom of the
        // window; openMenu flips it, so it is given the button's top edge.
        openMenu(Math.round(r.left), Math.round(r.top - 4), items);
      };
      setAuto(state.auto);
      if (view.desktop) setTimeout(function(){ if (!pageGone() && state.startTour) state.startTour(false); }, 1200);
      // "Run again" from a run's own thread lands here, in Main, ready to orchestrate
      try { if (view.chatId === "main" && localStorage.getItem("loomOrchNext:" + view.pid)) { localStorage.removeItem("loomOrchNext:" + view.pid); state.cmode = "orch"; } } catch (e) {}
      view.setComposerMode(state.cmode || "chat");
      refreshSkillCount();

      // ---- hold-to-talk -----------------------------------------------------
      // Press and hold records; release sends the audio to the daemon, whose
      // CONFIGURED transcriber (LOOM_STT_CMD — no cloud, no keys) turns it into
      // text appended to the composer. You still read it and press send: voice
      // fills the box, it does not fire the prompt, because a misheard word in
      // a dispatched turn costs a whole turn to walk back.
      var micB = document.getElementById("micbtn");
      if (micB && navigator.mediaDevices && window.MediaRecorder) {
        var rec = null, chunks = [];
        var stopRec = function(){
          if (recog) { try { recog.stop(); } catch (e) {} return; }
          if (rec && rec.state !== "inactive") rec.stop();
          micB.classList.remove("active");
        };
        // No transcriber on the daemon: the browser's own speech recognition
        // (Chrome, Edge, Safari) types a live transcript instead. It is the
        // browser vendor's service, so it's only used when nothing local is set.
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        var recog = null;
        var startSpeech = function(){
          if (recog) return;
          var box = document.getElementById("box"); if (!box) return;
          var base = box.value ? box.value.replace(/\s+$/, "") + " " : "";
          var finals = "";
          recog = new SR();
          recog.continuous = true;
          recog.interimResults = true;
          recog.lang = navigator.language || "en-US";
          recog.onresult = function(e){
            var interim = "";
            for (var i = e.resultIndex; i < e.results.length; i++) {
              if (e.results[i].isFinal) finals += e.results[i][0].transcript;
              else interim += e.results[i][0].transcript;
            }
            box.value = base + (finals + interim).replace(/^\s+/, "");
            box.dispatchEvent(new Event("input", { bubbles: true }));
          };
          recog.onerror = function(e){
            var why = e && e.error;
            toast(why === "not-allowed" || why === "service-not-allowed" ? "microphone permission refused"
              : why === "network" ? "this browser’s speech service can’t be reached — set LOOM_STT_CMD on the daemon to transcribe locally"
              : why === "no-speech" ? "didn’t hear anything" : "voice input stopped" + (why ? " (" + why + ")" : ""));
          };
          recog.onend = function(){ recog = null; micB.classList.remove("active"); box.focus(); };
          try { recog.start(); micB.classList.add("active"); } catch (err) { recog = null; }
        };
        var startRec = function(ev){
          ev.preventDefault();
          if (state.stt === false && SR) { startSpeech(); return; }
          if (rec && rec.state === "recording") return;
          navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream){
            chunks = [];
            rec = new MediaRecorder(stream);
            rec.ondataavailable = function(e){ if (e.data && e.data.size) chunks.push(e.data); };
            rec.onstop = function(){
              stream.getTracks().forEach(function(t){ t.stop(); });
              var blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
              if (blob.size < 1000) return; // a tap, not speech
              fetch("/api/projects/" + view.pid + "/voice", {
                method: "POST",
                headers: { "Authorization": "Bearer " + state.token, "Content-Type": "application/octet-stream" },
                body: blob,
              }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
                .then(function(x){
                  if (!x.ok) { toast(x.j.error || "transcription failed"); return; }
                  var box = document.getElementById("box");
                  if (box) {
                    box.value = (box.value ? box.value + " " : "") + x.j.text;
                    box.focus();
                  }
                }).catch(function(e){ toast(e.message); });
            };
            rec.start();
            micB.classList.add("active");
          }).catch(function(){ toast("microphone permission refused"); });
        };
        micB.onmousedown = startRec;
        micB.ontouchstart = startRec;
        micB.onmouseup = stopRec;
        micB.onmouseleave = stopRec;
        micB.ontouchend = stopRec;
      } else if (micB) {
        micB.style.display = "none"; // no recorder in this browser — no dead button
      }

      // Drag a file straight onto the card.
      var cbox = document.querySelector(".cbox");
      if (cbox) {
        cbox.addEventListener("dragover", function(e){ e.preventDefault(); });
        cbox.addEventListener("drop", function(e){
          e.preventDefault();
          Array.prototype.forEach.call((e.dataTransfer && e.dataTransfer.files) || [], uploadFile);
        });
      }
      updateModelLabel();
    }


    // The one selector that says who runs the turn: AUTO (the router) or a chosen
    // agent. In AUTO the model is the router's call, so the model pill steps aside.
    function updateModelLabel(){
      var lbl = document.getElementById("cmodellabel");
      var p = state.project || {};
      var cur = (p.agents || []).filter(function(a){ return a.id === state.selected; })[0];
      if (lbl) {
        var mtxt = (cur && cur.model) ? shortModel(cur.model) : (cur && cur.kind === "model" ? "Pick a model" : "Default");
        // A model agent already wears its model as its name; don't say it twice.
        if (cur && cur.kind === "model" && cur.model && agentLabel(cur.kind, cur.id) === mtxt.replace(/:free$/, "")) {
          mtxt = /:free$/.test(cur.model) ? "free" : "model";
        }
        lbl.textContent = mtxt;
      }
      var mp = document.getElementById("modelpick");
      if (mp) mp.style.display = state.auto || state.cmode === "orch" ? "none" : "";
      var meter = document.getElementById("cctx");
      if (meter) {
        var m = cur && !state.auto && state.cmode !== "orch" ? usageMeter(cur) : "";
        meter.innerHTML = m; meter.style.display = m ? "" : "none";
      }
      var chip = document.getElementById("cagent");
      if (!chip) return;
      // Always visible in Chat: hiding it is what made the agent unswitchable
      // before — you can't click a control that isn't painted. Orchestrate
      // has its own cast (drawOrchControls), so there it steps aside.
      chip.style.display = state.cmode === "orch" ? "none" : "";
      chip.classList.remove("dim");
      chip.classList.toggle("auto", state.auto);
      if (state.auto) {
        chip.innerHTML = '<span class="autodot"></span><span class="can">AUTO</span><span class="cchev">' + ICONS.chevron + "</span>";
      } else if (cur) {
        chip.innerHTML = agentGlyph(cur.kind, cur.id) + '<span class="can">' + esc(agentLabel(cur.kind, cur.id)) + "</span>" +
          (cur.busy ? '<span class="cadot" style="background:var(--live)" title="working"></span>' : "") +
          '<span class="cchev">' + ICONS.chevron + "</span>";
      } else {
        chip.innerHTML = '<span class="cadot"></span><span class="can">agent</span><span class="cchev">' + ICONS.chevron + "</span>";
      }
      drawPermChip(cur);
    }


    // ---- permissions -------------------------------------------------------
    /** The chip beside the agent picker: the chosen agent's mode, in its state colour. */
    function drawPermChip(cur){
      var pc = document.getElementById("cperm"); if (!pc) return;
      // Nothing to set for the router (AUTO picks per hop), a bridge (it runs
      // in its own window, under its own rules), or in Orchestrate, whose
      // cast wears its modes on the chips instead.
      if (!cur || state.auto || state.cmode === "orch" || cur.tier === "bridge") { pc.style.display = "none"; return; }
      var mode = permOf(cur), cell = permProfile(cur.kind).modes[mode] || {};
      pc.style.display = "";
      pc.className = "cperm " + mode;
      pc.setAttribute("data-mode", mode);
      pc.title = "permissions \u00b7 " + (cell.label || PERM_NAMES[mode]) + " \u2014 click to change";
      pc.setAttribute("aria-label", "permissions: " + (PERM_NAMES[mode] || mode));
      pc.innerHTML = ICONS.shield + '<span class="cpl">' + esc(PERM_SHORT[mode] || mode) + '</span><span class="cchev">' + ICONS.chevron + "</span>";
    }

    /**
     * Bypass / Auto / Always ask for one agent. Each row says what the mode
     * means on *this* CLI (they disagree), and a mode the real CLI couldn't
     * honour is shown, disabled, with what was observed — not hidden, so you
     * learn why it isn't there instead of assuming it is.
     */
    function openPermMenu(agentId){
      var p = state.project || {};
      var a = (p.agents || []).filter(function(x){ return x.id === agentId; })[0];
      var m = document.getElementById("cmenu");
      if (!m) return;
      if (!a) { toast("pick an agent first"); return; }
      view.menuState = { kind: "permmenu", at: 0, sel: 0, items: [], agent: agentId };
      function paint(){
        var prof = permProfile(a.kind), cur = permOf(a), lbl = agentLabel(a.kind, a.id);
        var askCell = prof.modes.ask || {};
        m.style.display = "block"; fitMenu(m); m.className = "cmenu";
        m.innerHTML = '<div class="cmhead">permissions \u00b7 ' + esc(lbl) + (a.id !== lbl ? " (" + esc(a.id) + ")" : "") + "</div>" +
          PERM_MODES.map(function(mode){
            var cell = prof.modes[mode] || {}, parts = permSplit(cell.label), off = !!cell.unsupported;
            return '<div class="cmi pm' + (off ? " off" : "") + '" data-pm="' + mode + '" role="menuitemradio" aria-checked="' + (mode === cur) + '"' +
              (off ? ' aria-disabled="true" title="' + esc(cell.unsupported) + '"' : "") + ">" +
              '<span class="ic"><span class="pmdot ' + mode + '"></span></span>' +
              '<span class="pmt"><b>' + esc(PERM_NAMES[mode]) + "</b>" +
                "<small>" + esc(off ? "Unavailable \u2014 " + cell.unsupported : (parts[1] || parts[0])) + "</small>" +
                (cell.flags && !off ? "<code>" + esc(cell.flags) + "</code>" : "") + "</span>" +
              (mode === cur ? '<span class="tick">' + ICONS.check + "</span>" : "") + "</div>";
          }).join("") +
          (askCell.ask === "approvals" ? '<div class="cmfoot">Always ask: each tool call waits in the thread for you to allow or deny.</div>'
            : askCell.ask === "read-only" ? '<div class="cmfoot">' + esc(lbl) + " can\u2019t hand a prompt to Loom, so \u201cask\u201d runs it read-only.</div>" : "");
        Array.prototype.forEach.call(m.querySelectorAll("[data-pm]"), function(row){
          row.onmousedown = function(ev){
            ev.preventDefault();
            if (row.classList.contains("off")) { toast(row.getAttribute("title") || "not available for this agent"); return; }
            var mode = row.getAttribute("data-pm");
            closeMenu();
            if (mode !== permOf(a)) setPermissions(a.id, mode);
          };
        });
      }
      paint();
      if (!state.permProfiles) loadPermProfiles().then(function(){ if (view.menuState && view.menuState.kind === "permmenu" && view.menuState.agent === agentId) paint(); });
      setTimeout(function(){ document.addEventListener("mousedown", menuAway); }, 0);
    }

    function setPermissions(agentId, mode){
      var a = ((state.project || {}).agents || []).filter(function(x){ return x.id === agentId; })[0];
      var was = a && a.permissions;
      if (a) a.permissions = mode; // paint it now; the POST confirms it or puts it back
      updateModelLabel(); view.drawOrchControls();
      api("/api/projects/" + view.pid + "/agents/" + encodeURIComponent(agentId) + "/permissions", {
        method: "POST", body: JSON.stringify({ permissions: mode }),
      }).then(function(){
        toast(labelOf(agentId) + " \u2192 " + PERM_NAMES[mode].toLowerCase());
        view.refresh();
      }).catch(function(err){
        if (a) a.permissions = was;
        updateModelLabel(); view.drawOrchControls();
        toast(err.message);
      });
    }


    // ---- plan mode -----------------------------------------------------------
    function setPlan(on){
      view.planState = !!on;
      try { if (view.planState) localStorage.setItem(view.PLAN_KEY, "1"); else localStorage.removeItem(view.PLAN_KEY); } catch (e) {}
      drawPlan();
    }

    /** The switch, the card's edge, the placeholder, the orchestra's send, the hint. */
    function drawPlan(){
      var b = document.getElementById("planbtn");
      if (b) { b.classList.toggle("on", view.planState); b.setAttribute("aria-checked", view.planState ? "true" : "false"); }
      var cb = document.querySelector(".cbox"); if (cb) cb.classList.toggle("planon", view.planState);
      var os = document.getElementById("orchsend");
      if (os) os.innerHTML = view.planState ? ICONS.plan + "Write plan" : ICONS.orchestra + "Orchestrate";
      var box = document.getElementById("box"); if (box) box.placeholder = composerPlaceholder();
      view.drawStatus();
    }

    function composerPlaceholder(){
      if (state.cmode === "orch") return view.planState
        ? "Describe the goal \u2014 the orchestrator writes PLAN.md and a spec per task, changing no code\u2026"
        : "Describe the goal \u2014 the orchestrator splits it into tasks and runs them in parallel\u2026";
      return view.planState ? "What should be planned? The agent writes it to plans/ and changes no code\u2026" : "Message\u2026  @ for files, / for actions";
    }

    function loadPrompts(){
      return api("/api/prompts").then(function(j){
        view.prompts.saved = j.saved || []; view.prompts.recent = j.recent || []; view.prompts.loaded = true;
        if (view.menuState && view.menuState.kind === "prompts") drawPrompts();
      }).catch(function(err){
        var l = document.getElementById("pmlist"); if (l) l.innerHTML = '<div class="pmempty">' + esc(err.message) + "</div>";
      });
    }

    function openPrompts(){
      if (view.menuState && view.menuState.kind === "prompts") { closeMenu(); var bx = document.getElementById("box"); if (bx) bx.focus(); return; }
      // what's selected in the thread now, before focus moves into the search box
      try { state.promptSel = String(window.getSelection ? window.getSelection() : "").trim(); } catch (e) { state.promptSel = ""; }
      if (view.desktop && state.tab !== "thread") view.showTab("thread"); // the composer lives under Thread
      var m = document.getElementById("cmenu"); if (!m) return;
      closeMenu();
      view.menuState = { kind: "prompts", at: 0, sel: 0, items: [] };
      view.prompts.q = ""; view.prompts.sel = 0;
      m.className = "cmenu pmgr";
      m.style.display = "flex";
      m.innerHTML = '<div class="pmhead"><label class="pmq">' + ICONS.search +
          '<input id="pmq" placeholder="Search saved and recent prompts\u2026" autocomplete="off" spellcheck="false" aria-label="search prompts" aria-controls="pmlist"></label>' +
          '<button type="button" class="pmsave" id="pmsave" title="save what\u2019s in the composer">' + ICONS.bookmark + "Save current</button></div>" +
        '<div class="pmlist" id="pmlist" role="listbox" aria-label="prompts">' + (view.prompts.loaded ? "" : LOADER) + "</div>" +
        '<div class="pmfoot"><span><kbd>\u2191</kbd><kbd>\u2193</kbd> move</span><span><kbd>\u21b5</kbd> insert</span>' +
          "<span><kbd>" + KMOD + "↵</kbd> insert &amp; send</span><span><kbd>esc</kbd> close</span>" +
          '<span class="pmvars" title="write these in a saved prompt and they fill in when you insert it">{{selection}} {{date}} {{time}} {{project}} {{branch}} {{chat}} {{agent}} {{last_reply}} {{file}}</span></div>';
      var pb = document.getElementById("promptbtn"); if (pb) pb.classList.add("on");
      var q = document.getElementById("pmq");
      q.oninput = function(){ view.prompts.q = q.value; view.prompts.sel = 0; drawPrompts(); };
      q.onkeydown = promptKey;
      document.getElementById("pmsave").onclick = saveCurrentPrompt;
      if (view.prompts.loaded) drawPrompts();
      loadPrompts();
      setTimeout(function(){ document.addEventListener("mousedown", menuAway); }, 0);
      q.focus();
    }

    function promptRows(){
      var q = view.prompts.q.trim().toLowerCase();
      var hit = function(t){ return !q || String(t || "").toLowerCase().indexOf(q) >= 0; };
      var kept = {};
      view.prompts.saved.forEach(function(sp){ kept[sp.text] = 1; });
      var rows = [];
      view.prompts.saved.forEach(function(sp){ if (hit(sp.title) || hit(sp.text)) rows.push({ kind: "saved", p: sp }); });
      view.prompts.recent.forEach(function(r){ if (hit(r.text)) rows.push({ kind: "recent", p: r, kept: !!kept[r.text] }); });
      return rows;
    }

    function promptRow(r, i){
      var pr = r.p, text = String(pr.text || ""), lines = text.split("\n");
      var title = r.kind === "saved" ? (pr.title || lines[0]) : lines[0];
      // the snippet is whatever the title didn't already say
      var rest = title === lines[0] ? lines.slice(1).join(" ") : text;
      var snippet = rest.replace(/\s+/g, " ").trim();
      var pinned = r.kind === "saved" && pr.pinned;
      var meta = r.kind === "saved"
        ? (pr.uses ? "used " + pr.uses + "\u00d7" : "saved " + rel(pr.createdAt))
        : (pr.mode && pr.mode !== "chat" ? (pr.mode === "orchestrate" ? "orchestra" : pr.mode) + " \u00b7 " : "") + rel(pr.at);
      var acts = r.kind === "saved"
        ? '<button type="button" data-pma="edit" title="rename or edit">' + ICONS.pencil + "</button>" +
          '<button type="button" data-pma="pin" class="' + (pinned ? "on" : "") + '" title="' + (pinned ? "unpin" : "pin to the top") + '">' + ICONS.pin + "</button>" +
          '<button type="button" data-pma="del" class="del" title="delete">' + ICONS.trash + "</button>"
        : (r.kept ? '<button type="button" class="on" title="already saved" disabled>' + ICONS.check + "</button>"
          : '<button type="button" data-pma="save" title="save this prompt">' + ICONS.bookmark + "</button>");
      return '<div class="pmrow' + (i === view.prompts.sel ? " sel" : "") + (pinned ? " pinned" : "") + '" data-pr="' + i + '" role="option" aria-selected="' + (i === view.prompts.sel) + '">' +
        '<span class="pmi">' + (r.kind === "recent" ? ICONS.clock : pinned ? ICONS.pin : ICONS.bookmark) + "</span>" +
        '<span class="pmb"><div class="pmtt">' + esc(title || "(empty)") + "</div>" + (snippet ? '<div class="pmsn">' + esc(snippet.slice(0, 200)) + "</div>" : "") + "</span>" +
        '<span class="pmm">' + esc(meta) + "</span>" +
        '<span class="pmacts">' + acts + "</span></div>";
    }

    function drawPrompts(){
      var list = document.getElementById("pmlist"); if (!list) return;
      var rows = view.prompts.rows = promptRows();
      if (view.prompts.sel >= rows.length) view.prompts.sel = Math.max(0, rows.length - 1);
      var count = { pinned: 0, saved: 0, recent: 0 };
      rows.forEach(function(r){ count[r.kind === "recent" ? "recent" : r.p.pinned ? "pinned" : "saved"]++; });
      var NAMES = { pinned: "Pinned", saved: "Saved", recent: "Recent" };
      var html = "", last = "";
      rows.forEach(function(r, i){
        var sec = r.kind === "recent" ? "recent" : r.p.pinned ? "pinned" : "saved";
        if (sec !== last) {
          html += '<div class="pmsec">' + NAMES[sec] + ' <span class="bn">' + count[sec] + "</span>" +
            (sec === "recent" && !view.prompts.q ? '<button type="button" data-pmclear="1" title="forget every sent prompt">Clear</button>' : "") + "</div>";
          last = sec;
        }
        html += promptRow(r, i);
      });
      if (!rows.length) html = view.prompts.q
        ? '<div class="pmempty">Nothing matches \u201c' + esc(view.prompts.q) + "\u201d.</div>"
        : '<div class="pmempty"><b>No prompts yet.</b><br>Everything you send lands under Recent \u2014 save the ones worth keeping.</div>';
      list.innerHTML = html;
      Array.prototype.forEach.call(list.querySelectorAll("[data-pr]"), function(row){
        row.onmousedown = function(ev){
          ev.preventDefault(); // keep focus in the search box
          var i = Number(row.getAttribute("data-pr"));
          var act = ev.target.closest && ev.target.closest("[data-pma]");
          if (act) { promptAction(i, act.getAttribute("data-pma")); return; }
          if (ev.target.closest && ev.target.closest(".pmacts")) return;
          insertPrompt(i, ev.metaKey || ev.ctrlKey);
        };
        // right-click: everything a prompt can do
        row.oncontextmenu = function(ev){
          ev.preventDefault();
          var i = Number(row.getAttribute("data-pr")), r = view.prompts.rows[i]; if (!r) return;
          var items = [{ head: r.kind === "saved" ? "Saved prompt" : "Recent prompt" },
            { label: "Insert", icon: ICONS.quote, run: function(){ insertPrompt(i, false); } },
            { label: "Insert and send", icon: ICONS.up, run: function(){ insertPrompt(i, true); } },
            { label: "Copy", icon: ICONS.copy, run: function(){ copyText(String(r.p.text || "")); toast("copied"); } }];
          if (r.kind === "saved") {
            items.push({ sep: true });
            items.push({ label: "Rename or edit\u2026", icon: ICONS.pencil, run: function(){ promptAction(i, "edit"); } });
            items.push({ label: r.p.pinned ? "Unpin" : "Pin to the top", icon: ICONS.pin, run: function(){ promptAction(i, "pin"); } });
            items.push({ label: "Delete", icon: ICONS.trash, danger: true, run: function(){ promptAction(i, "del"); } });
          } else if (!r.kept) {
            items.push({ label: "Save", icon: ICONS.bookmark, run: function(){ promptAction(i, "save"); } });
          }
          closeMenu();
          openMenu(ev.clientX, ev.clientY, items);
        };
      });
      var clr = list.querySelector("[data-pmclear]");
      if (clr) clr.onmousedown = function(ev){
        ev.preventDefault();
        askConfirm("Forget every prompt you've sent? Saved prompts stay.", { ok: "Forget them", danger: true }).then(function(ok){
          if (!ok) return;
          api("/api/prompts/recent", { method: "DELETE" }).then(function(){ view.prompts.recent = []; drawPrompts(); }).catch(function(err){ toast(err.message); });
        });
      };
      var sv = document.getElementById("pmsave"), bx = document.getElementById("box");
      if (sv) sv.disabled = !(bx && bx.value.trim());
      var sel = list.querySelector(".pmrow.sel");
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
    }

    function promptKey(e){
      var n = view.prompts.rows.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (n) { view.prompts.sel = (view.prompts.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n; drawPrompts(); }
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); insertPrompt(view.prompts.sel, e.metaKey || e.ctrlKey); return; }
      if (e.key === "Escape") { e.preventDefault(); closeMenu(); var bx = document.getElementById("box"); if (bx) bx.focus(); }
    }

    /** Put a prompt in the composer: into an empty box whole, else at the caret. */
    /**
     * A saved prompt's {{variables}}, filled from where you are: the selection
     * you made in the thread, today's date, this project, branch, chat and
     * agent, the last reply, the file open beside the thread. Anything it
     * doesn't know stays as written, for you to fill in.
     */
    function fillPromptVars(text){
      var now = new Date(), pad = function(n){ return (n < 10 ? "0" : "") + n; };
      var chat = ((state.project && state.project.chats) || []).filter(function(c){ return c.id === view.chatId; })[0];
      var replies = document.querySelectorAll("#feed .msg.agent:not(.thinking) .bubble");
      var dockOpen = document.querySelector("#dockpane.open");
      var vars = {
        selection: state.promptSel || "",
        date: now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()),
        time: pad(now.getHours()) + ":" + pad(now.getMinutes()),
        project: (state.project && state.project.name) || "",
        branch: (state.gitStat && state.gitStat.pid === view.pid && state.gitStat.branch) || "",
        chat: (chat && chat.title) || "Main",
        agent: state.selected ? labelOf(state.selected) : "",
        last_reply: replies.length ? (replies[replies.length - 1].innerText || "").trim().slice(0, 4000) : "",
        file: dockOpen ? ((document.getElementById("dockpath") || {}).textContent || "") : "",
      };
      return String(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, function(m, k){
        var v = vars[k.toLowerCase()];
        return v ? v : m;
      });
    }
    function insertPrompt(i, andSend){
      var r = view.prompts.rows[i]; if (!r) return;
      var box = document.getElementById("box"); if (!box) return;
      var text = fillPromptVars(String(r.p.text || ""));
      var left = text.match(/\{\{\s*[a-z_]+\s*\}\}/i);
      closeMenu();
      var v = box.value;
      if (!v.trim()) { box.value = text; box.setSelectionRange(text.length, text.length); }
      else {
        var a = box.selectionStart, b = box.selectionEnd;
        var before = v.slice(0, a), after = v.slice(b);
        var pre = before && !/\s$/.test(before) ? " " : "";
        box.value = before + pre + text + after;
        var caret = (before + pre + text).length;
        box.setSelectionRange(caret, caret);
      }
      box.focus(); autosizeBox();
      if (r.kind === "saved") {
        r.p.uses = (r.p.uses || 0) + 1; // it floats up next time, as it will on the daemon
        api("/api/prompts/" + encodeURIComponent(r.p.id), { method: "PATCH", body: JSON.stringify({ used: true }) }).catch(function(){});
      }
      // a blank left to fill: select it, don't send a prompt with a hole in it
      if (left) {
        var at = box.value.indexOf(left[0]);
        if (at >= 0) box.setSelectionRange(at, at + left[0].length);
        toast("fill in " + left[0] + " — it’s selected");
        return;
      }
      if (andSend) send();
    }

    function promptAction(i, act){
      var r = view.prompts.rows[i]; if (!r) return;
      var done = function(){ return loadPrompts(); };
      var fail = function(err){ toast(err.message); };
      if (act === "pin") {
        r.p.pinned = !r.p.pinned; drawPrompts();
        api("/api/prompts/" + encodeURIComponent(r.p.id), { method: "PATCH", body: JSON.stringify({ pinned: r.p.pinned }) }).then(done, fail);
      } else if (act === "edit") {
        var p0 = r.p;
        closeMenu();
        askText("Name this prompt", { value: p0.title || String(p0.text || "").split("\n")[0].slice(0, 60), ok: "Next", required: true }).then(function(title){
          if (title === null) return;
          return askText("Edit the prompt", { value: String(p0.text || ""), ok: "Save", multiline: true, required: true,
            note: "Variables fill in when you insert it: {{selection}} {{date}} {{time}} {{project}} {{branch}} {{chat}} {{agent}} {{last_reply}} {{file}}" })
            .then(function(text){
              if (text === null) return;
              return api("/api/prompts/" + encodeURIComponent(p0.id), { method: "PATCH", body: JSON.stringify({ title: title.trim(), text: text }) })
                .then(function(){ toast("saved \u201c" + view.trunc(title.trim(), 40) + "\u201d"); return done(); });
            });
        }).catch(fail);
      } else if (act === "del") {
        var gone = r.p;
        view.prompts.saved = view.prompts.saved.filter(function(sp){ return sp !== gone; }); drawPrompts();
        api("/api/prompts/" + encodeURIComponent(gone.id), { method: "DELETE" }).then(function(){
          toast("deleted \u201c" + view.trunc(gone.title || String(gone.text || ""), 30) + "\u201d");
          return done();
        }, fail);
      } else if (act === "save") {
        api("/api/prompts", { method: "POST", body: JSON.stringify({ text: r.p.text }) })
          .then(function(j){ toast("saved \u201c" + view.trunc(j.prompt.title, 40) + "\u201d"); return done(); }, fail);
      }
    }

    function saveCurrentPrompt(){
      var box = document.getElementById("box"), t = box ? box.value.trim() : "";
      if (!t) { toast("type a prompt first, then save it"); return; }
      api("/api/prompts", { method: "POST", body: JSON.stringify({ text: t }) })
        .then(function(j){ toast("saved \u201c" + view.trunc(j.prompt.title, 40) + "\u201d"); view.prompts.q = ""; var q = document.getElementById("pmq"); if (q) q.value = ""; return loadPrompts(); })
        .catch(function(err){ toast(err.message); });
    }


    // AUTO ⇄ specific-agent: one selector, repainted to whichever is live.
    function setAuto(on){
      state.auto = !!on;
      updateModelLabel();
    }

    function refreshSkillCount(){
      api("/api/projects/" + view.pid + "/skills").then(function(r){
        var skills = r.skills || [], on = skills.filter(function(s){ return s.enabled; }).length;
        var b = document.getElementById("skcount"); if (b){ b.textContent = on; b.style.display = on ? "" : "none"; }
        state.skillsOn = on; state.skillsTotal = skills.length;
        // The button these marked is now a row inside the More menu; the
        // badge on More carries the same signal.
        var btn = document.getElementById("morebtn"); if (btn){ btn.classList.toggle("active", on > 0); }
      }).catch(function(){});
    }

    /**
     * Both of these open a modal, not a dropdown.
     *
     * A dropdown would be a 280px-tall scroll box that could only flip a switch
     * on a list you couldn't add to. Browsing a registry, reading what a server
     * does and pasting an endpoint is a task that deserves the screen.
     */
    function toggleComposerPanel(kind){
      closeComposerPanel();
      var p = state.project && state.project.id; if (!p) return;
      if (kind === "skills") openSkillsModal(p); else openMcpModal(p);
    }

    function closeComposerPanel(){ state.cpanel = null; var p = document.getElementById("cpanel"); if (p){ p.style.display = "none"; p.innerHTML = ""; } document.removeEventListener("mousedown", cpanelAway); }

    function cpanelAway(ev){ var p = document.getElementById("cpanel"); if (!p) return; if (p.contains(ev.target)) return; if (ev.target.closest && (ev.target.closest("#skillbtn") || ev.target.closest("#mcpbtn"))) return; closeComposerPanel(); }

    function mcpMark(slug, name){
      var d = view.MCPMARK[slug];
      if (d) return '<svg class="mcpmarksvg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + d + "</svg>";
      return '<span class="mcpmono">' + esc((name || "?").slice(0, 1).toUpperCase()) + "</span>";
    }

    /**
     * The MCP marketplace — browse real servers and install one.
     *
     * A modal rather than the old dropdown because this is a task, not a
     * toggle: you search, read what a server does, decide, and sometimes have
     * to paste a URL. The list is the official registry
     * (registry.modelcontextprotocol.io), not a list typed into this file, so it
     * stays true as the ecosystem moves; the featured row is a curated set of
     * well-known providers for the empty state.
     */
    function openMcpModal(pid){
      if (document.querySelector(".scrim")) return;
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal mcpmodal"><div class="modalhead">MCP servers' +
        '<button class="iconbtn" id="mcx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="mcpsearchwrap"><input id="mcpq" class="mcpsearch" type="search" placeholder="Search the MCP registry\u2026" autocomplete="off"/></div>' +
        '<div class="modalbody" id="mcpbody"><div class="loader"><i></i><i></i><i></i><i></i></div></div></div>';
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
      function onKey(e){ if (e.key === "Escape") close(); }
      document.addEventListener("keydown", onKey);
      scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
      document.getElementById("mcx").onclick = close;

      var installed = {};
      var MCP_KINDS = ["claude-code", "codex"]; // the adapters that take MCP servers from Loom (providers/agent.ts)
      function load(q){
        var body = document.getElementById("mcpbody"); if (!body) return;
        Promise.all([
          api("/api/mcp/catalog" + (q ? "?q=" + encodeURIComponent(q) : "")).catch(function(){ return { servers: [], featured: [], degraded: true }; }),
          api("/api/projects/" + pid + "/mcps").catch(function(){ return { mcps: [] }; })
        ]).then(function(res){
          var cat = res[0] || {}, all = (res[1] && res[1].mcps) || [];
          // Only a row with somewhere to connect or something to run is installed;
          // the rest are suggestion placeholders, and must not hide the catalog's offer.
          var mine = all.filter(function(m){ return m.url || m.command; });
          installed = {}; mine.forEach(function(m){ installed[m.name] = m; });
          var list = (q ? (cat.servers || []) : (cat.featured || []).concat(cat.servers || []));
          renderMcpList(body, list, mine, cat.degraded, q);
        });
      }
      /** A command line, split like a shell would: quotes keep spaces together. */
      function splitArgs(line){
        var out = [], cur = "", quote = null, any = false;
        for (var i = 0; i < line.length; i++) {
          var ch = line[i];
          if (quote) { if (ch === quote) quote = null; else if (ch === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i]; else cur += ch; continue; }
          if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
          if (/\s/.test(ch)) { if (cur || any) { out.push(cur); cur = ""; any = false; } continue; }
          cur += ch;
        }
        if (cur || any) out.push(cur);
        return out;
      }
      /** "KEY=value" (env) or "Header: value" (headers), one per line, into an object. */
      function pairs(text, sep){
        var o = {};
        String(text || "").split("\n").forEach(function(l){
          var at = l.indexOf(sep); if (at <= 0) return;
          var k = l.slice(0, at).trim(), v = l.slice(at + 1).trim();
          if (k) o[k] = v;
        });
        return o;
      }
      function reachNote(){
        var kinds = ((state.project && state.project.agents) || []).filter(function(a){ return a.enabled !== false; }).map(function(a){ return a.kind; });
        var yes = kinds.filter(function(k){ return MCP_KINDS.indexOf(k) >= 0; }), no = kinds.filter(function(k){ return MCP_KINDS.indexOf(k) < 0 && k !== "echo"; });
        if (!kinds.length) return "";
        return '<div class="mcpnote">' + ICONS.info + "<span>" +
          (yes.length ? "Servers reach " + esc(yes.map(function(k){ return agentLabel(k); }).filter(function(v, i, a){ return a.indexOf(v) === i; }).join(" and ")) + " in this project." : "None of this project’s agents take MCP servers yet.") +
          (no.length ? " " + esc(no.map(function(k){ return agentLabel(k); }).filter(function(v, i, a){ return a.indexOf(v) === i; }).join(", ")) + " " + (no.length === 1 ? "doesn’t" : "don’t") + " use them yet." : "") +
          "</span></div>";
      }
      function renderMcpList(body, list, mine, degraded, q){
        // What's already connected comes first: this modal is also where you
        // check on and remove what you installed, not only where you add.
        var connectedRows = mine.map(function(m){
          var on = m.enabledForSession !== false, local = !m.url && !!m.command;
          var st = !on ? ["off", "off", "switched off"] : local ? ["", "local", "local command"] : m.connected ? ["on", "ok", "reachable"] : ["off", "bad", "unreachable"];
          return '<div class="mcpitem installed' + (on ? "" : " disabled") + '" data-mcprow="' + esc(m.name) + '"><span class="mcpmark ' + st[0] + '">' + mcpMark(m.slug || String(m.name || "").toLowerCase(), m.name) + "</span>" +
            '<div class="mcpinfo"><div class="mcpname">' + esc(m.name) +
              '<span class="mcpstate ' + st[1] + '">' + st[2] + "</span></div>" +
              '<div class="mcpdesc">' + esc(m.url || [m.command].concat(m.args || []).join(" ")) + "</div></div>" +
            '<label class="mcpswitch" title="' + (on ? "on for this project — click to switch off" : "off — click to switch on") + '"><input type="checkbox" data-toggle="' + esc(m.name) + '"' + (on ? " checked" : "") + '><span></span></label>' +
            '<button class="mcpbtn remove" data-remove="' + esc(m.name) + '">Remove</button></div>';
        }).join("");
        var rows = list.filter(function(s){ return !installed[s.name || s.title]; }).map(function(s){
          var dest = s.url || (s.command ? s.command + " " + ((s.args || []).join(" ")) : "");
          var needsSetup = !!(s.needsUrl || s.requires || (!s.url && !s.command));
          return '<div class="mcpitem"><span class="mcpmark">' + mcpMark(s.slug, s.title || s.name) + "</span>" +
            '<div class="mcpinfo"><div class="mcpname">' + esc(s.title || s.name) +
              (s.transport ? '<span class="mcptr">' + esc(s.transport) + "</span>" : "") + "</div>" +
              '<div class="mcpdesc">' + esc(s.description || dest || "") + "</div>" +
              (s.requires ? '<div class="mcpreq">' + ICONS.key + esc(s.requires) + "</div>" : "") + "</div>" +
            '<button class="mcpbtn" data-install="' + esc(encodeURIComponent(JSON.stringify(s))) + '">' + (needsSetup ? "Set up…" : "Install") + "</button></div>";
        }).join("");
        body.innerHTML =
          (degraded ? '<div class="mcpwarn">' + ICONS.route + " The public registry didn’t answer — showing well-known providers only. Search needs the registry.</div>" : "") +
          reachNote() +
          (connectedRows ? '<div class="mcpsec">Installed in this project</div>' + connectedRows : "") +
          '<div class="mcpsec">' + (q ? "Registry results" : "Popular providers") + "</div>" +
          (rows || '<div class="mcpempty">' + (q ? "Nothing matched “" + esc(q) + "”." : "Every provider here is installed.") + "</div>") +
          '<div class="mcpcustom"><div class="mcpsec">Add one by hand</div>' +
            '<div class="mcprow2"><input id="mcpcn" class="mcpin" placeholder="Name"/><input id="mcpcu" class="mcpin wide" placeholder="https://…/mcp — or a command, e.g. npx -y @scope/server “/my dir”"/>' +
            '<button class="mcpbtn" id="mcpcadd">Add</button></div>' +
            '<details class="mcpmore"><summary>Headers and environment</summary>' +
              '<textarea id="mcpch" class="mcpin mcpta" rows="2" placeholder="Authorization: Bearer …  (one header per line, for a URL)"></textarea>' +
              '<textarea id="mcpce" class="mcpin mcpta" rows="2" placeholder="API_KEY=…  (one variable per line, for a command)"></textarea></details></div>';
        Array.prototype.forEach.call(body.querySelectorAll("[data-install]"), function(b){
          b.onclick = function(){
            var s = JSON.parse(decodeURIComponent(b.getAttribute("data-install")));
            if (s.needsUrl || s.requires || (!s.url && !s.command)) { setupForm(b, s); return; }
            doInstall({ name: s.title || s.name, slug: s.slug, url: s.url, command: s.command, args: s.args, transport: s.transport, description: s.description }, b);
          };
        });
        Array.prototype.forEach.call(body.querySelectorAll("[data-toggle]"), function(c){
          c.onchange = function(){
            var m = installed[c.getAttribute("data-toggle")]; if (!m) return;
            var next = {}; Object.keys(m).forEach(function(k){ if (k !== "connected" && k !== "probedAt") next[k] = m[k]; });
            next.enabledForSession = c.checked;
            api("/api/projects/" + pid + "/mcps", { method: "PATCH", body: JSON.stringify({ mcp: next }) })
              .then(function(){ toast(m.name + (c.checked ? " is on for this project" : " is off for this project")); load(document.getElementById("mcpq").value.trim()); })
              .catch(function(err){ toast(err.message); c.checked = !c.checked; });
          };
        });
        Array.prototype.forEach.call(body.querySelectorAll("[data-remove]"), function(b){
          b.onclick = function(){
            var name = b.getAttribute("data-remove");
            askConfirm("Remove " + name + " from this project?", { ok: "Remove", danger: true }).then(function(yes){
              if (!yes) return;
              b.disabled = true; b.textContent = "…";
              api("/api/projects/" + pid + "/mcps/" + encodeURIComponent(name), { method: "DELETE" })
                .then(function(){ toast(name + " removed"); load(document.getElementById("mcpq").value.trim()); })
                .catch(function(err){ toast(err.message); b.disabled = false; b.textContent = "Remove"; });
            });
          };
        });
        var addBtn = body.querySelector("#mcpcadd");
        if (addBtn) addBtn.onclick = function(){
          var n = body.querySelector("#mcpcn").value.trim(), u = body.querySelector("#mcpcu").value.trim();
          if (!n || !u) return void toast("Name and endpoint are both required.");
          var headers = pairs(body.querySelector("#mcpch").value, ":"), env = pairs(body.querySelector("#mcpce").value, "=");
          if (/^https?:\/\//.test(u)) doInstall({ name: n, url: u, transport: /\/sse\/?$/.test(u) ? "sse" : "http", headers: headers }, addBtn);
          else { var parts = splitArgs(u); doInstall({ name: n, command: parts[0], args: parts.slice(1), env: env }, addBtn); }
        };
      }
      /** Inline setup for a provider that needs a URL, a token or some arguments before it can work. */
      function setupForm(btn, s){
        var item = btn.closest(".mcpitem");
        var open = item.nextElementSibling && item.nextElementSibling.classList.contains("mcpform");
        Array.prototype.forEach.call(document.querySelectorAll("#mcpbody .mcpform"), function(f){ f.remove(); });
        if (open) return;
        var isCmd = !!s.command && !s.needsUrl;
        var f = document.createElement("div"); f.className = "mcpform";
        f.innerHTML = (s.requires ? '<div class="mcpreq">' + ICONS.key + esc(s.requires) + "</div>" : "") +
          (isCmd
            ? '<label>Command</label><input class="mcpin" data-f="cmd" value="' + esc([s.command].concat(s.args || []).map(function(a){ return /\s/.test(a) ? JSON.stringify(a) : a; }).join(" ")) + '"/>' +
              '<label>Environment <span>KEY=value, one per line</span></label><textarea class="mcpin mcpta" rows="2" data-f="env"></textarea>'
            : '<label>Endpoint URL</label><input class="mcpin" data-f="url" value="' + esc(s.urlTemplate || s.url || "https://") + '"/>' +
              '<label>Headers <span>Name: value, one per line — e.g. Authorization: Bearer …</span></label><textarea class="mcpin mcpta" rows="2" data-f="headers"></textarea>') +
          '<div class="mcpformacts"><button class="mcpbtn ghost" data-f="cancel">Cancel</button><button class="mcpbtn" data-f="go">Install</button></div>';
        item.after(f);
        var first = f.querySelector("input"); if (first) { first.focus(); first.setSelectionRange(first.value.length, first.value.length); }
        f.querySelector('[data-f="cancel"]').onclick = function(){ f.remove(); };
        f.querySelector('[data-f="go"]').onclick = function(){
          var go = f.querySelector('[data-f="go"]');
          if (isCmd) {
            var parts = splitArgs(f.querySelector('[data-f="cmd"]').value.trim());
            if (!parts.length) return void toast("Give it a command to run.");
            doInstall({ name: s.title || s.name, slug: s.slug, command: parts[0], args: parts.slice(1), env: pairs(f.querySelector('[data-f="env"]').value, "="), description: s.description }, go);
          } else {
            var url = f.querySelector('[data-f="url"]').value.trim();
            if (!/^https?:\/\/[^/]+\.[^/]+/.test(url) || url === s.urlTemplate || /[{<]/.test(url)) return void toast("Fill in the endpoint URL for your account.");
            doInstall({ name: s.title || s.name, slug: s.slug, url: url, transport: s.transport, headers: pairs(f.querySelector('[data-f="headers"]').value, ":"), description: s.description }, go);
          }
        };
      }
      function doInstall(payload, btn){
        var old = btn.textContent; btn.disabled = true; btn.textContent = "Installing…";
        api("/api/projects/" + pid + "/mcps/install", { method: "POST", body: JSON.stringify(payload) })
          .then(function(j){
            var ok = j && j.installed && (j.installed.connected || !payload.url);
            toast(payload.name + " installed" + (payload.url && !ok ? " — but it didn’t answer yet; check the URL or token" : ""));
            load(document.getElementById("mcpq").value.trim());
          })
          .catch(function(err){ toast(err.message || "install failed"); btn.disabled = false; btn.textContent = old; });
      }
      var qEl = document.getElementById("mcpq"), qT = null;
      qEl.oninput = function(){ if (qT) clearTimeout(qT); qT = setTimeout(function(){ load(qEl.value.trim()); }, 280); };
      qEl.focus();
      load("");
    }

    /**
     * The Skills modal — everything installable on this machine, and a way to
     * bring in more.
     *
     * Skills used to be a toggle list over two directories, so the dozens a
     * person already has under ~/.claude/skills were invisible and there was no
     * way to add one. This browses every real root (project, user, plugins) and
     * installs from a git URL or a folder.
     */
    function openSkillsModal(pid){
      if (document.querySelector(".scrim")) return;
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal mcpmodal"><div class="modalhead">Skills' +
        '<button class="iconbtn" id="skx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="mcpsearchwrap"><input id="skq" class="mcpsearch" type="search" placeholder="Filter skills\u2026" autocomplete="off"/></div>' +
        '<div class="modalbody" id="skbody"><div class="loader"><i></i><i></i><i></i><i></i></div></div></div>';
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); if (state.refreshComposer) state.refreshComposer(); }
      function onKey(e){ if (e.key === "Escape") close(); }
      document.addEventListener("keydown", onKey);
      scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
      document.getElementById("skx").onclick = close;

      var all = [];
      function load(){
        var body = document.getElementById("skbody"); if (!body) return;
        api("/api/projects/" + pid + "/skills/catalog")
          .catch(function(){ return api("/api/projects/" + pid + "/skills"); })
          .then(function(r){ all = r.skills || []; draw(); })
          .catch(function(){ body.innerHTML = '<div class="mcpempty">Skills unavailable \u2014 the daemon didn\u2019t answer.</div>'; });
      }
      function draw(){
        var body = document.getElementById("skbody"); if (!body) return;
        var q = (document.getElementById("skq").value || "").trim().toLowerCase();
        var list = all.filter(function(s){
          return !q || (s.id + " " + (s.name || "") + " " + (s.description || "")).toLowerCase().indexOf(q) >= 0;
        });
        var ORIGINS = { project: "in this project", user: "your skills", plugin: "from a plugin", bundled: "bundled" };
        var groups = {};
        list.forEach(function(s){ var o = s.origin || "bundled"; (groups[o] = groups[o] || []).push(s); });
        var html = "";
        ["project", "user", "plugin", "bundled"].forEach(function(o){
          var g = groups[o]; if (!g || !g.length) return;
          html += '<div class="mcpsec">' + esc(ORIGINS[o] || o) + " \u00b7 " + g.length + "</div>" +
            g.map(function(s){
              return '<div class="mcpitem"><span class="mcpmark ' + (s.enabled ? "on" : "") + '">' + mcpMark("", s.name || s.id) + "</span>" +
                '<div class="mcpinfo"><div class="mcpname">' + esc(s.name || s.id) +
                  (s.enabled ? '<span class="mcpstate ok">on</span>' : "") + "</div>" +
                  '<div class="mcpdesc">' + esc(s.description || "") + "</div></div>" +
                '<button class="mcpbtn' + (s.enabled ? " remove" : "") + '" data-tog="' + esc(s.id) + '" data-on="' + (s.enabled ? "1" : "0") + '">' +
                  (s.enabled ? "Disable" : "Enable") + "</button>" +
                (o === "project" ? '<button class="iconbtn skdel" data-skdel="' + esc(s.id) + '" title="remove from this project" aria-label="remove ' + esc(s.name || s.id) + '">' + ICONS.trash + "</button>" : "") +
                "</div>";
            }).join("");
        });
        body.innerHTML = (html || '<div class="mcpempty">' + (q ? "No skills matched \u201c" + esc(q) + "\u201d." : "No skills on this machine yet \u2014 install one below, or put a folder with a SKILL.md under this project\u2019s skills/.") + "</div>") +
          '<div class="mcpcustom"><div class="mcpsec">Install a skill</div>' +
          '<div class="mcprow2"><input id="skgit" class="mcpin wide" placeholder="https://github.com/\u2026 (git) or /path/to/skill"/>' +
          '<button class="mcpbtn" id="skadd">Install</button></div>' +
          '<div class="mcphint">A folder with a <code>SKILL.md</code> (at the root, or under <code>skills/&lt;name&gt;/</code>). It is copied into this project\u2019s <code>skills/</code> and turned on.</div></div>';
        Array.prototype.forEach.call(body.querySelectorAll("[data-tog]"), function(b){
          b.onclick = function(){
            var on = b.getAttribute("data-on") === "1";
            b.disabled = true;
            api("/api/projects/" + pid + "/skills/" + encodeURIComponent(b.getAttribute("data-tog")),
              { method: "PUT", body: JSON.stringify({ enabled: !on }) })
              .then(load).catch(function(err){ toast(err.message); b.disabled = false; });
          };
        });
        Array.prototype.forEach.call(body.querySelectorAll("[data-skdel]"), function(b){
          b.onclick = function(){
            var id = b.getAttribute("data-skdel");
            askConfirm("Remove the skill \u201c" + id + "\u201d from this project? Its folder under skills/ is deleted.", { ok: "Remove", danger: true }).then(function(yes){
              if (!yes) return;
              api("/api/projects/" + pid + "/skills/" + encodeURIComponent(id), { method: "DELETE" })
                .then(function(){ toast("removed " + id); load(); }).catch(function(err){ toast(err.message); });
            });
          };
        });
        body.querySelector("#skadd").onclick = function(){
          var v = (body.querySelector("#skgit").value || "").trim();
          if (!v) return void toast("Paste a git URL or a folder path.");
          var btn = this; btn.disabled = true; btn.textContent = "Installing\u2026";
          var payload = /^(https?:|git@|ssh:)/.test(v) ? { gitUrl: v } : { dir: v };
          var install = function(force){
            return api("/api/projects/" + pid + "/skills/install", { method: "POST", body: JSON.stringify(force ? Object.assign({ force: true }, payload) : payload) })
              .then(function(r){
                var sk = (r && (r.skill || r.installed)) || {};
                var ids = [sk.id].concat(sk.also || []).filter(Boolean);
                // installed means "use it": turn it on, so it reaches the next briefing
                return Promise.all(ids.map(function(id){ return api("/api/projects/" + pid + "/skills/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify({ enabled: true }) }).catch(function(){}); }))
                  .then(function(){
                    toast(ids.length > 1 ? "Installed and turned on " + ids.length + " skills: " + ids.join(", ") : "Installed and turned on " + (sk.name || sk.id || "the skill"));
                    body.querySelector("#skgit").value = ""; load();
                  });
              })
              .catch(function(err){
                var m = String((err && err.message) || "install failed");
                if (/force/i.test(m) && !force) {
                  return askConfirm("That skill is already installed in this project. Replace it with this copy?", { ok: "Replace" })
                    .then(function(yes){ if (yes) return install(true); });
                }
                toast(m);
              });
          };
          install(false).then(function(){ btn.disabled = false; btn.textContent = "Install"; });
        };
      }
      document.getElementById("skq").oninput = draw;
      load();
    }

    function scheduleSkillSuggest(text){ if (view._sugT) clearTimeout(view._sugT); view._sugT = setTimeout(function(){ doSkillSuggest(text); }, 300); }

    function doSkillSuggest(text){
      var bar = document.getElementById("cskillsug"); if (!bar) return;
      if (!text || text.trim().length < 4){ bar.style.display = "none"; return; }
      api("/api/projects/" + view.pid + "/skills?suggest=" + encodeURIComponent(text.slice(0, 200))).then(function(r){
        var s = r.suggestion;
        if (!s){ bar.style.display = "none"; return; }
        bar.style.display = "";
        bar.innerHTML = '<span class="sugico">' + ICONS.spark + '</span><span class="sugtx"><b>Skill: ' + esc(s.name || s.id) + '</b> <span class="obsub">' + esc((s.description || "").slice(0, 90)) + '</span></span><button class="sugadd" data-skill="' + esc(s.id) + '">+ Enable</button><button class="sugx iconbtn" aria-label="dismiss">' + ICONS.x + "</button>";
        var add = bar.querySelector(".sugadd");
        if (add) add.onclick = function(){ api("/api/projects/" + view.pid + "/skills/" + encodeURIComponent(s.id), { method: "PUT", body: JSON.stringify({ enabled: true }) }).then(function(){ refreshSkillCount(); bar.style.display = "none"; toast("enabled " + (s.name || s.id)); }).catch(function(err){ toast(err.message); }); };
        var x = bar.querySelector(".sugx"); if (x) x.onclick = function(){ bar.style.display = "none"; };
      }).catch(function(){});
    }
// Settings → Preferences opens these for the project on screen.
state.openTools = function(kind){ if (!view.pid) return; if (kind === "skills") openSkillsModal(view.pid); else openMcpModal(view.pid); };
return { autosizeBox, drawAttach, closeMenu, menuAway, openModelMenu, bindComposer, updateModelLabel, openPermMenu, composerPlaceholder, send };
}
