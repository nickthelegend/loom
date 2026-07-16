/**
 * The Loom web app — a single-file app served by the daemon at /app.
 * Reachable over the tailnet, paired via the `loom pair` QR deep link
 * (…/app#pair=<one-time-token>), installable to the Android home screen,
 * and wrapped by the Electron shell on desktop.
 *
 * Served publicly (it's just a shell); every API call it makes carries the
 * paired client's bearer token. No frameworks, no build step, no CDN.
 *
 * Design: the "quiet graphite" system adapted from Orca (github.com/stablyai/
 * orca, MIT) — neutral monochrome chrome, hairline borders, Geist type, and
 * color reserved for state: thread cyan = live, shuttle magenta = the baton.
 * Desktop (>=900px) is the Orca workspace shell: projects/agents tree in the
 * left sidebar, a tabbed center pane (Thread | Changes | Brain | Routes), a
 * source-control right rail (>=1200px), and a status bar. Mobile keeps the
 * single-column thread. See docs/design-system.md.
 */

export const APP_MANIFEST = {
  name: "Loom",
  short_name: "Loom",
  start_url: "/app",
  display: "standalone",
  background_color: "#0a0a0a",
  theme_color: "#0a0a0a",
  icons: [
    {
      src:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%230a0a0a'/%3E%3Ctext x='50' y='60' font-size='36' text-anchor='middle' fill='%23fafafa' font-family='-apple-system,Segoe UI,sans-serif' font-weight='600'%3Elo%3C/text%3E%3Crect x='32' y='70' width='36' height='4' rx='2' fill='%2367e8f9'/%3E%3C/svg%3E",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
  ],
};

export const APP_HTML = `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0a0a0a">
<link rel="manifest" href="/app/manifest.webmanifest">
<title>Loom</title>
<script>
/* Apply the saved theme before first paint so there is no flash. */
try{if(localStorage.getItem("loomTheme")==="light")document.documentElement.classList.remove("dark")}catch(e){}
</script>
<style>
  @font-face{
    font-family:'Geist';
    src:url('/app/fonts/geist.woff2') format('woff2');
    font-weight:100 900;font-style:normal;font-display:swap;
  }
  /* ── Tokens (Orca design system; light then dark) ─────────────── */
  :root{
    --font-sans:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    --font-mono:'SF Mono',SFMono-Regular,ui-monospace,'Cascadia Code',Menlo,Consolas,'Liberation Mono',monospace;
    --radius:10px;--radius-sm:6px;--radius-md:8px;--radius-xl:14px;
    --background:#fff;--foreground:#0a0a0a;
    --editor-surface:#ffffff;
    --card:#fff;--card-foreground:#0a0a0a;
    --popover:#fff;--popover-foreground:#0a0a0a;
    --primary:#171717;--primary-foreground:#fafafa;
    --secondary:#f5f5f5;--secondary-foreground:#171717;
    --muted:#f5f5f5;--muted-foreground:#737373;
    --accent:#f5f5f5;--accent-foreground:#171717;
    --destructive:#e40014;
    --border:#e5e5e5;--input:#e5e5e5;--ring:#a1a1a1;
    --sidebar:#fafafa;--sidebar-foreground:#0a0a0a;
    --sidebar-accent:#f5f5f5;--sidebar-accent-foreground:#171717;
    --sidebar-border:#e5e5e5;
    --glass:rgba(255,255,255,.88);--glass-border:rgba(0,0,0,.14);
    --glass-highlight:rgba(255,255,255,.14);
    /* state — the only places color is allowed; -ink variants are text-grade */
    --thread:#67e8f9;--shuttle:#e879f9;
    --thread-ink:#0e7490;--shuttle-ink:#a21caf;
    --ok:#15803d;--warn:#b45309;--err:#e40014;--live:#eab308;
    --git-add:#587c0c;--git-mod:#895503;--git-del:#ad0707;
    --agent-l:36%;--selvage-l:44%;
    --warp:rgba(0,0,0,.018);
    /* legacy aliases so older inline styles keep resolving */
    --accent-2:var(--thread);--mag:var(--shuttle);--bg:var(--background);
  }
  .dark{
    --background:#0a0a0a;--foreground:#fafafa;
    --editor-surface:#141414;
    --card:#171717;--card-foreground:#fafafa;
    --popover:#171717;--popover-foreground:#fafafa;
    --primary:#e5e5e5;--primary-foreground:#171717;
    --secondary:#262626;--secondary-foreground:#fafafa;
    --muted:#262626;--muted-foreground:#a1a1a1;
    --accent:#404040;--accent-foreground:#fafafa;
    --destructive:#ff6568;
    --border:rgb(255 255 255 / 0.07);--input:rgb(255 255 255 / 0.15);--ring:#737373;
    --sidebar:#171717;--sidebar-foreground:#fafafa;
    --sidebar-accent:#262626;--sidebar-accent-foreground:#fafafa;
    --sidebar-border:rgb(255 255 255 / 0.07);
    --glass:rgba(23,23,23,.92);--glass-border:rgba(255,255,255,.14);
    --glass-highlight:rgba(255,255,255,.06);
    --thread-ink:#67e8f9;--shuttle-ink:#e879f9;
    --ok:#10b981;--warn:#eab308;--err:#ff6568;--live:#eab308;
    --git-add:#81b88b;--git-mod:#e2c08d;--git-del:#c74e39;
    --agent-l:70%;--selvage-l:52%;
    --warp:rgba(255,255,255,.012);
  }
  /* ── Base ─────────────────────────────────────────────── */
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0}
  body{background:var(--background);color:var(--foreground);
    font:14px/1.55 var(--font-sans);letter-spacing:.01em;
    -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
    padding-bottom:env(safe-area-inset-bottom);min-height:100dvh}
  /* the warp ground — Loom's fingerprint, near-invisible vertical threads */
  body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;
    background:repeating-linear-gradient(90deg, var(--warp) 0 1px, transparent 1px 28px)}
  ::selection{background:color-mix(in srgb, var(--thread) 30%, transparent)}
  :focus-visible{outline:none;border-color:var(--ring)!important;
    box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 50%, transparent)}
  #root{max-width:760px;margin:0 auto;min-height:100dvh;display:flex;flex-direction:column}
  svg{display:block;flex:none}
  button{font:inherit;color:inherit;background:none;border:none;padding:0;margin:0}
  button:not(:disabled){cursor:pointer}
  /* ── Buttons (Orca variants) ──────────────────────────── */
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;
    height:36px;padding:0 16px;border-radius:var(--radius-md);
    font-size:14px;font-weight:500;white-space:nowrap;
    background:var(--secondary);color:var(--secondary-foreground);
    border:1px solid transparent;transition:background .15s,border-color .15s,color .15s,opacity .15s}
  .btn:hover{background:color-mix(in srgb, var(--secondary) 80%, transparent)}
  .btn:disabled{opacity:.5;pointer-events:none}
  .btn.primary{background:var(--primary);color:var(--primary-foreground)}
  .btn.primary:hover{background:color-mix(in srgb, var(--primary) 90%, transparent)}
  .btn.outline{background:transparent;border-color:var(--border);
    box-shadow:0 1px 2px rgb(0 0 0 / .05)}
  .btn.outline:hover{background:var(--accent);border-color:color-mix(in srgb, var(--muted-foreground) 35%, transparent)}
  .btn.ghost{background:transparent}
  .btn.ghost:hover{background:var(--accent)}
  .btn.sm{height:32px;padding:0 12px;font-size:13px}
  .btn.xs{height:24px;padding:0 8px;font-size:12px;border-radius:var(--radius-sm)}
  .btn svg{width:16px;height:16px}
  .iconbtn{display:inline-flex;align-items:center;justify-content:center;
    width:32px;height:32px;border-radius:var(--radius-md);color:var(--muted-foreground);
    background:transparent;border:1px solid transparent;transition:background .15s,color .15s}
  .iconbtn:hover{background:var(--accent);color:var(--foreground)}
  .iconbtn svg{width:16px;height:16px}
  .sendbtn{display:inline-flex;align-items:center;justify-content:center;flex:none;
    width:34px;height:34px;border-radius:17px;background:var(--primary);color:var(--primary-foreground);
    transition:opacity .15s,transform .1s}
  .sendbtn:hover{opacity:.9}
  .sendbtn:active{transform:scale(.96)}
  .sendbtn svg{width:16px;height:16px}
  /* ── Type helpers ─────────────────────────────────────── */
  .wordmark{font-weight:650;font-size:15px;letter-spacing:0;color:var(--foreground);position:relative}
  .wordmark b{font-weight:650;color:inherit}
  .wordmark::after{content:"";position:absolute;left:1px;right:1px;bottom:-4px;height:2px;border-radius:1px;
    background:linear-gradient(90deg,transparent,color-mix(in srgb, var(--thread) 55%, transparent),transparent)}
  .sub{color:var(--muted-foreground);font-size:11px;font-weight:600;font-family:var(--font-mono);
    letter-spacing:.05em;text-transform:uppercase;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .spacer{margin-left:auto}
  .mono{font-family:var(--font-mono)}
  /* ── App bars ─────────────────────────────────────────── */
  header.appbar{position:sticky;top:0;z-index:5;height:48px;flex:none;
    display:flex;align-items:center;gap:12px;padding:0 16px;
    padding-top:env(safe-area-inset-top);height:calc(48px + env(safe-area-inset-top));
    background:color-mix(in srgb, var(--background) 88%, transparent);
    backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    border-bottom:1px solid var(--border)}
  main{flex:1;padding:14px 16px 100px}
  /* ── Cards (board) ────────────────────────────────────── */
  .card{position:relative;background:var(--card);border:1px solid var(--border);
    border-radius:var(--radius-xl);padding:14px 16px;margin-bottom:10px;cursor:pointer;
    box-shadow:0 1px 2px rgb(0 0 0 / .05);
    transition:border-color .15s,background .15s}
  .card:hover{border-color:color-mix(in srgb, var(--muted-foreground) 35%, transparent)}
  .card:active{background:var(--accent)}
  .card .row1{display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px;min-width:0}
  .card .row1 span.nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .card .row2{color:var(--muted-foreground);font-size:12px;margin-top:4px;
    font-family:var(--font-mono);letter-spacing:.02em}
  .dot{width:8px;height:8px;border-radius:50%;background:color-mix(in srgb, var(--muted-foreground) 40%, transparent);flex:none;position:relative}
  .dot.hot{background:var(--live)}
  .dot.hot::after{content:"";position:absolute;inset:-4px;border-radius:50%;
    border:1px solid var(--live);opacity:.5;animation:pulse 1.8s ease-out infinite}
  @keyframes pulse{0%{transform:scale(.6);opacity:.6}100%{transform:scale(1.7);opacity:0}}
  .badge{display:inline-flex;align-items:center;gap:5px;flex:none;
    font-size:11px;font-weight:500;font-family:var(--font-mono);letter-spacing:.02em;
    color:var(--muted-foreground);background:transparent;
    border:1px solid var(--border);border-radius:999px;padding:1px 9px;margin-left:auto}
  .badge.live{color:var(--foreground);
    border-color:color-mix(in srgb, var(--thread) 45%, transparent);
    background:color-mix(in srgb, var(--thread) 9%, transparent)}
  /* ── Agent chips (mobile thread) ──────────────────────── */
  .chips{display:flex;gap:6px;overflow-x:auto;padding:10px 16px;position:sticky;z-index:4;
    top:calc(48px + env(safe-area-inset-top));
    background:color-mix(in srgb, var(--background) 88%, transparent);
    backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    border-bottom:1px solid var(--border);scrollbar-width:none}
  .chips::-webkit-scrollbar{display:none}
  .chip{flex:none;display:inline-flex;align-items:center;gap:6px;height:26px;
    font-family:var(--font-mono);font-size:12px;padding:0 11px;border-radius:999px;
    border:1px solid var(--border);color:var(--muted-foreground);background:transparent;
    transition:background .15s,border-color .15s,color .15s;cursor:pointer}
  .chip:hover{background:var(--accent);color:var(--foreground)}
  .chip.sel{color:var(--primary-foreground);background:var(--primary);border-color:transparent;font-weight:600}
  .chip .role{opacity:.65;font-size:11px}
  .busy{width:10px;height:10px;border-radius:50%;flex:none;display:inline-block;
    border:1.5px solid currentColor;border-top-color:transparent;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  /* ── Thread feed ──────────────────────────────────────── */
  .msg{margin:10px 0;display:flex;flex-direction:column}
  .msg .who{font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);
    margin:0 2px 4px;letter-spacing:.04em}
  .msg .bubble{max-width:88%;padding:9px 13px;border-radius:var(--radius-xl);
    white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.55}
  .msg.user{align-items:flex-end}
  .msg.user .bubble{background:var(--secondary);color:var(--secondary-foreground);
    border:1px solid var(--border);border-bottom-right-radius:4px}
  .msg.agent{align-items:flex-start}
  .msg.agent .bubble{background:var(--card);border:1px solid var(--border);
    border-left:2px solid var(--border);border-bottom-left-radius:4px;
    box-shadow:0 1px 2px rgb(0 0 0 / .04)}
  .sys{color:var(--muted-foreground);font-size:12px;text-align:center;margin:10px auto;
    font-family:var(--font-mono);letter-spacing:.02em;max-width:92%}
  .sys.warn{color:var(--warn)}
  .sys.err{color:var(--err)}
  .sys.ok{color:var(--ok)}
  .sys.mag{color:var(--shuttle-ink)}
  .tool{color:color-mix(in srgb, var(--muted-foreground) 75%, transparent);
    font-size:11.5px;font-family:var(--font-mono);margin:3px 0 3px 14px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .handoff{display:flex;align-items:center;justify-content:center;gap:10px;margin:14px 0;
    font-family:var(--font-mono);font-size:12px}
  .handoff .a{color:var(--muted-foreground)}
  .handoff .shuttle{color:var(--shuttle-ink);font-size:15px;animation:glide .5s ease}
  .handoff .b{color:var(--shuttle-ink)}
  @keyframes glide{from{transform:translateX(-10px);opacity:0}to{transform:translateX(0);opacity:1}}
  /* woven loader — warp bars shimmering in thread */
  .loader{display:flex;flex-direction:column;gap:5px;align-items:center;padding:28px 0}
  .loader i{display:block;width:54px;height:2px;border-radius:2px;
    background:color-mix(in srgb, var(--muted-foreground) 25%, transparent);position:relative;overflow:hidden}
  .loader i::after{content:"";position:absolute;left:-40%;top:0;width:40%;height:100%;
    background:linear-gradient(90deg,transparent,var(--thread),transparent);animation:weave 1.15s ease-in-out infinite}
  .loader i:nth-child(2)::after{animation-delay:.14s}
  .loader i:nth-child(3)::after{animation-delay:.28s}
  .loader i:nth-child(4)::after{animation-delay:.42s}
  @keyframes weave{0%{left:-40%}100%{left:100%}}
  /* ── Route banner + sheets (floating tier) ────────────── */
  .routebar{position:sticky;top:8px;z-index:3;
    background:var(--popover);border:1px solid var(--border);
    border-left:2px solid color-mix(in srgb, var(--thread) 60%, transparent);
    border-radius:var(--radius);padding:10px 13px;margin:12px 0;font-size:13px;
    box-shadow:0 10px 24px rgb(0 0 0 / .18)}
  .routebar .q{color:var(--warn);margin-top:5px}
  .routebar .abort{float:right;margin-left:10px}
  .sheet{background:var(--glass);border:1px solid var(--glass-border);
    border-radius:var(--radius);padding:14px;margin:12px 0;
    display:flex;flex-direction:column;gap:10px;
    box-shadow:0 10px 24px rgb(0 0 0 / .18), inset 0 1px 0 var(--glass-highlight);
    backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
    animation:sheetin .18s ease}
  @keyframes sheetin{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  .sheet select,.sheet input,.formcol select,.formcol input{
    height:36px;background:transparent;border:1px solid var(--input);
    border-radius:var(--radius-md);color:var(--foreground);padding:0 11px;font:inherit;font-size:14px;width:100%;
    transition:border-color .15s,box-shadow .15s;outline:none}
  .dark .sheet select,.dark .sheet input,.dark .formcol select,.dark .formcol input{
    background:color-mix(in srgb, var(--input) 30%, transparent)}
  .dark .sheet select option,.dark .formcol select option{background:var(--popover);color:var(--popover-foreground)}
  .sheet select:focus-visible,.sheet input:focus-visible,.formcol select:focus-visible,.formcol input:focus-visible{
    border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 50%, transparent)}
  .sheet .row{display:flex;gap:8px}
  .sheet .row .btn{flex:1}
  .sheet label,.formcol label{font-size:11px;font-weight:600;color:var(--muted-foreground);
    letter-spacing:.05em;text-transform:uppercase;font-family:var(--font-mono)}
  /* ── Composer ─────────────────────────────────────────── */
  .composer{z-index:6;flex:none;
    background:color-mix(in srgb, var(--background) 92%, transparent);
    backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    border-top:1px solid var(--border);
    padding:10px 14px calc(10px + env(safe-area-inset-bottom))}
  .composer .inner{max-width:900px;margin:0 auto;display:flex;gap:9px;align-items:center}
  .composer input{flex:1;height:40px;background:transparent;border:1px solid var(--input);
    border-radius:var(--radius);color:var(--foreground);padding:0 14px;font:inherit;font-size:14px;outline:none;
    transition:border-color .15s,box-shadow .15s}
  .dark .composer input{background:color-mix(in srgb, var(--input) 30%, transparent)}
  .composer input::placeholder{color:color-mix(in srgb, var(--muted-foreground) 60%, transparent)}
  .composer input:focus{border-color:var(--ring);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 40%, transparent)}
  .hint{color:color-mix(in srgb, var(--muted-foreground) 80%, transparent);font-size:11px;
    font-family:var(--font-mono);letter-spacing:.02em;max-width:760px;margin:7px auto 0;text-align:center;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* ── Toast (floating tier) ────────────────────────────── */
  #toast{position:fixed;left:50%;transform:translateX(-50%) translateY(6px);bottom:94px;z-index:20;
    background:var(--glass);color:var(--popover-foreground);
    border:1px solid var(--glass-border);border-radius:var(--radius);
    backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
    padding:9px 15px;font-size:13px;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;max-width:86%;
    box-shadow:0 10px 24px rgb(0 0 0 / .18), inset 0 1px 0 var(--glass-highlight)}
  #toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  /* ── Pair screen ──────────────────────────────────────── */
  .pairwrap{display:flex;flex-direction:column;gap:16px;align-items:center;justify-content:center;
    min-height:92dvh;padding:28px;text-align:center;max-width:420px;margin:0 auto;position:relative}
  .pairwrap::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;
    background-image:radial-gradient(circle, color-mix(in srgb, var(--foreground) 7%, transparent) 1px, transparent 1.2px);
    background-size:5px 5px;
    mask-image:radial-gradient(70% 55% at 50% 42%, #000, transparent);
    -webkit-mask-image:radial-gradient(70% 55% at 50% 42%, #000, transparent)}
  .pairwrap .biglogo{font-size:40px;font-weight:650;letter-spacing:-.02em;color:var(--foreground)}
  .pairwrap .tag{color:var(--muted-foreground);font-size:14px;line-height:1.55;max-width:300px}
  .pairwrap .hair{width:56px;height:2px;border-radius:1px;
    background:linear-gradient(90deg,transparent,var(--thread),transparent)}
  .pairwrap input{width:100%;height:40px;background:transparent;border:1px solid var(--input);
    border-radius:var(--radius);color:var(--foreground);padding:0 13px;font:inherit;font-size:14px;
    text-align:center;outline:none;transition:border-color .15s,box-shadow .15s}
  .dark .pairwrap input{background:color-mix(in srgb, var(--input) 30%, transparent)}
  .pairwrap input:focus{border-color:var(--ring);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 40%, transparent)}
  .pairwrap .btn.primary{width:100%;height:40px}
  .pairwrap .help{color:color-mix(in srgb, var(--muted-foreground) 85%, transparent);font-size:12px;line-height:1.7}
  .pairwrap .help b{color:var(--foreground);font-weight:500;font-family:var(--font-mono);font-size:11.5px;
    background:var(--secondary);border:1px solid var(--border);border-radius:5px;padding:1px 6px}
  /* ── Thread panel (self-contained flex column) ────────── */
  .panel{display:flex;flex-direction:column;height:100dvh;min-height:0}
  .panel > header{position:static;z-index:5;height:48px;flex:none;
    display:flex;align-items:center;gap:10px;padding:0 14px;
    background:color-mix(in srgb, var(--background) 88%, transparent);
    border-bottom:1px solid var(--border)}
  .panel .ptitle{display:flex;flex-direction:column;min-width:0;justify-content:center}
  .panel .ptitle .nm{font-size:13px;font-weight:600;line-height:1.3;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .panel .ptitle .st{font-size:11px;color:var(--muted-foreground);font-family:var(--font-mono);line-height:1.3;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .panel > .chips{position:static;top:auto}
  .panel .scroll{flex:1;min-height:0;overflow-y:auto;padding:16px 16px 20px}
  /* sleek scrollbars (Orca) */
  .scroll,.slist,.rbody,.sheet .scrollable{scrollbar-width:thin;
    scrollbar-color:color-mix(in srgb, var(--muted-foreground) 34%, transparent) transparent}
  .scroll::-webkit-scrollbar,.slist::-webkit-scrollbar,.rbody::-webkit-scrollbar{width:12px;height:12px}
  .scroll::-webkit-scrollbar-track,.slist::-webkit-scrollbar-track,.rbody::-webkit-scrollbar-track{background:transparent}
  .scroll::-webkit-scrollbar-thumb,.slist::-webkit-scrollbar-thumb,.rbody::-webkit-scrollbar-thumb{
    background:color-mix(in srgb, var(--muted-foreground) 28%, transparent);
    border:3px solid transparent;border-radius:7px;background-clip:padding-box;min-height:28px}
  .scroll::-webkit-scrollbar-thumb:hover,.slist::-webkit-scrollbar-thumb:hover,.rbody::-webkit-scrollbar-thumb:hover{
    background-color:color-mix(in srgb, var(--muted-foreground) 48%, transparent)}
  /* ── Desktop workspace shell (Orca layout) ────────────── */
  /* column widths are drag-resizable and persisted; the rail column only
     exists while .railopen is set. */
  .dshell{display:grid;height:100dvh;
    --sbw:264px;--railw:304px;
    grid-template-columns:var(--sbw) minmax(0,1fr);
    grid-template-rows:minmax(0,1fr) 25px}
  .dshell.railopen{grid-template-columns:var(--sbw) minmax(0,1fr) var(--railw)}
  /* drag handles: wide hit area, hairline that lights up on hover (Orca) */
  .rz{position:absolute;top:0;bottom:0;width:9px;z-index:12;cursor:col-resize}
  .rz::after{content:"";position:absolute;top:0;bottom:0;left:50%;width:1px;
    transform:translateX(-50%);background:transparent;transition:background .12s}
  .rz:hover::after,.rz.dragging::after{background:var(--ring)}
  .rz-sidebar{right:-4px}
  .rz-rail{left:-4px}
  .rz-dock{left:-4px}
  body.resizing-x{cursor:col-resize;user-select:none}
  body.resizing-x *{pointer-events:none}
  .sidebar{grid-column:1;grid-row:1;border-right:1px solid var(--sidebar-border);
    display:flex;flex-direction:column;min-width:0;position:relative;
    background:var(--sidebar);color:var(--sidebar-foreground)}
  .sidebar .shead{display:flex;align-items:center;gap:10px;height:40px;flex:none;padding:0 12px 0 16px;
    box-shadow:inset 0 -1px 0 var(--sidebar-border)}
  .sidebar .slist{flex:1;overflow-y:auto;padding:8px}
  .sidebar .stitle{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--muted-foreground);
    letter-spacing:.05em;text-transform:uppercase;padding:8px 8px 6px;font-family:var(--font-mono)}
  .stitle .iconbtn{width:22px;height:22px;margin-left:auto}
  .stitle .iconbtn svg{width:13px;height:13px}
  /* quiet search row (Orca sidebar nav) */
  .snav{display:flex;align-items:center;gap:8px;margin:8px 8px 0;padding:0 10px;height:30px;flex:none;
    border-radius:var(--radius-md);border:1px solid transparent;color:var(--muted-foreground);
    transition:background .12s,border-color .12s}
  .snav:focus-within{background:var(--sidebar-accent);border-color:var(--border)}
  .snav svg{width:14px;height:14px;flex:none}
  .snav input{flex:1;min-width:0;background:none;border:none;outline:none;box-shadow:none!important;
    color:var(--sidebar-foreground);font:inherit;font-size:12.5px}
  .snav input::placeholder{color:color-mix(in srgb, var(--muted-foreground) 65%, transparent)}
  .addform{display:flex;flex-direction:column;gap:6px;margin:2px 8px 8px;padding:10px;flex:none;
    border:1px solid var(--border);border-radius:var(--radius-md);background:var(--sidebar-accent)}
  .addform input{height:30px;background:var(--background);border:1px solid var(--input);
    border-radius:var(--radius-sm);color:var(--foreground);padding:0 9px;font:inherit;font-size:12px;outline:none}
  .addform .row{display:flex;gap:6px}
  .addform .row .btn{flex:1}
  .sfoot{display:flex;align-items:center;gap:4px;height:40px;flex:none;padding:0 10px;
    border-top:1px solid var(--sidebar-border)}
  .sfoot .iconbtn{width:28px;height:28px}
  .sgroup{margin-bottom:2px}
  .srow{padding:8px 10px;border-radius:var(--radius-md);border:1px solid transparent;cursor:pointer;
    transition:background .12s,border-color .12s}
  .srow:hover{background:var(--sidebar-accent)}
  .srow.sel{background:var(--sidebar-accent);border-color:var(--border)}
  .srow .n{font-weight:500;font-size:13px;display:flex;align-items:center;gap:8px;min-width:0}
  .srow .n .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .srow .n .cnt{margin-left:auto;flex:none;font-family:var(--font-mono);font-size:10.5px;color:var(--muted-foreground)}
  .pglyph{width:18px;height:18px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;
    font-family:var(--font-mono);font-size:9.5px;font-weight:700;flex:none;position:relative}
  .pglyph.hot::after{content:"";position:absolute;inset:-3px;border-radius:8px;
    border:1px solid var(--live);opacity:.6;animation:pulse 1.8s ease-out infinite}
  .srow .m{color:var(--muted-foreground);font-family:var(--font-mono);font-size:11px;margin-top:3px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .arow{display:flex;align-items:center;gap:8px;padding:5px 10px 5px 24px;margin-top:1px;
    border-radius:var(--radius-md);border:1px solid transparent;cursor:pointer;
    font-size:12.5px;color:var(--muted-foreground);transition:background .12s,color .12s}
  .arow:hover{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground)}
  .arow.cur{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground);border-color:var(--border)}
  .arow .anm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:6px}
  .arow .role{margin-left:auto;flex:none;font-family:var(--font-mono);font-size:10.5px;
    color:color-mix(in srgb, var(--muted-foreground) 75%, transparent)}
  .adot{width:7px;height:7px;border-radius:50%;flex:none;position:relative;
    background:color-mix(in srgb, var(--muted-foreground) 40%, transparent)}
  .adot.busy{background:var(--live)}
  .adot.busy::after{content:"";position:absolute;inset:-3px;border-radius:50%;
    border:1px solid var(--live);opacity:.5;animation:pulse 1.8s ease-out infinite}
  .abadge{flex:none;font-size:9.5px;font-family:var(--font-mono);letter-spacing:.04em;
    color:var(--muted-foreground);border:1px solid var(--border);border-radius:5px;
    padding:0 5px;line-height:14px;text-transform:uppercase}
  .arow.cur .abadge{color:var(--sidebar-accent-foreground)}
  .dmain{grid-column:2;grid-row:1;min-width:0;display:flex;flex-direction:column;position:relative;background:var(--background)}
  .dmain .panel{height:100%}
  .dmain .composer .inner,.dmain .hint{max-width:none}
  /* tab strip — the Orca workspace signature; it IS the window's top chrome:
     project context on the left, document tabs at the seam, actions right */
  .tabstrip{display:flex;align-items:flex-end;gap:2px;height:40px;flex:none;padding:0 10px;
    background:var(--sidebar);border-bottom:1px solid var(--border)}
  .tabstrip .ptitle{align-self:center;display:flex;flex-direction:column;justify-content:center;
    min-width:0;max-width:240px;padding:0 10px 0 6px;margin-right:6px}
  .tabstrip .ptitle .nm{font-size:12.5px;font-weight:600;line-height:1.25;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tabstrip .ptitle .st{font-size:10.5px;color:var(--muted-foreground);font-family:var(--font-mono);line-height:1.25;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tabstrip .iconbtn{align-self:center;width:30px;height:30px}
  .tab{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 13px;
    border-radius:8px 8px 0 0;border:1px solid transparent;border-bottom:none;
    font-size:12.5px;font-weight:500;color:var(--muted-foreground);cursor:pointer;position:relative;
    transition:color .12s,background .12s}
  .tab:hover{color:var(--foreground);background:color-mix(in srgb, var(--sidebar-accent) 70%, transparent)}
  .tab.active{background:var(--background);color:var(--foreground);border-color:var(--border)}
  .tab.active::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:var(--background)}
  .tab svg{width:13px;height:13px}
  .tab .tbadge{font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);
    border:1px solid var(--border);border-radius:4px;padding:0 4px;line-height:13px}
  .tabstrip .spacer{margin-left:auto}
  .pane{flex:1;min-height:0;overflow-y:auto;padding:16px 16px 20px}
  .dmain .pane > #feed,.dmain .pane > #routebar,.dmain .pane > .agenthead{max-width:840px;margin-inline:auto}
  .dmain .msg .bubble{max-width:82%}
  .pane-inner{max-width:840px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
  .formcol{display:flex;flex-direction:column;gap:10px;max-width:520px}
  /* diff/preview dock — opens to the RIGHT of the chat on click, closed by default */
  .paneswrap{flex:1;min-height:0;min-width:0;display:flex}
  .mainpane{flex:1;min-width:0;display:flex;flex-direction:column}
  .dockpane{width:var(--dockw,48%);min-width:280px;flex:none;display:none;flex-direction:column;min-height:0;
    position:relative;border-left:1px solid var(--border);background:var(--editor-surface)}
  .dockpane.open{display:flex}
  .dockpane .pane{flex:1}
  .dockpane .diffwrap{max-width:none}
  .dockhead{height:36px;flex:none;display:flex;align-items:center;gap:7px;padding:0 8px 0 12px;min-width:0;
    border-bottom:1px solid var(--border);font-family:var(--font-mono);font-size:11.5px;color:var(--muted-foreground);
    background:var(--sidebar)}
  .dockhead .b{color:var(--foreground);font-weight:600}
  .dockhead .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dockhead .sep{opacity:.6}
  .dockhead .spacer{margin-left:auto}
  .dockhead .iconbtn{width:26px;height:26px}
  .dockhead .iconbtn svg{width:13px;height:13px}
  .iconbtn.active{background:var(--accent);color:var(--foreground)}
  /* read-only file preview in the dock */
  .filepreview{font-family:var(--font-mono);font-size:11.5px;line-height:1.6;padding:6px 0}
  .filepreview .fl{display:grid;grid-template-columns:44px 1fr;white-space:pre;min-width:max-content}
  .filepreview .fl .ln{color:color-mix(in srgb, var(--muted-foreground) 55%, transparent);text-align:right;
    padding-right:10px;user-select:none;font-size:10px}
  .filepreview .fl .lc{padding-right:14px}
  /* agent header block — who holds the pane (Orca terminal header) */
  .agenthead{display:flex;align-items:center;gap:10px;padding:10px 12px;margin:0 0 10px;
    border:1px solid var(--border);border-radius:var(--radius);background:var(--card);
    box-shadow:0 1px 2px rgb(0 0 0 / .04)}
  .agenthead .ag{width:26px;height:26px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;
    font-family:var(--font-mono);font-size:11px;font-weight:700;flex:none}
  .agenthead .meta{min-width:0;display:flex;flex-direction:column;gap:1px}
  .agenthead .l1{font-size:12.5px;font-weight:600;display:flex;gap:8px;align-items:baseline}
  .agenthead .l1 .role{font-family:var(--font-mono);font-size:10.5px;font-weight:400;color:var(--muted-foreground)}
  .agenthead .l2{font-family:var(--font-mono);font-size:10.5px;color:var(--muted-foreground);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .agenthead .kind{margin-left:auto}
  /* terminal-style turn cards (Update blocks) in the thread */
  .turncard{max-width:88%;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
    padding:9px 12px;margin:10px 0;cursor:pointer;font-family:var(--font-mono);
    box-shadow:0 1px 2px rgb(0 0 0 / .04);
    transition:border-color .12s,background .12s}
  .turncard:hover{border-color:color-mix(in srgb, var(--muted-foreground) 38%, transparent);
    background:color-mix(in srgb, var(--accent) 40%, var(--card))}
  .turncard:hover .tchev{color:var(--foreground)}
  .turncard .tch{display:flex;align-items:center;gap:10px;font-size:12px;font-weight:600}
  .turncard .tca{color:var(--git-add);margin-left:auto}
  .turncard .tcd{color:var(--git-del)}
  .turncard .tchev{color:var(--muted-foreground)}
  .turncard .tcf{color:var(--muted-foreground);font-size:11px;margin-top:3px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .turncard .tcdiff{margin-top:8px;border-top:1px solid var(--border);max-height:320px;overflow:auto;cursor:auto}
  /* changes pane — per-file diff cards on the editor surface */
  .diffwrap{max-width:1000px;margin:0 auto}
  .dhead{display:flex;align-items:center;gap:10px;font-family:var(--font-mono);font-size:12px;
    color:var(--muted-foreground);margin:2px 2px 12px}
  /* every inline icon in a header/row is 14px — an unsized svg fills its
     container and reads as a stray glyph. */
  .dhead svg,.dfh svg,.frow svg,.dockhead svg,.rhead svg{width:14px;height:14px;flex:none}
  .dhead .branch{color:var(--foreground);font-weight:600}
  .dfile{border:1px solid var(--border);border-radius:var(--radius);margin-bottom:12px;overflow:hidden;
    background:var(--editor-surface);box-shadow:0 1px 2px rgb(0 0 0 / .05)}
  .dfh{display:flex;align-items:center;gap:8px;padding:7px 12px;background:var(--card);
    border-bottom:1px solid var(--border);font-family:var(--font-mono);font-size:12px;min-width:0}
  .dfh .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dfh .cadd{margin-left:auto;color:var(--git-add);flex:none}
  .dfh .cdel{color:var(--git-del);flex:none}
  .dcode{font-family:var(--font-mono);font-size:11.5px;line-height:1.6;overflow-x:auto;padding:6px 0}
  .dl{display:grid;grid-template-columns:34px 34px 14px 1fr;white-space:pre;min-width:max-content}
  .dl .ln{color:color-mix(in srgb, var(--muted-foreground) 55%, transparent);text-align:right;
    padding-right:7px;user-select:none;font-size:10px;line-height:inherit}
  .dl .lm{user-select:none;text-align:center}
  .dl .lc{padding-right:14px}
  .dl.full{display:block;padding:0 12px;min-width:0}
  .dl.add{background:color-mix(in srgb, var(--git-add) 13%, transparent);color:var(--git-add)}
  .dl.del{background:color-mix(in srgb, var(--git-del) 13%, transparent);color:var(--git-del)}
  .dl.hunk{color:var(--thread-ink);opacity:.85;padding-top:3px;padding-bottom:3px}
  .dl.meta{color:color-mix(in srgb, var(--muted-foreground) 70%, transparent)}
  /* right rail — multi-view: Explorer / Search / Source Control / Tasks (Orca) */
  .rail{display:none;grid-column:3;grid-row:1;flex-direction:column;min-width:0;position:relative;
    background:var(--sidebar);color:var(--sidebar-foreground);border-left:1px solid var(--sidebar-border)}
  .railbar{display:flex;align-items:center;gap:2px;height:40px;flex:none;padding:0 6px;
    box-shadow:inset 0 -1px 0 var(--sidebar-border)}
  .railbar .iconbtn{width:30px;height:30px}
  .railbar .iconbtn.active{background:var(--sidebar-accent);color:var(--foreground)}
  .railbar .iconbtn.active::after{content:"";position:absolute}
  .railbar .rvbtn{position:relative}
  .railbar .rvbtn.active::before{content:"";position:absolute;left:6px;right:6px;bottom:-6px;height:2px;
    border-radius:1px;background:var(--foreground)}
  .railbar .spacer{margin-left:auto}
  .rail .rhead{display:flex;align-items:center;gap:8px;height:30px;flex:none;padding:0 12px;
    font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;font-family:var(--font-mono);
    color:var(--muted-foreground);box-shadow:inset 0 -1px 0 var(--sidebar-border)}
  .rail .rhead .b{color:var(--foreground);text-transform:none;letter-spacing:0}
  .rail .rbody{flex:1;overflow-y:auto;overflow-x:hidden;padding:8px}
  .rail .rbody.pad{padding:12px}
  .rsec{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;
    color:var(--muted-foreground);font-family:var(--font-mono);margin:12px 2px 8px}
  .rsec:first-child{margin-top:0}
  .frow{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:var(--radius-sm);
    font-family:var(--font-mono);font-size:12px;cursor:pointer;min-width:0}
  .frow:hover{background:var(--sidebar-accent)}
  .frow .fst{width:14px;flex:none;text-align:center;font-weight:600}
  .frow .fp{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fst.add{color:var(--git-add)}
  .fst.mod{color:var(--git-mod)}
  .fst.del{color:var(--git-del)}
  /* explorer tree */
  .trow{display:flex;align-items:center;gap:6px;height:24px;padding:0 6px;border-radius:var(--radius-sm);
    font-size:12.5px;cursor:pointer;min-width:0;white-space:nowrap}
  .trow:hover{background:var(--sidebar-accent)}
  .trow .tw{width:12px;flex:none;color:var(--muted-foreground);display:inline-flex;justify-content:center}
  .trow .tw svg{width:11px;height:11px;transition:transform .12s}
  .trow.open .tw svg{transform:rotate(90deg)}
  .trow .ti{width:14px;flex:none;color:var(--muted-foreground);display:inline-flex}
  .trow .ti svg{width:13px;height:13px}
  .trow .tn{overflow:hidden;text-overflow:ellipsis}
  .trow.dir .tn{font-weight:500}
  .tchild{overflow:hidden}
  /* search */
  .rsearch{padding:8px}
  .rsearch input{width:100%;height:32px;background:transparent;border:1px solid var(--input);border-radius:var(--radius-md);
    color:var(--foreground);padding:0 10px;font:inherit;font-size:12.5px;outline:none}
  .dark .rsearch input{background:color-mix(in srgb, var(--input) 30%, transparent)}
  .rsearch input:focus-visible{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 45%, transparent)}
  .sres{display:flex;flex-direction:column;gap:1px;padding:6px 8px}
  .sres .frow .fp .dim{color:var(--muted-foreground)}
  .railcard{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
    padding:10px 12px;margin-bottom:8px;box-shadow:0 1px 2px rgb(0 0 0 / .05)}
  .railcard .rt{font-weight:600;font-size:12px;margin-bottom:3px;display:flex;align-items:center;gap:7px}
  .railcard .rm{color:var(--muted-foreground);font-family:var(--font-mono);font-size:11px;line-height:1.5;
    word-break:break-word}
  .railcard.warnc{border-left:2px solid var(--warn)}
  .railcard.threadc{border-left:2px solid color-mix(in srgb, var(--thread) 60%, transparent)}
  .rempty{color:color-mix(in srgb, var(--muted-foreground) 80%, transparent);
    font-family:var(--font-mono);font-size:11.5px;padding:2px 2px 6px}
  .taskbtn{width:100%;margin-bottom:10px}
  /* status bar (Orca, 25px) */
  .statusbar{grid-column:1 / -1;grid-row:2;display:flex;align-items:center;gap:14px;
    padding:0 12px;background:var(--sidebar);border-top:1px solid var(--sidebar-border);
    font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);
    user-select:none;min-width:0;overflow:hidden;white-space:nowrap}
  .statusbar .sit{display:inline-flex;align-items:center;gap:6px;flex:none}
  .sdot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex:none}
  .sdot.off{background:color-mix(in srgb, var(--muted-foreground) 50%, transparent)}
  .meter{width:56px;height:4px;border-radius:2px;flex:none;overflow:hidden;
    background:color-mix(in srgb, var(--muted-foreground) 25%, transparent)}
  .meter i{display:block;height:100%;border-radius:2px;
    background:color-mix(in srgb, var(--muted-foreground) 70%, transparent)}
  .dempty{flex:1;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;
    color:var(--muted-foreground);font-family:var(--font-mono);font-size:13px}
  .dempty .biglogo{font-size:36px;font-weight:650;letter-spacing:-.02em;color:var(--foreground)}
  .dempty .hair{width:48px;height:2px;border-radius:1px;
    background:linear-gradient(90deg,transparent,var(--thread),transparent)}
  /* ── Terminal dock (Orca bottom terminal splits) ──────── */
  .termdock{flex:none;display:none;flex-direction:column;height:240px;min-height:110px;max-height:70vh;
    border-top:1px solid var(--border);background:var(--editor-surface)}
  .termdock.open{display:flex}
  .termresize{height:5px;flex:none;cursor:row-resize;margin-top:-3px;position:relative;z-index:2}
  .termresize::after{content:"";position:absolute;left:0;right:0;top:2px;height:1px;background:transparent;transition:background .12s}
  .termresize:hover::after{background:var(--ring)}
  .termtabs{display:flex;align-items:center;gap:2px;height:30px;flex:none;padding:0 8px;
    border-bottom:1px solid var(--border);background:var(--sidebar)}
  .termtab{display:inline-flex;align-items:center;gap:7px;height:24px;padding:0 8px 0 10px;border-radius:6px;
    font-family:var(--font-mono);font-size:11.5px;color:var(--muted-foreground);cursor:pointer;border:1px solid transparent}
  .termtab:hover{color:var(--foreground);background:color-mix(in srgb, var(--accent) 55%, transparent)}
  .termtab.active{background:var(--editor-surface);color:var(--foreground);border-color:var(--border)}
  .termtab .tx{display:inline-flex;opacity:.5;border-radius:3px;width:15px;height:15px;align-items:center;justify-content:center}
  .termtab .tx:hover{opacity:1;background:var(--accent)}
  .termtab .tx svg{width:11px;height:11px}
  .termtabs .iconbtn{width:24px;height:24px}
  .termtabs .iconbtn svg{width:13px;height:13px}
  .termbody{flex:1;min-height:0;overflow-y:auto;padding:8px 12px;font-family:var(--font-mono);font-size:12px;
    line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--foreground);cursor:text}
  .termbody .pl{color:var(--muted-foreground)}
  .termbody .pl b{color:var(--ok);font-weight:400}
  .termbody .cmd{color:var(--foreground)}
  .termbody .eo{color:var(--err)}
  .termbody .ex{color:color-mix(in srgb, var(--muted-foreground) 75%, transparent)}
  .termbody .exbad{color:var(--err);opacity:.9}
  .termbody .hintl{color:color-mix(in srgb, var(--muted-foreground) 70%, transparent)}
  .termbody .run{color:var(--muted-foreground);opacity:.8}
  /* ANSI SGR → tokens (16-colour + bold/dim/underline) */
  .a-b{font-weight:700}.a-d{opacity:.65}.a-u{text-decoration:underline}.a-i{font-style:italic}
  .a-30{color:#555}.a-31{color:var(--git-del)}.a-32{color:var(--git-add)}.a-33{color:var(--warn)}
  .a-34{color:var(--thread-ink)}.a-35{color:var(--shuttle-ink)}.a-36{color:var(--thread-ink)}.a-37{color:var(--foreground)}
  .a-90{color:var(--muted-foreground)}.a-91{color:var(--err)}.a-92{color:var(--ok)}.a-93{color:var(--warn)}
  .a-94{color:var(--thread-ink)}.a-95{color:var(--shuttle-ink)}.a-96{color:var(--thread-ink)}.a-97{color:var(--foreground)}
  .terminput{flex:none;display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid var(--border)}
  .terminput .pr{color:var(--ok);font-family:var(--font-mono);font-size:12px;flex:none;
    max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .terminput .pr b{color:var(--muted-foreground);font-weight:400}
  .terminput input{flex:1;background:none;border:none;outline:none;box-shadow:none!important;color:var(--foreground);
    font-family:var(--font-mono);font-size:12px;letter-spacing:0;caret-color:var(--ok)}
  .terminput.busy input{opacity:.6}
  .terminput .st{flex:none;font-size:10px;font-family:var(--font-mono);color:var(--muted-foreground)}
  /* ── Sidebar top nav (Orca: Tasks / Search) ───────────── */
  .topnav{display:flex;flex-direction:column;gap:1px;padding:8px 8px 4px}
  .navitem{display:flex;align-items:center;gap:10px;height:32px;padding:0 10px;border-radius:var(--radius-md);
    font-size:13px;font-weight:500;color:var(--sidebar-foreground);cursor:pointer;border:1px solid transparent;
    transition:background .12s}
  .navitem:hover{background:var(--sidebar-accent)}
  .navitem svg{width:15px;height:15px;color:var(--muted-foreground)}
  .navitem .kbd{margin-left:auto;font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);
    border:1px solid var(--border);border-radius:4px;padding:0 5px;line-height:15px}
  /* ── Modal (Create task — Orca Create Worktree) ───────── */
  .scrim{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5);
    backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);
    display:flex;align-items:center;justify-content:center;padding:24px;animation:fade .15s ease}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  .modal{width:100%;max-width:440px;background:var(--popover);color:var(--popover-foreground);
    border:1px solid var(--glass-border);border-radius:var(--radius);overflow:hidden;
    box-shadow:0 24px 72px rgba(0,0,0,.42), inset 0 1px 0 var(--glass-highlight);animation:pop .16s ease}
  @keyframes pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
  .modalhead{display:flex;align-items:center;height:48px;padding:0 12px 0 16px;
    border-bottom:1px solid var(--border);font-size:15px;font-weight:600}
  .modalhead .iconbtn{margin-left:auto}
  .modalbody{padding:16px;display:flex;flex-direction:column;gap:14px;max-height:70vh;overflow-y:auto}
  .field{display:flex;flex-direction:column;gap:6px}
  .field label{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;
    color:var(--muted-foreground);font-family:var(--font-mono)}
  .field select,.field input,.field textarea{width:100%;background:transparent;border:1px solid var(--input);
    border-radius:var(--radius-md);color:var(--foreground);font:inherit;font-size:14px;outline:none;
    transition:border-color .15s,box-shadow .15s}
  .field select,.field input{height:38px;padding:0 11px}
  .field textarea{min-height:70px;padding:9px 11px;resize:vertical;line-height:1.55}
  .dark .field select,.dark .field input,.dark .field textarea{background:color-mix(in srgb, var(--input) 30%, transparent)}
  .dark .field select option{background:var(--popover);color:var(--popover-foreground)}
  .field select:focus-visible,.field input:focus-visible,.field textarea:focus-visible{border-color:var(--ring);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 50%, transparent)}
  .field .hintx{font-size:11px;color:var(--muted-foreground)}
  .disclose{font-size:12px;color:var(--muted-foreground);cursor:pointer;user-select:none;
    display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono)}
  .modalfoot{display:flex;gap:8px;justify-content:flex-end;align-items:center;
    padding:12px 16px;border-top:1px solid var(--border)}
  .modalfoot .kbd{font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);
    border:1px solid var(--border);border-radius:4px;padding:1px 6px;margin-left:6px}
  /* agent multi-select chips (one ADE, or several in sequence) */
  .agsel{display:flex;flex-wrap:wrap;gap:6px}
  .agchip{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px;border-radius:999px;
    border:1px solid var(--input);color:var(--foreground);background:transparent;cursor:pointer;font-size:12.5px;
    transition:background .12s,border-color .12s}
  .dark .agchip{background:color-mix(in srgb, var(--input) 22%, transparent)}
  .agchip:hover{border-color:color-mix(in srgb, var(--muted-foreground) 40%, transparent)}
  .agchip.sel{background:var(--primary);color:var(--primary-foreground);border-color:transparent;font-weight:600}
  .agchip .num{display:none;font-family:var(--font-mono);font-size:10px;width:16px;height:16px;border-radius:50%;
    align-items:center;justify-content:center;background:color-mix(in srgb, var(--primary-foreground) 25%, transparent)}
  .agchip.sel .num{display:inline-flex}
  .agchip .role{opacity:.6;font-size:10.5px;font-family:var(--font-mono)}
  .agchip.sel .role{opacity:.8}
  /* ── Native desktop chrome (Electron shell) ───────────── */
  html[data-electron] .sidebar .shead,
  html[data-electron] .tabstrip,
  html[data-electron] #root > .panel > header,
  html[data-electron] header.appbar,
  html[data-electron] .rail .rhead,
  html[data-electron] .dragstrip{-webkit-app-region:drag;user-select:none}
  html[data-electron] .sidebar .shead button,
  html[data-electron] .tabstrip button,
  html[data-electron] #root > .panel > header button,
  html[data-electron] header.appbar button,
  html[data-electron] .rail .rhead button,
  html[data-electron] .sidebar .shead .wordmark{-webkit-app-region:no-drag}
  .dragstrip{position:fixed;top:0;left:0;right:0;height:36px;z-index:50}
  html[data-electron="darwin"] .sidebar .shead{padding-left:84px}
  html[data-electron="darwin"] header.appbar{padding-left:88px}
  html[data-electron="darwin"] #root > .panel > header{padding-left:88px}
  /* on wide screens the app-shell fills the window and owns the height */
  @media (min-width:900px){
    #root{max-width:none;height:100dvh;display:block}
    .dmain .composer .inner{max-width:840px}
    .dmain > .panel > header{padding-left:18px;padding-right:14px}
    .srow .badge{font-size:10px;padding:0 7px}
  }
  .dshell.railopen .rail{display:flex}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body id="loom-app">
<div id="root"></div>
<div id="toast"></div>
<script>
(function(){
  "use strict";
  var TOKEN_KEY = "loomClientToken";
  var THEME_KEY = "loomTheme";
  var state = { token: localStorage.getItem(TOKEN_KEY) || "", projects: [], pid: null,
                project: null, selected: null, lastId: 0, ws: null, timers: [],
                tab: "thread", tree: null, wsLive: false, lastQuestion: null };
  var root = document.getElementById("root");

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]; }); }
  function toast(msg){ var t = document.getElementById("toast"); t.textContent = msg;
    t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(function(){ t.classList.remove("show"); }, 2600); }
  function hue(id){ var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; }
  function money(n){ return "$" + (n >= 0.01 ? n.toFixed(2) : n.toFixed(4)); }
  var LOADER = '<div class="loader"><i></i><i></i><i></i><i></i></div>';

  // Inline icon set — 24px grid, stroke 2, currentColor (no emoji, no CDN).
  function svg(inner){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>";
  }
  var ICONS = {
    back: svg('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
    up: svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
    thread: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    memory: svg('<path d="m12 3 8.5 4.7L12 12.5 3.5 7.7 12 3Z"/><path d="m3.5 12.2 8.5 4.8 8.5-4.8"/><path d="m3.5 16.6 8.5 4.8 8.5-4.8"/>'),
    // a changed file: document outline with a small +/- pair inside
    tree: svg('<path d="M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z"/><path d="M14 3v5h5"/><path d="M12 11.5v4"/><path d="M10 13.5h4"/><path d="M10 18h4"/>'),
    route: svg('<circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="5.5" r="2.5"/><path d="M8 18.5h5.5a4 4 0 0 0 4-4V8"/>'),
    branch: svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M15.5 8.5H11a5 5 0 0 0-5 5"/>'),
    refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>'),
    moon: svg('<path d="M20 12.5A8.5 8.5 0 1 1 11.5 4a6.7 6.7 0 0 0 8.5 8.5Z"/>'),
    unpair: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>'),
    help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.2 9a2.9 2.9 0 0 1 5.6 1c0 1.8-2.6 2.2-2.6 3.6"/><path d="M12 17h.01"/>'),
    plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
    panelRight: svg('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M15 4.5v15"/>'),
    terminal: svg('<path d="m5 8 4 4-4 4"/><path d="M12 16h6"/>'),
    x: svg('<path d="M18 6 6 18"/><path d="M6 6l12 12"/>'),
    tasks: svg('<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="m4 6 1 1 2-2"/><path d="m4 12 1 1 2-2"/><path d="m4 18 1 1 2-2"/>'),
    files: svg('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><path d="M14 2v6h6"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    file: svg('<path d="M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z"/><path d="M14 3v5h5"/>'),
    chevron: svg('<path d="m9 6 6 6-6 6"/>')
  };

  /**
   * Icon-only controls hold an <svg aria-hidden> and no text, so they have no
   * accessible name. Every one already carries a title for the tooltip, so
   * mirror that into aria-label. Done with an observer rather than at each
   * call site because most of this UI is rendered from strings, and a missed
   * call site is an unnamed button.
   */
  function nameIcon(b){
    if (b.getAttribute("aria-label") || b.textContent.trim()) return;
    b.setAttribute("aria-label", b.getAttribute("title"));
  }
  function labelIcons(el){
    if (el.matches && el.matches("button[title],a[title]")) nameIcon(el);
    Array.prototype.forEach.call(el.querySelectorAll("button[title],a[title]"), nameIcon);
  }
  new MutationObserver(function(muts){
    muts.forEach(function(m){
      Array.prototype.forEach.call(m.addedNodes, function(n){
        if (n.nodeType === 1) labelIcons(n);
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  function themeNow(){ return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; }
  function applyTheme(){
    var t = themeNow();
    document.documentElement.classList.toggle("dark", t !== "light");
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", t === "light" ? "#ffffff" : "#0a0a0a");
    var tb = document.getElementById("themebtn");
    if (tb) tb.innerHTML = t === "light" ? ICONS.moon : ICONS.sun;
  }
  function bindTheme(){
    var tb = document.getElementById("themebtn");
    if (!tb) return;
    tb.innerHTML = themeNow() === "light" ? ICONS.moon : ICONS.sun;
    tb.onclick = function(){
      localStorage.setItem(THEME_KEY, themeNow() === "light" ? "dark" : "light");
      applyTheme();
    };
  }
  var THEME_BTN = '<button id="themebtn" class="iconbtn" title="toggle theme"></button>';
  function isElectron(){ return document.documentElement.hasAttribute("data-electron"); }

  function clearTimers(){ state.timers.forEach(clearInterval); state.timers = [];
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; } }

  function api(path, opts){
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers["Authorization"] = "Bearer " + state.token;
    if (opts.body) opts.headers["Content-Type"] = "application/json";
    return fetch(path, opts).then(function(r){
      if (r.status === 401) { logout(); throw new Error("session revoked — pair again"); }
      return r.json().then(function(j){
        if (!r.ok) throw new Error(j.message || j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }
  function logout(){ state.token = ""; localStorage.removeItem(TOKEN_KEY); route(); }

  // ---- pairing -------------------------------------------------------------
  function pairFromHash(){
    var m = location.hash.match(/pair=([A-Za-z0-9]+)/);
    if (!m) return Promise.resolve(false);
    history.replaceState(null, "", location.pathname);
    return claim(m[1]);
  }
  function claim(tok){
    return fetch("/api/pair/claim", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tok, name: "phone" }) })
    .then(function(r){ return r.json().then(function(j){
      if (!r.ok) throw new Error(j.error || "pairing failed");
      state.token = j.clientToken; localStorage.setItem(TOKEN_KEY, state.token);
      return true; }); });
  }
  function renderPair(){
    clearTimers();
    clearShell();
    root.innerHTML =
      (isElectron() ? '<div class="dragstrip"></div>' : "") +
      '<div class="pairwrap">' +
      '<div class="biglogo">loom</div>' +
      '<div class="hair"></div>' +
      '<div class="tag">the shared-memory layer for your AI dev environments</div>' +
      '<input id="ptok" placeholder="pairing token or link" autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '<button class="btn primary" id="pgo">Pair this device</button>' +
      '<div class="help">On your computer: <b>loom up --tailnet</b>, then <b>loom pair</b>.<br>Scan the QR, or paste the token or whole link above.</div>' +
      '</div>';
    document.getElementById("pgo").onclick = function(){
      var v = (document.getElementById("ptok").value || "").trim();
      if (!v) return toast("paste the token from loom pair");
      try { var j = JSON.parse(v); if (j && j.token) v = j.token; } catch (e) {}
      var m = v.match(/pair=([A-Za-z0-9]+)/); if (m) v = m[1];
      claim(v).then(route).catch(function(err){ toast(err.message); });
    };
  }

  // ---- board (mobile) ------------------------------------------------------
  function renderBoard(){
    clearTimers();
    clearShell();
    root.innerHTML =
      '<header class="appbar"><span class="wordmark">lo<b>om</b></span><span class="sub">projects</span>' +
      '<span class="spacer"></span>' + THEME_BTN +
      '<button id="unpair" class="iconbtn" title="unpair this device">' + ICONS.unpair + "</button></header>" +
      '<main id="list">' + LOADER + "</main>";
    bindTheme();
    document.getElementById("unpair").onclick = logout;
    function refresh(){
      api("/api/projects").then(function(j){
        state.projects = j.projects || [];
        var el = document.getElementById("list");
        if (!el) return;
        if (!state.projects.length) { el.innerHTML = '<div class="sys" style="padding:40px 0;line-height:1.8">no projects woven yet<br><span style="opacity:.75">run <b class="mono" style="font-weight:500">loom init</b> in a repo on your computer</span></div>'; return; }
        el.innerHTML = state.projects.map(function(p){
          var r = p.route, act = r && (r.status === "running" || r.status === "waiting_human");
          return '<div class="card" data-id="' + esc(p.id) + '">' +
            '<div class="row1"><span class="dot' + (p.needsInput ? " hot" : "") + '"></span>' +
            '<span class="nm">' + esc(p.name) + "</span>" +
            (act ? '<span class="badge live">' + esc(r.name || "route") + " " + (r.current + 1) + "/" + r.steps.length + (r.status === "waiting_human" ? " \\u00b7 paused" : "") + "</span>" : "") +
            '</div>' +
            '<div class="row2">baton: ' + esc(p.holder || "\\u2014") +
            (p.costUsd > 0 ? " &middot; " + money(p.costUsd) : "") +
            (p.needsInput ? ' &middot; <span style="color:var(--warn)">needs input</span>' : "") + "</div></div>";
        }).join("");
        Array.prototype.forEach.call(el.querySelectorAll(".card"), function(card){
          card.onclick = function(){ location.hash = "#p/" + card.getAttribute("data-id"); };
        });
      }).catch(function(err){ toast(err.message); });
    }
    refresh();
    state.timers.push(setInterval(refresh, 5000));
  }

  // ---- event rendering -----------------------------------------------------
  function lineFor(e){
    var p = e.payload || {};
    if (e.kind === "message") {
      if (!e.agentId) {
        if (p.author === "loom") return '<div class="sys">\\u25b8 ' + esc(String(p.text).split("\\n")[0]) + "</div>";
        return '<div class="msg user"><div class="bubble">' + esc(p.text) + "</div></div>";
      }
      var h = hue(e.agentId);
      return '<div class="msg agent"><div class="who" style="color:hsl(' + h + ',60%,var(--agent-l))">' + esc(e.agentId) + '</div><div class="bubble" style="border-left-color:hsl(' + h + ',50%,var(--selvage-l))">' + esc(p.text) + "</div></div>";
    }
    if (e.kind === "tool_call") return '<div class="tool">\\u2699 ' + esc(p.summary || p.tool) + "</div>";
    if (e.kind === "file_edit") return '<div class="tool">\\u270e ' + esc(p.path) + "</div>";
    if (e.kind === "turn_diff") {
      var fl = (p.files || []).map(function(f){ return f.path; });
      var enc = p.patch ? encodeURIComponent(String(p.patch)) : "";
      var lbl = "Update(" + fl.length + " file" + (fl.length === 1 ? "" : "s") + ")";
      return '<div class="turncard" data-patch="' + enc + '" data-label="' + esc(lbl) + '">' +
        '<div class="tch"><span>\\u270e ' + lbl + "</span>" +
        '<span class="tca">+' + Number(p.added || 0) + '</span><span class="tcd">\\u2212' + Number(p.removed || 0) + "</span>" +
        '<span class="tchev">\\u25b8</span></div>' +
        '<div class="tcf">' + esc(fl.slice(0, 4).join(", ")) + (fl.length > 4 ? " \\u2026" : "") + "</div>" +
        '<div class="tcdiff" style="display:none"></div></div>';
    }
    if (e.kind === "handoff") return '<div class="handoff"><span class="a">' + esc(p.from || "\\u2014") + '</span><span class="shuttle">\\u27ff</span><span class="b">' + esc(p.to || "\\u2014") + "</span></div>";
    if (e.kind === "suggestion") return '<div class="sys warn">\\u2726 ' + esc(p.reason || "handoff suggested") + "</div>";
    if (e.kind === "needs_input") return '<div class="sys warn">\\u23f8 ' + esc(e.agentId) + " asks: " + esc(p.question) + "</div>";
    if (e.kind === "decision") return '<div class="sys">\\u2605 ' + esc(p.text) + "</div>";
    if (e.kind === "memory_import") return '<div class="sys" style="color:var(--thread-ink)">\\u25c8 imported ' + esc(p.file) + " into the shared brain</div>";
    if (e.kind === "error") return '<div class="sys err">\\u2717 ' + esc(p.message) + "</div>";
    if (e.kind === "route_started") {
      if (p.mode === "dynamic") return '<div class="sys">\\u25b8 route "auto" started \\u2014 ' + esc(p.router) + " picks each hop</div>";
      return '<div class="sys">\\u25b8 route started: ' + esc((p.steps || []).join(" \\u2192 ")) + "</div>";
    }
    if (e.kind === "route_step") {
      var pos = p.of ? "step " + (Number(p.step) + 1) + "/" + Number(p.of) : "hop " + (Number(p.step) + 1);
      return '<div class="sys">\\u25b8 ' + pos + " \\u2192 " + esc(p.agent) +
        (p.reason ? ' <span style="opacity:.7">(' + esc(p.reason) + ")</span>" : "") + "</div>";
    }
    if (e.kind === "route_paused") return '<div class="sys warn">\\u23f8 route paused \\u2014 ' + esc(p.agent) + " asks: " + esc(p.question) + "</div>";
    if (e.kind === "route_resumed") return '<div class="sys">\\u25b8 route resumed</div>';
    if (e.kind === "route_completed") return '<div class="sys ok">\\u2713 route completed</div>';
    if (e.kind === "route_failed") return '<div class="sys ' + (p.aborted ? "warn" : "err") + '">\\u2298 ' + esc(p.reason || "route ended") + "</div>";
    if (e.kind === "run_complete") return '<div class="tool">\\u2713 ' + esc(e.agentId) + " done</div>";
    return "";
  }

  // ---- diff parsing (changes pane + rail) ---------------------------------
  // Loom's own state dir is workspace noise, not the user's change set.
  function isLoomInternal(path){ return String(path || "").indexOf(".loom/") === 0; }
  function visibleFiles(t){ return (t && t.files ? t.files : []).filter(function(f){ return !isLoomInternal(f.path); }); }
  function splitPatch(patch){
    var parts = [];
    var cur = null;
    String(patch || "").split("\\n").forEach(function(line){
      var m = line.match(/^diff --git a\\/(.+) b\\/(.+)$/);
      if (m) { cur = { path: m[2], lines: [], add: 0, del: 0 }; parts.push(cur); return; }
      if (!cur) { cur = { path: "", lines: [], add: 0, del: 0 }; parts.push(cur); }
      cur.lines.push(line);
      if (line.charAt(0) === "+" && line.slice(0, 3) !== "+++") cur.add++;
      if (line.charAt(0) === "-" && line.slice(0, 3) !== "---") cur.del++;
    });
    return parts.filter(function(f){ return f.path || f.lines.join("").trim(); });
  }
  function diffLineClass(line){
    if (line.slice(0, 3) === "+++" || line.slice(0, 3) === "---" || line.slice(0, 5) === "index" || line.slice(0, 3) === "new" || line.slice(0, 7) === "deleted") return "meta";
    if (line.charAt(0) === "+") return "add";
    if (line.charAt(0) === "-") return "del";
    if (line.slice(0, 2) === "@@") return "hunk";
    return "";
  }
  // Unified diff lines with an old/new line-number gutter (Orca diff view).
  function renderDiffLines(lines){
    var oldN = 0, newN = 0, out = "";
    lines.forEach(function(line){
      var m = line.match(/^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);
      if (m) {
        oldN = Number(m[1]); newN = Number(m[2]);
        out += '<div class="dl hunk full">' + esc(line) + "</div>";
        return;
      }
      var c = diffLineClass(line);
      if (c === "meta") { out += '<div class="dl meta full">' + (esc(line) || " ") + "</div>"; return; }
      var ch = line.charAt(0);
      if (!oldN && !newN && ch !== "+" && ch !== "-") {
        out += '<div class="dl full">' + (esc(line) || " ") + "</div>";
        return;
      }
      var lo = "", ln = "", mark = "";
      if (c === "add") { ln = String(newN++); mark = "+"; }
      else if (c === "del") { lo = String(oldN++); mark = "\\u2212"; }
      else { lo = String(oldN++); ln = String(newN++); }
      var content = ch === "+" || ch === "-" || ch === " " ? line.slice(1) : line;
      out += '<div class="dl' + (c ? " " + c : "") + '">' +
        '<span class="ln">' + lo + '</span><span class="ln">' + ln + "</span>" +
        '<span class="lm">' + mark + "</span>" +
        '<span class="lc">' + (esc(content) || " ") + "</span></div>";
    });
    return out;
  }
  function renderDiffFiles(tree){
    var files = splitPatch(tree.patch).filter(function(f){ return !isLoomInternal(f.path); });
    files.forEach(function(f){
      f.lines = f.lines.filter(function(l){ return !/^\\?\\? new file: \\.loom\\//.test(l); });
    });
    files = files.filter(function(f){ return f.path || f.lines.join("").trim(); });
    if (!files.length) return '<div class="sys">working tree is clean</div>';
    return files.map(function(f, i){
      return '<div class="dfile" id="df-' + i + '">' +
        '<div class="dfh">' + ICONS.tree + '<span class="p">' + esc(f.path || "patch") + "</span>" +
        '<span class="cadd">+' + f.add + "</span><span class=\\"cdel\\">\\u2212" + f.del + "</span></div>" +
        '<div class="dcode">' + renderDiffLines(f.lines) + "</div></div>";
    }).join("");
  }

  // ---- project view (mobile: sheets · desktop: Orca workspace tabs) -------
  function renderProject(pid, mount, desktop){
    mount = mount || root;
    clearTimers();
    state.pid = pid; state.lastId = 0; state.selected = null;
    state.tab = "thread"; state.tree = null; state.lastQuestion = null;
    var expl = { kids: {}, open: {} }; // explorer tree cache — declared before any drawRail() call

    var headerActions =
      (desktop ? THEME_BTN : "") +
      (desktop ? "" :
        '<button id="brainbtn" class="iconbtn" title="unified memory">' + ICONS.memory + "</button>" +
        '<button id="treebtn" class="iconbtn" title="working tree">' + ICONS.tree + "</button>" +
        '<button id="routebtn" class="iconbtn" title="routes">' + ICONS.route + "</button>") +
      '<button id="stop" class="iconbtn" title="interrupt">' + ICONS.stop + "</button>";

    var composerHtml =
      '<div class="composer" id="composerwrap"><form class="inner" id="cform">' +
      '<input id="box" placeholder="Message&hellip;" autocomplete="off">' +
      '<button class="sendbtn" id="send" type="submit" title="send">' + ICONS.up + "</button></form>" +
      '<div class="hint" id="hint"></div></div>';

    if (desktop) {
      mount.innerHTML =
        '<div class="panel">' +
        // Orca chrome: the strip is the window top — context, tabs, actions.
        '<div class="tabstrip" id="tabstrip">' +
        '<div class="ptitle"><span class="nm" id="pname">&hellip;</span><span class="st" id="pstat"></span></div>' +
        '<span id="tabsbox" style="display:contents"></span>' +
        '<span class="spacer"></span>' +
        // &#96; is a backtick — a literal one would close this template literal
        '<button id="termbtn" class="iconbtn" title="toggle terminal (\\u2303&#96;)">' + ICONS.terminal + "</button>" +
        '<button id="railbtn" class="iconbtn" title="toggle right panel">' + ICONS.panelRight + "</button>" +
        headerActions +
        "</div>" +
        '<div class="paneswrap">' +
        '<div class="mainpane" id="mainpane">' +
        '<div class="pane scroll" id="pane-thread"><div id="agenthead" class="agenthead" style="display:none"></div><div id="routebar"></div><div id="feed">' + LOADER + "</div></div>" +
        '<div class="pane scroll" id="pane-brain" style="display:none">' + LOADER + "</div>" +
        '<div class="pane scroll" id="pane-routes" style="display:none"></div>' +
        composerHtml +
        "</div>" +
        '<div class="dockpane" id="dockpane">' +
        '<div class="rz rz-dock" id="rz-dock" title="drag to resize"></div>' +
        '<div class="dockhead" id="dockhead"><span class="di" id="dockicon"></span>' +
        '<span class="p" id="dockpath">changes</span><span class="spacer"></span>' +
        '<button id="dockclose" class="iconbtn" title="close">' + ICONS.x + "</button></div>" +
        '<div class="pane scroll" id="pane-changes">' + LOADER + "</div>" +
        "</div>" +
        "</div>" +
        '<div class="termdock" id="termdock">' +
        '<div class="termresize" id="termresize"></div>' +
        '<div class="termtabs"><span id="termtabs" style="display:contents"></span>' +
        '<button id="termadd" class="iconbtn" title="new terminal">' + ICONS.plus + "</button>" +
        '<span class="spacer"></span>' +
        '<button id="termhide" class="iconbtn" title="hide terminal">' + ICONS.x + "</button></div>" +
        '<div class="termbody" id="termbody"></div>' +
        '<form class="terminput" id="termform"><span class="pr">&#10095;</span>' +
        '<input id="terminput" placeholder="run a command\\u2026" autocomplete="off" autocapitalize="off" spellcheck="false">' +
        '<span class="st"></span></form>' +
        "</div>" +
        "</div>";
    } else {
      mount.innerHTML =
        '<div class="panel">' +
        "<header>" + '<button id="back" class="iconbtn" title="back">' + ICONS.back + "</button>" +
        '<div class="ptitle"><span class="nm" id="pname">&hellip;</span><span class="st" id="pstat"></span></div>' +
        '<span class="spacer"></span>' + headerActions + "</header>" +
        '<div class="chips" id="chips"></div>' +
        '<div class="scroll" id="pane-thread"><div id="routesheet"></div><div id="routebar"></div><div id="feed">' + LOADER + "</div></div>" +
        composerHtml +
        "</div>";
    }
    bindTheme();
    var backBtn = document.getElementById("back");
    if (backBtn) backBtn.onclick = function(){ location.hash = ""; };
    document.getElementById("stop").onclick = function(){
      api("/api/projects/" + pid + "/interrupt", { method: "POST", body: "{}" })
        .then(function(j){ toast(j.interrupted ? "interrupted " + j.interrupted : "nothing running"); })
        .catch(function(err){ toast(err.message); });
    };

    // ---- desktop tabs (Thread / Brain / Routes) ----------------------------
    function drawTabs(){
      var box = document.getElementById("tabsbox"); if (!box) return;
      var tabs = ["thread", "brain", "routes"];
      if (tabs.indexOf(state.tab) < 0) state.tab = "thread";
      var LBL = { thread: [ICONS.thread, "Thread"], brain: [ICONS.memory, "Brain"], routes: [ICONS.route, "Routes"] };
      box.innerHTML = tabs.map(function(tb){
        return '<button class="tab' + (state.tab === tb ? " active" : "") + '" data-tab="' + tb + '">' +
          LBL[tb][0] + LBL[tb][1] + "</button>";
      }).join("");
      Array.prototype.forEach.call(box.querySelectorAll(".tab"), function(tb){
        tb.onclick = function(){ showTab(tb.getAttribute("data-tab")); };
      });
    }
    function showTab(name){
      state.tab = name;
      ["thread", "brain", "routes"].forEach(function(t){
        var p = document.getElementById("pane-" + t);
        if (p) p.style.display = t === name ? "" : "none";
      });
      var strip = document.getElementById("tabstrip");
      if (strip) Array.prototype.forEach.call(strip.querySelectorAll(".tab"), function(tb){
        tb.classList.toggle("active", tb.getAttribute("data-tab") === name);
      });
      var cw = document.getElementById("composerwrap");
      if (cw) cw.style.display = name === "thread" ? "" : "none";
      if (name === "brain") refreshBrain();
      if (name === "routes") drawRoutesPane();
      if (name === "thread") {
        var sc = document.getElementById("pane-thread");
        if (sc) sc.scrollTop = sc.scrollHeight;
      }
    }

    // ---- diff/preview dock (right of the chat, opens on click) --------------
    function dockShowing(){ var d = document.getElementById("dockpane"); return d && d.classList.contains("open"); }
    function openDock(){ var d = document.getElementById("dockpane"); if (d) d.classList.add("open"); }
    function closeDock(){ var d = document.getElementById("dockpane"); if (d) d.classList.remove("open"); }
    function dockTitle(icon, label){
      var i = document.getElementById("dockicon"); if (i) i.innerHTML = icon || "";
      var h = document.getElementById("dockpath"); if (h) h.textContent = label || "";
    }
    // Show a working-tree file's diff (from the tree patch), or the whole tree.
    function openChangesDock(focusPath){
      openDock();
      dockTitle(focusPath ? ICONS.tree : ICONS.branch, focusPath || "Source control");
      var render = function(){
        var el = document.getElementById("pane-changes"); if (!el) return;
        var t = state.tree;
        if (!t) { el.innerHTML = LOADER; return; }
        if (!t.git) { el.innerHTML = '<div class="diffwrap"><div class="sys">not a git repository</div></div>'; return; }
        el.innerHTML = '<div class="diffwrap">' + renderDiffFiles(t) + "</div>";
        if (focusPath) {
          var files = splitPatch(t.patch).filter(function(f){ return !isLoomInternal(f.path); });
          var idx = -1;
          files.forEach(function(f, i){ if (f.path === focusPath) idx = i; });
          if (idx >= 0) { var tgt = document.getElementById("df-" + idx); if (tgt) tgt.scrollIntoView({ block: "start" }); }
        }
      };
      if (state.tree) render();
      else { document.getElementById("pane-changes").innerHTML = LOADER; api("/api/projects/" + pid + "/tree").then(function(j){ state.tree = j.tree || {}; render(); drawRail(); }).catch(function(){}); }
    }
    // Show a turn's combined patch (from a turn_diff card in the thread).
    function openPatchDock(patch, label){
      openDock();
      dockTitle(ICONS.tree, label || "changes");
      var el = document.getElementById("pane-changes");
      var files = splitPatch(patch);
      el.innerHTML = '<div class="diffwrap">' + (files.length
        ? files.map(function(f, i){
            return '<div class="dfile" id="df-' + i + '"><div class="dfh">' + ICONS.tree +
              '<span class="p">' + esc(f.path || "patch") + "</span>" +
              '<span class="cadd">+' + f.add + '</span><span class="cdel">\\u2212' + f.del + "</span></div>" +
              '<div class="dcode">' + renderDiffLines(f.lines) + "</div></div>";
          }).join("")
        : '<div class="dcode">' + renderDiffLines(String(patch).split("\\n")) + "</div>") + "</div>";
      var sc = el; if (sc) sc.scrollTop = 0;
    }
    // Show a read-only file preview (from Explorer clicks).
    function openFileDock(relPath){
      openDock();
      dockTitle(ICONS.file, relPath);
      var el = document.getElementById("pane-changes"); el.innerHTML = LOADER;
      api("/api/projects/" + pid + "/file?path=" + encodeURIComponent(relPath)).then(function(j){
        var lines = String(j.content || "").split("\\n");
        el.innerHTML = '<div class="filepreview">' + lines.map(function(line, i){
          return '<div class="fl"><span class="ln">' + (i + 1) + '</span><span class="lc">' + (esc(line) || " ") + "</span></div>";
        }).join("") + (j.truncated ? '<div class="sys">\\u2026 file truncated at 400KB</div>' : "") + "</div>";
        el.scrollTop = 0;
      }).catch(function(err){ el.innerHTML = '<div class="sys err">' + esc(err.message) + "</div>"; });
    }
    if (desktop) {
      document.getElementById("dockclose").onclick = closeDock;
      document.getElementById("railbtn").onclick = toggleRail;
      document.getElementById("termbtn").onclick = toggleTerm;
      state.openChangesDock = openChangesDock;
      state.openFileDock = openFileDock;
      if (!state.railView) state.railView = localStorage.getItem("loomRailView") || "explorer";
      applyRail();
      var dockEl = document.getElementById("dockpane");
      var savedDock = Number(localStorage.getItem("loomDockW"));
      if (savedDock) dockEl.style.width = savedDock + "px";
      makeResizer("rz-dock", {
        get: function(){ return dockEl.offsetWidth; },
        set: function(w){ dockEl.style.width = w + "px"; },
        min: 280,
        max: function(){
          var wrap = document.querySelector(".paneswrap");
          return Math.max(320, (wrap ? wrap.offsetWidth : window.innerWidth) - 380);
        },
        def: 520, key: "loomDockW", invert: true,
      });
      drawTabs();
      showTab("thread");
      drawRail();
    }

    // ---- terminal dock (a real shell session per tab) ----------------------
    var TERM_KEY = "loomTerm";
    var terms = [], activeTerm = null, termSeq = 0;
    function shortCwd(abs){
      var d = String(abs || "");
      var base = (state.project && state.project.dir) || "";
      if (base && d.indexOf(base) === 0) {
        var rest = d.slice(base.length).replace(/^[\\\\/]/, "");
        var name = base.split(/[\\\\/]/).filter(Boolean).pop() || "~";
        return rest ? name + "/" + rest : name;
      }
      var parts = d.split(/[\\\\/]/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : "~";
    }
    function curTerm(){ for (var i = 0; i < terms.length; i++) if (terms[i].id === activeTerm) return terms[i]; return null; }
    function termOpen(){ return desktop && localStorage.getItem(TERM_KEY) === "1"; }
    function applyTerm(){
      var dock = document.getElementById("termdock"); if (!dock) return;
      var on = termOpen();
      dock.classList.toggle("open", on);
      var tb = document.getElementById("termbtn");
      if (tb) tb.classList.toggle("active", on);
      if (on) { ensureTerm(); focusTermInput(); }
    }
    function toggleTerm(){
      localStorage.setItem(TERM_KEY, termOpen() ? "0" : "1");
      applyTerm();
    }
    function ensureTerm(){ if (!terms.length) addTerm(); }
    function focusTermInput(){ var i = document.getElementById("terminput"); if (i && termOpen()) setTimeout(function(){ i.focus(); }, 0); }
    function addTerm(){
      termSeq++;
      var id = "t" + termSeq;
      var t = { id: id, title: "Terminal " + termSeq, html: "", busy: false,
                cwd: (state.project && state.project.dir) || "", hist: [], hi: -1, draft: "" };
      terms.push(t);
      activeTerm = id;
      drawTermTabs();
      drawTermBody();
      focusTermInput();
      // open the shell for this tab; the daemon reports its starting cwd
      api("/api/projects/" + pid + "/term/open", { method: "POST", body: JSON.stringify({ term: id }) })
        .then(function(r){
          t.cwd = r.cwd || t.cwd;
          termAppend(t, '<div class="hintl">shell in ' + esc(shortCwd(t.cwd)) +
            " \\u00b7 \\u2303C interrupt \\u00b7 \\u2303L clear \\u00b7 \\u2191 history</div>");
          drawPrompt();
        })
        .catch(function(err){ termAppend(t, '<div class="eo">loom: ' + esc(err.message) + "</div>"); });
    }
    function closeTerm(id){
      var idx = -1;
      for (var i = 0; i < terms.length; i++) if (terms[i].id === id) idx = i;
      if (idx < 0) return;
      api("/api/projects/" + pid + "/term/close", { method: "POST", body: JSON.stringify({ term: id }) }).catch(function(){});
      terms.splice(idx, 1);
      if (activeTerm === id) activeTerm = terms.length ? terms[Math.max(0, idx - 1)].id : null;
      if (!terms.length) { localStorage.setItem(TERM_KEY, "0"); applyTerm(); return; }
      drawTermTabs();
      drawTermBody();
    }
    function drawTermTabs(){
      var box = document.getElementById("termtabs"); if (!box) return;
      box.innerHTML = terms.map(function(t){
        return '<span class="termtab' + (t.id === activeTerm ? " active" : "") + '" data-t="' + t.id + '">' +
          (t.busy ? '<span class="busy" style="width:8px;height:8px;color:var(--live)"></span>' : "") +
          esc(t.title) + '<span class="tx" data-close="' + t.id + '">' + ICONS.x + "</span></span>";
      }).join("");
      Array.prototype.forEach.call(box.querySelectorAll(".termtab"), function(el){
        el.onclick = function(ev){
          var c = ev.target.closest ? ev.target.closest("[data-close]") : null;
          if (c) { closeTerm(c.getAttribute("data-close")); return; }
          activeTerm = el.getAttribute("data-t"); drawTermTabs(); drawTermBody(); drawPrompt(); focusTermInput();
        };
      });
    }
    function drawTermBody(){
      var body = document.getElementById("termbody"); var t = curTerm();
      if (!body || !t) return;
      body.innerHTML = t.html;
      body.scrollTop = body.scrollHeight;
    }
    function drawPrompt(){
      var t = curTerm(); if (!t) return;
      var pr = document.querySelector(".terminput .pr");
      if (pr) pr.innerHTML = esc(shortCwd(t.cwd)) + " <b>\\u276f</b>";
      var row = document.querySelector(".terminput");
      if (row) row.classList.toggle("busy", !!t.busy);
      var st = document.querySelector(".terminput .st");
      if (st) st.textContent = t.busy ? "running \\u00b7 \\u2303C to stop" : "";
    }
    function termAppend(t, html){
      t.html += html;
      if (t.id === activeTerm) {
        var body = document.getElementById("termbody");
        if (body) {
          var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
          body.insertAdjacentHTML("beforeend", html);
          if (atBottom) body.scrollTop = body.scrollHeight;
        }
      }
    }
    /**
     * Minimal ANSI renderer: SGR colour/bold/underline become spans, other
     * escape sequences are dropped, and \\r rewinds to the last newline the way
     * a terminal overwrites a line (progress bars, spinners).
     */
    function ansiToHtml(text, openRef){
      var out = "";
      var i = 0;
      var cls = openRef.cls || [];
      function openSpan(){ return cls.length ? '<span class="' + cls.join(" ") + '">' : ""; }
      function closeSpan(){ return cls.length ? "</span>" : ""; }
      out += openSpan();
      while (i < text.length) {
        var ch = text.charAt(i);
        if (ch === "\\u001b") {
          var m = /^\\u001b\\[([0-9;]*)m/.exec(text.slice(i));
          if (m) {
            out += closeSpan();
            var codes = m[1] === "" ? ["0"] : m[1].split(";");
            codes.forEach(function(c){
              var n = Number(c);
              if (n === 0) cls = [];
              else if (n === 1) { if (cls.indexOf("a-b") < 0) cls.push("a-b"); }
              else if (n === 2) { if (cls.indexOf("a-d") < 0) cls.push("a-d"); }
              else if (n === 3) { if (cls.indexOf("a-i") < 0) cls.push("a-i"); }
              else if (n === 4) { if (cls.indexOf("a-u") < 0) cls.push("a-u"); }
              else if (n === 22) cls = cls.filter(function(x){ return x !== "a-b" && x !== "a-d"; });
              else if (n === 24) cls = cls.filter(function(x){ return x !== "a-u"; });
              else if (n === 39) cls = cls.filter(function(x){ return !/^a-[39]\\d$/.test(x); });
              else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
                cls = cls.filter(function(x){ return !/^a-[39]\\d$/.test(x); });
                cls.push("a-" + n);
              }
            });
            out += openSpan();
            i += m[0].length;
            continue;
          }
          // any other escape sequence: drop it
          var other = /^\\u001b[\\[\\]][0-9;?]*[a-zA-Z]?/.exec(text.slice(i));
          i += other ? other[0].length : 1;
          continue;
        }
        if (ch === "\\r") { i++; continue; } // \\r\\n handled by the \\n
        out += esc(ch);
        i++;
      }
      out += closeSpan();
      openRef.cls = cls;
      return out;
    }
    function runCmd(cmd){
      var t = curTerm(); if (!t) return;
      termAppend(t, '<div><span class="pl">' + esc(shortCwd(t.cwd)) + " <b>\\u276f</b></span> " +
        '<span class="cmd">' + esc(cmd) + "</span></div>");
      t.busy = true; drawTermTabs(); drawPrompt();
      api("/api/projects/" + pid + "/term/input", { method: "POST", body: JSON.stringify({ term: t.id, data: cmd }) })
        .catch(function(err){
          t.busy = false; drawTermTabs(); drawPrompt();
          termAppend(t, '<div class="eo">loom: ' + esc(err.message) + "</div>");
        });
    }
    function interruptTerm(){
      var t = curTerm(); if (!t || !t.busy) return;
      termAppend(t, '<div class="run">^C</div>');
      api("/api/projects/" + pid + "/term/signal", { method: "POST", body: JSON.stringify({ term: t.id }) })
        .catch(function(){});
    }
    function onTermFrame(frame){
      var t = null;
      for (var i = 0; i < terms.length; i++) if (terms[i].id === frame.term) t = terms[i];
      if (!t) return;
      if (frame.chunk !== undefined) {
        if (!t.ansi) t.ansi = { cls: [] };
        termAppend(t, ansiToHtml(String(frame.chunk), t.ansi));
      }
      if (frame.exit !== undefined) {
        t.busy = false;
        if (frame.cwd) t.cwd = frame.cwd;
        var code = Number(frame.exit);
        if (code !== 0) termAppend(t, '<div class="exbad">\\u2514 exit ' + code + "</div>");
        drawTermTabs(); drawPrompt();
      }
      if (frame.closed) {
        t.busy = false;
        termAppend(t, '<div class="ex">\\u2514 shell exited</div>');
        drawTermTabs(); drawPrompt();
      }
    }
    if (desktop) {
      document.getElementById("termhide").onclick = function(){ localStorage.setItem(TERM_KEY, "0"); applyTerm(); };
      document.getElementById("termadd").onclick = function(){ addTerm(); };
      // clicking anywhere in the output focuses the input, like a real terminal
      document.getElementById("termbody").addEventListener("mousedown", function(ev){
        if (String(window.getSelection() || "")) return; // don't steal a text selection
        if (ev.target.closest && ev.target.closest("a")) return;
        setTimeout(focusTermInput, 0);
      });
      var tin = document.getElementById("terminput");
      tin.addEventListener("keydown", function(e){
        var t = curTerm(); if (!t) return;
        if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
          if (!String(window.getSelection() || "")) { e.preventDefault(); interruptTerm(); }
          return;
        }
        if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
          e.preventDefault(); t.html = ""; t.ansi = { cls: [] }; drawTermBody(); return;
        }
        if (e.key === "ArrowUp") {
          if (!t.hist.length) return;
          e.preventDefault();
          if (t.hi === -1) { t.draft = this.value; t.hi = t.hist.length - 1; }
          else if (t.hi > 0) t.hi--;
          this.value = t.hist[t.hi];
          return;
        }
        if (e.key === "ArrowDown") {
          if (t.hi === -1) return;
          e.preventDefault();
          if (t.hi < t.hist.length - 1) { t.hi++; this.value = t.hist[t.hi]; }
          else { t.hi = -1; this.value = t.draft || ""; }
        }
      });
      document.getElementById("termform").addEventListener("submit", function(ev){
        ev.preventDefault();
        var inp = document.getElementById("terminput");
        var cmd = (inp.value || "").trim();
        var t = curTerm();
        inp.value = "";
        if (t) { t.hi = -1; t.draft = ""; }
        if (!cmd || !t) return;
        if (t.hist[t.hist.length - 1] !== cmd) t.hist.push(cmd);
        if (cmd === "clear") { t.html = ""; t.ansi = { cls: [] }; drawTermBody(); return; }
        runCmd(cmd);
      });
      // drag the top edge to resize the dock
      var rz = document.getElementById("termresize");
      rz.addEventListener("mousedown", function(ev){
        ev.preventDefault();
        var dock = document.getElementById("termdock");
        var startY = ev.clientY, startH = dock.offsetHeight;
        document.body.classList.add("resizing-x");
        function mv(e){ dock.style.height = Math.max(110, Math.min(window.innerHeight * 0.7, startH + (startY - e.clientY))) + "px"; }
        function up(){
          document.body.classList.remove("resizing-x");
          localStorage.setItem("loomTermH", String(dock.offsetHeight));
          document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
        }
        document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
      });
      var savedH = Number(localStorage.getItem("loomTermH"));
      if (savedH) document.getElementById("termdock").style.height = savedH + "px";
      state.toggleTerm = toggleTerm;
      applyTerm();
    }
    // click an Update(…) card in the thread → open its diff on the right
    // (desktop dock); on mobile, expand it inline.
    document.getElementById("feed").addEventListener("click", function(ev){
      var t = ev.target;
      while (t && t !== this && !(t.classList && t.classList.contains("turncard"))) t = t.parentNode;
      if (!t || t === this) return;
      if (ev.target.closest && ev.target.closest(".tcdiff")) return; // let diff text select/scroll
      var enc = t.getAttribute("data-patch"); if (!enc) return;
      var patch = decodeURIComponent(enc);
      if (desktop) { openPatchDock(patch, t.getAttribute("data-label") || "changes"); return; }
      var d = t.querySelector(".tcdiff"); if (!d) return;
      var open = d.style.display !== "none" && d.innerHTML;
      if (open) { d.style.display = "none"; }
      else {
        if (!d.innerHTML) d.innerHTML = '<div class="dcode">' + renderDiffLines(patch.split("\\n")) + "</div>";
        d.style.display = "";
      }
      var ch = t.querySelector(".tchev");
      if (ch) ch.textContent = open ? "\\u25b8" : "\\u25be";
    });

    // ---- working tree (feeds the Source Control rail view) -----------------
    function refreshTree(force){
      api("/api/projects/" + pid + "/tree").then(function(j){
        state.tree = j.tree || {};
        if (state.railView === "scm") drawRail();
      }).catch(function(err){ if (force) toast(err.message); });
    }

    // ---- brain pane ---------------------------------------------------------
    function refreshBrain(){
      var el = document.getElementById("pane-brain"); if (!el) return;
      el.innerHTML = '<div class="pane-inner">' + LOADER + "</div>";
      api("/api/projects/" + pid + "/memory").then(function(j){
        el = document.getElementById("pane-brain"); if (!el) return;
        var m = j.memory || {};
        var src = (m.sources || []).map(function(s){
          return '<div class="tool">' + esc(s.agentId) + " \\u2190 " + esc(s.file) + "</div>";
        }).join("");
        var body = esc(m.document || "").split("\\n").map(function(line){
          var c = line.charAt(0) === "#" ? "var(--foreground)" : "var(--muted-foreground)";
          var w = line.charAt(0) === "#" ? "600" : "400";
          return '<div style="color:' + c + ";font-weight:" + w + ';white-space:pre-wrap;word-break:break-word;font-size:12px;font-family:var(--font-mono)">' + (line || " ") + "</div>";
        }).join("");
        el.innerHTML = '<div class="pane-inner">' +
          '<span class="sub">one brain &middot; ' + (m.sources || []).length + " ADE source(s) &middot; " +
          (m.decisions || []).length + " decision(s)</span>" + src +
          '<div style="border-top:1px solid var(--border);padding-top:10px">' + body + "</div>" +
          '<div><button class="btn primary sm" id="reimport">re-import ADE memory</button></div></div>';
        document.getElementById("reimport").onclick = function(){
          api("/api/projects/" + pid + "/memory/import", { method: "POST", body: "{}" })
            .then(function(r){ toast(r.imported ? "imported " + r.imported + " source(s)" : "brain already current"); refreshBrain(); })
            .catch(function(err){ toast(err.message); });
        };
      }).catch(function(err){ toast(err.message); });
    }

    // ---- routes pane (desktop) / sheet (mobile) -----------------------------
    function routeFormHtml(){
      var names = (state.project && state.project.routeNames) || ["auto"];
      return "<label>pipeline</label>" +
        '<select id="rsel">' +
        names.map(function(n){
          return '<option value="' + esc(n) + '">' + esc(n === "auto" ? "auto \\u2014 LLM picks each hop" : n) + "</option>";
        }).join("") +
        '<option value="__custom">custom steps&hellip;</option></select>' +
        '<input id="rsteps" placeholder="steps e.g. planner,executor" style="display:none">' +
        '<input id="rtask" placeholder="what should they do?">' +
        '<div class="row"><button class="btn primary" id="rgo">Start route</button></div>';
    }
    function bindRouteForm(after){
      var sel = document.getElementById("rsel"); if (!sel) return;
      sel.onchange = function(){
        document.getElementById("rsteps").style.display = this.value === "__custom" ? "" : "none";
      };
      document.getElementById("rgo").onclick = function(){
        var task = (document.getElementById("rtask").value || "").trim();
        if (!task) return toast("describe the task first");
        var spec = sel.value === "__custom" ? (document.getElementById("rsteps").value || "").trim() : sel.value;
        if (!spec) return toast("give steps like planner,executor");
        api("/api/projects/" + pid + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: spec }) })
          .then(function(){ refresh(); toast("route started"); if (after) after(); })
          .catch(function(err){ toast(err.message); });
      };
    }
    function drawRoutesPane(){
      var el = document.getElementById("pane-routes"); if (!el) return;
      var p = state.project;
      var r = p && p.route;
      var live = r && (r.status === "running" || r.status === "waiting_human");
      el.innerHTML = '<div class="pane-inner">' +
        (live
          ? '<div class="railcard threadc" style="margin:0"><div class="rt">' + esc(r.name || "route") + " \\u00b7 " +
            (r.mode === "dynamic" ? "hop " + (r.current + 1) : "step " + (r.current + 1) + "/" + r.steps.length) +
            '</div><div class="rm">' + esc(r.steps[r.current] || "") +
            (r.status === "waiting_human" ? " \\u2014 \\u23f8 " + esc(r.pendingQuestion || "waiting for you") : "") + "</div>" +
            '<div style="margin-top:8px"><button class="btn xs outline" id="rabort2">abort route</button></div></div>'
          : "") +
        '<div class="formcol">' + routeFormHtml() + "</div></div>";
      bindRouteForm(function(){ drawRoutesPane(); });
      var ab = document.getElementById("rabort2");
      if (ab) ab.onclick = function(){
        api("/api/projects/" + pid + "/route", { method: "DELETE" })
          .then(function(){ toast("route aborted"); refresh(); drawRoutesPane(); })
          .catch(function(err){ toast(err.message); });
      };
    }

    // ---- mobile sheets -------------------------------------------------------
    var brainOpen = false, treeOpen = false, sheetOpen = false;
    if (!desktop) {
      document.getElementById("brainbtn").onclick = function(){
        brainOpen = !brainOpen; treeOpen = false;
        var el = document.getElementById("routesheet");
        if (!brainOpen) { el.innerHTML = ""; return; }
        el.innerHTML = '<div class="sheet"><label>unified memory</label>' + LOADER + "</div>";
        api("/api/projects/" + pid + "/memory").then(function(j){
          if (!brainOpen) return;
          var m = j.memory || {};
          var head = "<label>one brain &middot; " + (m.sources || []).length +
            " ADE source(s) &middot; " + (m.decisions || []).length + " decision(s)</label>";
          var src = (m.sources || []).map(function(s){
            return '<div class="tool">' + esc(s.agentId) + " \\u2190 " + esc(s.file) + "</div>";
          }).join("");
          var body = esc(m.document || "").split("\\n").map(function(line){
            var c = line.charAt(0) === "#" ? "var(--foreground)" : "var(--muted-foreground)";
            return '<div style="color:' + c + ';white-space:pre-wrap;word-break:break-word;font-size:12px;font-family:var(--font-mono)">' + (line || " ") + "</div>";
          }).join("");
          el.innerHTML = '<div class="sheet">' + head + src +
            '<div class="scrollable" style="max-height:46vh;overflow:auto;border-top:1px solid var(--border);padding-top:8px">' + body + "</div>" +
            '<button class="btn primary" id="reimport">re-import ADE memory</button></div>';
          document.getElementById("reimport").onclick = function(){
            api("/api/projects/" + pid + "/memory/import", { method: "POST", body: "{}" })
              .then(function(r){ toast(r.imported ? "imported " + r.imported + " source(s)" : "brain already current"); brainOpen = false; document.getElementById("brainbtn").click(); })
              .catch(function(err){ toast(err.message); });
          };
        }).catch(function(err){ toast(err.message); });
      };
      document.getElementById("treebtn").onclick = function(){
        treeOpen = !treeOpen; brainOpen = false;
        var el = document.getElementById("routesheet");
        if (!treeOpen) { el.innerHTML = ""; return; }
        el.innerHTML = '<div class="sheet"><label>working tree</label>' + LOADER + "</div>";
        api("/api/projects/" + pid + "/tree").then(function(j){
          if (!treeOpen) return;
          var t = j.tree || {};
          if (!t.git) { el.innerHTML = '<div class="sheet"><label>working tree</label><div class="sys">not a git repository</div></div>'; return; }
          var head = "<label>working tree &middot; " + esc(t.branch || "") + " &middot; " +
            (t.files || []).length + " changed</label>";
          var list = (t.files || []).map(function(f){
            return '<div class="tool">' + esc(f.status) + " " + esc(f.path) + "</div>";
          }).join("");
          var patch = (t.patch || "").split("\\n").map(function(line){
            var c = line.charAt(0) === "+" ? "var(--git-add)" : line.charAt(0) === "-" ? "var(--git-del)" : "var(--muted-foreground)";
            return '<div style="color:' + c + ';white-space:pre-wrap;word-break:break-all">' + esc(line) + "</div>";
          }).join("");
          el.innerHTML = '<div class="sheet">' + head + list +
            '<div class="scrollable" style="font-family:var(--font-mono);font-size:11px;max-height:40vh;overflow:auto;border-top:1px solid var(--border);padding-top:8px">' +
            (patch || '<div class="sys">clean</div>') + "</div></div>";
        }).catch(function(err){ toast(err.message); });
      };
      document.getElementById("routebtn").onclick = function(){
        sheetOpen = !sheetOpen; treeOpen = false; brainOpen = false;
        var el = document.getElementById("routesheet"); if (!el) return;
        if (!sheetOpen) { el.innerHTML = ""; return; }
        el.innerHTML = '<div class="sheet">' + routeFormHtml() + "</div>";
        bindRouteForm(function(){ sheetOpen = false; document.getElementById("routesheet").innerHTML = ""; });
      };
    }

    // ---- right rail (source control) ----------------------------------------
    // ---- right rail: Explorer / Search / Source Control / Tasks ------------
    function railTitle(html){ var h = document.getElementById("railtitle"); if (h) h.innerHTML = html; }
    function openFileFromTree(relPath){
      var t = state.tree;
      var changed = t && t.git && visibleFiles(t).some(function(f){ return f.path === relPath; });
      if (changed) openChangesDock(relPath); else openFileDock(relPath);
    }
    function drawRail(){
      var el = document.getElementById("railbody"); if (!el) return;
      var bar = document.querySelector(".railbar");
      if (bar) Array.prototype.forEach.call(bar.querySelectorAll(".rvbtn"), function(b){
        b.classList.toggle("active", b.getAttribute("data-view") === state.railView);
      });
      el.className = "rbody" + (state.railView === "explorer" || state.railView === "search" ? "" : " pad");
      if (state.railView === "search") return drawSearch(el);
      if (state.railView === "scm") return drawScm(el);
      if (state.railView === "tasks") return drawTasksView(el);
      return drawExplorer(el);
    }
    function renderTreeLevel(rel, depth){
      var kids = expl.kids[rel]; if (!kids) return "";
      return kids.map(function(e){
        var pad = 6 + depth * 12;
        if (e.dir) {
          var isOpen = !!expl.open[e.path];
          return '<div class="trow dir' + (isOpen ? " open" : "") + '" data-dir="' + esc(e.path) + '" style="padding-left:' + pad + 'px">' +
            '<span class="tw">' + ICONS.chevron + '</span><span class="ti">' + ICONS.folder + '</span><span class="tn">' + esc(e.name) + "</span></div>" +
            (isOpen ? '<div class="tchild">' + renderTreeLevel(e.path, depth + 1) + "</div>" : "");
        }
        return '<div class="trow file" data-file="' + esc(e.path) + '" style="padding-left:' + (pad + 12) + 'px">' +
          '<span class="ti">' + ICONS.file + '</span><span class="tn">' + esc(e.name) + "</span></div>";
      }).join("");
    }
    function loadDir(rel){
      api("/api/projects/" + pid + "/files?dir=" + encodeURIComponent(rel)).then(function(j){
        expl.kids[rel] = j.entries || [];
        if (state.railView === "explorer") drawExplorer(document.getElementById("railbody"));
      }).catch(function(err){ toast(err.message); });
    }
    state.refreshExplorer = function(){
      expl.kids = {}; // keep folders open, re-read their contents
      var open = Object.keys(expl.open).filter(function(k){ return expl.open[k]; });
      drawExplorer(document.getElementById("railbody"));
      open.forEach(function(d){ loadDir(d); });
    };
    function drawExplorer(el){
      railTitle('<span class="b">' + esc(state.project ? state.project.name : "Explorer") + "</span>");
      if (!expl.kids["."]) { el.innerHTML = LOADER; loadDir("."); return; }
      el.innerHTML = renderTreeLevel(".", 0) || '<div class="rempty">this project has no files yet</div>';
      Array.prototype.forEach.call(el.querySelectorAll(".trow"), function(row){
        row.onclick = function(){
          var d = row.getAttribute("data-dir");
          if (d) {
            expl.open[d] = !expl.open[d];
            if (expl.open[d] && !expl.kids[d]) loadDir(d);
            else drawExplorer(el);
            return;
          }
          var f = row.getAttribute("data-file");
          if (f) openFileFromTree(f);
        };
      });
    }
    function drawSearch(el){
      railTitle('<span class="b">Search</span>');
      el.innerHTML = '<div class="rsearch"><input id="rsearchi" placeholder="find files by name\\u2026" autocomplete="off" spellcheck="false"></div>' +
        '<div class="sres" id="sres"></div>' +
        '<div class="rempty" id="shint">type to find files by name in this project</div>';
      var inp = document.getElementById("rsearchi");
      if (state.railSearchQ) inp.value = state.railSearchQ;
      var to;
      inp.oninput = function(){ state.railSearchQ = this.value; clearTimeout(to); to = setTimeout(runSearch, 220); };
      inp.onkeydown = function(e){ if (e.key === "Enter") { clearTimeout(to); runSearch(); } };
      setTimeout(function(){ inp.focus(); }, 20);
      if (state.railSearchQ) runSearch();
    }
    function runSearch(){
      var q = (state.railSearchQ || "").trim();
      var res = document.getElementById("sres"); if (!res) return;
      var hint = document.getElementById("shint");
      if (hint) hint.style.display = q ? "none" : "";
      if (!q) { res.innerHTML = ""; return; }
      res.innerHTML = '<div class="rempty">searching\\u2026</div>';
      api("/api/projects/" + pid + "/find?q=" + encodeURIComponent(q)).then(function(j){
        res = document.getElementById("sres"); if (!res) return;
        var m = j.matches || [];
        if (!m.length) { res.innerHTML = '<div class="rempty">no files match</div>'; return; }
        res.innerHTML = m.map(function(pth){
          var name = pth.split("/").pop();
          var dir = pth.slice(0, pth.length - name.length);
          return '<div class="frow" data-file="' + esc(pth) + '"><span style="color:var(--muted-foreground);display:inline-flex">' + ICONS.file + "</span>" +
            '<span class="fp">' + esc(name) + ' <span class="dim">' + esc(dir) + "</span></span></div>";
        }).join("");
        Array.prototype.forEach.call(res.querySelectorAll(".frow[data-file]"), function(row){
          row.onclick = function(){ openFileFromTree(row.getAttribute("data-file")); };
        });
      }).catch(function(err){ var r = document.getElementById("sres"); if (r) r.innerHTML = '<div class="rempty">' + esc(err.message) + "</div>"; });
    }
    function drawScm(el){
      railTitle('<span class="b">Source control</span>');
      var p = state.project, t = state.tree, r = p && p.route;
      var live = r && (r.status === "running" || r.status === "waiting_human");
      var html = "";
      if (p && p.needsInput) {
        html += '<div class="railcard warnc"><div class="rt"><span class="dot hot"></span>needs input</div>' +
          '<div class="rm">' + esc(state.lastQuestion || (r && r.pendingQuestion) || "an agent is waiting for you \\u2014 reply in the thread") + "</div></div>";
      }
      if (live) {
        html += '<div class="railcard threadc"><div class="rt">' + esc(r.name || "route") + " \\u00b7 " +
          (r.mode === "dynamic" ? "hop " + (r.current + 1) : "step " + (r.current + 1) + "/" + r.steps.length) +
          '</div><div class="rm">\\u25b8 ' + esc(r.steps[r.current] || "") + "</div></div>";
      }
      html += '<div class="rsec">Changes</div>';
      if (!t) { el.innerHTML = html + '<div class="rempty">loading\\u2026</div>'; refreshTree(false); return; }
      if (!t.git) { el.innerHTML = html + '<div class="rempty">not a git repository</div>'; return; }
      html += '<div class="frow" style="cursor:default"><span style="display:inline-flex;color:var(--muted-foreground)">' + ICONS.branch + "</span>" +
        '<span class="fp" style="color:var(--foreground);font-weight:600">' + esc(t.branch || "") + "</span></div>";
      var files = visibleFiles(t);
      if (!files.length) html += '<div class="rempty">clean \\u2014 nothing to stage</div>';
      else files.forEach(function(f){
        var st = String(f.status || "").trim();
        var cls = st.indexOf("D") >= 0 ? "del" : (st.indexOf("M") >= 0 ? "mod" : "add");
        html += '<div class="frow" data-file="' + esc(f.path) + '"><span class="fst ' + cls + '">' + esc(st) + "</span>" +
          '<span class="fp">' + esc(f.path) + "</span></div>";
      });
      el.innerHTML = html;
      Array.prototype.forEach.call(el.querySelectorAll(".frow[data-file]"), function(row){
        row.onclick = function(){ openChangesDock(row.getAttribute("data-file")); };
      });
    }
    function drawTasksView(el){
      railTitle('<span class="b">Tasks</span>');
      var p = state.project;
      var adapters = p ? p.agents.filter(function(a){ return a.tier === "adapter"; }) : [];
      var r = p && p.route;
      var live = r && (r.status === "running" || r.status === "waiting_human");
      var html = '<button class="btn primary sm taskbtn" id="railnewtask">+ New task</button>';
      if (live) {
        html += '<div class="railcard threadc"><div class="rt">' + esc(r.name || "route") + " \\u00b7 " +
          (r.mode === "dynamic" ? "hop " + (r.current + 1) : "step " + (r.current + 1) + "/" + r.steps.length) +
          '</div><div class="rm">\\u25b8 ' + esc(r.steps[r.current] || "") +
          (r.status === "waiting_human" ? " \\u2014 \\u23f8 " + esc(r.pendingQuestion || "waiting") : "") + "</div></div>";
      }
      html += '<div class="rsec">Assign to</div>';
      if (!adapters.length) html += '<div class="rempty">no agents configured</div>';
      else adapters.forEach(function(a){
        var hh = hue(a.id);
        html += '<div class="frow" data-agent="' + esc(a.id) + '"><span class="adot' + (a.busy ? " busy" : "") + '"></span>' +
          '<span class="fp" style="color:hsl(' + hh + ',55%,var(--agent-l))">' + esc(a.id) + "</span>" +
          '<span style="margin-left:auto;color:var(--muted-foreground);font-size:10.5px">' + esc(a.role) + "</span></div>";
      });
      el.innerHTML = html;
      document.getElementById("railnewtask").onclick = function(){ openTaskModal(pid); };
      Array.prototype.forEach.call(el.querySelectorAll(".frow[data-agent]"), function(row){
        row.onclick = function(){ openTaskModal(pid, [row.getAttribute("data-agent")]); };
      });
    }
    state.drawRail = drawRail;

    // ---- status (title, chips, routebar, rail, statusbar) --------------------
    function drawChips(){
      var p = state.project; if (!p) return;
      var chips = document.getElementById("chips");
      if (!chips) return;
      var adapters = p.agents.filter(function(a){ return a.tier === "adapter"; });
      if (state.selected === null) state.selected = p.holder || (adapters[0] && adapters[0].id) || null;
      chips.innerHTML = adapters.map(function(a){
        var sel = a.id === state.selected;
        return '<button class="chip' + (sel ? " sel" : "") + '" data-id="' + esc(a.id) + '">' +
          esc(a.id) + ' <span class="role">' + esc(a.role) + (a.id === p.holder ? " \\u2190" : "") + "</span>" +
          (a.busy ? ' <span class="busy"></span>' : "") + "</button>";
      }).join("");
      Array.prototype.forEach.call(chips.querySelectorAll(".chip"), function(chip){
        chip.onclick = function(){ state.selected = chip.getAttribute("data-id"); drawStatus(); };
      });
    }
    function drawStatus(){
      var p = state.project; if (!p) return;
      var adapters = p.agents.filter(function(a){ return a.tier === "adapter"; });
      if (state.selected === null) state.selected = p.holder || (adapters[0] && adapters[0].id) || null;
      var nm = document.getElementById("pname"); if (nm) nm.textContent = p.name;
      var stat = document.getElementById("pstat");
      if (stat) stat.textContent = p.needsInput ? "needs input" : p.costUsd > 0 ? money(p.costUsd) : "";
      var hint = document.getElementById("hint");
      if (hint) hint.textContent = state.selected && state.selected !== p.holder
        ? "send will shift the baton to " + state.selected
        : (desktop ? "select an agent in the sidebar \\u00b7 baton: " : "tap a chip to shift agents \\u00b7 baton: ") + (p.holder || "\\u2014");
      if (!desktop) drawChips();
      // agent header block — who the composer talks to, and where
      var ah = document.getElementById("agenthead");
      if (ah) {
        var focus = null;
        adapters.forEach(function(a){ if (a.id === (state.selected || p.holder)) focus = a; });
        if (!focus) focus = adapters[0] || null;
        if (focus) {
          var hh = hue(focus.id);
          ah.innerHTML =
            '<span class="ag" style="background:color-mix(in srgb, hsl(' + hh + ',60%,50%) 18%, transparent);color:hsl(' + hh + ',60%,var(--agent-l))">' + esc(focus.id.slice(0, 2)) + "</span>" +
            '<span class="meta"><span class="l1">' + esc(focus.id) +
            '<span class="role">' + esc(focus.role) + (focus.id === p.holder ? " \\u00b7 baton" : "") + (focus.busy ? " \\u00b7 working\\u2026" : "") + "</span></span>" +
            '<span class="l2">' + esc(p.dir || p.name) + "</span></span>" +
            '<span class="badge kind">' + esc(focus.kind || "agent") + "</span>";
          ah.style.display = "";
        } else {
          ah.style.display = "none";
        }
      }
      var bar = document.getElementById("routebar");
      var r = p.route;
      if (bar) {
        if (r && (r.status === "running" || r.status === "waiting_human")) {
          var pos = r.mode === "dynamic"
            ? "hop " + (r.current + 1) + (r.maxHops ? " of \\u2264" + r.maxHops : "")
            : "step " + (r.current + 1) + "/" + r.steps.length;
          bar.innerHTML = '<div class="routebar"><button class="abort btn xs outline" id="rabort">abort</button>\\u25b8 ' +
            esc(r.name || "route") + " " + pos + " &middot; " + esc(r.steps[r.current]) +
            (r.mode === "dynamic" && r.reason ? '<span style="opacity:.7"> &mdash; ' + esc(r.reason) + "</span>" : "") +
            (r.status === "waiting_human" ? '<div class="q">\\u23f8 ' + esc(r.pendingQuestion || "waiting for you") + " \\u2014 reply below to resume</div>" : "") + "</div>";
          var ab = document.getElementById("rabort");
          if (ab) ab.onclick = function(){
            api("/api/projects/" + pid + "/route", { method: "DELETE" })
              .then(function(){ toast("route aborted"); refresh(); })
              .catch(function(err){ toast(err.message); });
          };
        } else { bar.innerHTML = ""; }
      }
      // only the live views (Source Control, Tasks) redraw on status polls;
      // Explorer/Search are user-driven so they aren't torn down mid-scroll.
      if (desktop) {
        if (state.railView === "scm" || state.railView === "tasks") drawRail();
        drawStatusbar();
      }
    }

    function refresh(){
      api("/api/projects/" + pid).then(function(j){
        state.project = j.project;
        drawStatus();
      }).catch(function(err){ toast(err.message); });
    }

    // ---- feed + live websocket ----------------------------------------------
    function append(events){
      var feed = document.getElementById("feed"); if (!feed) return;
      // only the loading placeholder gets cleared — never real history
      if (feed.firstChild && feed.firstChild.className === "loader") feed.innerHTML = "";
      var html = "";
      events.forEach(function(e){
        if (e.id <= state.lastId) return;
        state.lastId = e.id;
        if (e.kind === "needs_input" && e.payload) state.lastQuestion = e.payload.question || null;
        html += lineFor(e);
      });
      if (html) { feed.insertAdjacentHTML("beforeend", html);
        var sc = feed.parentNode;
        if (sc && sc.scrollHeight) sc.scrollTop = sc.scrollHeight;
        else window.scrollTo(0, document.body.scrollHeight); }
    }

    // Live frames that race the history fetch wait their turn, so an early
    // WS event can't outrun (and id-mask) the backlog.
    var historyLoaded = false, pendingWs = [];
    function flushPending(){
      historyLoaded = true;
      if (pendingWs.length) { append(pendingWs); pendingWs = []; }
    }
    api("/api/projects/" + pid + "/events?limit=60")
      .then(function(j){ append(j.events || []); flushPending(); })
      .catch(function(err){ toast(err.message); flushPending(); });
    refresh();
    state.timers.push(setInterval(refresh, 4000));
    if (desktop) {
      refreshTree(false);
      state.timers.push(setInterval(function(){ refreshTree(false); }, 5000));
    }

    function connect(){
      var proto = location.protocol === "https:" ? "wss://" : "ws://";
      var ws = new WebSocket(proto + location.host + "/ws?token=" + encodeURIComponent(state.token) + "&project=" + encodeURIComponent(pid));
      state.ws = ws;
      ws.onopen = function(){ state.wsLive = true; drawStatusbar(); };
      ws.onmessage = function(ev){
        try {
          var frame = JSON.parse(ev.data);
          if (frame.type === "term") { onTermFrame(frame); return; }
          if (frame.type === "event" && frame.event) {
            if (historyLoaded) append([frame.event]);
            else pendingWs.push(frame.event);
          }
        } catch (e) {}
      };
      ws.onclose = function(){
        state.wsLive = false; drawStatusbar();
        if (state.pid === pid) state.timers.push(setTimeout(connect, 3000));
      };
    }
    connect();

    function send(){
      var box = document.getElementById("box");
      var text = (box.value || "").trim();
      if (!text) return;
      box.value = "";
      var p = state.project || {};
      var chain = Promise.resolve();
      if (state.selected && state.selected !== p.holder) {
        chain = api("/api/projects/" + pid + "/handoff", { method: "POST", body: JSON.stringify({ to: state.selected }) });
      }
      chain.then(function(){
        return api("/api/projects/" + pid + "/messages", { method: "POST", body: JSON.stringify({ text: text, agentId: state.selected || undefined }) });
      }).then(refresh).catch(function(err){ toast(err.message); });
    }
    document.getElementById("cform").addEventListener("submit", function(ev){
      ev.preventDefault(); send();
    });
  }

  // ---- status bar (desktop shell) ------------------------------------------
  function drawStatusbar(){
    var el = document.getElementById("statusbar"); if (!el) return;
    var p = state.project;
    var busy = 0, total = 0;
    (state.projects || []).forEach(function(pr){
      total += pr.costUsd > 0 ? pr.costUsd : 0;
      (pr.agents || []).forEach(function(a){ if (a.busy) busy++; });
    });
    var share = p && p.costUsd > 0 && total > 0 ? Math.min(100, Math.round((p.costUsd / total) * 100)) : 0;
    el.innerHTML =
      '<span class="sit"><span class="sdot' + (state.wsLive ? "" : " off") + '"></span>' + (state.wsLive ? "live" : "offline") + "</span>" +
      '<span class="sit">' + esc(location.host) + "</span>" +
      (p ? '<span class="sit">baton ' + esc(p.holder || "\\u2014") + "</span>" : "") +
      (p && p.costUsd > 0
        ? '<span class="sit"><span class="meter"><i style="width:' + share + '%"></i></span>' + money(p.costUsd) + " \\u00b7 " + share + "% of \\u03a3</span>"
        : "") +
      '<span class="spacer"></span>' +
      (busy ? '<span class="sit" style="color:var(--live)">' + busy + " working</span>" : "") +
      '<span class="sit">' + (state.projects || []).length + " project" + ((state.projects || []).length === 1 ? "" : "s") + "</span>" +
      (total > 0 ? '<span class="sit">\\u03a3 ' + money(total) + "</span>" : "");
  }

  // ---- right rail toggle — open by default (shows the file tree) -----------
  var RAIL_KEY = "loomRail";
  function railOpen(){ var v = localStorage.getItem(RAIL_KEY); return v === null ? true : v === "1"; }
  function applyRail(){
    var shell = document.querySelector(".dshell");
    if (shell) shell.classList.toggle("railopen", railOpen());
    var rb = document.getElementById("railbtn");
    if (rb) rb.classList.toggle("active", railOpen());
  }
  function toggleRail(){
    localStorage.setItem(RAIL_KEY, railOpen() ? "0" : "1");
    applyRail();
  }

  // ---- column resizing -----------------------------------------------------
  function shellEl(){ return document.querySelector(".dshell"); }
  function cssPx(el, name, fallback){
    if (!el) return fallback;
    var n = parseInt(getComputedStyle(el).getPropertyValue(name), 10);
    return isNaN(n) ? fallback : n;
  }
  /**
   * Drag a handle to resize a column: clamped, persisted, double-click resets.
   * opts.invert is for handles on a panel's left edge, where dragging left widens.
   */
  function makeResizer(handleId, opts){
    var h = document.getElementById(handleId); if (!h) return;
    h.addEventListener("mousedown", function(ev){
      if (ev.button !== 0) return;
      ev.preventDefault();
      var startX = ev.clientX, startW = opts.get();
      h.classList.add("dragging");
      document.body.classList.add("resizing-x");
      function mv(e){
        var dx = (e.clientX - startX) * (opts.invert ? -1 : 1);
        opts.set(Math.max(opts.min, Math.min(opts.max(), startW + dx)));
      }
      function up(){
        h.classList.remove("dragging");
        document.body.classList.remove("resizing-x");
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
        if (opts.key) localStorage.setItem(opts.key, String(opts.get()));
      }
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    });
    h.addEventListener("dblclick", function(){
      opts.set(opts.def);
      if (opts.key) localStorage.setItem(opts.key, String(opts.def));
    });
  }
  function applyWidths(){
    var s = shellEl(); if (!s) return;
    var sb = Number(localStorage.getItem("loomSbW")) || 264;
    var rw = Number(localStorage.getItem("loomRailW")) || 304;
    s.style.setProperty("--sbw", sb + "px");
    s.style.setProperty("--railw", rw + "px");
  }

  // ---- New Task modal (Orca's Create Worktree, mapped to Loom) -------------
  // One ADE runs it directly; several run it as a pipeline, hop to hop.
  function openTaskModal(prefillPid, prefillAgents){
    var projects = state.projects || [];
    if (!projects.length) { toast("add a project first"); return; }
    if (document.querySelector(".scrim")) return;
    var pid = prefillPid || state.pid || projects[0].id;
    var picked = (prefillAgents || []).slice();
    function proj(id){ for (var i = 0; i < projects.length; i++) if (projects[i].id === id) return projects[i]; return null; }
    function agentsFor(id){ var p = proj(id); return p ? p.agents.filter(function(a){ return a.tier === "adapter"; }) : []; }
    function routesFor(id){ var p = proj(id); return (p && p.routeNames) || ["auto"]; }
    function projOpts(){ return projects.map(function(p){ return '<option value="' + esc(p.id) + '"' + (p.id === pid ? " selected" : "") + ">" + esc(p.name) + "</option>"; }).join(""); }
    function routeOpts(id){ return '<option value="">\\u2014 use the agents above \\u2014</option>' + routesFor(id).map(function(n){ return '<option value="' + esc(n) + '">' + esc(n === "auto" ? "auto \\u2014 LLM picks each hop" : n) + "</option>"; }).join(""); }
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal">' +
      '<div class="modalhead">Create task<button class="iconbtn" id="mclose">' + ICONS.x + "</button></div>" +
      '<div class="modalbody">' +
        '<div class="field"><label>Project</label><select id="mproj">' + projOpts() + "</select></div>" +
        '<div class="field"><label>Task</label><textarea id="mtask" placeholder="what should the agent do?"></textarea></div>' +
        '<div class="field"><label>Agents \\u00b7 one, or several in sequence</label>' +
          '<div class="agsel" id="magsel"></div>' +
          '<span class="hintx" id="maghint"></span></div>' +
        '<div class="disclose" id="madv">\\u25b8 Advanced</div>' +
        '<div class="field" id="mroutewrap" style="display:none"><label>Named pipeline</label>' +
          '<select id="mroute">' + routeOpts(pid) + "</select>" +
          '<span class="hintx">run one of the project\\u2019s saved pipelines instead of the agents above.</span></div>' +
      "</div>" +
      '<div class="modalfoot"><button class="btn ghost" id="mcancel">Cancel</button>' +
      '<button class="btn primary" id="mcreate">Create task<span class="kbd">\\u2318\\u21b5</span></button></div>' +
    "</div>";
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("mclose").onclick = close;
    document.getElementById("mcancel").onclick = close;
    function drawChips(){
      var box = document.getElementById("magsel"); if (!box) return;
      var agents = agentsFor(pid);
      picked = picked.filter(function(id){ return agents.some(function(a){ return a.id === id; }); });
      box.innerHTML = agents.map(function(a){
        var order = picked.indexOf(a.id);
        return '<button type="button" class="agchip' + (order >= 0 ? " sel" : "") + '" data-id="' + esc(a.id) + '">' +
          '<span class="num">' + (order >= 0 ? order + 1 : "") + "</span>" + esc(a.id) +
          '<span class="role">' + esc(a.role) + "</span></button>";
      }).join("") || '<span class="hintx">no agents configured for this project</span>';
      Array.prototype.forEach.call(box.querySelectorAll(".agchip"), function(ch){
        ch.onclick = function(){
          var id = ch.getAttribute("data-id");
          var i = picked.indexOf(id);
          if (i >= 0) picked.splice(i, 1); else picked.push(id);
          drawChips();
        };
      });
      var hint = document.getElementById("maghint");
      if (hint) hint.textContent = picked.length > 1
        ? "runs as a pipeline: " + picked.join(" \\u2192 ")
        : picked.length === 1
          ? "one ADE runs the whole task"
          : "pick one ADE \\u2014 or several to run them in order";
    }
    var advOpen = false;
    document.getElementById("madv").onclick = function(){
      advOpen = !advOpen;
      this.textContent = (advOpen ? "\\u25be" : "\\u25b8") + " Advanced";
      document.getElementById("mroutewrap").style.display = advOpen ? "" : "none";
    };
    document.getElementById("mproj").onchange = function(){
      pid = this.value;
      picked = [];
      drawChips();
      document.getElementById("mroute").innerHTML = routeOpts(pid);
    };
    // default-pick the current holder when nothing was prefilled
    if (!picked.length) {
      var holder = (proj(pid) || {}).holder;
      if (holder && agentsFor(pid).some(function(a){ return a.id === holder; })) picked = [holder];
    }
    drawChips();
    setTimeout(function(){ var ta = document.getElementById("mtask"); if (ta) ta.focus(); }, 30);
    function create(){
      var mproj = document.getElementById("mproj").value;
      var task = (document.getElementById("mtask").value || "").trim();
      var pipeline = document.getElementById("mroute").value;
      if (!task) return toast("describe the task first");
      if (!pipeline && !picked.length) return toast("pick at least one agent");
      var btn = document.getElementById("mcreate"); btn.disabled = true;
      var work, note;
      if (pipeline) {
        work = api("/api/projects/" + mproj + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: pipeline }) });
        note = "pipeline " + pipeline + " started";
      } else if (picked.length > 1) {
        work = api("/api/projects/" + mproj + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: picked.join(",") }) });
        note = picked.length + " agents \\u00b7 " + picked.join(" \\u2192 ");
      } else {
        var agent = picked[0];
        var holder = (proj(mproj) || {}).holder;
        var chain = agent !== holder
          ? api("/api/projects/" + mproj + "/handoff", { method: "POST", body: JSON.stringify({ to: agent }) })
          : Promise.resolve();
        work = chain.then(function(){
          return api("/api/projects/" + mproj + "/messages", { method: "POST", body: JSON.stringify({ text: task, agentId: agent }) });
        });
        note = "task sent to " + agent;
      }
      work.then(function(){
        close();
        toast(note);
        if (state.selectProject) state.selectProject(mproj);
        else location.hash = "#p/" + mproj;
      }).catch(function(err){ btn.disabled = false; toast(err.message); });
    }
    document.getElementById("mcreate").onclick = create;
    function onKey(e){
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); create(); }
    }
    document.addEventListener("keydown", onKey);
  }

  // ---- router ----------------------------------------------------------
  var mq = window.matchMedia("(min-width:900px)");
  function isDesktop(){ return mq.matches; }
  function clearShell(){ if (state.shellTimer) { clearInterval(state.shellTimer); state.shellTimer = null; } }

  // Desktop workspace: projects/agents rail + tabbed pane + source-control rail.
  function renderShell(){
    clearTimers();
    clearShell();
    var m = location.hash.match(/^#p\\/(.+)$/);
    var cur = m ? m[1] : null;
    root.innerHTML =
      '<div class="dshell">' +
      '<aside class="sidebar">' +
        '<div class="shead"><span class="wordmark">lo<b>om</b></span></div>' +
        '<div class="topnav"><button class="navitem" id="newtask">' + ICONS.tasks + "New task<span class=\\"kbd\\">N</span></button></div>" +
        '<div class="snav">' + ICONS.search + '<input id="sfilter" placeholder="Search" autocomplete="off" spellcheck="false"></div>' +
        '<div class="stitle">projects<button id="addproj" class="iconbtn" title="add a project by path">' + ICONS.plus + "</button></div>" +
        '<div id="addwrap"></div>' +
        '<div class="slist" id="slist">' + LOADER + "</div>" +
        '<div class="sfoot">' +
        '<a class="iconbtn" title="Loom on GitHub" href="https://github.com/nickthelegend/loom" target="_blank" rel="noreferrer">' + ICONS.help + "</a>" +
        '<span class="spacer"></span>' +
        '<button id="unpair" class="iconbtn" title="unpair this device">' + ICONS.unpair + "</button></div>" +
        '<div class="rz rz-sidebar" id="rz-sidebar" title="drag to resize"></div>' +
      "</aside>" +
      '<section class="dmain" id="dmain"></section>' +
      '<aside class="rail">' +
        '<div class="rz rz-rail" id="rz-rail" title="drag to resize"></div>' +
        '<div class="railbar">' +
          '<button class="iconbtn rvbtn" data-view="explorer" title="Explorer">' + ICONS.files + "</button>" +
          '<button class="iconbtn rvbtn" data-view="search" title="Search">' + ICONS.search + "</button>" +
          '<button class="iconbtn rvbtn" data-view="scm" title="Source Control">' + ICONS.branch + "</button>" +
          '<button class="iconbtn rvbtn" data-view="tasks" title="Tasks">' + ICONS.tasks + "</button>" +
          '<span class="spacer"></span>' +
          '<button id="railrefresh" class="iconbtn" title="refresh">' + ICONS.refresh + "</button>" +
          '<button id="railclose" class="iconbtn" title="hide panel">' + ICONS.panelRight + "</button>" +
        "</div>" +
        '<div class="rhead" id="railtitle"><span class="b">Explorer</span></div>' +
        '<div class="rbody" id="railbody"><div class="rempty">select a project</div></div></aside>' +
      '<div class="statusbar" id="statusbar"></div>' +
      "</div>";
    document.getElementById("unpair").onclick = logout;
    document.getElementById("railclose").onclick = toggleRail;
    document.getElementById("newtask").onclick = function(){ openTaskModal(cur); };
    if (!state.railView) state.railView = localStorage.getItem("loomRailView") || "explorer";
    applyWidths();
    makeResizer("rz-sidebar", {
      get: function(){ return cssPx(shellEl(), "--sbw", 264); },
      set: function(w){ shellEl().style.setProperty("--sbw", w + "px"); },
      min: 200, max: function(){ return Math.min(520, window.innerWidth - 480); },
      def: 264, key: "loomSbW",
    });
    makeResizer("rz-rail", {
      get: function(){ return cssPx(shellEl(), "--railw", 304); },
      set: function(w){ shellEl().style.setProperty("--railw", w + "px"); },
      min: 220, max: function(){ return Math.min(620, window.innerWidth - 520); },
      def: 304, key: "loomRailW", invert: true,
    });
    Array.prototype.forEach.call(document.querySelectorAll(".railbar .rvbtn"), function(b){
      b.onclick = function(){
        state.railView = b.getAttribute("data-view");
        localStorage.setItem("loomRailView", state.railView);
        if (!railOpen()) toggleRail();
        if (state.drawRail) state.drawRail();
      };
    });
    applyRail();
    var filter = "";
    document.getElementById("sfilter").oninput = function(){
      filter = (this.value || "").trim().toLowerCase();
      drawList();
    };
    document.getElementById("addproj").onclick = function(){
      var wrap = document.getElementById("addwrap");
      if (wrap.firstChild) { wrap.innerHTML = ""; return; }
      wrap.innerHTML = '<div class="addform">' +
        '<input id="adddir" placeholder="/path/to/repo on the daemon host" autocomplete="off" spellcheck="false">' +
        '<div class="row"><button class="btn primary xs" id="addgo">Add project</button>' +
        '<button class="btn outline xs" id="addcancel">Cancel</button></div></div>';
      document.getElementById("addcancel").onclick = function(){ wrap.innerHTML = ""; };
      document.getElementById("addgo").onclick = function(){
        var dir = (document.getElementById("adddir").value || "").trim();
        if (!dir) return toast("enter a directory path");
        api("/api/projects", { method: "POST", body: JSON.stringify({ dir: dir }) })
          .then(function(j){ wrap.innerHTML = ""; toast("added " + (j.project && j.project.name ? j.project.name : "project")); refresh(); })
          .catch(function(err){ toast(err.message); });
      };
      document.getElementById("adddir").focus();
    };
    document.getElementById("railrefresh").onclick = function(){
      // refresh whichever view is showing: Explorer re-reads the file tree,
      // the others re-read the working tree / project state.
      if (state.refreshExplorer && state.railView === "explorer") { state.refreshExplorer(); return; }
      state.tree = null;
      if (state.drawRail) state.drawRail();
      api("/api/projects/" + (cur || "") + "/tree").then(function(j){
        state.tree = j.tree || {};
        if (state.drawRail) state.drawRail();
      }).catch(function(err){ toast(err.message); });
      refresh();
    };
    var dmain = document.getElementById("dmain");
    function drawEmpty(){
      dmain.innerHTML = '<div class="dempty"><div class="biglogo">loom</div><div class="hair"></div>' +
        "<div>select a project to open its workspace</div></div>";
    }
    function drawList(){
      var el = document.getElementById("slist"); if (!el) return;
      if (!state.projects.length) {
        el.innerHTML = '<div class="sys" style="padding:24px 8px;line-height:1.7">no projects yet<br><span style="opacity:.75">run <b class="mono" style="font-weight:500">loom init</b></span></div>';
        return;
      }
      var shown = !filter ? state.projects : state.projects.filter(function(p){
        if (String(p.name || "").toLowerCase().indexOf(filter) >= 0) return true;
        return (p.agents || []).some(function(a){ return String(a.id).toLowerCase().indexOf(filter) >= 0; });
      });
      if (!shown.length) {
        el.innerHTML = '<div class="sys" style="padding:24px 8px">no matches for \\u201c' + esc(filter) + '\\u201d</div>';
        return;
      }
      el.innerHTML = shown.map(function(p){
        var r = p.route, act = r && (r.status === "running" || r.status === "waiting_human");
        var adapters = (p.agents || []).filter(function(a){ return a.tier === "adapter"; });
        var sel = p.id === cur;
        var gh = hue(p.id + p.name);
        var rows = '<div class="srow' + (sel ? " sel" : "") + '" data-id="' + esc(p.id) + '">' +
          '<div class="n"><span class="pglyph' + (p.needsInput ? " hot" : "") + '" style="background:color-mix(in srgb, hsl(' + gh + ',60%,50%) 20%, transparent);color:hsl(' + gh + ',60%,var(--agent-l))">' + esc((p.name || "?").slice(0, 1).toUpperCase()) + '</span><span class="nm">' + esc(p.name) + "</span>" +
          (act ? '<span class="badge live" style="margin-left:auto">' + (r.current + 1) + "/" + r.steps.length + "</span>" : '<span class="cnt">' + adapters.length + "</span>") + "</div>" +
          '<div class="m">baton ' + esc(p.holder || "\\u2014") +
          (p.costUsd > 0 ? " \\u00b7 " + money(p.costUsd) : "") + "</div></div>";
        if (sel) {
          rows += adapters.map(function(a){
            var curA = a.id === state.selected;
            return '<div class="arow' + (curA ? " cur" : "") + '" data-p="' + esc(p.id) + '" data-a="' + esc(a.id) + '"' + (curA ? ' data-current="true"' : "") + ">" +
              '<span class="adot' + (a.busy ? " busy" : "") + '"></span>' +
              '<span class="anm">' + esc(a.id) + (a.id === p.holder ? ' <span class="abadge">baton</span>' : "") + "</span>" +
              '<span class="role">' + esc(a.role) + "</span></div>";
          }).join("");
        }
        return '<div class="sgroup">' + rows + "</div>";
      }).join("");
      Array.prototype.forEach.call(el.querySelectorAll(".srow"), function(row){
        row.onclick = function(){ select(row.getAttribute("data-id")); };
      });
      Array.prototype.forEach.call(el.querySelectorAll(".arow"), function(row){
        row.onclick = function(){
          var pidA = row.getAttribute("data-p"), aid = row.getAttribute("data-a");
          if (pidA !== cur) { select(pidA); state.selected = aid; }
          else { state.selected = aid; }
          drawList();
          var hint = document.getElementById("hint");
          var holder = state.project && state.project.holder;
          if (hint) hint.textContent = aid !== holder
            ? "send will shift the baton to " + aid
            : "baton already with " + aid;
        };
      });
    }
    function select(pid){
      cur = pid;
      history.replaceState(null, "", "#p/" + pid);
      renderProject(pid, dmain, true);
      drawList();
    }
    state.selectProject = select;
    function refresh(){
      api("/api/projects").then(function(j){
        state.projects = j.projects || [];
        if (!state.projects.length) { drawList(); drawEmpty(); drawStatusbar(); return; }
        var exists = state.projects.some(function(p){ return p.id === cur; });
        if (!document.getElementById("feed")) select(cur && exists ? cur : state.projects[0].id);
        else drawList();
        drawStatusbar();
      }).catch(function(err){ toast(err.message); });
    }
    if (!cur) drawEmpty();
    drawStatusbar();
    refresh();
    state.shellTimer = setInterval(refresh, 5000);
  }

  function route(){
    applyTheme();
    state.toggleTerm = null;
    state.selectProject = null;
    state.drawRail = null;
    if (!state.token) return renderPair();
    if (isDesktop()) return renderShell();
    var m = location.hash.match(/^#p\\/(.+)$/);
    if (m) return renderProject(m[1], root, false);
    renderBoard();
  }
  window.addEventListener("hashchange", function(){ if (!isDesktop()) route(); });
  mq.addEventListener("change", function(){ clearShell(); route(); });
  // Global shortcuts: Ctrl+backtick toggles the terminal; "n" opens New task
  // (both only while a desktop workspace is mounted, never while typing).
  function typingInField(t){
    if (!t) return false;
    var tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
  }
  document.addEventListener("keydown", function(e){
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "\`" || e.key === "~")) {
      if (state.toggleTerm) { e.preventDefault(); state.toggleTerm(); }
      return;
    }
    if (e.key === "n" && !e.metaKey && !e.ctrlKey && !e.altKey &&
        isDesktop() && state.token && !typingInField(e.target) && !document.querySelector(".scrim")) {
      e.preventDefault();
      openTaskModal(state.pid);
    }
  });
  pairFromHash().then(function(paired){
    if (paired) toast("paired \\u2713");
    route();
  }).catch(function(err){ toast(err.message); route(); });
})();
</script>
</body>
</html>`;
