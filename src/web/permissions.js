/** Browser permissions module. See README.md for ownership and startup. */
import { api } from './connection.js';
import { esc } from './format.js';
import { state } from './state.js';


  // ---- permissions: bypass | auto | ask, per agent -------------------------
  // The table lives on the daemon (core/permissions.ts) and is fetched once:
  // each kind's three cells, what they mean on that CLI, and the ones the real
  // CLI couldn't honour. A kind with no row (echo, a custom adapter) still
  // gets the three words, with meanings that promise nothing specific.
  var PERM_MODES = ["bypass", "auto", "ask"];

  var PERM_NAMES = { bypass: "Bypass", auto: "Auto", ask: "Always ask" };

  var PERM_SHORT = { bypass: "Bypass", auto: "Auto", ask: "Ask" };

  var GENERIC_PERMS = { default: "auto", modes: {
    bypass: { flags: "", label: "Bypass \u2014 runs anything, never asks" },
    auto: { flags: "", label: "Auto \u2014 the agent\u2019s own defaults" },
    ask: { flags: "", label: "Always ask \u2014 nothing changes without you" } } };

  function permProfile(kind){ var t = state.permProfiles; return (t && kind && t[kind]) || GENERIC_PERMS; }

  function loadPermProfiles(){
    if (state.permProfiles) return Promise.resolve(state.permProfiles);
    if (!state.permLoading) {
      state.permLoading = api("/api/permissions").then(function(j){
        state.permProfiles = (j && j.profiles) || {}; state.permLoading = null; return state.permProfiles;
      }).catch(function(){ state.permLoading = null; return null; });
    }
    return state.permLoading;
  }

  /** The mode an agent runs in: what the daemon says, else its kind's default. */
  function permOf(a){ return (a && a.permissions) || permProfile(a && a.kind).default || "auto"; }

  /** "Bypass — runs any tool" → ["Bypass", "runs any tool"]. */
  function permSplit(label){
    label = String(label || "");
    var i = label.indexOf(" \u2014 ");
    return i < 0 ? [label, ""] : [label.slice(0, i), label.slice(i + 3)];
  }

  /** The tiny mode badge. With an agent id it's also the way to change it. */
  /**
   * The model an agent will actually run, as a chip you can click. A CLI has
   * its own default and the chip says so; a model agent has no default at
   * all — it is a name off a provider's list — so until one is picked the
   * chip says that, loudly, because that agent cannot take a single turn.
   */
  function modelBadge(a){
    var needs = a.kind === "model" && !a.model;
    var txt = a.model ? shortModel(a.model) : (needs ? "pick a model" : "default");
    return '<span class="pbdg mbdg' + (needs ? " needs" : "") + '" data-modelof="' + esc(a.id) + '"' +
      ' title="model: ' + esc(a.model || (needs ? "none chosen — this agent can’t run yet" : a.kind + "’s own choice")) +
      ' — click to change">' + esc(txt) + "</span>";
  }

  /** Provider-qualified ids are long; the tail is the part that identifies it. */
  function shortModel(m){
    var v = String(m);
    var cut = v.lastIndexOf("/");
    if (cut >= 0) v = v.slice(cut + 1);
    return v.length > 24 ? v.slice(0, 23) + "…" : v;
  }

  function permBadge(mode, agentId, kind){
    // with the agent's kind, the tooltip says what this mode actually lets *this* agent do — "Auto"
    // isn't the same for every CLI, and the badge alone can't say so
    var cell = kind && permProfile(kind).modes ? permProfile(kind).modes[mode] : null;
    var what = cell && cell.label ? cell.label : "permissions: " + (PERM_NAMES[mode] || mode);
    return '<span class="pbdg ' + esc(mode) + '"' + (agentId ? ' data-permof="' + esc(agentId) + '"' : "") +
      ' title="' + esc(what) + (agentId ? " \u2014 click to change" : "") + '">' + esc(mode) + "</span>";
  }

  // What the platform calls the command key, for the shortcuts we print.
  var KMOD = /Mac|iPhone|iPad/.test(navigator.platform || "") ? "\u2318" : "Ctrl+";
export { GENERIC_PERMS,KMOD,loadPermProfiles,modelBadge,PERM_MODES,PERM_NAMES,PERM_SHORT,permBadge,permOf,permProfile,permSplit,shortModel };