import { api } from '../connection.js';
import { esc,money } from '../format.js';
import { ICONS,LOADER } from '../icons.js';
import { toast } from '../notifications.js';
import { state } from '../state.js';
import { avatarFor,durfmt } from '../transcript.js';
import { labelOf } from '../agents.js';

/** observatory behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createObservatory(view) {

    function scheduleObsRefresh(){
      if (view.obRefreshT || state.tab !== "observatory") return;
      view.obRefreshT = setTimeout(function(){ view.obRefreshT = null; if (state.tab === "observatory") drawObservatory(); }, 700);
    }

    function tokfmt(n){ n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); }

    function trunc(s, m){ s = String(s || ""); return s.length > m ? s.slice(0, m - 1) + "\u2026" : s; }

    function drawObservatory(){
      var el = document.getElementById("pane-observatory"); if (!el) return;
      var p = state.project;
      if (!p){ el.innerHTML = '<div class="obempty"><div class="biglogo">loom</div><div class="hair"></div><div class="obsub">Open a project to watch its fleet in action.</div></div>'; return; }
      // Metrics leads: "how is the fleet doing and what is it costing" is the
      // question people actually arrive with. The node views answer a narrower
      // one and used to greet everybody first.
      if (!state.obView) state.obView = "metrics";
      if (state.obView === "replay") state.obView = "travel"; // merged; old links still land
      Promise.all([
        api("/api/projects/" + p.id + "/metrics").catch(function(){ return {}; }),
        api("/api/projects/" + p.id + "/events?limit=500").catch(function(){ return {}; }),
        api("/api/projects/" + p.id + "/insights/health").catch(function(){ return {}; })
      ]).then(function(res){
        state.obHealth = res[2] || {};
        state.obKairo = (res[0] && res[0].kairo) || {};
        renderObservatory(el, p, (res[0] && res[0].metrics) || {}, (res[1] && res[1].events) || []);
      });
    }

    function obByAgent(m){ var o = {}; (m.byAgent || []).forEach(function(a){ o[a.agentId] = a; }); return o; }

    // One plain line under the tabs so each view explains itself — the fleet's
    // graphs mean nothing without saying what a node, an arrow, or a frame is.
    function obExplain(view){
      var drag = '<span class="obdraghint">' + (ICONS.move || "") + "drag any node to rearrange</span>";
      var fx = '<b style="color:var(--shuttle)">';
      var E = {
        canvas: "<b>Right now.</b> Who is running this second, who is idle, and where the " + fx + "baton</b> is \u2014 the ring pulses on whoever holds it. Every agent hangs off the <b>one shared brain</b> in the middle: that is the memory they all read and write, which is the whole point of the fleet. Updates live as turns start and finish. " + drag,
        graph: "<b>What already happened.</b> The baton\u2019s actual route through the fleet, left to right, oldest handoff first. Each " + fx + "\u2192</b> is one real handoff from the event log; <code>19t</code> under a name is turns that agent took. Live view is the <b>Live fleet</b> tab \u2014 this one is history. " + drag,
        timeline: "<b>The run, in the order it happened.</b> Every turn, handoff, route, memory fold, budget pause and self-heal line on one spine \u2014 so \u201cwhy did it do that?\u201d is answered by scrolling rather than by guessing. The \ud83d\udca1 lines are <b>decisions</b>; click one to read the reasoning behind it.",
        usage: "<b>What it cost, and what it used.</b> Spend and tokens split by agent, model, chat, day and tool, beside the turn metrics. Each turn\u2019s dollars are counted once, on the turn that spent them. An agent that reports no price (a subscription CLI, a free model) shows its tokens at $0 and is flagged, so the total is the least you spent, not an estimate.",
        metrics: "<b>Where the run\u2019s time and money actually went.</b> Nothing here is estimated: tokens and cost are what each agent\u2019s own CLI reported for the turn, and the durations are the spans Loom exports. Every agent carries a 0\u2013100 <b>health score</b>, and <b>\u26a0 Triage</b> root-causes a bad one from that agent\u2019s own spans.",
        decisions: "<b>The reasoning, not just the result.</b> Every choice an agent made, with what it weighed and rejected \u2014 mined out of its own prose after each turn, so it survives the agent that made it. A confidence it actually measured and one merely pattern-matched are labelled differently, because a number you cannot source is worse than no number.",
        alerts: "<b>What your monitoring told Loom, and what Loom did about it.</b> A firing alert takes the named agent out of rotation \u2014 it is refused the baton until the alert resolves \u2014 and a resolved one puts it back. This is the part your dashboards cannot show you: they know the alert fired, only Loom knows the fleet reacted.",
        logs: "<b>The third signal, read back out of the telemetry store.</b> Every message, tool call, file edit and error at the severity it was recorded, filterable by both. Each line carries the <b>trace</b> of the turn that produced it, so a log and the span it came from are one click apart. This is the one view with no local fallback: if ClickHouse is not answering it says so, rather than showing an empty list that looks like a quiet run.",
        travel: "<b>Rewind the whole run.</b> Drag the scrubber (or hit Play) to any moment and the whole app rewinds to it: who held the baton, every agent\u2019s state, the decisions made so far, the thread \u2014 and the <b>turn running at that instant</b> with its model, tokens, cost and trace. All reconstructed from the event log."
      };
      return E[view] ? '<div class="obexplain">' + E[view] + "</div>" : "";
    }

    function askPanelHtml(){
      var st = state.obAsk || { msgs: [], busy: false };
      var body;
      if (!st.msgs.length){
        body = '<div class="askempty"><div class="askmark">' + (ICONS.spark || "") + "</div>" +
          '<div class="askh">Ask</div>' +
          '<div class="asksub">Questions about this fleet\u2019s traces, spend, health and decisions \u2014 answered from its own telemetry.</div>' +
          '<div class="asksugs">' + view.ASK_SUGGESTIONS.map(function(s){
            return '<button class="asksug" type="button" data-q="' + esc(s) + '">' + esc(s) + "</button>";
          }).join("") + "</div></div>";
      } else {
        body = '<div class="askmsgs" id="askmsgs">' + st.msgs.map(function(m){
          if (m.role === "user") return '<div class="askm user">' + esc(m.text) + "</div>";
          if (m.role === "pending") return '<div class="askm noz pending"><span class="askdots"><i></i><i></i><i></i></span>reading the fleet\u2019s telemetry\u2026</div>';
          return '<div class="askm noz">' + esc(m.text).replace(/\n/g, "<br>") +
            (m.via ? '<div class="askvia">answered by ' + esc(m.via) + (m.mcp && m.mcp.length ? " \u00b7 via telemetry MCP: " + esc(m.mcp.join(", ")) : "") +
              (m.spanSource === "local-log" ? " \u00b7 local event log (backend unreachable)" : m.spanSource === "backend" ? " \u00b7 exported spans" : "") + "</div>" : "") + "</div>";
        }).join("") + "</div>";
      }
      return '<div class="askhd"><span class="askt">' + (ICONS.spark || "") + "Ask</span>" +
        '<button class="iconbtn" id="askclear" title="new conversation" aria-label="new conversation">' + (ICONS.plus || "+") + "</button>" +
        '<button class="iconbtn" id="askclose" title="close" aria-label="close">' + ICONS.x + "</button></div>" +
        body +
        '<div class="askform"><textarea id="askinput" rows="1" placeholder="Ask anything about this fleet\u2026"></textarea>' +
        '<button class="asksend" id="asksend" type="button" aria-label="send">' + (ICONS.arrowUp || ICONS.chevron || "\u2191") + "</button></div>";
    }

    function renderAskPanel(){
      var el = document.getElementById("obaskpanel"); if (!el) return;
      var st = state.obAsk || { msgs: [], busy: false };
      el.className = "obaskpanel" + (st.open ? " open" : "");
      if (!st.open){ el.innerHTML = ""; return; }
      el.innerHTML = askPanelHtml();
      var msgs = el.querySelector("#askmsgs"); if (msgs) msgs.scrollTop = msgs.scrollHeight;
      var input = el.querySelector("#askinput");
      Array.prototype.forEach.call(el.querySelectorAll(".asksug"), function(b){
        b.onclick = function(){ sendAsk(b.getAttribute("data-q")); };
      });
      el.querySelector("#askclose").onclick = function(){ state.obAsk.open = false; renderAskPanel(); };
      el.querySelector("#askclear").onclick = function(){ state.obAsk.msgs = []; renderAskPanel(); };
      el.querySelector("#asksend").onclick = function(){ if (input) sendAsk(input.value); };
      if (input){
        input.onkeydown = function(ev){
          if (ev.key === "Enter" && !ev.shiftKey){ ev.preventDefault(); sendAsk(input.value); }
        };
        if (!st.busy) input.focus();
      }
    }

    function sendAsk(q){
      q = (q || "").trim(); if (!q) return;
      var st = state.obAsk; if (!st || st.busy) return;
      st.msgs.push({ role: "user", text: q });
      st.msgs.push({ role: "pending" });
      st.busy = true; renderAskPanel();
      var pid = state.project && state.project.id;
      api("/api/projects/" + pid + "/observatory/ask", { method: "POST", body: JSON.stringify({ question: q }) })
        .then(function(r){
          st.msgs.pop(); // drop the pending bubble
          st.msgs.push({ role: "noz", text: r.answer || "(no answer)", via: r.via, mcp: r.mcpServers, spanSource: r.spanSource });
        })
        .catch(function(err){
          st.msgs.pop();
          st.msgs.push({ role: "noz", text: "Couldn\u2019t reach the daemon \u2014 " + (err && err.message ? err.message : "unknown error") + ". Try again." });
        })
        .then(function(){ st.busy = false; renderAskPanel(); });
    }

    function obChartCard(title, sub, inner, wide){
      return '<div class="obchart' + (wide ? " wide" : "") + '"><div class="obcht"><span class="obchtt">' + esc(title) + "</span>" +
        (sub ? '<span class="obchts">' + esc(sub) + "</span>" : "") + "</div>" + inner + "</div>";
    }

    /** Ring chart: slices are {k,v,label}; the centre carries the total. */
    function obDonut(slices, centreVal, centreSub){
      slices = slices.filter(function(s){ return s.v > 0; });
      var total = slices.reduce(function(a, s){ return a + s.v; }, 0);
      if (!total) return '<div class="obchempty">nothing recorded yet</div>';
      var r = 52, circ = 2 * Math.PI * r, off = 0;
      var rings = slices.map(function(s, i){
        var len = (s.v / total) * circ;
        var seg = '<circle cx="70" cy="70" r="' + r + '" fill="none" stroke="' + view.OBPAL[i % view.OBPAL.length] +
          '" stroke-width="20" stroke-dasharray="' + len.toFixed(2) + " " + (circ - len).toFixed(2) +
          '" stroke-dashoffset="' + (-off).toFixed(2) + '"><title>' + esc(s.k + " \u00b7 " + s.label) + "</title></circle>";
        off += len; return seg;
      }).join("");
      var legend = slices.map(function(s, i){
        return '<div class="obdli"><span class="obdsw" style="background:' + view.OBPAL[i % view.OBPAL.length] + '"></span>' +
          '<span class="obdlk">' + esc(s.k) + '</span><span class="obdlv">' + esc(s.label) + "</span></div>";
      }).join("");
      return '<div class="obdonutwrap"><svg viewBox="0 0 140 140" class="obdonut" role="img" aria-label="' + esc(centreSub + " " + centreVal) + '">' +
        '<g transform="rotate(-90 70 70)">' + rings + "</g>" +
        '<text x="70" y="70" class="obdcv">' + esc(centreVal) + "</text>" +
        '<text x="70" y="86" class="obdcs">' + esc(centreSub) + "</text></svg>" +
        '<div class="obdlegend">' + legend + "</div></div>";
    }

    /** Multi-series line chart over a shared time axis. series: {k,pts:[n]}. */
    function obSeries(series, fmtY, xlabels){
      var max = 0;
      series.forEach(function(s){ s.pts.forEach(function(v){ if (v > max) max = v; }); });
      if (!max) return '<div class="obchempty">nothing recorded yet</div>';
      var W = 600, H = 130, PL = 44, PR = 10, PT = 8, PB = 20;
      var iw = W - PL - PR, ih = H - PT - PB;
      var lines = series.map(function(s, i){
        var n = s.pts.length; if (n < 2) return "";
        var pts = s.pts.map(function(v, j){
          return (PL + (j / (n - 1)) * iw).toFixed(1) + "," + (PT + ih - (v / max) * ih).toFixed(1);
        }).join(" ");
        return '<polyline points="' + pts + '" fill="none" stroke="' + view.OBPAL[i % view.OBPAL.length] + '" stroke-width="1.6" stroke-linejoin="round"/>';
      }).join("");
      var grid = [0, 0.5, 1].map(function(f){
        var y = (PT + ih - f * ih).toFixed(1);
        return '<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y + '" class="obgl"/>' +
          '<text x="' + (PL - 6) + '" y="' + (Number(y) + 3).toFixed(1) + '" class="obax" text-anchor="end">' + esc(fmtY(max * f)) + "</text>";
      }).join("");
      var xs = (xlabels || []).map(function(l, j, arr){
        var x = PL + (arr.length < 2 ? 0 : (j / (arr.length - 1)) * iw);
        return '<text x="' + x.toFixed(1) + '" y="' + (H - 6) + '" class="obax" text-anchor="' + (j === 0 ? "start" : j === arr.length - 1 ? "end" : "middle") + '">' + esc(l) + "</text>";
      }).join("");
      var legend = series.map(function(s, i){
        return '<span class="obsli"><span class="obdsw" style="background:' + view.OBPAL[i % view.OBPAL.length] + '"></span>' + esc(s.k) + "</span>";
      }).join("");
      return '<svg viewBox="0 0 ' + W + " " + H + '" class="obsvgline" preserveAspectRatio="none">' + grid + lines + xs + "</svg>" +
        '<div class="obslegend">' + legend + "</div>";
    }

    /** The Metrics dashboard's chart band, all from real telemetry. */
    function obCharts(p, events, byAgent){
      var k = state.obKairo || {};
      var modelOf = {};
      (p.agents || []).forEach(function(a){ modelOf[a.id] = (a.options && a.options.model) || ""; });
      var rows = Object.keys(byAgent).map(function(id){ return byAgent[id]; })
        .filter(function(a){ return a && (a.turns || a.tokensIn || a.tokensOut); });
      var tokSlices = rows.map(function(a){
        var t = (a.tokensIn || 0) + (a.tokensOut || 0);
        return { k: a.agentId + (modelOf[a.agentId] ? " \u00b7 " + modelOf[a.agentId] : ""), v: t, label: tokfmt(t) };
      }).sort(function(x, y){ return y.v - x.v; });
      var callSlices = rows.map(function(a){ return { k: a.agentId, v: a.turns || 0, label: String(a.turns || 0) }; })
        .sort(function(x, y){ return y.v - x.v; });
      var totalTok = tokSlices.reduce(function(s, x){ return s + x.v; }, 0);
      var totalCalls = callSlices.reduce(function(s, x){ return s + x.v; }, 0);

      // Turn duration over time, per agent, bucketed from real run_complete events.
      // Sorted rather than assumed. The feed arrives oldest-first today and the
      // bucketing below depends on it: t1 - t0 going negative would clamp span
      // to 1ms, floor every earlier event into a negative bucket index, and the
      // 0..N read loop would silently skip them — a wrong chart, not an empty
      // one. A sort on a copy costs nothing and removes the dependency.
      var done = (events || []).filter(function(e){ return e.kind === "run_complete" && e.payload && e.payload.durationMs; })
        .slice().sort(function(a, b){ return a.ts - b.ts; });
      var durSeries = [], xl = [];
      if (done.length > 1){
        var t0 = done[0].ts, t1 = done[done.length - 1].ts, span = Math.max(1, t1 - t0), N = 16;
        var per = {};
        done.forEach(function(e){
          var b = Math.min(N - 1, Math.floor(((e.ts - t0) / span) * N));
          var a = e.agentId || "?";
          (per[a] = per[a] || []);
          (per[a][b] = per[a][b] || []).push(e.payload.durationMs / 1000);
        });
        durSeries = Object.keys(per).map(function(a){
          var pts = []; for (var i = 0; i < N; i++){ var arr = per[a][i]; pts.push(arr ? arr.reduce(function(s, v){ return s + v; }, 0) / arr.length : 0); }
          return { k: a, pts: pts };
        });
        // A run that spans more than a day gets dates on the axis. Without them
        // this read "21:59 · 16:49 · 11:39" for a 37-hour run, which looks like
        // time flowing backwards until you work out that each step is 18h50m
        // and the labels have silently crossed two midnights. Anyone reading the
        // chart for five seconds concludes it is broken. Same-day runs keep the
        // bare clock, which is the common case and needs no date.
        var multiDay = span > 36e5 * 20;
        var f = function(ms){
          var d = new Date(ms);
          var hm = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
          if (!multiDay) return hm;
          return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
        };
        xl = [f(t0), f(t0 + span / 2), f(t1)];
      }
      var tokSpark = (k.tokenSparkline || []).slice(), costSpark = (k.costSparkline || []).slice();
      // The card says "cumulative USD", so make it cumulative. costSparkline is
      // the per-turn cost of the last ten runs; plotting that raw meant a run
      // whose recent turns reported no cost drew "nothing recorded yet"
      // directly under a $3.64 SPEND total. Both numbers were true — the total
      // sums the whole log, the sparkline only the tail — but read together on
      // one screen they look like the dashboard contradicting itself, which is
      // the last thing this project can afford to look like.
      //
      // Seeding the running total with (total - tail) lands the last point
      // exactly on the SPEND figure above, so the curve is the real cumulative
      // spend and the two can never disagree. Turns that cost nothing now show
      // as what they are: a flat stretch, not missing data.
      var costTail = costSpark.reduce(function(s, v){ return s + (Number(v) || 0); }, 0);
      var runUsd = k.totalCostUsd != null ? k.totalCostUsd : (p.costUsd || 0);
      var costRun = Math.max(0, (Number(runUsd) || 0) - costTail), cumCost = [];
      costSpark.forEach(function(v){ costRun += Number(v) || 0; cumCost.push(costRun); });

      return '<div class="obchartgrid">' +
        obChartCard("Token distribution", "by agent \u00b7 model", obDonut(tokSlices, tokfmt(totalTok), "tokens")) +
        obChartCard("Turns", "by agent", obDonut(callSlices, String(totalCalls), "turns")) +
        obChartCard("Turn duration over time", "seconds \u00b7 per agent", obSeries(durSeries, function(v){ return v.toFixed(1) + "s"; }, xl), true) +
        obChartCard("Token usage", "over the run", obSeries(tokSpark.length ? [{ k: "tokens", pts: tokSpark }] : [], tokfmt, []), true) +
        obChartCard("Spend", "cumulative USD", obSeries(cumCost.length ? [{ k: "cost", pts: cumCost }] : [], money, []), true) +
        "</div>";
    }

    function renderObservatory(el, p, m, events){
      var agents = (p.agents || []), byAgent = obByAgent(m);
      var active = agents.filter(function(a){ return a.busy; }).length;
      var totalUsd = m.totalUsd != null ? m.totalUsd : (p.costUsd || 0);
      var turns = m.turns || 0, tin = m.tokensIn || 0, tout = m.tokensOut || 0;
      function card(label, val, sub, accent, titleText){
        // titleText is the plain-text value where one exists, so it is also the
        // only honest way to measure length: val itself may carry markup. (No
        // backticks in this comment — the whole page is one template literal.)
        // An agent
        // called "claude-code" rendered as "claude-c…" in the BATON card at 22px,
        // which is the one card whose entire job is naming who holds the baton.
        // Ellipsising the answer is worse than setting it a step smaller.
        var big = !titleText || titleText.length <= 9;
        return '<div class="obcard' + (accent ? " accent" : "") + '"><div class="obcl">' + label +
          '</div><div class="obcv' + (big ? "" : " sm") + '"' + (titleText ? ' title="' + esc(titleText) + '"' : "") + ">" + val + '</div><div class="obcs">' + sub + "</div></div>";
      }
      var cards =
        card("Agents", '<span class="live">' + active + "</span> / " + agents.length, "active / in fleet") +
        card("Baton", esc(p.holder || "\u2014"), "who holds it now", false, p.holder || "") +
        card("Spend", money(totalUsd), "across all agents", true) +
        card("Turns", String(turns), "completed") +
        card("Tokens", tokfmt(tin + tout), tokfmt(tin) + " in \u00b7 " + tokfmt(tout) + " out");
      // Six views, ordered by the question people arrive with. "Replay" is the
      // old Time Travel: it absorbed the separate span-replay tab, which scrubbed
      // the same run on a second slider and left everyone asking which was which.
      var VIEWS = [["metrics", "Metrics"], ["usage", "Spend & tokens"], ["canvas", "Live fleet"], ["graph", "Handoffs"], ["alerts", "Self-heal"], ["timeline", "Timeline"], ["decisions", "Decisions"], ["logs", "Logs"], ["travel", "Replay"]];
      var tabs = VIEWS.map(function(v){
        var on = state.obView === v[0];
        return '<button class="obtab' + (on ? " on" : "") + '" role="tab" aria-selected="' + on + '" tabindex="' + (on ? "0" : "-1") + '" data-obv="' + v[0] + '">' + esc(v[1]) + "</button>";
      }).join("");
      var body;
      if (state.obView === "graph") body = observatoryGraph(agents, p.holder, events, byAgent);
      else if (state.obView === "timeline") body = observatoryTimeline(events);
      else if (state.obView === "metrics")
        // The dashboard: tiles, then the composition donuts, then behaviour over
        // time, then spend. Burn used to be its own tab answering a question
        // nobody asked separately from "what is this costing me".
        body = renderKairoMetrics(state.obKairo || {}) + obCharts(p, events, byAgent) +
          observatoryMetricsDetail(p, events, byAgent, state.obHealth || {}) +
          '<div id="obboard" class="obasync">' + LOADER + "</div>" +
          '<div id="obburn" class="obasync">' + LOADER + "</div>" +
          '<div id="obmex" class="obasync">' + LOADER + "</div>";
      else if (state.obView === "usage") body = '<div id="obusage" class="obasync">' + LOADER + "</div>";
      else if (state.obView === "decisions") body = '<div id="obdecisions" class="obasync">' + LOADER + "</div>";
      else if (state.obView === "logs") body = '<div id="oblogs" class="obasync">' + LOADER + "</div>";
      else if (state.obView === "alerts") body = '<div id="obalerts" class="obasync">' + LOADER + "</div>";
      else if (state.obView === "travel") body = '<div id="obtravel" class="obasync">' + LOADER + "</div>";
      else body = '<div class="obcanvaswrap">' + observatoryCanvas(agents, p.holder, byAgent) + "</div>";
      el.innerHTML =
        '<div class="obhead"><div class="obtitle">' + ICONS.telescope +
          '<span>Observatory</span> <span class="obsub">agents in action \u00b7 the one brain</span></div>' +
          '<button class="obask" id="obaskbtn" type="button">' + (ICONS.spark || ICONS.route) + " Ask</button>" +
          traceUiLink() + "</div>" +
        '<div class="obmetrics">' + cards + "</div>" +
        '<div class="obtabs" role="tablist" aria-label="Observatory views">' + tabs + "</div>" +
        obExplain(state.obView) +
        '<div class="obbody">' + body + "</div>" +
        '<div id="obaskpanel" class="obaskpanel"></div>';
      // Tabs follow the ARIA pattern: click or arrow-key to move, the active tab
      // is the only tab stop (roving tabindex), and it stays scrolled into view.
      var tabEls = Array.prototype.slice.call(el.querySelectorAll(".obtab"));
      // Focus ownership is tracked, not fired once. Selecting re-renders (which
      // destroys the focused button), and so does every live event arriving from
      // the stream — a one-shot "restore focus now" flag survives the first and
      // loses to the second, leaving the arrow keys dead mid-session. So the
      // strip remembers it owns focus until focus genuinely moves somewhere
      // else. Destroying the focused node sends focus to <body>, which fires no
      // focusin, so the claim survives a re-render; clicking the composer fires
      // one, which releases it.
      if (!state.obFocusWired){
        state.obFocusWired = true;
        document.addEventListener("focusin", function(ev){
          var t = ev.target;
          state.obTabFocus = !!(t && t.classList && t.classList.contains("obtab"));
        });
      }
      function selectTab(t){ state.obTabFocus = true; state.obView = t.getAttribute("data-obv"); renderObservatory(el, p, m, events); }
      tabEls.forEach(function(t, i){
        t.onclick = function(){ selectTab(t); };
        t.onkeydown = function(ev){
          var d = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
          if (d){ ev.preventDefault(); selectTab(tabEls[(i + d + tabEls.length) % tabEls.length], true); }
          else if (ev.key === "Home"){ ev.preventDefault(); selectTab(tabEls[0], true); }
          else if (ev.key === "End"){ ev.preventDefault(); selectTab(tabEls[tabEls.length - 1], true); }
        };
      });
      var onTab = el.querySelector(".obtab.on"), strip = el.querySelector(".obtabs");
      if (onTab && strip){
        // Only nudge the strip's own horizontal scroll — never the page (a live
        // refresh must not yank a reader back up to the tabs).
        var tl = onTab.offsetLeft, tr = tl + onTab.offsetWidth;
        if (tl < strip.scrollLeft) strip.scrollLeft = tl - 8;
        else if (tr > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = tr - strip.clientWidth + 8;
        // Deferred a frame on purpose. Re-rendering inside a click destroys the
        // button the browser is mid-way through focusing, and its own fixup runs
        // after the handler returns — landing focus on <body> and undoing a
        // synchronous restore. The flag is re-checked inside, so a user who
        // clicked away in the meantime keeps the focus they asked for.
        if (state.obTabFocus && document.activeElement !== onTab){
          requestAnimationFrame(function(){
            var live = el.querySelector(".obtab.on");
            if (live && state.obTabFocus && document.activeElement !== live) live.focus({ preventScroll: true });
          });
        }
      }
      Array.prototype.forEach.call(el.querySelectorAll(".obtriage"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); openTriage(p, b.getAttribute("data-triage")); };
      });
      Array.prototype.forEach.call(el.querySelectorAll(".obhealth"), function(b){
        if (!b.getAttribute("data-health")) return;
        b.onclick = function(ev){ ev.stopPropagation(); openHealth(b.getAttribute("data-health")); };
      });
      // Clicking a decision line in the Timeline jumps to the Decision Explorer.
      Array.prototype.forEach.call(el.querySelectorAll(".obtl.decision[data-decid]"), function(li){
        li.onclick = function(){ state.obPendingDecision = li.getAttribute("data-decid"); state.obView = "decisions"; renderObservatory(el, p, m, events); };
      });
      // Ask survives a redraw: the Observatory repaints on every live event,
      // and a chat that vanished mid-answer would be unusable.
      state.obAsk = state.obAsk || { open: false, msgs: [], busy: false };
      var askBtn = el.querySelector("#obaskbtn");
      if (askBtn) askBtn.onclick = function(){ state.obAsk.open = !state.obAsk.open; renderAskPanel(); };
      renderAskPanel();
      if (state.obView === "canvas" || state.obView === "graph") wireObservatoryDrag(el);
      if (state.obView === "metrics") { observatoryBoard(p); observatoryBurn(p); }
      if (state.obView === "metrics") observatoryMetricExplorer(p);
      if (state.obView === "usage") observatoryUsage(p);
      if (state.obView === "decisions") observatoryDecisions(p);
      if (state.obView === "logs") observatoryLogs(p);
      if (state.obView === "alerts") observatoryAlerts(p, events);
      if (state.obView === "travel") observatoryTravel(p);
    }

    // "Why did I fail?" — pull the agent's own traces and root-cause them.
    function openTriage(p, agent){
      if (document.querySelector(".scrim")) return;
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal triagemodal"><div class="modalhead">Triage \u00b7 ' + esc(agent) +
        '<button class="iconbtn" id="tx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="modalbody"><div class="loader"><i></i><i></i><i></i><i></i></div>' +
        '<div class="obsub" style="text-align:center;margin-top:10px">Reading ' + esc(agent) + "\u2019s traces\u2026</div></div></div>";
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
      function onKey(e){ if (e.key === "Escape") close(); }
      document.addEventListener("keydown", onKey);
      scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
      document.getElementById("tx").onclick = close;
      api("/api/projects/" + p.id + "/triage/" + encodeURIComponent(agent))
        .then(function(r){
          var t = (r && r.triage) || {};
          var src = t.source === "llm" ? '<span class="tbadge on">Claude</span>' : t.source === "heuristic" ? '<span class="tbadge">rule-based</span>' : '<span class="tbadge">no data</span>';
          var frm = t.from === "backend" ? '<span class="tbadge">from spans</span>' : t.from === "local-log" ? '<span class="tbadge">from event log</span>' : "";
          var evs = (t.evidence || []).map(function(s){
            var d = new Date(s.ts), hh = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
            return '<div class="tev' + (s.code === 2 ? " err" : "") + '"><span class="tevn">' + esc(s.name) + "</span>" +
              '<span class="tevm">' + (s.ms ? s.ms + "ms" : "") + "</span>" +
              '<span class="tevmsg">' + esc((s.msg || "").slice(0, 90)) + "</span>" +
              '<span class="tevt">' + hh + "</span></div>";
          }).join("");
          var body = document.querySelector(".triagemodal .modalbody");
          if (body) body.innerHTML =
            '<div class="tmeta">' + src + frm + '<span class="obsub">' + (t.spanCount || 0) + " spans \u00b7 " + (t.errorCount || 0) + " error(s)</span></div>" +
            '<div class="tlabel">Root cause</div><div class="trootcause">' + esc(t.rootCause || "\u2014") + "</div>" +
            '<div class="tlabel">Suggested fix</div><div class="tfix">' + esc(t.suggestedFix || "\u2014") + "</div>" +
            (evs ? '<div class="tlabel">Evidence <span class="obsub">(its own spans)</span></div><div class="tevidence">' + evs + "</div>" : "");
        })
        .catch(function(){
          var body = document.querySelector(".triagemodal .modalbody");
          if (body) body.innerHTML = '<div class="obsub">Triage failed \u2014 the daemon or the telemetry store is unreachable.</div>';
        });
    }

    // Agent Health Score breakdown — the 4 penalty buckets behind the pill.
    function openHealth(agent){
      if (document.querySelector(".scrim")) return;
      var h = ((state.obHealth || {}).byAgent || {})[agent] || {}, b = h.buckets || {};
      function bucket(l, v, max){
        var pct = Math.max(0, Math.min(100, Math.round((v / max) * 100)));
        return '<div class="hbk"><span class="hbkl">' + l + '</span><span class="hbkbar"><span class="hbkfill" style="width:' + pct + '%"></span></span><span class="hbkv">' + (v ? "\u2212" + v : "0") + "</span></div>";
      }
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal healthmodal"><div class="modalhead">Health \u00b7 ' + esc(agent) +
        '<button class="iconbtn" id="hx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="modalbody"><div class="hscore ' + (h.grade || "") + '">' + (h.score != null ? h.score : "\u2014") +
        '<span class="hscoremax">/100</span><span class="hgrade ' + (h.grade || "") + '">' + esc(h.grade || "") + "</span></div>" +
        '<div class="obsub" style="margin:2px 0 12px">' + (h.turns || 0) + " turns \u00b7 " + (h.errorCount || 0) + " error(s) \u00b7 penalties subtracted from 100</div>" +
        bucket("Error rate", b.errorRate || 0, 40) + bucket("Latency", b.latency || 0, 25) +
        bucket("Token bloat", b.tokenBloat || 0, 20) + bucket("Recent error", b.recency || 0, 15) +
        "</div></div>";
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
      function onKey(e){ if (e.key === "Escape") close(); }
      document.addEventListener("keydown", onKey);
      scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
      document.getElementById("hx").onclick = close;
    }

    // The telemetry backend's own UI, when one is configured (LOOM_TRACE_UI_URL).
    // Empty when it isn't, and every caller checks: a "View traces" link
    // pointing at a guessed localhost port is a dead end dressed as a feature.
    function backendBase(){ var u = window.__loomTraceUrl; return (u && u.charAt(0) !== "%" ? u : "").replace(/\/+$/, ""); }

    function backendTraceUrl(id){ var b = backendBase(); return b ? b + "/trace/" + encodeURIComponent(id || "") : ""; }

    function traceUiLink(){
      var b = backendBase();
      return b ? '<a class="obtraceui" href="' + b + '" target="_blank" rel="noreferrer">' + ICONS.route + " View traces</a>" : "";
    }
    // LEADERBOARD + HEATMAP: every turn off the log — who finishes, how fast,
    // what a turn costs — and twelve weeks of activity, a square a day.
    function observatoryBoard(p){
      var host = document.getElementById("obboard"); if (!host) return;
      api("/api/projects/" + p.id + "/insights/turns?days=84").then(function(r){
        if (!document.getElementById("obboard")) return;
        var lb = r.leaderboard || [], days = r.days || [];
        var rows = lb.length ? lb.map(function(a, i){
          var pct = Math.round((a.successRate || 0) * 100);
          var tone = pct >= 90 ? "ok" : pct >= 70 ? "warn" : "bad";
          return '<tr><td class="lbrank">' + (i + 1) + '</td><td><span class="lbwho">' + avatarFor(a.agentId) + esc(labelOf(a.agentId)) + "</span></td>" +
            '<td class="num">' + a.turns + '</td><td><span class="lbbar ' + tone + '"><i style="width:' + pct + '%"></i></span><span class="num">' + pct + "%</span></td>" +
            '<td class="num">' + (a.medianMs != null ? durfmt(a.medianMs) : "—") + "</td>" +
            '<td class="num">' + (a.avgCostUsd != null ? money(a.avgCostUsd) : "—") + '</td><td class="num">' + money(a.totalCostUsd || 0) + "</td>" +
            '<td class="num lbrated">' + (a.rated ? '<span class="up">' + a.rated.up + '</span> · <span class="dn">' + a.rated.down + "</span>" : "—") + "</td></tr>";
        }).join("") : '<tr><td colspan="8" class="lbempty">No finished turns yet — the table fills in as agents work.</td></tr>';
        // the heatmap: weeks as columns, Monday on top
        var max = 1; days.forEach(function(d){ if (d.turns > max) max = d.turns; });
        var first = days.length ? new Date(days[0].date + "T00:00:00") : new Date();
        var pad = (first.getDay() + 6) % 7, cells = [];
        for (var k = 0; k < pad; k++) cells.push('<i class="hm pad"></i>');
        days.forEach(function(d){
          var lvl = d.turns ? Math.min(4, 1 + Math.floor((d.turns / max) * 3.999)) : 0;
          cells.push('<i class="hm l' + lvl + (d.errors ? " err" : "") + '" title="' + esc(new Date(d.date + "T00:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) +
            " · " + d.turns + " turn" + (d.turns === 1 ? "" : "s") + (d.errors ? " (" + d.errors + " failed)" : "") + (d.costUsd ? " · " + money(d.costUsd) : "")) + '"></i>');
        });
        var active = days.filter(function(d){ return d.turns; }).length;
        // this month so far, and where this month's pace ends up
        var now = new Date(), ym = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
        var month = days.filter(function(d){ return d.date.slice(0, 7) === ym; });
        var spent = month.reduce(function(a, d){ return a + (d.costUsd || 0); }, 0);
        var dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), dayN = now.getDate();
        var pace = dayN ? spent / dayN : 0, forecast = spent + pace * (dim - dayN);
        host.innerHTML =
          '<div class="burnstats monthstats">' +
            '<div class="obminicard"><div class="obcl">This month so far</div><div class="obcv sm">' + money(spent) + "</div></div>" +
            '<div class="obminicard"><div class="obcl">Daily average</div><div class="obcv sm">' + money(pace) + "</div></div>" +
            '<div class="obminicard" title="this month’s spend so far, plus the daily average for the days left"><div class="obcl">Month-end at this pace</div><div class="obcv sm">' + money(forecast) + "</div></div></div>" +
          '<div class="obmlabel lbhead">Agent leaderboard<span class="spacer"></span>' +
            '<button type="button" class="btn xs outline" id="turnscsv">' + ICONS.download + "Export turns (CSV)</button></div>" +
          '<div class="lbwrap"><table class="lbtable"><thead><tr><th>#</th><th>Agent</th><th class="num">Turns</th><th>Finished cleanly</th><th class="num">Median time</th><th class="num">Per turn</th><th class="num">Total</th><th class="num" title="your thumbs up and down on its replies">You rated</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
          '<div class="obmlabel" style="margin-top:18px">Activity · last 12 weeks<span class="hmsum">' + (r.total || 0) + " turns · active " + active + " of " + days.length + " days</span></div>" +
          '<div class="hmgrid" role="img" aria-label="turns per day for twelve weeks">' + cells.join("") + "</div>" +
          '<div class="hmkey">Less <i class="hm l0"></i><i class="hm l1"></i><i class="hm l2"></i><i class="hm l3"></i><i class="hm l4"></i> More<span class="spacer"></span><i class="hm l2 err"></i> a day with a failed turn</div>';
        var csv = document.getElementById("turnscsv");
        if (csv) csv.onclick = function(){
          csv.disabled = true;
          fetch("/api/projects/" + p.id + "/insights/turns.csv", { headers: { Authorization: "Bearer " + state.token } })
            .then(function(res){ if (!res.ok) throw new Error("export failed (" + res.status + ")"); return res.blob(); })
            .then(function(blob){
              var a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = String(p.name || "loom").replace(/[^\w.-]+/g, "-") + "-turns.csv";
              document.body.appendChild(a); a.click(); a.remove();
              setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
              toast("exported " + a.download);
            })
            .catch(function(err){ toast(err.message); })
            .then(function(){ csv.disabled = false; });
        };
      }).catch(function(err){ if (host) host.innerHTML = '<div class="obnote">Couldn’t read turns: ' + esc(err.message) + "</div>"; });
    }

    // BURN: per-agent cost over time (real ClickHouse), linear projection, budgets.
    /** Spend & tokens: GET /usage, broken down every way worth asking. */
    function observatoryUsage(p){
      var host = document.getElementById("obusage"); if (!host) return;
      var days = state.obUsageDays || 30;
      api("/api/projects/" + p.id + "/usage?days=" + days).then(function(r){
        if (!document.getElementById("obusage")) return;
        host.innerHTML = usageView(r.usage || {}, days);
        Array.prototype.forEach.call(host.querySelectorAll("[data-udays]"), function(b){
          b.onclick = function(){ state.obUsageDays = Number(b.getAttribute("data-udays")); host.innerHTML = LOADER; observatoryUsage(p); };
        });
        Array.prototype.forEach.call(host.querySelectorAll("[data-uchat]"), function(row){
          row.onclick = function(){ if (state.setChat) state.setChat(state.pid, row.getAttribute("data-uchat")); if (state.showTab) state.showTab("thread"); };
        });
      }).catch(function(e){ host.innerHTML = '<div class="obnote">Usage unavailable \u2014 ' + esc(e.message) + "</div>"; });
    }

    function usageView(u, days){
      var t = u.totals || {}, pct = function(x, of){ return of ? Math.round((x / of) * 100) + "%" : "\u2014"; };
      var tok = function(n){ return tokfmt(n || 0); };
      var range = '<div class="useg" role="group" aria-label="period">' + [1, 7, 30, 90].map(function(d){
        return '<button type="button" data-udays="' + d + '" class="' + (d === days ? "on" : "") + '">' + (d === 1 ? "24h" : d + "d") + "</button>";
      }).join("") + "</div>";
      var tile = function(label, val, sub){ return '<div class="obminicard"><div class="obcl">' + esc(label) + '</div><div class="obcv sm">' + val + "</div>" + (sub ? '<div class="usub">' + sub + "</div>" : "") + "</div>"; };
      var tiles =
        tile("Spend", money(t.usd || 0), (t.unpriced ? t.unpriced + " unpriced turn" + (t.unpriced === 1 ? "" : "s") : "every turn priced")) +
        tile("Per turn", money(t.usdPerTurn || 0), (t.turns || 0) + " turns") +
        tile("Tokens in", tok(t.tokensIn), pct(t.cachedIn, t.tokensIn) + " from cache") +
        tile("Tokens out", tok(t.tokensOut), t.reasoning ? tok(t.reasoning) + " thinking" : "") +
        tile("Avg turn", durfmt(t.avgTurnMs || 0), durfmt(t.ms || 0) + " in all") +
        tile("Tool calls", String(t.toolCalls || 0), (t.toolFailures || 0) + " failed") +
        tile("Errors", String(t.errors || 0), (t.questions || 0) + " questions asked") +
        tile("Changed", String(t.filesChanged || 0) + " files", '<span class="cadd">+' + (t.linesAdded || 0) + '</span> <span class="cdel">\u2212' + (t.linesRemoved || 0) + "</span>");
      // daily bars: spend when there is any, else tokens
      // every day of the period, so a quiet day is a gap rather than missing
      var seen = {}; (u.byDay || []).forEach(function(d){ seen[d.day] = d; });
      var byDay = [];
      for (var di = days - 1; di >= 0; di--) {
        var dt = new Date(Date.now() - di * 86400000);
        var key = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
        byDay.push(seen[key] || { day: key, usd: 0, turns: 0, tokensIn: 0, tokensOut: 0 });
      }
      var spendy = byDay.some(function(d){ return d.usd > 0; });
      var val = function(d){ return spendy ? d.usd : d.tokensIn + d.tokensOut; };
      var max = Math.max.apply(null, byDay.map(val).concat([0])) || 1;
      var bars = byDay.some(function(d){ return d.turns; }) ? '<div class="ubars" role="img" aria-label="' + (spendy ? "spend" : "tokens") + ' per day">' + byDay.map(function(d){
        var h = Math.max(2, Math.round((val(d) / max) * 100));
        return '<i style="height:' + h + '%" title="' + esc(d.day + " \u00b7 " + money(d.usd) + " \u00b7 " + tokfmt(d.tokensIn + d.tokensOut) + " tokens \u00b7 " + d.turns + " turns") + '"></i>';
      }).join("") + "</div>" : '<div class="obnote">No turns in this period.</div>';
      var share = function(x){ return t.usd > 0 ? pct(x.usd, t.usd) : pct(x.tokensIn + x.tokensOut, (t.tokensIn || 0) + (t.tokensOut || 0)); };
      var shareBar = function(x){ var v = t.usd > 0 ? x.usd / t.usd : (x.tokensIn + x.tokensOut) / (((t.tokensIn || 0) + (t.tokensOut || 0)) || 1); return '<span class="ushare"><i style="width:' + Math.round(v * 100) + '%"></i></span>'; };
      var agentRows = (u.byAgent || []).map(function(a){
        return "<tr><td>" + avatarFor(a.agentId) + " " + esc(labelOf(a.agentId)) + (a.unpriced ? ' <span class="uflag" title="reports tokens but no price">unpriced</span>' : "") + "</td>" +
          '<td class="num">' + money(a.usd) + "</td><td>" + shareBar(a) + " " + share(a) + "</td>" +
          '<td class="num">' + a.turns + '</td><td class="num">' + tok(a.tokensIn) + '</td><td class="num">' + tok(a.tokensOut) + '</td><td class="num">' + pct(a.cachedIn, a.tokensIn) + "</td>" +
          '<td class="num">' + (a.turns ? durfmt(a.ms / a.turns) : "\u2014") + '</td><td class="num">' + a.toolCalls + (a.toolFailures ? ' <span class="cdel">(' + a.toolFailures + ")</span>" : "") + '</td><td class="num">' + a.errors + "</td>" +
          '<td class="umodels">' + esc((a.models || []).join(", ")) + "</td></tr>";
      }).join("");
      var modelRows = (u.byModel || []).map(function(m){
        return "<tr><td><code>" + esc(m.model) + '</code></td><td class="num">' + money(m.usd) + "</td><td>" + shareBar(m) + " " + share(m) + '</td><td class="num">' + m.turns + '</td><td class="num">' + tok(m.tokensIn) + '</td><td class="num">' + tok(m.tokensOut) + '</td><td class="num">' + money(m.turns ? m.usd / m.turns : 0) + "</td></tr>";
      }).join("");
      var chatRows = (u.byChat || []).map(function(c){
        return '<tr class="uclick" data-uchat="' + esc(c.chat) + '"><td>' + esc(c.title || c.chat) + '</td><td class="num">' + money(c.usd) + '</td><td class="num">' + c.turns + '</td><td class="num">' + tok(c.tokensIn + c.tokensOut) + "</td></tr>";
      }).join("");
      var toolRows = (u.byTool || []).map(function(x){
        return "<tr><td><code>" + esc(x.tool) + '</code></td><td class="num">' + x.calls + '</td><td class="num">' + (x.failures ? '<span class="cdel">' + x.failures + "</span>" : "0") + "</td></tr>";
      }).join("");
      var table = function(title, head, rows){ return rows ? '<div class="obmlabel" style="margin-top:18px">' + title + '</div><div class="lbwrap"><table class="lbtable"><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody></table></div>" : ""; };
      return '<div class="uhead"><div class="obmlabel">Last ' + (days === 1 ? "24 hours" : days + " days") + "</div>" + range + "</div>" +
        '<div class="burnstats utiles">' + tiles + "</div>" +
        '<div class="obmlabel" style="margin-top:18px">' + (spendy ? "Spend" : "Tokens") + " per day</div>" + bars +
        table("By agent", '<th>Agent</th><th class="num">Spend</th><th>Share</th><th class="num">Turns</th><th class="num">In</th><th class="num">Out</th><th class="num">Cached</th><th class="num">Avg turn</th><th class="num">Tools</th><th class="num">Errors</th><th>Models</th>', agentRows) +
        table("By model", '<th>Model</th><th class="num">Spend</th><th>Share</th><th class="num">Turns</th><th class="num">In</th><th class="num">Out</th><th class="num">Per turn</th>', modelRows) +
        table("By chat", '<th>Chat</th><th class="num">Spend</th><th class="num">Turns</th><th class="num">Tokens</th>', chatRows) +
        table("Tools", '<th>Tool</th><th class="num">Calls</th><th class="num">Failed</th>', toolRows);
    }

    function observatoryBurn(p){
      var host = document.getElementById("obburn"); if (!host) return;
      api("/api/projects/" + p.id + "/insights/burn?hours=24&buckets=12").then(function(r){
        host.innerHTML = burnView(p, r.burn || { buckets: [], totalUsd: 0, ratePerHour: 0, projected24h: 0 }, r.budgets || {});
        wireBurnBudgets(p, host);
      }).catch(function(){ host.innerHTML = '<div class="obnote">Burn data unavailable \u2014 the telemetry store is unreachable.</div>'; });
    }

    function burnView(p, burn, budgets){
      var bk = burn.buckets || [], n = bk.length, W = 680, H = 150, PADL = 6, PADR = 6, PADT = 12, PADB = 8;
      var hasData = (burn.totalUsd || 0) > 0 || bk.some(function(b){ return (b.total || 0) > 0; });
      var chart;
      if (hasData) {
        var max = 0.0000001; bk.forEach(function(b){ if (b.total > max) max = b.total; });
        var pts = bk.map(function(b, i){
          var x = PADL + (n <= 1 ? (W - PADL - PADR) / 2 : i * ((W - PADL - PADR) / (n - 1)));
          var y = (H - PADB) - (b.total / max) * (H - PADT - PADB);
          return [x, y];
        });
        var line = pts.map(function(pt, i){ return (i ? "L" : "M") + pt[0].toFixed(1) + " " + pt[1].toFixed(1); }).join(" ");
        var area = pts.length > 1 ? line + " L " + pts[pts.length - 1][0].toFixed(1) + " " + (H - PADB) + " L " + pts[0][0].toFixed(1) + " " + (H - PADB) + " Z" : "";
        var dots = pts.map(function(pt){ return '<circle cx="' + pt[0].toFixed(1) + '" cy="' + pt[1].toFixed(1) + '" r="2.5" fill="var(--primary)"/>'; }).join("");
        chart = '<svg viewBox="0 0 ' + W + " " + H + '" class="obsvg burnsvg" preserveAspectRatio="none">' +
          '<defs><linearGradient id="burnfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--primary)" stop-opacity="0.35"/><stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/></linearGradient></defs>' +
          (area ? '<path d="' + area + '" fill="url(#burnfill)"/>' : "") +
          (line ? '<path d="' + line + '" fill="none" stroke="var(--primary)" stroke-width="2"/>' : "") + dots + "</svg>";
      } else {
        // No spend → a compact empty state, not a blank 150px chart box that
        // reads as broken. The flat curve says nothing; a sentence says it all.
        chart = '<div class="burnempty">' + ICONS.spark +
          "<span>No spend in the last 24h. Free-model turns (Gemini, local) cost <b>$0</b>; the curve fills in as paid turns run.</span></div>";
      }
      var empty = "";
      var svg = chart;
      var summary = '<div class="burnstats">' +
        '<div class="obminicard"><div class="obcl">Spent (24h)</div><div class="obcv sm">' + money(burn.totalUsd || 0) + "</div></div>" +
        '<div class="obminicard"><div class="obcl">Rate</div><div class="obcv sm">' + money(burn.ratePerHour || 0) + "/h</div></div>" +
        '<div class="obminicard"><div class="obcl">Projected 24h</div><div class="obcv sm">' + money(burn.projected24h || 0) + "</div></div></div>";
      var budrows = (p.agents || []).map(function(a){
        var v = budgets[a.id];
        return '<div class="budrow"><span class="obname">' + esc(a.id) + '</span><span class="obsub">$/day</span>' +
          '<input class="budinput" type="number" min="0" step="0.5" data-agent="' + esc(a.id) + '" value="' + (v != null ? v : "") + '" placeholder="none"/>' +
          '<button class="budsave" data-agent="' + esc(a.id) + '">Save</button></div>';
      }).join("");
      return '<div class="burnwrap"><div class="obmlabel">Burn rate \u00b7 per-agent cost, last 24h</div>' + svg + summary + empty +
        '<div class="obmlabel" style="margin-top:16px">Per-agent budgets</div><div class="budgets">' + budrows + "</div></div>";
    }

    function wireBurnBudgets(p, host){
      Array.prototype.forEach.call(host.querySelectorAll(".budsave"), function(btn){
        btn.onclick = function(){
          var agent = btn.getAttribute("data-agent"), inp = host.querySelector('.budinput[data-agent="' + agent + '"]');
          var v = inp ? Number(inp.value) : 0;
          btn.textContent = "\u2026";
          api("/api/projects/" + p.id + "/budgets/" + encodeURIComponent(agent), { method: "PUT", body: JSON.stringify({ usdPerDay: v }) })
            .then(function(){ btn.textContent = "Saved"; setTimeout(function(){ btn.textContent = "Save"; }, 1200); })
            .catch(function(){ btn.textContent = "!"; });
        };
      });
    }

    // REPLAY: scrub the fleet's turns frame by frame — each frame is a real span.
    function observatoryReplay(p){
      var host = document.getElementById("obreplay"); if (!host) return;
      api("/api/projects/" + p.id + "/insights/spans?limit=100").then(function(r){
        var turns = (r.spans || []).filter(function(s){ return s.name === "gen_ai.agent.turn"; });
        if (!turns.length){ host.innerHTML = '<div class="obnote">No turn spans yet. Run a turn and replay it here.</div>'; return; }
        state.obReplaySrc = r.from;
        state.obReplayTurns = turns; if (state.obReplayIx == null || state.obReplayIx >= turns.length) state.obReplayIx = 0;
        renderReplay(p, host);
      }).catch(function(){ host.innerHTML = '<div class="obnote">Span replay unavailable \u2014 the telemetry store is unreachable.</div>'; });
    }

    function renderReplay(p, host){
      var turns = state.obReplayTurns || [], ix = state.obReplayIx || 0, t = turns[ix] || {};
      var d = new Date(t.ts || Date.now()), hh = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
      function pill(l, v){ return '<span class="rppill"><span class="rppl">' + l + "</span>" + v + "</span>"; }
      var frame = '<div class="rpframe">' +
        '<div class="rphead"><span class="rpagent">' + esc(t.agent || "agent") + "</span>" +
          '<span class="rpade">' + esc(t.ade || "") + (t.model ? " \u00b7 " + esc(t.model) : "") + "</span>" +
          '<span class="rpstatus ' + (t.code === 2 ? "err" : "ok") + '">' + (t.code === 2 ? "ERROR" : "OK") + "</span></div>" +
        (t.msg ? '<div class="rpmsg">' + esc(t.msg) + "</div>" : "") +
        '<div class="rpmetrics">' + pill("duration ", (t.ms || 0) + "ms") + pill("in ", tokfmt(t.tin || 0)) + pill("out ", tokfmt(t.tout || 0)) + pill("cost ", money(t.cost || 0)) + "</div>" +
        '<div class="rpactions">' +
          (t.traceId
            ? '<button class="rpwf" data-trace="' + esc(t.traceId) + '">Trace waterfall</button><a class="obtrace" href="' + backendTraceUrl(t.traceId) + '" target="_blank" rel="noreferrer">Open trace \u2197</a>'
            : '<span class="rpnote">' + ICONS.route + " The trace waterfall lights up once the telemetry store is reachable \u2014 this turn is from the local event log.</span>") +
          "</div></div>";
      var src = state.obReplaySrc === "local-log";
      var scrub = '<div class="rpscrubwrap"><input class="rpscrub" type="range" aria-label="Scrub turns" aria-valuetext="turn ' + (ix + 1) + " of " + turns.length + (t.agent ? ", " + esc(t.agent) : "") + '" min="0" max="' + (turns.length - 1) + '" value="' + ix + '"/>' +
        '<div class="rpscrubinfo">turn ' + (ix + 1) + " / " + turns.length + " \u00b7 " + hh + "</div></div>";
      host.innerHTML = '<div class="replaywrap"><div class="obmlabel">Span replay \u00b7 scrub the fleet\u2019s turns \u00b7 ' + (src ? "local event log" : "from exported spans") + "</div>" + scrub + frame + "</div>";
      var range = host.querySelector(".rpscrub");
      if (range) range.oninput = function(){ state.obReplayIx = Number(range.value); renderReplay(p, host); };
      var wf = host.querySelector(".rpwf");
      if (wf) wf.onclick = function(){ openWaterfall(p, wf.getAttribute("data-trace")); };
    }

    // WATERFALL: one trace's spans as time-positioned bars + a deep link.
    function openWaterfall(p, traceId){
      if (!traceId || document.querySelector(".scrim")) return;
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal wfmodal"><div class="modalhead">Trace waterfall <span class="obsub">' + esc(traceId.slice(0, 16)) +
        '\u2026</span><button class="iconbtn" id="wfx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="modalbody"><div class="loader"><i></i><i></i><i></i><i></i></div></div></div>';
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
      function onKey(e){ if (e.key === "Escape") close(); }
      document.addEventListener("keydown", onKey);
      scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
      document.getElementById("wfx").onclick = close;
      function wfpill(l, v){ return '<span class="wfp"><span class="wfpl">' + l + "</span>" + v + "</span>"; }
      api("/api/projects/" + p.id + "/insights/trace/" + encodeURIComponent(traceId)).then(function(r){
        var spans = r.spans || [], body = scrim.querySelector(".modalbody");
        if (!spans.length){ body.innerHTML = '<div class="wfempty">No spans in this trace yet \u2014 they land within about a second of the turn finishing.</div>' + traceDeepLink(traceId); return; }
        var t0 = Math.min.apply(null, spans.map(function(s){ return s.ts; }));
        var t1 = Math.max.apply(null, spans.map(function(s){ return s.ts + (s.ms || 0); }));
        var dur = Math.max(1, t1 - t0);
        var turn = spans.filter(function(s){ return s.name === "gen_ai.agent.turn"; })[0] || spans[0];
        var err = spans.some(function(s){ return s.code === 2; });
        var summary = '<div class="wfsum"><div class="wfsumhd"><span class="wfagent">' + esc(turn.agent || "agent") + "</span>" +
          (turn.model ? '<span class="wfmodel">' + esc(turn.ade ? turn.ade + " \u00b7 " : "") + esc(turn.model) + "</span>" : "") +
          '<span class="wfstatus ' + (err ? "err" : "ok") + '">' + (err ? "ERROR" : "OK") + "</span></div>" +
          '<div class="wfsumstats">' + wfpill("duration ", fmtMs(dur)) + (turn.tin ? wfpill("in ", tokfmt(turn.tin)) : "") + (turn.tout ? wfpill("out ", tokfmt(turn.tout)) : "") + (turn.cost ? wfpill("cost ", money(turn.cost)) : "") + wfpill("spans ", spans.length) + "</div></div>";
        var rows = spans.map(function(s){
          var left = ((s.ts - t0) / dur) * 100, w = Math.max(2, ((s.ms || 0) / dur) * 100);
          var short = String(s.name).replace(/^gen_ai\./, "").replace(/^loom\./, "");
          return '<div class="wfrow"><span class="wfname' + (s.code === 2 ? " err" : "") + '" title="' + esc(s.name) + '">' + esc(short) + "</span>" +
            '<span class="wftrack"><span class="wfbar' + (s.code === 2 ? " err" : "") + '" style="left:' + left.toFixed(1) + "%;width:" + w.toFixed(1) + '%"></span></span>' +
            '<span class="wfms">' + (s.ms || 0) + "ms</span></div>";
        }).join("");
        body.innerHTML = summary +
          '<div class="wflabel">Spans \u00b7 each bar is one span, placed by when it started</div>' +
          '<div class="wfrows">' + rows + "</div>" +
          '<div class="wfaxis"><span>0ms</span><span>' + fmtMs(dur) + "</span></div>" + traceDeepLink(traceId);
      }).catch(function(){ var body = scrim.querySelector(".modalbody"); if (body) body.innerHTML = '<div class="wfempty">Trace unavailable \u2014 the telemetry store is unreachable.</div>' + traceDeepLink(traceId); });
    }

    function traceDeepLink(traceId){
      var u = backendTraceUrl(traceId);
      return u ? '<a class="obtrace wide" href="' + u + '" target="_blank" rel="noreferrer">View full trace \u2197</a>' : "";
    }

    // ---- KAIRO-style dense metrics panels (above the fleet table) ----------
    function fmtMs(ms){ ms = Number(ms) || 0; if (ms < 1000) return ms + "ms"; if (ms < 60000) return (ms / 1000).toFixed(1) + "s"; return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s"; }

    function kmSpark(values, cls){
      values = values || []; if (!values.length) return "";
      var max = Math.max.apply(null, values.concat([1])), w = 78, h = 22, n = values.length;
      var pts = values.map(function(v, i){ var x = (n <= 1 ? w / 2 : (i / (n - 1)) * w); var y = h - (v / max) * (h - 2) - 1; return x.toFixed(1) + "," + y.toFixed(1); }).join(" ");
      return '<svg width="' + w + '" height="' + h + '" class="kmspark ' + cls + '"><polyline points="' + pts + '" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    }

    function renderKairoMetrics(k){
      if (!k || k.agentsSpawned == null) return "";
      function c(label, val, sub, extra){ return '<div class="kmcard"><div class="kmlabel">' + label + '</div><div class="kmvalue">' + val + '</div><div class="kmsub">' + sub + "</div>" + (extra || "") + "</div>"; }
      var totalTok = (k.totalTokensIn || 0) + (k.totalTokensOut || 0);
      var grid = '<div class="kmgrid">' +
        c("Agents spawned", k.agentsSpawned || 0, (k.turnsCompleted || 0) + " turns", '<div class="kmsparkwrap tok">' + kmSpark(k.tokenSparkline, "tok") + "</div>") +
        // filesCreated now genuinely means "new files"; the old number (distinct
        // paths seen in a diff) is filesTouched, which is what the label meant.
        c("Files touched", k.filesTouched != null ? k.filesTouched : (k.filesCreated || 0),
          (k.filesCreated || 0) + " new \u00b7 " + (k.filesModified || 0) + " changed",
          '<div class="kmsparkwrap cost">' + kmSpark(k.costSparkline, "cost") + "</div>") +
        c("Avg turn time", fmtMs(k.avgReasoningTimeMs), "reasoning time") +
        c("Token usage", tokfmt(totalTok), tokfmt(k.totalTokensIn) + "\u2191 " + tokfmt(k.totalTokensOut) + "\u2193", '<div class="kmsparkwrap blue">' + kmSpark(k.tokenSparkline, "blue") + "</div>") +
        c("Est. cost", '<span class="kmcost">' + money(k.totalCostUsd || 0) + "</span>", "from CLI usage") +
        c("Critical path", '<span class="kmsm">' + (k.criticalPath && k.criticalPath.length ? esc(k.criticalPath.join(" \u2192 ")) : "\u2014") + "</span>", (k.decisionsRecorded || 0) + " decisions") +
        // A fleet whose decisions were pattern-matched has no average confidence
        // to report. "0%" would read as "the agents were completely unsure",
        // which is a different and false claim from "nothing measured this".
        c("Avg confidence",
          k.avgConfidence != null ? k.avgConfidence + "%" : '<span class="kmsm">not measured</span>',
          k.avgConfidence != null && k.confidenceSamples != null
            ? "across " + k.confidenceSamples + " of " + (k.decisionsRecorded || 0) + " decisions"
            : (k.decisionsRecorded || 0) + " decisions",
          k.avgConfidence != null ? '<div class="kmbar"><div class="kmbarfill" style="width:' + k.avgConfidence + '%"></div></div>' : "") +
        c("Retries", k.retriesTotal || 0, "errors + route fails") + "</div>";
      var tba = k.tokensByAgent || {}, names = Object.keys(tba).sort(function(a, b){ return tba[b] - tba[a]; });
      var bars = names.map(function(a){
        var pct = totalTok ? Math.round((tba[a] / totalTok) * 100) : 0;
        return '<div class="kmarow"><span class="kmaname">' + esc(a) + '</span><span class="kmabarwrap"><span class="kmabar" style="width:' + pct + '%"></span></span><span class="kmatok">' + tokfmt(tba[a]) + "</span></div>";
      }).join("");
      return grid + (names.length ? '<div class="kmagents"><div class="kmlabel">Tokens by agent</div>' + bars + "</div>" : "");
    }

    // ---- Decision Explorer (KAIRO Decisions tab) ---------------------------
    function decCatColor(cat){ return ({ architecture: "var(--primary)", design: "var(--thread)", implementation: "var(--accentBlue)", fix: "var(--err)", refactor: "var(--warn)", test: "var(--ok)" })[cat] || "var(--muted-foreground)"; }

    /**
     * How this decision was pulled out of the turn, said plainly. A number a
     * model actually produced and a number a regex stamped are not the same
     * claim, and the UI used to render both as an identical measured "%".
     */
    function decSourceBadge(d){
      // No guessing. A decision that does not say how it was extracted gets
      // "source unknown" — inferring "a model rated this" from the mere presence
      // of a number is how a hardcoded constant came to be displayed as a
      // measurement in the first place.
      var s = d.source || "unknown";
      var L = { llm: ["model-read", "an LLM read the turn and rated its own confidence"],
                cli: ["model-read", "a local model read the turn and rated its own confidence"],
                heuristic: ["pattern-matched", "found by text patterns \u2014 no confidence is claimed"],
                unknown: ["source unknown", "this decision predates extraction-source tracking"] };
      var e = L[s] || L.unknown;
      return '<span class="decsrc ' + esc(s) + '" title="' + esc(e[1]) + '">' + esc(e[0]) + "</span>";
    }

    function renderDecisionCard(d){
      var conf = d.confidence != null ? '<span class="decconf">' + d.confidence + "%</span>" : "";
      return '<div class="deccard" data-id="' + esc(d.id) + '" data-agent="' + esc(d.agentId) + '">' +
        '<div class="decchd"><span class="deccat" style="color:' + decCatColor(d.category) + '">' + esc((d.category || "").toUpperCase()) + "</span>" + conf + "</div>" +
        '<div class="decctitle">' + esc(d.title) + "</div>" +
        (d.reasoning ? '<div class="deccwhy">' + esc(trunc(d.reasoning, 96)) + "</div>" : "") +
        '<div class="deccmeta"><span class="deccagent">' + esc(d.agentId) + "</span>" +
          (d.agentRole ? '<span class="deccrole">' + esc(d.agentRole) + "</span>" : "") +
          ((d.alternatives || []).length ? '<span class="deccalt">' + d.alternatives.length + " alt</span>" : "") +
        "</div></div>";
    }

    function renderDecisionDetail(d){
      var alts = (d.alternatives || []).length ? '<div class="decsl">ALTERNATIVES</div>' + d.alternatives.map(function(a){ return '<div class="decalt">\u25cb ' + esc(a) + "</div>"; }).join("") : "";
      var files = (d.filesCreated || []).concat(d.filesModified || []);
      var filesH = files.length ? '<div class="decsl">FILES</div>' + files.map(function(f){ return '<div class="decfile">\u25a1 ' + esc(f) + "</div>"; }).join("") : "";
      var arts = (d.artifactNames || []).length ? '<div class="decsl">ARTIFACTS</div>' + d.artifactNames.map(function(a){ return '<div class="decart">\u25c6 ' + esc(a) + "</div>"; }).join("") : "";
      // Confidence is only drawn when something actually measured it. The turn's
      // totals are labelled as the TURN's, because that is what they are — every
      // decision mined from one turn used to display that turn's full cost as if
      // it were its own.
      var conf = d.confidence != null
        ? '<div class="decsl">CONFIDENCE</div><div class="decconfbar"><div class="decconffill" style="width:' + d.confidence + '%"></div></div>' +
          '<div class="decsub2">' + d.confidence + "% \u00b7 " + decSourceBadge(d) + "</div>"
        : '<div class="decsl">CONFIDENCE</div><div class="decsub2">not measured \u00b7 ' + decSourceBadge(d) + "</div>";
      var tTok = d.turnTokensUsed != null ? d.turnTokensUsed : d.tokensUsed;
      var tUsd = d.turnCostUsd != null ? d.turnCostUsd : d.costUsd;
      var turnLine = (tTok || tUsd)
        ? '<div class="decsl">THE TURN IT CAME FROM</div><div class="decsub2">used ' + tokfmt(tTok || 0) + " tokens \u00b7 " + money(tUsd || 0) +
          ' <span class="decfoot">whole-turn totals, not this decision alone</span></div>'
        : "";
      return '<div class="decsl">DECISION</div><div class="decdt">' + esc(d.title) + "</div>" +
        '<div class="decsl">REASON</div><div class="decdtext">' + esc(d.reasoning || "\u2014") + "</div>" + alts +
        conf + turnLine + filesH + arts;
    }

    function selectDecision(id){
      var d = (state.obDecisions || {})[id]; if (!d) return;
      Array.prototype.forEach.call(document.querySelectorAll(".deccard"), function(c){ c.classList.toggle("sel", c.getAttribute("data-id") === id); });
      var el = document.getElementById("decdetail"); if (el) el.innerHTML = renderDecisionDetail(d);
    }

    function observatoryDecisions(p){
      var host = document.getElementById("obdecisions"); if (!host) return;
      api("/api/projects/" + p.id + "/decisions").then(function(r){
        var decisions = r.decisions || [], stats = r.stats || {};
        state.obDecisions = {}; decisions.forEach(function(d){ state.obDecisions[d.id] = d; });
        if (!decisions.length){ host.innerHTML = '<div class="obnote">No decisions captured yet. Run a turn \u2014 with <code>ANTHROPIC_API_KEY</code> set for rich extraction \u2014 and each agent\u2019s choices appear here.</div>'; return; }
        var agents = []; decisions.forEach(function(d){ if (agents.indexOf(d.agentId) < 0) agents.push(d.agentId); });
        var chips = '<button class="decchip on" data-filter="all">All</button>' + agents.map(function(a){ return '<button class="decchip" data-filter="' + esc(a) + '">' + esc(a) + "</button>"; }).join("");
        // Only average what was actually measured; a fleet of pattern-matched
        // decisions has no average confidence to report.
        var rated = decisions.filter(function(d){ return d.confidence != null; });
        var avg = rated.length ? Math.round(rated.reduce(function(s, d){ return s + d.confidence; }, 0) / rated.length) : null;
        host.innerHTML = '<div class="decheader"><span class="declabel">DECISIONS</span><span class="deccount">' + (stats.total || decisions.length) + " recorded" +
          (avg != null ? " \u00b7 avg " + avg + "% over " + rated.length + " rated" : "") + "</span></div>" +
          '<div class="decfilters">' + chips + "</div>" +
          '<div class="declayout"><div class="declist" id="declist">' + decisions.map(renderDecisionCard).join("") + '</div><div class="decdetail" id="decdetail"><div class="obsub" style="padding:20px;text-align:center">Select a decision to see its reasoning, alternatives, and files.</div></div></div>';
        Array.prototype.forEach.call(host.querySelectorAll(".decchip"), function(chip){
          chip.onclick = function(){
            Array.prototype.forEach.call(host.querySelectorAll(".decchip"), function(c){ c.classList.remove("on"); }); chip.classList.add("on");
            var f = chip.getAttribute("data-filter");
            Array.prototype.forEach.call(host.querySelectorAll(".deccard"), function(card){ card.style.display = (f === "all" || card.getAttribute("data-agent") === f) ? "" : "none"; });
          };
        });
        Array.prototype.forEach.call(host.querySelectorAll(".deccard"), function(card){ card.onclick = function(){ selectDecision(card.getAttribute("data-id")); }; });
        var pending = state.obPendingDecision; state.obPendingDecision = null;
        if (pending && state.obDecisions[pending]) selectDecision(pending);
        else if (decisions[0]) selectDecision(decisions[0].id);
      }).catch(function(){ host.innerHTML = '<div class="obnote">Decisions unavailable \u2014 the daemon didn\u2019t answer. Switch tabs and back to retry.</div>'; });
    }

    /**
     * Self-heal — what your monitoring said, and what Loom did about it.
     *
     * Deliberately built from Loom's OWN record rather than the backend's API: the
     * webhook already tells us every fire and resolve, so this needs no
     * credentials, no polling of another service, and it keeps working when
     * the backend is down — which is exactly the moment you want to know which
     * agents are still paused. It can tell you an alert fired; only this
     * can tell you the fleet reacted.
     */
    function observatoryAlerts(p, events){
      var host = document.getElementById("obalerts"); if (!host) return;
      // Fetched fresh, not read off the project object we were handed: a pause
      // arrives over a webhook, so the cached copy is precisely the
      // thing that will be stale on the view whose whole job is "right now".
      api("/api/projects/" + p.id).then(function(r){
        var proj = (r && r.project) || r || {};
        p.quarantine = proj.quarantine || {};
        host.innerHTML = alertsHtml(p.quarantine, events);
        wireAlertLifts(host, p, events);
      }).catch(function(){
        host.innerHTML = '<div class="obnote">Self-heal state unavailable \u2014 the daemon didn\u2019t answer. Switch tabs and back to retry.</div>';
      });
    }

    function alertsHtml(q, events){
      var paused = Object.keys(q || {});
      q = q || {};

      // Pair each intervention with the recovery that ended it, so the history
      // reads as episodes with a duration rather than a stream of half-events.
      var heal = (events || []).filter(function(e){
        return e.kind === "status" && /^alert_/.test(String((e.payload || {}).state || ""));
      }).sort(function(a, b){ return a.ts - b.ts; });
      // An intervention with no matching recovery is only "still paused" if the
      // live quarantine map agrees. Otherwise the episode ended and we simply
      // never saw the recovery event — an old run, a log window that rolled.
      // Saying "still paused" about an agent that is taking work would be the
      // screen contradicting itself two sections apart.
      var open = {}, episodes = [];
      heal.forEach(function(e){
        var pay = e.payload || {}, agent = e.agentId || "?";
        if (pay.state === "alert_intervention"){
          open[agent] = { agent: agent, alert: pay.alert || "alert", from: e.ts, fallback: pay.fallback || null, to: null, via: null, retried: false };
          episodes.push(open[agent]);
        } else if (pay.state === "alert_recovery"){
          var ep = open[agent];
          if (ep){ ep.to = e.ts; ep.via = pay.via || "resolved"; ep.retried = !!pay.retried; delete open[agent]; }
          else episodes.push({ agent: agent, alert: pay.alert || "alert", from: null, to: e.ts, via: pay.via || "resolved", retried: !!pay.retried, fallback: null });
        }
      });
      episodes.reverse();

      function dur(ms){
        if (ms == null) return "";
        var s = Math.round(ms / 1000);
        return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
      }

      var nowCard = paused.length
        ? '<div class="alsec">PAUSED RIGHT NOW</div>' + paused.map(function(a){
            var it = q[a];
            return '<div class="alrow paused"><span class="aldot firing"></span>' +
              '<div class="alinfo"><div class="alname">' + esc(a) + '</div>' +
              '<div class="alwhy">' + esc(it.reason) + " \u00b7 paused " + dur(Date.now() - it.since) + " ago" +
              (it.displaced ? " \u00b7 the baton was taken off it" : "") + "</div></div>" +
              '<button class="allift" data-lift="' + esc(a) + '">Lift</button></div>';
          }).join("")
        : '<div class="alsec">PAUSED RIGHT NOW</div><div class="alok">' + (ICONS.check || "\u2713") +
          " Nothing is paused. Every agent can take the baton.</div>";

      var hist = episodes.length
        ? episodes.slice(0, 25).map(function(ep){
            var live = ep.from && !ep.to && Object.prototype.hasOwnProperty.call(q, ep.agent);
            var lost = ep.from && !ep.to && !live;
            return '<div class="alrow"><span class="aldot ' + (live ? "firing" : "resolved") + '"></span>' +
              '<div class="alinfo"><div class="alname">' + esc(ep.agent) +
                '<span class="alalert">' + esc(ep.alert) + "</span></div>" +
                '<div class="alwhy">' +
                  (ep.from ? new Date(ep.from).toLocaleTimeString() : "\u2014") +
                  (ep.to ? " \u2192 " + new Date(ep.to).toLocaleTimeString() + " \u00b7 held " + dur(ep.to - ep.from)
                         : live ? " \u00b7 still paused" : " \u00b7 ended (no recovery recorded)") +
                  (ep.fallback ? " \u00b7 baton moved to " + esc(ep.fallback) : "") +
                  (ep.retried ? " \u00b7 baton handed back" : "") +
                  (ep.via && ep.via !== "resolved" ? " \u00b7 via " + esc(ep.via) : "") +
                "</div></div>" +
              '<span class="alstate ' + (live ? "firing" : lost ? "" : "ok") + '">' + (live ? "FIRING" : lost ? "ENDED" : "RECOVERED") + "</span></div>";
          }).join("")
        : '<div class="obnote">No alert has fired yet. Point your monitoring\u2019s webhook at <code>/api/webhooks/alerts</code> and every fire and recovery lands here.</div>';

      return '<div class="alwrap">' + nowCard +
        '<div class="alsec">HISTORY \u00b7 ' + episodes.length + " episode" + (episodes.length === 1 ? "" : "s") + "</div>" + hist +
        '<div class="alfoot">Alert rules live in your monitoring backend. ' +
        "A firing alert refuses that agent the baton; a resolved one gives it back.</div></div>";
    }


    /** Lift a pause by hand, then redraw from the map the API returns. */
    function wireAlertLifts(host, p, events){
      Array.prototype.forEach.call(host.querySelectorAll("[data-lift]"), function(b){
        b.onclick = function(){
          var agent = b.getAttribute("data-lift");
          b.disabled = true; b.textContent = "…";
          api("/api/projects/" + p.id + "/quarantine/" + encodeURIComponent(agent), { method: "DELETE" })
            .then(function(r){
              toast("lifted the pause on " + agent);
              p.quarantine = (r && r.quarantine) || {};
              host.innerHTML = alertsHtml(p.quarantine, events);
              wireAlertLifts(host, p, events);
            })
            .catch(function(err){ toast(err.message); b.disabled = false; b.textContent = "Lift"; });
        };
      });
    }


    /**
     * Metric explorer — the raw series behind the dashboard.
     *
     * The panels above answer fixed questions. This answers "what is Loom
     * actually recording, and what does each series look like right now",
     * which is the question you have when a panel disagrees with your
     * expectation. Every series is read back out of the telemetry store through
     * /insights/metrics; nothing here is computed locally.
     *
     * Deliberately a section of the dashboard rather than a ninth tab: it is
     * the same subject at a lower altitude, and the tab strip has already been
     * cut once for being a list of things to learn before you could look.
     */
    function observatoryMetricExplorer(p){
      var host = document.getElementById("obmex"); if (!host) return;
      var st = state.obMex = state.obMex || { sinceMs: 86400000 };
      var WINDOWS = [[3600000, "1h"], [21600000, "6h"], [86400000, "24h"], [604800000, "7d"]];
      api("/api/projects/" + p.id + "/insights/metrics?since=" + st.sinceMs).then(function(r){
        if (r.from === "unavailable"){
          host.innerHTML = '<div class="obmexhd"><span class="declabel">METRIC EXPLORER</span></div>' +
            '<div class="obnote">' + ICONS.route + " Metrics live in the telemetry store, and it isn’t answering. Bring your collector up and the series appear.</div>";
          return;
        }
        var series = (r.series || []).slice().sort(function(a, b){
          return String(a.metric).localeCompare(String(b.metric));
        });
        var chips = WINDOWS.map(function(w){
          return '<button class="decchip' + (st.sinceMs === w[0] ? " on" : "") + '" data-win="' + w[0] + '">' + w[1] + "</button>";
        }).join("");
        var rows = series.map(function(sr){
          var pts = sr.points || [];
          var key = sr.prefer === "avg" ? "avg" : "sum";
          var vals = pts.map(function(pt){ return Number(pt[key] != null ? pt[key] : pt.sum) || 0; });
          var last = vals.length ? vals[vals.length - 1] : null;
          var total = vals.reduce(function(a, v){ return a + v; }, 0);
          var labels = Object.keys(sr.labels || {}).filter(function(k){ return k !== "loom.project"; })
            .map(function(k){ return '<span class="mexlbl">' + esc(k.replace(/^gen_ai./, "")) + "=" + esc(String(sr.labels[k])) + "</span>"; }).join("");
          // A one-line sparkline over this series only — the shape is the point,
          // so it carries no axis and claims no absolute scale.
          var spark = "";
          if (vals.length > 1){
            var mx = Math.max.apply(null, vals) || 1;
            var pl = vals.map(function(v, i){
              return (i / (vals.length - 1) * 100).toFixed(1) + "," + (18 - (v / mx) * 16).toFixed(1);
            }).join(" ");
            spark = '<svg class="mexspark" viewBox="0 0 100 20" preserveAspectRatio="none"><polyline points="' + pl +
              '" fill="none" stroke="var(--ch2)" stroke-width="1.4"/></svg>';
          } else spark = '<span class="mexflat">single point</span>';
          var shown = sr.prefer === "avg" ? (last == null ? "—" : (Math.round(last * 100) / 100)) : Math.round(total * 100) / 100;
          return '<div class="mexrow"><div class="mexinfo"><div class="mexname">' + esc(sr.metric) +
            '<span class="mextype">' + esc(sr.type || "") + (sr.unit ? " · " + esc(sr.unit) : "") + "</span></div>" +
            '<div class="mexlbls">' + (labels || '<span class="mexlbl">no labels</span>') + "</div></div>" +
            spark +
            '<div class="mexval">' + shown + '<span class="mexagg">' + (sr.prefer === "avg" ? "latest" : "total") + "</span></div></div>";
        }).join("");
        host.innerHTML =
          '<div class="obmexhd"><span class="declabel">METRIC EXPLORER</span>' +
            '<span class="deccount">' + series.length + " series · from the telemetry store</span>" +
            '<span class="mexwins">' + chips + "</span></div>" +
          (rows ? '<div class="mexlist">' + rows + "</div>"
                : '<div class="obnote">No series in this window. Loom records turns, cost, tokens, handoffs, live agent count and turn duration — run a turn, or widen the window.</div>');
        Array.prototype.forEach.call(host.querySelectorAll("[data-win]"), function(b){
          b.onclick = function(){ st.sinceMs = Number(b.getAttribute("data-win")); observatoryMetricExplorer(p); };
        });
      }).catch(function(){
        host.innerHTML = '<div class="obnote">Metric explorer unavailable — the daemon didn’t answer. Switch tabs and back to retry.</div>';
      });
    }


    /**
     * The fleet's logs, read back out of the telemetry store.
     *
     * Loom emits all three OTel signals, but for a long time it could only read
     * traces — logs were write-only from the product's side, which is a strange
     * thing to ship in an observability tool. There is deliberately no local
     * fallback here: spans genuinely have one, logs do not, so when ClickHouse
     * is unreachable this says so instead of showing an empty list that reads
     * like "nothing happened".
     */
    function observatoryLogs(p){
      var host = document.getElementById("oblogs"); if (!host) return;
      var st = state.obLogs = state.obLogs || { severity: "", q: "" };
      var qs = "?limit=300" + (st.severity ? "&severity=" + encodeURIComponent(st.severity) : "") +
        (st.q ? "&q=" + encodeURIComponent(st.q) : "");
      api("/api/projects/" + p.id + "/insights/logs" + qs).then(function(r){
        if (r.from === "unavailable"){
          host.innerHTML = '<div class="obnote">' + ICONS.route + " Logs live in the telemetry store, and it isn\u2019t answering \u2014 so there is nothing to read. Unlike spans, logs have no local fallback. Bring your collector up and this fills in.</div>";
          return;
        }
        var logs = r.logs || [];
        var LEVELS = ["", "ERROR", "WARN", "INFO", "DEBUG"];
        var chips = LEVELS.map(function(L){
          return '<button class="decchip' + (st.severity === L ? " on" : "") + '" data-sev="' + esc(L) + '">' + (L || "All") + "</button>";
        }).join("");
        var rows = logs.map(function(l){
          var sev = String(l.severity || "INFO").toUpperCase();
          return '<div class="lgrow ' + esc(sev.toLowerCase()) + '">' +
            '<span class="lgtime">' + new Date(l.ts).toLocaleTimeString() + "</span>" +
            '<span class="lgsev ' + esc(sev.toLowerCase()) + '">' + esc(sev) + "</span>" +
            '<span class="lgagent">' + esc(l.agent || "\u2014") + "</span>" +
            '<span class="lgbody">' + esc(l.body || "") + "</span>" +
            (l.traceId ? '<a class="lgtrace" href="' + backendTraceUrl(l.traceId) + '" target="_blank" rel="noreferrer" title="open this trace">' + esc(l.traceId.slice(0, 8)) + "</a>" : '<span class="lgtrace none">\u2014</span>') +
            "</div>";
        }).join("");
        host.innerHTML =
          '<div class="decheader"><span class="declabel">LOGS</span><span class="deccount">' + logs.length + " lines \u00b7 from the telemetry store</span></div>" +
          '<div class="decfilters">' + chips +
            '<input class="mcpin lgq" id="lgq" placeholder="filter text\u2026" value="' + esc(st.q) + '"/></div>' +
          (rows ? '<div class="lglist">' + rows + "</div>"
                : '<div class="obnote">No log lines match. Loom ships every message, tool call, file edit and error \u2014 widen the filter.</div>');
        Array.prototype.forEach.call(host.querySelectorAll(".decchip"), function(c){
          c.onclick = function(){ st.severity = c.getAttribute("data-sev"); observatoryLogs(p); };
        });
        var qEl = host.querySelector("#lgq"), t = null;
        if (qEl) qEl.oninput = function(){
          if (t) clearTimeout(t);
          t = setTimeout(function(){ st.q = qEl.value.trim(); observatoryLogs(p); }, 320);
        };
      }).catch(function(){
        host.innerHTML = '<div class="obnote">Logs unavailable \u2014 the daemon didn\u2019t answer. Switch tabs and back to retry.</div>';
      });
    }


    // ---- Replay — the time machine -----------------------------------------
    // This absorbed the old separate "span replay" tab. Both scrubbed the same
    // run on their own slider, which is why nobody could say what the difference
    // was. One timeline now drives both readings: the reconstructed fleet state
    // at that moment (left) and the actual turn running then (right).
    function observatoryTravel(p){
      var host = document.getElementById("obtravel"); if (!host) return;
      state.obTravelProject = p; // the frame's waterfall button needs it later
      Promise.all([
        api("/api/projects/" + p.id + "/snapshots").catch(function(){ return {}; }),
        api("/api/projects/" + p.id + "/decisions").catch(function(){ return {}; }),
        api("/api/projects/" + p.id + "/insights/spans?limit=200").catch(function(){ return {}; })
      ]).then(function(res){
        var snaps = (res[0] && res[0].snapshots) || [], decs = (res[1] && res[1].decisions) || [];
        var spans = (res[2] && res[2].spans) || [];
        state.obReplaySrc = (res[2] && res[2].from) || "";
        if (!snaps.length){ host.innerHTML = '<div class="obnote">No replay data yet \u2014 run some agents to build a timeline.</div>'; return; }
        var byId = {}; decs.forEach(function(d){ byId[d.id] = d; });
        // Turns, oldest first, so a frame can find the one running at its instant.
        var turns = spans.filter(function(s){ return s.name === "gen_ai.agent.turn" && s.agent; })
          .slice().sort(function(a, b){ return (a.ts || 0) - (b.ts || 0); });
        state.obTravel = { snaps: snaps, byId: byId, turns: turns, i: 0, timer: null };
        var markers = snaps.map(function(s, i){
          var pct = (snaps.length <= 1 ? 0 : (i / (snaps.length - 1)) * 100);
          var col = s.triggerEvent.type === "error" ? "var(--err)" : s.triggerEvent.type === "decision" ? "var(--primary)" : "var(--border)";
          return '<div class="ttmarker" style="left:' + pct.toFixed(1) + "%;background:" + col + '" title="' + esc(s.triggerEvent.description) + '"></div>';
        }).join("");
        host.innerHTML =
          '<div class="ttheader"><div class="ttctrls"><button class="ttbtn" id="ttprev">\u25c0</button><button class="ttbtn ttplay" id="ttplay">\u25b6 Play</button><button class="ttbtn" id="ttnext">\u25b6</button></div><div class="ttframe">Frame <span id="ttnum">1</span> / ' + snaps.length + "</div></div>" +
          '<div class="tttimeline"><input type="range" class="ttscrub" id="ttscrub" aria-label="Scrub the run timeline" aria-valuetext="frame 1 of ' + snaps.length + '" min="0" max="' + (snaps.length - 1) + '" value="0"><div class="ttmarkers">' + markers + "</div></div>" +
          '<div class="ttbody"><div class="ttstate" id="ttstate"></div><div class="ttevent" id="ttevent"></div></div>';
        var scrub = host.querySelector("#ttscrub");
        function go(i){ state.obTravel.i = i; scrub.value = i; scrub.setAttribute("aria-valuetext", "frame " + (i + 1) + " of " + snaps.length); updateTravelFrame(); }
        scrub.oninput = function(){ go(Number(scrub.value)); };
        host.querySelector("#ttprev").onclick = function(){ if (state.obTravel.i > 0) go(state.obTravel.i - 1); };
        host.querySelector("#ttnext").onclick = function(){ if (state.obTravel.i < snaps.length - 1) go(state.obTravel.i + 1); };
        host.querySelector("#ttplay").onclick = function(){
          var t = state.obTravel, btn = this;
          if (t.timer){ clearInterval(t.timer); t.timer = null; btn.textContent = "\u25b6 Play"; }
          else { btn.textContent = "\u23f8 Pause"; t.timer = setInterval(function(){ if (t.i < snaps.length - 1) go(t.i + 1); else { clearInterval(t.timer); t.timer = null; btn.textContent = "\u25b6 Play"; } }, 800); }
        };
        updateTravelFrame();
      }).catch(function(){ host.innerHTML = '<div class="obnote">Time-travel unavailable \u2014 the daemon didn\u2019t answer. Switch tabs and back to retry.</div>'; });
    }

    function updateTravelFrame(){
      var t = state.obTravel; if (!t) return; var s = t.snaps[t.i]; if (!s) return;
      var numEl = document.getElementById("ttnum"); if (numEl) numEl.textContent = String(t.i + 1);
      var decsAt = (s.decisionsAtPoint || []).map(function(id){ return t.byId[id]; }).filter(Boolean);
      var stEl = document.getElementById("ttstate");
      if (stEl){
        var agentRows = Object.keys(s.agentStates || {}).map(function(a){
          var st = s.agentStates[a];
          return '<div class="ttarow"><span class="ttdot tt-' + st.status + '"></span><span class="ttaname">' + esc(a) + '</span><span class="ttaturns">' + st.turnsCompleted + ' turns</span><span class="ttacost">' + money(st.costUsd) + "</span></div>";
        }).join("");
        var decItems = decsAt.slice(-3).map(function(d){ return '<div class="ttdi"><span class="ttdcat">' + esc(d.category) + '</span><span class="ttdt">' + esc(d.title) + "</span></div>"; }).join("");
        var facts = (s.memorySnapshot.keyFacts || []).map(function(f){ return '<div class="ttfact">\u00b7 ' + esc(f) + "</div>"; }).join("");
        var lm = s.lastMessage;
        stEl.innerHTML =
          '<div class="ttsec"><div class="ttsl">BATON AT THIS MOMENT</div><div class="ttbaton">' + esc(s.batonHolder) + '</div><div class="tttime">' + new Date(s.timestampMs).toLocaleTimeString() + "</div></div>" +
          '<div class="ttsec"><div class="ttsl">FLEET STATE</div>' + (agentRows || '<div class="obsub">no agents yet</div>') + "</div>" +
          '<div class="ttsec"><div class="ttsl">DECISIONS SO FAR</div><div class="ttdc">' + decsAt.length + " recorded</div>" + decItems + "</div>" +
          '<div class="ttsec"><div class="ttsl">MEMORY AT THIS POINT</div><div class="ttdc">' + s.memorySnapshot.decisionsCount + " items</div>" + facts + "</div>" +
          '<div class="ttsec"><div class="ttsl">THREAD</div><div class="ttdc">' + s.threadLength + " messages</div>" + (lm ? '<div class="ttlm"><span class="ttlma">' + esc(lm.agentId) + ":</span> " + esc((lm.text || "").slice(0, 120)) + "</div>" : "") + "</div>";
      }
      var evEl = document.getElementById("ttevent");
      if (evEl){
        var col = s.triggerEvent.type === "error" ? "var(--err)" : s.triggerEvent.type === "decision" ? "var(--primary)" : "var(--thread)";
        var pct = t.snaps.length > 1 ? Math.round((t.i / (t.snaps.length - 1)) * 100) : 100;
        evEl.innerHTML = '<div class="ttevcard" style="border-color:' + col + '"><div class="ttevtype" style="--ttev:' + col + '">' + esc(String(s.triggerEvent.type).toUpperCase().replace(/_/g, " ")) + '</div><div class="ttevdesc">' + esc(s.triggerEvent.description) + '</div><div class="ttevmeta">Agent: ' + esc(s.triggerEvent.agentId) + " \u00b7 " + new Date(s.timestampMs).toLocaleTimeString() + "</div></div>" +
          ttTurnCard(t, s) +
          '<div class="ttprog"><div class="ttsl">RUN PROGRESS</div><div class="ttprogbar"><div class="ttprogfill" style="transform:scaleX(' + (pct / 100) + ')"></div></div><div class="ttdc">' + pct + "% complete</div></div>";
        var wf = evEl.querySelector(".rpwf");
        if (wf) wf.onclick = function(){ openWaterfall(state.obTravelProject, wf.getAttribute("data-trace")); };
      }
    }

    /**
     * The turn that was running at this frame's instant — the old span-replay
     * tab, folded in. "Running at" means the last turn to have started at or
     * before this moment, which is the one whose work produced the state on the
     * left. When the store is unreachable the local event log has no trace id, so
     * the waterfall link is replaced by an honest note rather than a dead button.
     */
    function ttTurnCard(t, s){
      var turns = (t && t.turns) || [];
      if (!turns.length) return "";
      var at = s.timestampMs, cur = null;
      for (var i = 0; i < turns.length; i++){ if ((turns[i].ts || 0) <= at) cur = turns[i]; else break; }
      if (!cur) return '<div class="ttsec"><div class="ttsl">TURN AT THIS MOMENT</div><div class="obsub">nothing had run yet</div></div>';
      function pill(l, v){ return '<span class="rppill"><span class="rppl">' + l + "</span>" + v + "</span>"; }
      var err = cur.code === 2;
      return '<div class="ttturn' + (err ? " err" : "") + '">' +
        '<div class="ttsl">TURN AT THIS MOMENT</div>' +
        '<div class="ttthead"><span class="rpagent">' + esc(cur.agent) + "</span>" +
          (cur.model ? '<span class="rpade">' + esc(cur.model) + "</span>" : "") +
          '<span class="rpstatus ' + (err ? "err" : "ok") + '">' + (err ? "ERROR" : "OK") + "</span></div>" +
        (cur.msg ? '<div class="rpmsg">' + esc(cur.msg) + "</div>" : "") +
        '<div class="rpmetrics">' + pill("took ", ((cur.ms || 0) / 1000).toFixed(1) + "s") +
          pill("in ", tokfmt(cur.tin || 0)) + pill("out ", tokfmt(cur.tout || 0)) + pill("cost ", money(cur.cost || 0)) + "</div>" +
        (cur.traceId
          ? '<div class="rpactions"><button class="rpwf" data-trace="' + esc(cur.traceId) + '">Trace waterfall</button>' +
            '<a class="obtrace" href="' + backendTraceUrl(cur.traceId) + '" target="_blank" rel="noreferrer">Open trace \u2197</a></div>'
          : '<div class="rpnote">' + ICONS.route + " Trace waterfall lights up once the telemetry store is reachable \u2014 this turn came from the local event log.</div>") +
        "</div>";
    }

    // GRAPH: the baton/handoff DAG — agents in columns by handoff depth, edges
    // are the passes of the baton. Draggable, like the canvas.
    function observatoryGraph(agents, holder, events, byAgent){
      var ids = agents.map(function(a){ return a.id; }), idset = {};
      ids.forEach(function(i){ idset[i] = 1; });
      var byId = {}; agents.forEach(function(a){ byId[a.id] = a; });
      var em = {};
      (events || []).forEach(function(e){
        if (e.kind !== "handoff" || !e.payload) return;
        var f = e.payload.from, t = e.payload.to;
        if (f && t && idset[f] && idset[t] && f !== t) em[f + "\u0001" + t] = (em[f + "\u0001" + t] || 0) + 1;
      });
      var edges = Object.keys(em).map(function(k){ var pr = k.split("\u0001"); return { from: pr[0], to: pr[1], n: em[k] }; });
      var incoming = {}; ids.forEach(function(i){ incoming[i] = []; });
      edges.forEach(function(e){ incoming[e.to].push(e.from); });
      var layer = {};
      function layerOf(id, seen){
        if (layer[id] != null) return layer[id];
        if (seen[id]) return 0;
        var s2 = {}; for (var k in seen) s2[k] = 1; s2[id] = 1;
        var inc = incoming[id] || []; if (!inc.length) return (layer[id] = 0);
        var mx = 0; inc.forEach(function(src){ mx = Math.max(mx, layerOf(src, s2) + 1); });
        return (layer[id] = mx);
      }
      ids.forEach(function(i){ layerOf(i, {}); });
      var byLayer = {}, maxLayer = 0;
      ids.forEach(function(i){ var l = layer[i] || 0; (byLayer[l] = byLayer[l] || []).push(i); maxLayer = Math.max(maxLayer, l); });
      var COL = 202, ROW = 74, NW = 158, NH = 46, PADX = 28, PADY = 34, maxRows = 1, pos = {};
      Object.keys(byLayer).forEach(function(l){ maxRows = Math.max(maxRows, byLayer[l].length);
        byLayer[l].forEach(function(id, r){ pos[id] = { x: PADX + Number(l) * COL, y: PADY + r * ROW }; }); });
      ids.forEach(function(id){ if (view.obNodePos["g:" + id]) pos[id] = view.obNodePos["g:" + id]; });
      var W = PADX * 2 + maxLayer * COL + NW, H = Math.max(220, PADY * 2 + (maxRows - 1) * ROW + NH);
      // The last handoff that actually happened, so "where the baton just came
      // from" is visible instead of inferred.
      var lastHop = null;
      for (var li = (events || []).length - 1; li >= 0; li--){
        var le = events[li];
        if (le.kind === "handoff" && le.payload && le.payload.from && le.payload.to){ lastHop = le.payload.from + "\u0001" + le.payload.to; break; }
      }
      var maxN = edges.reduce(function(m, e){ return Math.max(m, e.n); }, 1);
      var edgeSvg = edges.map(function(e){
        var a = pos[e.from], b = pos[e.to]; if (!a || !b) return "";
        var x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, mid = (x1 + x2) / 2;
        var recent = lastHop === (e.from + "\u0001" + e.to);
        // Thickness carries how heavily this route was used — a path walked 12
        // times and one walked once are not the same fact.
        var w = 1.2 + (e.n / maxN) * 2.4;
        var lx = (x1 + x2) / 2, ly = (y1 + y2) / 2 - 7;
        return '<path class="' + (recent ? "obhop recent" : "obhop") + '" d="M ' + x1 + " " + y1 + " C " + mid + " " + y1 + ", " + mid + " " + y2 + ", " + x2 + " " + y2 +
          '" fill="none" stroke="var(--shuttle)" stroke-width="' + w.toFixed(1) + '" opacity="' + (recent ? "0.95" : "0.5") + '" marker-end="url(#obarrow)"><title>' +
          esc(e.from + " \u2192 " + e.to + ": " + e.n + (e.n === 1 ? " handoff" : " handoffs")) + "</title></path>" +
          '<text x="' + lx.toFixed(0) + '" y="' + ly.toFixed(0) + '" text-anchor="middle" font-size="9" font-weight="700" fill="var(--shuttle-ink)">\u00d7' + e.n + "</text>";
      }).join("");
      var nodeSvg = ids.map(function(id){
        var a = byId[id] || { id: id }, c = byAgent[id] || {}, baton = id === holder, busy = a.busy, pp = pos[id];
        var stroke = baton ? "var(--shuttle)" : busy ? "var(--thread)" : "var(--border)";
        var dot = busy ? "var(--thread)" : baton ? "var(--shuttle)" : "var(--muted-foreground)";
        return '<g class="obnode' + (busy ? " busy" : "") + '" data-agent="g:' + esc(id) + '" transform="translate(' + pp.x + " " + pp.y + ')">' +
          '<rect x="0" y="0" width="' + NW + '" height="' + NH + '" rx="10" fill="var(--card)" stroke="' + stroke + '" stroke-width="' + (busy || baton ? 2 : 1) + '"/>' +
          '<circle cx="15" cy="' + (NH / 2) + '" r="4" fill="' + dot + '"' + (busy ? ' class="obdotpulse"' : "") + "/>" +
          '<text x="28" y="' + (NH / 2 - 2) + '" fill="var(--card-foreground)" font-size="12" font-weight="600">' + esc(trunc(id, 15)) + "</text>" +
          '<text x="28" y="' + (NH / 2 + 12) + '" fill="var(--muted-foreground)" font-size="10">' + esc(a.kind || "agent") + (c.turns ? " \u00b7 " + c.turns + "t" : "") + "</text>" +
          (baton ? '<text x="' + (NW - 8) + '" y="12" text-anchor="end" fill="var(--shuttle-ink)" font-size="8.5" font-weight="700" letter-spacing="0.06em">BATON</text>' : "") +
          "</g>";
      }).join("");
      var note = edges.length ? "" : '<div class="obnote">No baton handoffs yet \u2014 the flow graph draws itself as the baton moves between agents.</div>';
      var totalHops = edges.reduce(function(s, e){ return s + e.n; }, 0);
      var legend = edges.length ? '<div class="oblegend">' +
        '<span class="oblg"><span class="oblgline" style="background:var(--shuttle)"></span>a handoff \u2014 thicker means walked more often</span>' +
        '<span class="oblg"><span class="oblgx">\u00d7n</span>times the baton took that route</span>' +
        '<span class="oblg"><span class="oblgline recent" style="background:var(--shuttle)"></span>most recent handoff</span>' +
        '<span class="oblglive">' + totalHops + (totalHops === 1 ? " handoff" : " handoffs") + " total</span></div>" : "";
      return note + '<div class="obcanvaswrap"><svg viewBox="0 0 ' + W + " " + H + '" class="obsvg" preserveAspectRatio="xMidYMid meet">' +
        '<defs><marker id="obarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--shuttle)"/></marker></defs>' +
        edgeSvg + nodeSvg + "</svg></div>" + legend;
    }

    // TIMELINE: the chronological trace — turns, handoffs, routes, memory folds.
    function observatoryTimeline(events){
      var KINDS = { run_complete: ["ok", 1], handoff: ["baton", 1], route_started: ["info", 1], route_step: ["info", 1],
        route_completed: ["ok", 1], route_failed: ["err", 1], memory_add: ["mem", 1], memory_update: ["mem", 1],
        memory_forget: ["mem", 1], needs_input: ["warn", 1], error: ["err", 1], decision: ["info", 1] };
      var isHeal = function(e){ return e.kind === "status" && (e.payload || {}).state === "alert_intervention"; };
      var isRecover = function(e){ return e.kind === "status" && (e.payload || {}).state === "alert_recovery"; };
      // A refused turn and a re-admitted agent are things you must be able to
      // see; so is the moment an agent was actually handed its MCP servers,
      // which is the only visible proof that half of this feature is real.
      var isBudget = function(e){ return e.kind === "status" && /^budget_/.test((e.payload || {}).state || ""); };
      var isMcp = function(e){ return e.kind === "status" && (e.payload || {}).state === "mcp_attached"; };
      // The newer lifecycle facts, same rule as budgets: a reaped session, a
      // per-turn commit, a card's branch and a restore are things you must be
      // able to see happened.
      var isLifecycle = function(e){
        return e.kind === "status" && /^(session_reaped|turn_committed|task_branch|restored)$/.test((e.payload || {}).state || "");
      };
      var isDecision = function(e){ return e.kind === "status" && (e.payload || {}).state === "agent_decision"; };
      var evs = (events || []).filter(function(e){ return KINDS[e.kind] || isHeal(e) || isRecover(e) || isDecision(e) || isBudget(e) || isMcp(e) || isLifecycle(e); }).sort(function(a, b){ return a.ts - b.ts; });
      if (!evs.length) return '<div class="obnote">No fleet events yet. Run a turn and the trace fills in.</div>';
      var base = evs[0].ts;
      var rows = evs.map(function(e){
        var p = e.payload || {};
        var cls = isHeal(e) ? "heal" : isRecover(e) ? "ok" : isDecision(e) ? "decision"
          : isBudget(e) ? (p.state === "budget_exceeded" ? "warn" : "ok")
          : isMcp(e) ? "info" : isLifecycle(e) ? (p.state === "session_reaped" ? "warn" : "info") : KINDS[e.kind][0];
        var label, extra = "";
        if (isBudget(e)) label = p.state === "budget_exceeded"
          ? "\ud83d\udcb8 " + esc(e.agentId || "agent") + " paused \u2014 over its daily budget" +
            (p.budgetUsd != null ? " (" + money(p.spentTodayUsd || 0) + " of " + money(p.budgetUsd) + ")" : "")
          : "\u2713 " + esc(e.agentId || "agent") + " back under budget \u2014 pause lifted";
        else if (isMcp(e)) label = "\ud83d\udd0c " + esc(e.agentId || "agent") + " got MCP: " + esc(((p.servers || []).join(", ")) || "no servers");
        else if (isLifecycle(e)) label =
          p.state === "session_reaped" ? "\u267b " + esc(e.agentId || "agent") + " reaped and respawned"
          : p.state === "turn_committed" ? "\u2713 " + esc(e.agentId || "agent") + " committed its turn \u00b7 " + esc(String(p.subject || "")).slice(0, 48)
          : p.state === "task_branch" ? "\u2387 card branch " + esc(p.branch || "") + (p.created ? " created" : "")
          : "\u21ba snapshot restored \u00b7 " + (p.tasks != null ? p.tasks + " cards" : "");
        else if (isHeal(e)) label = "\u26a1 Alert \u00b7 " + esc(p.alert || "alert") + " \u2192 baton forced off " + esc(e.agentId || "agent") + (p.fallback ? " to " + esc(p.fallback) : "");
        else if (isRecover(e)) label = "\u2713 Recovery \u00b7 " + esc(p.alert || "alert") + " resolved \u2192 " + (p.retried ? "baton retried on " + esc(e.agentId || "agent") : "quarantine lifted on " + esc(e.agentId || "agent"));
        else if (isDecision(e)){ label = "\ud83d\udca1 " + esc(e.agentId || "agent") + " decided: <strong>" + esc(p.title || "decision") + "</strong>" +
          (p.confidence != null ? ' <span class="obtlconf">' + p.confidence + "%</span>" : ""); extra = ' data-decid="' + esc(p.decisionId || "") + '"'; }
        else if (e.kind === "run_complete") label = esc(e.agentId || "agent") + " finished a turn" + (p.durationMs ? " \u00b7 " + (Math.round(p.durationMs / 100) / 10) + "s" : "");
        else if (e.kind === "handoff") label = p.from ? "baton \u00b7 " + esc(p.from) + " \u2192 " + esc(p.to || "\u2014") : "baton \u00b7 " + esc(p.to || "agent") + " takes it first";
        else if (e.kind.indexOf("route_") === 0) label = "route " + e.kind.slice(6) + (p.error ? " \u00b7 " + esc(p.error) : "");
        else if (e.kind.indexOf("memory_") === 0) label = "brain \u00b7 " + e.kind.slice(7) + (p.kind ? " (" + esc(p.kind) + ")" : "");
        else if (e.kind === "needs_input") label = esc(e.agentId || "agent") + " needs input";
        else if (e.kind === "error") label = esc(p.message || "error");
        else label = "decision \u00b7 " + esc(trunc(p.text || "", 56));
        var secs = Math.max(0, Math.round((e.ts - base) / 1000));
        // Roll up so a run that spans hours or days stays readable — "2133m 37s"
        // means nothing to a person; "1d 11h" does.
        var t;
        if (secs < 60) t = secs + "s";
        else if (secs < 3600) t = Math.floor(secs / 60) + "m " + (secs % 60) + "s";
        else if (secs < 86400) t = Math.floor(secs / 3600) + "h " + Math.round((secs % 3600) / 60) + "m";
        else t = Math.floor(secs / 86400) + "d " + Math.round((secs % 86400) / 3600) + "h";
        return '<li class="obtl ' + cls + '"' + extra + '><span class="obtldot"></span><span class="obtllabel">' + label + '</span><span class="obtltime">' + t + "</span></li>";
      }).join("");
      return '<ol class="obtimeline">' + rows + "</ol>";
    }

    // A 0-100 health pill, coloured by grade. Clickable → penalty breakdown.
    function healthBadge(h, agent){
      if (!h || h.score == null) return '<span class="obhealth na" title="No health data yet">\u2014</span>';
      var g = h.grade || "healthy";
      return '<button class="obhealth ' + g + '" data-health="' + esc(agent) + '" title="Agent Health ' + h.score +
        '/100 (' + g + ') \u2014 click for the breakdown">' + h.score + "</button>";
    }

    // METRICS: the baton path + counts + per-agent fleet breakdown + health.
    function observatoryMetricsDetail(p, events, byAgent, health){
      var agents = (p.agents || []), hb = (health && health.byAgent) || {};
      var handoffs = (events || []).filter(function(e){ return e.kind === "handoff"; }).length;
      var routes = (events || []).filter(function(e){ return e.kind === "route_completed" || e.kind === "route_failed"; }).length;
      var chain = [];
      (events || []).forEach(function(e){ if (e.kind === "handoff" && e.payload){ if (!chain.length && e.payload.from) chain.push(e.payload.from); if (e.payload.to) chain.push(e.payload.to); } });
      var CAP = 16, trimmed = chain.length > CAP, shownChain = trimmed ? chain.slice(chain.length - CAP) : chain;
      var chainHtml = chain.length
        ? (trimmed ? '<span class="obsub">+' + (chain.length - CAP) + ' earlier</span> <span class="obarrow">\u2192</span> ' : "") +
          shownChain.map(function(a, i){ return (i ? ' <span class="obarrow">\u2192</span> ' : "") + '<span class="obchip">' + esc(a) + "</span>"; }).join("")
        : '<span class="obsub">no handoffs yet</span>';
      var rows = agents.map(function(a){
        var c = byAgent[a.id] || {}, baton = a.id === p.holder, cls = a.busy ? "busy" : baton ? "baton" : "idle";
        return '<div class="obrow"><span class="obdot ' + cls + '"></span><span class="obname">' + esc(a.id) + "</span>" +
          '<span class="obkind">' + esc(a.kind || "") + (a.role ? " \u00b7 " + esc(a.role) : "") + "</span>" +
          healthBadge(hb[a.id], a.id) +
          '<span class="obspend">' + money(c.usd || 0) + '</span><span class="obturns">' + (c.turns || 0) + " turns</span>" +
          '<span class="obtok">' + tokfmt((c.tokensIn || 0) + (c.tokensOut || 0)) + " tok</span>" +
          '<button class="obtriage" data-triage="' + esc(a.id) + '" title="Why did I fail? Root-cause this agent from its own traces">\u26a0 Triage</button></div>';
      }).join("") || '<div class="obsub" style="padding:10px 2px">No agents.</div>';
      function mini(l, v){ return '<div class="obminicard"><div class="obcl">' + l + '</div><div class="obcv sm">' + v + "</div></div>"; }
      return '<div class="obmsec"><div class="obmlabel">Baton path</div><div class="obchain">' + chainHtml + "</div></div>" +
        '<div class="obmgrid">' + mini("Handoffs", handoffs) + mini("Routes", routes) + mini("Events", (events || []).length) + "</div>" +
        '<div class="obagents"><div class="obagentshead">Fleet</div>' + rows + "</div>";
    }

    function observatoryCanvas(agents, holder, byAgent){
      var n = agents.length, W = 680, H = Math.max(260, 80 + n * 62);
      var bx = 104, by = H / 2, ax = 460;
      var nodes = agents.map(function(a, i){
        var pos = view.obNodePos[a.id];
        var ay = n <= 1 ? H / 2 : 54 + i * ((H - 108) / Math.max(1, n - 1));
        return { a: a, x: pos ? pos.x : ax, y: pos ? pos.y : ay };
      });
      var edges = nodes.map(function(nd){
        var baton = nd.a.id === holder, busy = nd.a.busy;
        // Idle edges were --border at 0.35 opacity, which is invisible on the
        // card they sit on: six agents rendered with one visible edge, directly
        // under a caption promising that *every* agent hangs off the one shared
        // brain. The single claim this whole view exists to make was the one
        // thing you couldn't see. Muted-foreground at 0.5 reads as "connected,
        // not active" while still losing to the baton edge next to it.
        var col = baton ? "var(--shuttle)" : busy ? "var(--thread)" : "var(--muted-foreground)";
        var mid = (bx + nd.x) / 2;
        // A live edge flows: the dash marches from the brain toward the agent, so
        // "this one is reading and writing the shared memory right now" is
        // something you see rather than something you decode from a colour.
        return '<path class="' + (baton || busy ? "obedge live" : "obedge") + '" d="M ' + (bx + 30) + " " + by + " C " + mid + " " + by + ", " + mid + " " + nd.y + ", " + nd.x + " " + nd.y +
          '" fill="none" stroke="' + col + '" stroke-width="' + (baton ? 2.2 : busy ? 1.8 : 1.2) + '" ' +
          (busy || baton ? "" : 'stroke-dasharray="3 6" ') + 'opacity="' + (busy || baton ? "0.9" : "0.5") + '"/>';
      }).join("");
      var brain =
        '<g transform="translate(' + bx + " " + by + ')">' +
          '<circle r="30" fill="url(#obglow)" stroke="var(--primary)" stroke-width="1.5"/>' +
          '<circle class="obbrainpulse" r="30" fill="none" stroke="var(--primary)" stroke-width="1.5"/>' +
          '<g transform="translate(-9 -9)" stroke="var(--primary)" stroke-width="1.6" fill="none" stroke-linejoin="round">' +
            '<path d="m9 1 8 4.4L9 9.8 1 5.4 9 1Z"/><path d="m1 9 8 4.4 8-4.4"/></g>' +
          '<text x="0" y="48" text-anchor="middle" fill="var(--foreground)" font-size="10.5" font-weight="500">shared brain</text>' +
        "</g>";
      var an = nodes.map(function(nd){
        var a = nd.a, c = byAgent[a.id] || {}, baton = a.id === holder, busy = a.busy;
        var stroke = baton ? "var(--shuttle)" : busy ? "var(--thread)" : "var(--border)";
        var dot = busy ? "var(--thread)" : baton ? "var(--shuttle)" : "var(--muted-foreground)";
        // The live line is the point of this view: what is this agent doing this
        // second, and what has it cost so far. Anything already answered by the
        // Metrics dashboard stays there.
        var statusText = a.enabled === false ? "off" : busy ? "running now" : baton ? "holds the baton \u00b7 idle" : "idle";
        var statusCol = busy ? "var(--thread-ink)" : baton ? "var(--shuttle-ink)" : "var(--muted-foreground)";
        var work = (c.turns ? c.turns + (c.turns === 1 ? " turn" : " turns") : "no turns yet") + (c.usd ? " \u00b7 " + money(c.usd) : "");
        return '<g class="obnode' + (busy ? " busy" : "") + '" data-agent="' + esc(a.id) +
          '" transform="translate(' + nd.x + " " + nd.y + ')">' +
          '<rect x="0" y="-27" width="172" height="54" rx="12" fill="var(--card)" stroke="' + stroke + '" stroke-width="' + (busy || baton ? 2 : 1) + '"/>' +
          '<circle cx="18" cy="-8" r="4" fill="' + dot + '"' + (busy ? ' class="obdotpulse"' : "") + "/>" +
          '<text x="32" y="-4" fill="var(--card-foreground)" font-size="12.5" font-weight="600">' + esc(trunc(a.id, 15)) + "</text>" +
          '<text x="32" y="10" fill="' + statusCol + '" font-size="10" font-weight="600">' + statusText + "</text>" +
          '<text x="32" y="22" fill="var(--muted-foreground)" font-size="9.5">' + esc(work) + "</text>" +
          (baton ? '<text x="162" y="-13" text-anchor="end" fill="var(--shuttle-ink)" font-size="8.5" font-weight="700" letter-spacing="0.06em">BATON</text>' : "") +
          "</g>";
      }).join("");
      var running = agents.filter(function(a){ return a.busy; }).length;
      var legend = '<div class="oblegend">' +
        '<span class="oblg"><span class="oblgline live" style="background:var(--shuttle)"></span>holds the baton \u2014 only this one may edit code</span>' +
        '<span class="oblg"><span class="oblgline live" style="background:var(--thread)"></span>running a turn now</span>' +
        '<span class="oblg"><span class="oblgline dash"></span>idle \u2014 still shares the same memory</span>' +
        '<span class="oblglive">' + (running ? '<span class="oblgdot"></span>' + running + " running" : "fleet idle") + "</span></div>";
      return '<svg viewBox="0 0 ' + W + " " + H + '" class="obsvg" preserveAspectRatio="xMidYMid meet">' +
        '<defs><radialGradient id="obglow" cx="50%" cy="38%"><stop offset="0%" stop-color="color-mix(in srgb, var(--primary) 46%, var(--card))"/>' +
        '<stop offset="100%" stop-color="color-mix(in srgb, var(--primary) 12%, var(--card))"/></radialGradient></defs>' +
        edges + brain + an + "</svg>" + legend;
    }

    /** Drag agent nodes around the canvas; positions persist across live redraws. */
    function wireObservatoryDrag(el){
      var svg = el.querySelector(".obsvg"); if (!svg) return;
      svg.style.touchAction = "none"; // don't let touch scroll steal the drag
      var drag = null;
      // Map a client point into the SVG's own user space — getScreenCTM accounts
      // for the viewBox AND preserveAspectRatio letterboxing, so the node tracks
      // the cursor exactly instead of drifting.
      function pt(e){
        var m = svg.getScreenCTM(); if (!m) return { x: 0, y: 0 };
        var p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
        var q = p.matrixTransform(m.inverse());
        return { x: q.x, y: q.y };
      }
      function originOf(g){
        var t = (g.getAttribute("transform") || "").match(/translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/);
        return t ? { x: parseFloat(t[1]), y: parseFloat(t[2]) } : { x: 0, y: 0 };
      }
      Array.prototype.forEach.call(svg.querySelectorAll(".obnode"), function(g){
        g.style.cursor = "grab";
        g.addEventListener("pointerdown", function(e){
          e.preventDefault();
          var q = pt(e), o = originOf(g);
          // grab-offset: keep the point under the cursor fixed while dragging
          drag = { g: g, id: g.getAttribute("data-agent"), dx: q.x - o.x, dy: q.y - o.y };
          try { g.setPointerCapture(e.pointerId); } catch (err) {}
          g.style.cursor = "grabbing"; g.classList.add("dragging");
        });
        g.addEventListener("pointermove", function(e){
          if (!drag || drag.g !== g) return;
          var q = pt(e), x = q.x - drag.dx, y = q.y - drag.dy;
          view.obNodePos[drag.id] = { x: x, y: y };
          g.setAttribute("transform", "translate(" + x + " " + y + ")");
        });
        function end(e){
          if (!drag || drag.g !== g) return;
          try { g.releasePointerCapture(e.pointerId); } catch (err) {}
          g.style.cursor = "grab"; g.classList.remove("dragging");
          drag = null;
          drawObservatory(); // snap the edges to the node's new home
        }
        g.addEventListener("pointerup", end);
        g.addEventListener("pointercancel", end);
      });
    }
return { trunc, drawObservatory };
}
