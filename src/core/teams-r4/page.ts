import { withShareCountdown } from "../share-page.js";
import type { LinkDetails } from "./links.js";
import type { LoomEvent } from "../../types.js";
export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const shell = (body: string) => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Loom · shared work</title><style>body{font:16px system-ui;max-width:860px;margin:32px auto;padding:0 20px}pre{white-space:pre-wrap;overflow-wrap:anywhere}article,form{border:1px solid #888;padding:16px;margin:12px 0;border-radius:8px}input,textarea,select,button{font:inherit;max-width:100%;margin:6px;padding:8px}label{display:block}textarea{display:block;width:90%}</style></head><body>' + body + '</body></html>';
export function sharePage(html: string | null, d: LinkDetails, events: LoomEvent[], expiresAt: number, locked = false) {
  let body = "";
  if (locked) body = '<h1>Passcode required</h1><form data-action="unlock"><label>Passcode<input name="passcode" type="password" required maxlength="128"></label><button>Open share</button></form>';
  else {
    if (d.handoff) body += '<article><h1>Pass to @' + esc(d.handoff.to) + '</h1><p>Branch: ' + esc(d.handoff.branch) + '</p><h2>Summary</h2><pre>' + esc(d.handoff.summary) + '</pre><h2>Open questions</h2><pre>' + esc(d.handoff.questions.join('\n') || 'None recorded.') + '</pre><p>' + esc(d.handoff.note) + '</p></article>';
    if (d.changes) body += '<h1>Changes · ' + esc(d.changes.branch) + '</h1><p>Snapshot at sharing time · ' + esc(d.changes.files.length) + ' files</p>' + d.changes.files.map(f => '<details><summary>' + esc(f.path) + '</summary><pre>' + esc(f.diff) + '</pre></details>').join('');
    body += '<section aria-label="Comments"><h2>Comments and review</h2><p>Visitor names are self-reported. Comments are annotations; agents do not act on them.</p>' + d.annotations.map(a => '<article><b>' + esc(a.name) + '</b> ' + (a.messageId ? 'on message #' + esc(a.messageId) : '') + (a.verdict ? ' · ' + esc(a.verdict === 'approve' ? 'Approved' : 'Changes requested') : '') + '<pre>' + esc(a.text) + '</pre>' + (a.reply ? '<b>Owner reply</b><pre>' + esc(a.reply) + '</pre>' : '') + '</article>').join('');
    const messages = d.changes ? [] : events.filter(e => e.kind === "message" && !e.payload.reasoning);
    if (messages.length) body += '<form data-action="annotations"><h3>Comment on a message</h3><label>Message<select name="messageId">' + messages.map(e => '<option value="' + esc(e.id) + '">#' + esc(e.id) + ' · ' + esc(String(e.payload.text ?? '').slice(0, 100)) + '</option>').join('') + '</select></label><label>Your name<input name="name" required maxlength="80"></label><label>Comment<textarea name="text" required maxlength="4000"></textarea></label><button>Comment</button></form>';
    if (d.reviewer && !d.annotations.some(a => a.verdict)) body += '<form data-action="annotations"><h3>Review requested from @' + esc(d.reviewer) + '</h3><label>Your name<input name="name" required maxlength="80"></label><label>Verdict<select name="verdict"><option value="approve">Approve</option><option value="request-changes">Request changes</option></select></label><label>Note<textarea name="text" required maxlength="4000"></textarea></label><button>Submit review</button></form>';
    body += '</section>';
  }
  const source = html && !locked ? html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, '').replace('</main>', () => body + '</main>') : shell(body);
  // The replay's static CSP is replaced by the countdown's nonce policy, also used for forms.
  const page = withShareCountdown(source, expiresAt);
  const nonce = /nonce-([^']+)/.exec(page.csp)![1];
  const script = `<script nonce="${nonce}">document.querySelectorAll('form[data-action]').forEach(function(f){f.addEventListener('submit',async function(e){e.preventDefault();var b=f.querySelector('button');b.disabled=true;try{var data=Object.fromEntries(new FormData(f));if(data.messageId)data.messageId=Number(data.messageId);var r=await fetch(location.pathname+'/'+f.dataset.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(!r.ok)throw new Error((await r.json()).error||'Could not save');location.reload();}catch(e){var p=f.querySelector('[role=alert]');if(!p){p=document.createElement('p');p.setAttribute('role','alert');f.appendChild(p);}p.textContent=e.message;b.disabled=false;}});});</script>`;
  return { html: page.html.replace('</body>', () => script + '</body>'), csp: page.csp.replace("base-uri 'none'", "connect-src 'self'; base-uri 'none'") };
}
