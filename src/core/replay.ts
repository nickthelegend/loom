/**
 * Replay: a chat as one self-contained HTML page you can send anyone.
 *
 * What was asked, what the agents said, what they ran, what they changed, and
 * what Loom checked — Proof's verdicts, the loop watch, the shield, a night
 * shift's report — in one file with no scripts and nothing to load: every
 * value escaped, a Content-Security-Policy that forbids the rest, the diffs
 * and tool output folded away in <details>. Opens in any browser, offline.
 */

import type { LoomEvent } from "../types.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (ts: number) => new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const dur = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const money = (n: number) => (n < 0.00005 ? "$0" : `$${n >= 0.01 ? n.toFixed(2) : n.toFixed(4)}`);

/** Just enough Markdown for agent replies: fenced code, inline code, bold, headings, lists, http(s) links. Escaped first. */
export function miniMarkdown(text: string): string {
  const out: string[] = [];
  const parts = String(text ?? "").split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf("\n");
      const body = nl >= 0 && /^[\w+-]*$/.test(part.slice(0, nl).trim()) ? part.slice(nl + 1) : part;
      out.push(`<pre><code>${esc(body.replace(/\n$/, ""))}</code></pre>`);
      return;
    }
    let list = false;
    for (const raw of part.split("\n")) {
      const line = esc(raw)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
      const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      if (li) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${li[1]}</li>`); continue; }
      if (list) { out.push("</ul>"); list = false; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) out.push(`<h${h[1]!.length + 2}>${h[2]}</h${h[1]!.length + 2}>`);
      else if (line.trim()) out.push(`<p>${line}</p>`);
    }
    if (list) out.push("</ul>");
  });
  return out.join("\n");
}

function diffHtml(patch: string): string {
  return String(patch ?? "").split("\n").map((l) => {
    const cls = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff --git") ? "dh" : l.startsWith("@@") ? "dn" : l.startsWith("+") ? "da" : l.startsWith("-") ? "dd" : "";
    return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
  }).join("\n");
}

const PROOF_WORD: Record<string, string> = { verified: "Verified", contradicted: "Didn’t hold", unverified: "Unverified" };
const SHIFT_WORD: Record<string, string> = { verified: "Verified", done: "Done", didnt_hold: "Didn’t hold", failed: "Failed", needs_you: "Needs you", not_started: "Not started", running: "Running" };

function item(e: LoomEvent): string {
  const p = (e.payload ?? {}) as Record<string, any>;
  const who = esc(e.agentId ?? "loom");
  const at = `<time>${clock(e.ts)}</time>`;
  switch (e.kind) {
    case "message":
      if (p.reasoning) return "";
      if (!e.agentId) return p.author === "loom" ? `<div class="sys">${esc(p.text)}</div>` : `<section class="you"><header>You ${at}</header>${miniMarkdown(p.text)}</section>`;
      return `<section class="agent"><header>${who}${p.model ? ` <span class="m">${esc(p.model)}</span>` : ""} ${at}${p.partial ? ' <span class="m">stopped</span>' : ""}</header>${miniMarkdown(p.text)}</section>`;
    case "tool_call": {
      const failed = p.ok === false || (typeof p.exitCode === "number" && p.exitCode !== 0);
      const title = esc(String(p.summary ?? p.tool ?? "tool").split("\n")[0]!.slice(0, 200));
      const out = [p.preview, p.output, p.error].filter((x) => typeof x === "string" && x.trim()).join("\n").slice(-4000);
      const tail = failed ? ` <span class="bad">${typeof p.exitCode === "number" ? `exit ${p.exitCode}` : "failed"}</span>` : "";
      return out ? `<details class="tool"><summary>⚙ ${title}${tail}</summary><pre>${esc(out)}</pre></details>` : `<div class="tool">⚙ ${title}${tail}</div>`;
    }
    case "turn_diff": {
      const files = (p.files as Array<{ path: string }> | undefined) ?? [];
      const look = ((p.triage as Array<{ path: string; level: string; reasons?: string[] }> | undefined) ?? []).filter((t) => t.level !== "low").slice(0, 3);
      return `<details class="diff"><summary>✎ Edited ${files.length} file${files.length === 1 ? "" : "s"} <span class="da">+${Number(p.added ?? 0)}</span> <span class="dd">−${Number(p.removed ?? 0)}</span> <span class="m">${esc(files.slice(0, 5).map((f) => f.path).join(", "))}${files.length > 5 ? " …" : ""}</span></summary>` +
        (look.length ? `<p class="tri">Review first: ${look.map((t) => `<code>${esc(t.path)}</code> ${esc(t.reasons?.[0] ?? "")}`).join(" · ")}</p>` : "") +
        `<pre class="patch">${diffHtml(String(p.patch ?? ""))}</pre></details>`;
    }
    case "proof": {
      const claims = ((p.claims as Array<Record<string, unknown>> | undefined) ?? []).map((c) => `<li class="c-${esc(c.status)}">“${esc(c.text)}” <span class="m">— ${esc(c.why)}</span></li>`).join("");
      return `<div class="card proof v-${esc(p.verdict)}"><b>Proof · ${esc(PROOF_WORD[String(p.verdict)] ?? p.verdict)}</b> ${esc(p.headline)}${claims ? `<ul>${claims}</ul>` : ""}</div>`;
    }
    case "shift":
      if (p.phase === "started") return `<div class="sys">🌙 Night shift started — ${(p.tasks ?? []).length} tasks${p.to ? ` for ${esc(p.to)}` : ""}</div>`;
      if (p.phase !== "report") return "";
      return `<div class="card shift"><b>🌙 Night shift report</b> ${esc(p.summary)}${p.stopped ? ` <span class="m">— stopped: ${esc(p.stopped)}</span>` : ""}<ul>${((p.tasks as Array<Record<string, any>>) ?? []).map((t) =>
        `<li><span class="tag s-${esc(t.status)}">${esc(SHIFT_WORD[t.status] ?? t.status)}</span> ${esc(t.text)}${t.question ? ` <span class="m">— asks: ${esc(t.question)}</span>` : t.error ? ` <span class="m">— ${esc(t.error)}</span>` : t.headline ? ` <span class="m">— ${esc(t.headline)}</span>` : ""}</li>`).join("")}</ul></div>`;
    case "status":
      if (p.state === "loop_detected") return `<div class="card warn"><b>↻ ${who} was going in circles</b> <code>${esc(p.call)}</code> — ${esc(p.count)}× this turn${p.nudged ? "; Loom stopped it and asked it to step back" : ""}</div>`;
      if (p.state === "shield_tripped") return `<div class="card bad"><b>⛔ ${who} ran ${esc(p.what)}</b> <code>${esc(p.command)}</code> — ${esc(p.why)}${p.stopped ? ". Loom stopped the turn." : ""}</div>`;
      if (typeof p.state === "string" && p.state.startsWith("quota_") && p.text) return `<div class="sys">⇄ ${esc(p.text)}</div>`;
      if (p.state === "interrupted" || p.state === "stopped") return `<div class="sys">■ ${who} stopped</div>`;
      return "";
    case "needs_input": return `<div class="card warn"><b>? ${who} asked</b> ${esc(p.question)}</div>`;
    case "approval":
      if (p.phase === "requested") return `<div class="sys">${who} asked to use ${esc(p.tool)}</div>`;
      if (p.phase === "decided") return `<div class="sys">${p.behavior === "allow" ? "✓ allowed" : "✕ denied"} ${esc(p.tool)} for ${who}</div>`;
      return "";
    case "handoff": return `<div class="sys">⇢ the baton passed${p.from ? ` from ${esc(p.from)}` : ""} to ${esc(p.to)}</div>`;
    case "error": return `<div class="card bad"><b>Error</b> ${esc(String(p.message ?? p.error ?? "").split("\n")[0])}</div>`;
    case "run_complete": return `<div class="done">${who} finished${p.durationMs ? ` in ${dur(Number(p.durationMs))}` : ""}${p.costUsd ? ` · ${money(Number(p.costUsd))}` : ""}${p.error ? ` · <span class="bad">${esc(p.error)}</span>` : ""}</div>`;
    default: return "";
  }
}

export interface ReplayMeta { project: string; chat: string; now?: Date }

export function threadReplay(events: LoomEvent[], meta: ReplayMeta): string {
  const now = meta.now ?? new Date();
  const agents = [...new Set(events.filter((e) => e.agentId && e.kind === "run_complete").map((e) => e.agentId!))];
  const turns = events.filter((e) => e.kind === "run_complete" && e.agentId).length;
  const cost = events.reduce((n, e) => n + (e.kind === "status" && e.payload.state === "turn_cost" ? Number(e.payload.costUsd ?? 0) || 0 : 0), 0);
  const ms = events.reduce((n, e) => n + (e.kind === "run_complete" ? Number(e.payload.durationMs ?? 0) || 0 : 0), 0);
  const files = new Set(events.flatMap((e) => (e.kind === "turn_diff" ? ((e.payload.files as Array<{ path: string }> | undefined) ?? []).map((f) => f.path) : [])));
  const proofs = events.filter((e) => e.kind === "proof");
  const verified = proofs.filter((e) => e.payload.verdict === "verified").length;
  const facts = [
    agents.length ? `${agents.map(esc).join(", ")}` : "",
    `${turns} turn${turns === 1 ? "" : "s"}`,
    ms ? dur(ms) : "",
    files.size ? `${files.size} file${files.size === 1 ? "" : "s"} changed` : "",
    proofs.length ? `${verified}/${proofs.length} checks verified` : "",
    cost ? money(cost) : "",
  ].filter(Boolean).join(" · ");
  let lastDay = "";
  const body: string[] = [];
  for (const e of events) {
    const d = day(e.ts);
    if (d !== lastDay) { lastDay = d; body.push(`<h2 class="day">${esc(d)}</h2>`); }
    const h = item(e);
    if (h) body.push(h);
  }
  const title = `${meta.project} — ${meta.chat}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · Loom replay</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1c1a;--mut:#6f6b64;--line:#e6e2db;--card:#fff;--ok:#1f8a4c;--err:#c0392b;--warn:#b7791f;--add:#1f8a4c;--del:#c0392b;--code:#f3f0ea}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe7;--mut:#9b978f;--line:#2b2a27;--card:#1c1b19;--ok:#4fbf7f;--err:#ef6f61;--warn:#e0a548;--add:#4fbf7f;--del:#ef6f61;--code:#23221f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14.5px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 64px}
.top h1{font-size:22px;margin:0 0 4px}.top p{margin:0;color:var(--mut)}
h2.day{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
section{margin:12px 0;padding:10px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card)}
section.you{background:var(--code)}
section header{font-size:12.5px;font-weight:650;margin-bottom:4px}section header time,.m,time{font-weight:400;color:var(--mut);font-size:12px}
section p{margin:6px 0}section h3,section h4,section h5,section h6{margin:10px 0 4px}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:4px;padding:1px 4px}
pre{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:8px;padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-word}
pre code{background:none;padding:0}
.tool,details.tool summary,details.diff summary{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mut);margin:3px 0 3px 4px;cursor:pointer}
details pre{margin:6px 0 10px}.patch .da{color:var(--add)}.patch .dd{color:var(--del)}.patch .dh{color:var(--mut);font-weight:600}.patch .dn{color:var(--warn)}
.da{color:var(--add)}.dd{color:var(--del)}.bad{color:var(--err)}
.tri{font-size:12.5px;margin:6px 0}
.sys,.done{font-size:12.5px;color:var(--mut);margin:6px 0 6px 4px}
.card{margin:10px 0;padding:9px 12px;border-radius:10px;border:1px solid var(--line);border-left:3px solid var(--mut);background:var(--card);font-size:13.5px}
.card ul{margin:6px 0 0;padding-left:18px}.card.warn{border-left-color:var(--warn)}.card.bad{border-left-color:var(--err)}
.proof.v-verified{border-left-color:var(--ok)}.proof.v-contradicted{border-left-color:var(--err)}
.c-supported::marker{color:var(--ok)}.c-contradicted::marker{color:var(--err)}
.tag{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;border:1px solid var(--line);border-radius:999px;padding:0 7px;color:var(--mut)}
.s-verified{color:var(--ok)}.s-didnt_hold,.s-failed{color:var(--err)}.s-needs_you{color:var(--warn)}
footer{margin-top:40px;color:var(--mut);font-size:12px;text-align:center}
</style></head>
<body><main>
<div class="top"><h1>${esc(title)}</h1><p>${facts}</p></div>
${body.join("\n")}
<footer>A replay from Loom · exported ${esc(now.toLocaleString())} · ${events.length} events</footer>
</main></body></html>
`;
}
