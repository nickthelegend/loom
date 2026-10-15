/**
 * The context meter on a native agent's chip: tokens in context against the
 * model's window, "compacting…" while the harness compacts, and the provider
 * account's usage-limit windows. Seeded from the project status
 * (AgentStatus.context / .limits) and kept live from the thread's events —
 * the same fold the daemon does in runtime/native-usage.ts.
 */
import { esc,money,tokens } from './format.js';

var PROVIDER = { codex: "codex", "claude-code": "claude" };
var CLAUDE_WINDOWS = { five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet", seven_day_overage_included: "weekly (overage)", overage: "overage" };

/** Fold one event into the project's agent statuses. True when a meter changed. */
function observeUsage(project, e){
  if (!project || !e || !e.agentId) return false;
  var agent = null;
  project.agents.forEach(function(a){ if (a.id === e.agentId) agent = a; });
  if (!agent || !PROVIDER[agent.kind]) return false;
  var p = e.payload || {}, ctx = agent.context || null;
  if (e.kind === "run_complete" || e.kind === "error" || (e.kind === "status" && p.state === "interrupted")) {
    if (!ctx || !ctx.compacting) return false;
    agent.context = Object.assign({}, ctx, { compacting: false });
    return true;
  }
  if (e.kind !== "status") return false;
  if (p.state === "context_usage" && typeof p.usedTokens === "number") {
    agent.context = { usedTokens: p.usedTokens, maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : ctx ? ctx.maxTokens : null,
      compacting: ctx ? ctx.compacting : false, compactedAt: ctx ? ctx.compactedAt : null, at: e.ts };
    return true;
  }
  if (p.state === "compacting") {
    agent.context = Object.assign({ usedTokens: 0, maxTokens: null, compactedAt: null }, ctx || {}, { compacting: true, at: e.ts });
    return true;
  }
  if (p.state === "native_compacted") {
    agent.context = Object.assign({ usedTokens: 0, maxTokens: null }, ctx || {},
      typeof p.postTokens === "number" ? { usedTokens: p.postTokens } : {}, { compacting: false, compactedAt: e.ts, at: e.ts });
    return true;
  }
  if (p.state === "usage_limits" && Array.isArray(p.windows)) {
    // Limits belong to the account: every agent on this provider shares them.
    var provider = PROVIDER[agent.kind];
    project.agents.forEach(function(a){
      if (PROVIDER[a.kind] !== provider) return;
      var byId = {}, order = [];
      ((a.limits && a.limits.windows) || []).concat(p.windows).forEach(function(w){
        if (!w || !w.id) return; if (!(w.id in byId)) order.push(w.id); byId[w.id] = w;
      });
      a.limits = { provider: provider, windows: order.map(function(id){ return byId[id]; }), reached: p.reached || null, at: e.ts };
    });
    return true;
  }
  return false;
}

function windowName(w){
  if (CLAUDE_WINDOWS[w.id]) return CLAUDE_WINDOWS[w.id];
  var m = w.windowMinutes;
  if (m === 10080) return "weekly";
  if (m && m % 60 === 0) return (m / 60) + "-hour";
  if (m) return m + "-minute";
  return w.id;
}

function resets(ms){
  if (!ms) return "";
  var d = new Date(ms), soon = ms - Date.now() < 24 * 3600 * 1000;
  return " (resets " + (soon ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { weekday: "short", hour: "numeric" })) + ")";
}

/** The chip's meter, or "" when the harness hasn't reported anything yet. */
function usageMeter(agent){
  var ctx = agent.context, lim = agent.limits;
  if (!ctx && !(lim && lim.windows && lim.windows.length)) return "";
  var lines = [], pct = null;
  if (ctx && ctx.maxTokens) {
    pct = Math.min(100, Math.round(ctx.usedTokens / ctx.maxTokens * 100));
    lines.push("Context: " + ctx.usedTokens.toLocaleString() + " of " + ctx.maxTokens.toLocaleString() + " tokens (" + pct + "%) — compacts automatically");
  } else if (ctx && ctx.usedTokens) lines.push("Context: " + ctx.usedTokens.toLocaleString() + " tokens");
  var hot = null;
  ((lim && lim.windows) || []).forEach(function(w){
    lines.push("Usage, " + windowName(w) + ": " + Math.round(w.usedPercent) + "%" + resets(w.resetsAt));
    if (w.usedPercent >= 80 && (!hot || w.usedPercent > hot.usedPercent)) hot = w;
  });
  if (lim && lim.reached) lines.push("Limit reached: " + windowName({ id: lim.reached }));
  var title = esc(lines.join("\n"));
  var h = "";
  if (ctx && ctx.compacting) h += '<span class="ctxm live" title="' + title + '">compacting…</span>';
  else if (pct !== null) h += '<span class="ctxm' + (pct >= 85 ? " warn" : "") + '" title="' + title + '"><span class="ctxbar"><i style="width:' + pct + '%"></i></span>' + pct + "%</span>";
  else if (ctx && ctx.usedTokens) h += '<span class="ctxm" title="' + title + '">' + tokens(ctx.usedTokens) + "</span>";
  if (lim && lim.reached) h += '<span class="ctxm err" title="' + title + '">limit</span>';
  else if (hot) h += '<span class="ctxm warn" title="' + title + '">' + esc(windowName(hot)) + " " + Math.round(hot.usedPercent) + "%</span>";
  else if (!h) h += '<span class="ctxm" title="' + title + '">limits</span>';
  return h;
}

// Pre-flight forecast (core/forecast.ts): what a turn on this agent usually
// costs and takes, from its own recent turns — before you send one.
function approxTime(ms){
  var s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60), r = s % 60;
  return m < 10 && r ? m + "m " + r + "s" : m + "m";
}
function forecastChip(agent){
  var f = agent && agent.forecast;
  if (!f || !f.ms) return "";
  var lines = ["A turn here usually takes " + approxTime(f.ms.typical) + " (up to " + approxTime(f.ms.high) + ")"];
  if (f.usd) lines.push("and costs " + money(f.usd.typical) + " (up to " + money(f.usd.high) + ")");
  lines.push("— from its last " + f.turns + " turns");
  if (f.budget) lines.push("\nToday: " + money(f.budget.spentUsd) + " of its " + money(f.budget.capUsd) + " budget" + (f.budget.mayCross ? " — one more long turn could cross it" : ""));
  var txt = "~" + (f.usd ? money(f.usd.typical) + " \u00b7 " : "") + approxTime(f.ms.typical);
  return '<span class="ctxm fcst' + (f.budget && f.budget.mayCross ? " warn" : "") + '" title="' + esc(lines.join(" ")) + '">' + esc(txt) + "</span>";
}

export { forecastChip,observeUsage,usageMeter };
