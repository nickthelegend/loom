// The shell's own two pages: while the daemon starts, and when it couldn't.
// Plain data: URLs with no script — the CSS reveals the waiting hint on a delay.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const shell = (bg, inner) =>
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>Loom</title>` +
      `<style>body{background:${bg};color:#fafafa;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.01em;padding:48px;margin:0}` +
      `h2{font-weight:650;font-size:22px;margin:0 0 4px}.bar{width:48px;height:2px;border-radius:1px;background:linear-gradient(90deg,transparent,#67e8f9,transparent);margin:0 0 18px}` +
      `p{color:#a1a1a1;max-width:620px}code{background:#262626;border-radius:5px;padding:1px 6px;color:#e5e5e5}` +
      `pre{color:#ff6568;background:#171717;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:12px 14px;white-space:pre-wrap;max-width:720px}` +
      `.later{opacity:0;animation:show .4s ease 6s forwards}@keyframes show{to{opacity:1}}` +
      `.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#67e8f9;margin-right:8px;animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{50%{opacity:.3}}</style>` +
      `<h2>loom</h2><div class="bar"></div>${inner}`,
  );

/** Shown the moment the window opens, until the app itself loads. */
export function startingPage(bg) {
  return shell(
    bg,
    `<p><span class="dot"></span>Starting Loom…</p>` +
      `<p class="later">Still waiting for Loom's background service. If macOS asked whether <b>Loom Desktop</b> may access files — ` +
      `on an external drive, or in Documents or Desktop, wherever your projects live — choose <b>Allow</b>. Loom carries on as soon as you answer.</p>`,
  );
}

/** When the daemon couldn't be reached: what happened, and what to do — for an installed app, not a checkout. */
export function failedPage(bg, err, { packaged, logPath }) {
  const next = packaged
    ? `<p>Quit Loom and open it again. If macOS asks whether Loom Desktop may access files, choose <b>Allow</b> — ` +
      `you can also turn it on later in System Settings → Privacy &amp; Security → Files and Folders.</p>` +
      `<p>What the background service said is in <code>${esc(logPath)}</code>.</p>`
    : `<p>Make sure the project is built (<code>npm run build</code>) and try again. The daemon's log is <code>${esc(logPath)}</code>.</p>`;
  return shell(bg, `<p>Could not start the loom daemon.</p><pre>${esc(err)}</pre>${next}`);
}
