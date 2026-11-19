import { randomBytes } from "node:crypto";
import type { OrchestraRun } from "./orchestra.js";

const esc = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** Deliberately select public fields: a run also holds local paths and worker credentials. */
export function orchestraSharePage(run: OrchestraRun, project: string): string {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + esc(project) + ' · Orchestra</title>' +
    '<style>body{font:16px system-ui;max-width:880px;margin:32px auto;padding:0 20px;color:#ddd;background:#171717}article{border:1px solid #555;border-radius:12px;padding:16px;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#aaa}</style></head><body>' +
    '<small>Read-only Orchestra run · ' + esc(project) + '</small><h1>' + esc(run.goal) + '</h1><p>' + esc(run.status) + '</p><p>Orchestrator: ' + esc(run.orchestrator.agent) + ' · Workers: ' + esc(run.workers.join(', ')) + '</p>' +
    (run.summary ? '<h2>Summary</h2><pre>' + esc(run.summary) + '</pre>' : '') +
    (run.question ? '<h2>Waiting for input</h2><pre>' + esc(run.question) + '</pre>' : '') +
    run.tasks.map(t => '<article><h2>' + esc(t.title) + '</h2><p>' + esc(t.agent) + ' · ' + esc(t.status) + '</p><pre>' + esc(t.result ?? "") + '</pre></article>').join("") + '</body></html>';
}

export function withShareCountdown(html: string, expiresAt: number): { html: string; csp: string } {
  const nonce = randomBytes(18).toString("base64");
  const banner = '<p id="share-expiry" role="timer" style="padding:12px;border:1px solid #888">Expires ' + esc(new Date(expiresAt).toISOString()) + '</p>';
  const script = `<script nonce="${nonce}">function tick(){var s=Math.max(0,Math.ceil((${expiresAt}-Date.now())/1000));var e=document.getElementById('share-expiry');if(!s){document.body.textContent='This link has expired.';clearInterval(timer);return;}if(e)e.textContent='Read-only · expires in '+Math.floor(s/86400)+'d '+Math.floor(s%86400/3600)+'h '+Math.floor(s%3600/60)+'m '+s%60+'s';}var timer=setInterval(tick,1000);tick();</script>`;
  return { html: html.replace(/<body([^>]*)>/, '<body$1>' + banner).replace('</body>', script + '</body>'),
    csp: `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` };
}
