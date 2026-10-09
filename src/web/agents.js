import { BRAND_ICON_ALIAS,BRAND_TITLES } from '../daemon/brand-icons.ts';
/** Browser agents module. See README.md for ownership and startup. */
import { api } from './connection.js';
import { esc,hue } from './format.js';
import { toast } from './notifications.js';
import { state } from './state.js';
import { shortModel } from './permissions.js';


  // ---- ADE brand marks -----------------------------------------------------




  /**
   * The agent's own logo, drawn from the sprite in <body>. Keyed by adapter
   * kind, not by the instance id — you can name an agent anything, but its
   * kind is what it actually is. An unknown kind (a custom adapter, "echo")
   * has no logo to show, so callers fall back to the hue monogram rather than
   * guessing with someone else's brand.
   */
  function brandMark(kind, cls){
    if (!kind || !BRAND_TITLES[kind]) return "";
    var sym = BRAND_ICON_ALIAS[kind] || kind;
    // the mono marks (opencode, Grok) have no colour of their own: draw them in the foreground
    var mono = sym === "opencode" || sym === "grok-code" ? " mono" : "";
    return '<svg class="' + (cls || "brand") + mono + '" aria-hidden="true"><use href="#brand-' + sym + '"></use></svg>';
  }

  function hasBrand(kind){ return !!(kind && BRAND_TITLES[kind]); }

  /**
   * What a person calls each agent. The roster speaks in kinds ("codex",
   * "grok-code"); the pickers speak in products. A kind with no entry here —
   * echo, a custom adapter — is shown by its roster id, which is the name its
   * owner gave it.
   */
  var AGENT_LABELS = { "codex": "Codex (ChatGPT)", "antigravity-cli": "Antigravity", "antigravity": "Antigravity",
    "claude-code": "Claude Code", "grok-code": "Grok", "opencode": "OpenCode" };

  function agentLabel(kind, id){
    // A model agent left with its generic id ("model", "model-2") is better
    // named by the model it runs: "gemma-4-31b-it" says which one it is.
    if (kind === "model" && /^model(-\d+)?$/.test(String(id || ""))) {
      var list = (state.project && state.project.agents) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id && list[i].model) return shortModel(list[i].model).replace(/:free$/, "");
      }
    }
    return (kind && AGENT_LABELS[kind]) || id || kind || "agent";
  }

  /**
   * A roster id's label, resolving its kind from the open project. Before the
   * project has loaded, an id that IS a kind (the default roster's are) still
   * reads as its product, rather than flashing "claude-code" for a beat.
   */
  function labelOf(id){
    var s = String(id || "");
    // an ask-several thread's agent is the model it asked
    if (s.indexOf("ask:") === 0) return shortModel(s.slice(4));
    return agentLabel(kindOf(id) || (AGENT_LABELS[s] ? s : null), id);
  }

  /** The quiet second line of a picker row: id and role, each only if it adds something. */
  function agentSub(a, lbl){
    var bits = [];
    if (a.id !== lbl) bits.push(a.id);
    var role = a.tier === "bridge" ? "bridge" : (a.role || "");
    if (role && bits.indexOf(role) < 0 && role !== lbl) bits.push(role);
    return bits.join(" \u00b7 ");
  }

  /** The brand mark, or a hue monogram for a kind that has none — never blank. */
  function agentGlyph(kind, id, cls){
    var pic = id && state.project && (state.project.agents || []).filter(function(a){ return a.id === id && a.avatar; })[0];
    if (pic && /^data:image\/(png|jpeg|webp);base64,/.test(pic.avatar)) return '<img class="agpic' + (cls ? " " + cls : "") + '" src="' + pic.avatar + '" alt="">';
    if (hasBrand(kind)) return brandMark(kind, cls);
    var h = hue(String(id || kind || "?"));
    return '<span class="agmono" style="background:color-mix(in srgb, hsl(' + h + ',60%,50%) 20%, transparent);color:hsl(' + h + ',60%,var(--agent-l))">' +
      esc(String(id || kind || "?").slice(0, 1)) + "</span>";
  }

  /** Look up an agent's kind from the project payload (rows only carry ids). */
  function kindOf(id){
    var p = state.project, list = (p && p.agents) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].kind;
    return null;
  }


  /**
   * Rename a job in place, wherever a role is drawn. Roles are free text —
   * "architect", "the one that writes docs", whatever your project actually
   * does — so the label is the editor. Stops propagation because these sit
   * inside rows that do something else when clicked.
   */
  function wireRoleEditors(root, redraw){
    Array.prototype.forEach.call(root.querySelectorAll("[data-role-a]"), function(tag){
      tag.onclick = function(ev){
        ev.stopPropagation();
        if (tag.querySelector("input")) return;
        var was = tag.textContent;
        var inp = document.createElement("input");
        inp.className = "roleinput";
        inp.value = was === "\u2026" ? "" : was;
        inp.maxLength = 40;
        tag.textContent = "";
        tag.appendChild(inp);
        inp.focus();
        inp.select();
        var done = false;
        function finish(save){
          if (done) return; done = true;
          var next = inp.value.trim();
          if (!save || !next || next === was) { redraw(); return; }
          api("/api/projects/" + tag.getAttribute("data-role-p") + "/agents/" +
              tag.getAttribute("data-role-a") + "/role",
              { method: "POST", body: JSON.stringify({ role: next }) })
            .then(function(){ toast("role \u2192 " + next); redraw(); })
            .catch(function(err){ toast(err.message); redraw(); });
        }
        inp.onkeydown = function(e){
          if (e.key === "Enter") { e.preventDefault(); finish(true); }
          else if (e.key === "Escape") { e.preventDefault(); finish(false); }
        };
        inp.onblur = function(){ finish(true); };
        inp.onclick = function(e){ e.stopPropagation(); };
      };
    });
  }
export { AGENT_LABELS,agentGlyph,agentLabel,agentSub,BRAND_ICON_ALIAS,BRAND_TITLES,brandMark,hasBrand,kindOf,labelOf,wireRoleEditors };