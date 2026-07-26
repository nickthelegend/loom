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
 * left sidebar, a tabbed center pane (Thread | Tasks | Brain | Board), a diff
 * dock right of the chat, a 4-view right rail, a terminal dock, and a status
 * bar. Mobile keeps the single-column thread. See docs/design-system.md.
 */

import { BRAND_SPRITE, BRAND_TITLES } from "./brand-icons.js";

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
<link rel="stylesheet" href="/app/vendor/xterm.css">
<title>Loom</title>
<script>
/* Apply the saved theme before first paint so there is no flash. */
try{if(localStorage.getItem("loomTheme")==="light")document.documentElement.classList.remove("dark")}catch(e){}
/* The telemetry backend's own UI, for the trace deep links, injected by the
   daemon from LOOM_TRACE_UI_URL. Empty unless one is configured — the links
   hide themselves rather than pointing at a guessed port. */
window.__loomTraceUrl="%%TRACE_UI_URL%%";
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
  .iconbtn.spin svg{animation:spin .9s linear infinite}
  /* ADE brand marks. These are the one place real colour enters the chrome —
     they're the agent's identity, not our state palette, so they keep their own
     hues. opencode's mark is mono and inherits currentColor by design. */
  .brand{width:14px;height:14px;flex:none;display:inline-block;vertical-align:middle}
  .brand.lg{width:18px;height:18px}
  .brand.xl{width:22px;height:22px}
  .sendbtn{display:inline-flex;align-items:center;justify-content:center;flex:none;
    width:30px;height:30px;border-radius:15px;background:var(--primary);color:var(--primary-foreground);
    transition:opacity .15s,transform .1s}
  .sendbtn:hover{opacity:.9}
  .sendbtn:active{transform:scale(.96)}
  .sendbtn svg{width:15px;height:15px}
  /* Stop takes send's place mid-turn. Same shape and position — it's the same
     button answering a different question — but it must not read as "go", so
     it carries the warn colour and a slow pulse to say the turn is live. */
  .stopbtn{background:var(--warn);color:var(--background)}
  .stopbtn::after{content:"";position:absolute;inset:-4px;border-radius:21px;
    border:1px solid var(--warn);opacity:.35;animation:stoppulse 1.8s ease-in-out infinite}
  .stopbtn{position:relative}
  @keyframes stoppulse{0%,100%{opacity:.15;transform:scale(.94)}50%{opacity:.4;transform:scale(1)}}
  @media (prefers-reduced-motion:reduce){.stopbtn::after{animation:none}}
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
    margin:0 2px 4px;letter-spacing:.04em;display:flex;align-items:center;gap:5px}
  .msg .bubble{max-width:88%;padding:9px 13px;border-radius:var(--radius-xl);
    white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.55}
  .msg.user{align-items:flex-end}
  .msg.user .bubble{background:var(--secondary);color:var(--secondary-foreground);
    border:1px solid var(--border);border-bottom-right-radius:4px}
  .msg.agent{align-items:flex-start}
  .msg.agent .bubble{background:var(--card);border:1px solid var(--border);
    border-left:2px solid var(--border);border-bottom-left-radius:4px;
    box-shadow:0 1px 2px rgb(0 0 0 / .04)}
  /* --- rendered markdown inside a bubble --- */
  .bubble.md{white-space:normal}
  .md>*:first-child{margin-top:0}
  .md>*:last-child{margin-bottom:0}
  .md .mdp{margin:0 0 8px;line-height:1.6}
  .md .mdh{font-weight:600;line-height:1.3;margin:14px 0 6px}
  .md .mdh1{font-size:18px}
  .md .mdh2{font-size:16px}
  .md .mdh3{font-size:14.5px}
  .md .mdh4,.md .mdh5,.md .mdh6{font-size:13.5px;color:var(--muted-foreground)}
  .md .mdlist{margin:0 0 8px;padding-left:20px}
  .md .mdlist li{margin:2px 0;line-height:1.55}
  .md .mdq{margin:0 0 8px;padding:2px 0 2px 12px;border-left:3px solid var(--border);
    color:var(--muted-foreground)}
  .md .mdhr{border:0;border-top:1px solid var(--border);margin:12px 0}
  .md .mdi{font-family:var(--font-mono);font-size:.88em;background:color-mix(in srgb, var(--muted-foreground) 16%, transparent);
    padding:1px 5px;border-radius:5px;word-break:break-word}
  .md a{color:var(--thread,#67e8f9);text-decoration:underline;text-underline-offset:2px}
  .md .mdcode{margin:0 0 8px;background:var(--editor-surface,color-mix(in srgb, var(--foreground) 6%, var(--background)));
    border:1px solid var(--border);border-radius:8px;padding:10px 12px;overflow-x:auto}
  .md .mdcode code{font-family:var(--font-mono);font-size:12.5px;line-height:1.5;white-space:pre;color:var(--foreground)}
  .md strong{font-weight:650}
  /* --- reasoning / thinking block --- */
  .msg.agent.thinking{align-items:flex-start;margin-bottom:2px}
  .thinktag{font-size:9.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:var(--muted-foreground);background:var(--sidebar-accent);border-radius:5px;padding:1px 6px;margin-left:2px}
  .thinkbox{max-width:88%;background:color-mix(in srgb, var(--muted-foreground) 8%, transparent);
    border:1px dashed color-mix(in srgb, var(--muted-foreground) 30%, transparent);border-radius:10px;
    padding:6px 12px;font-size:12.5px;color:var(--muted-foreground)}
  .thinkbox summary{cursor:pointer;font-family:var(--font-mono);font-size:11px;letter-spacing:.03em;
    list-style:none;user-select:none;opacity:.85}
  .thinkbox summary::-webkit-details-marker{display:none}
  .thinkbox summary::before{content:"\\25b8 ";font-size:9px}
  .thinkbox[open] summary::before{content:"\\25be "}
  .thinkbox .md{margin-top:6px;line-height:1.55}
  .thinkbox .md .mdp{margin-bottom:5px}
  .sys{color:var(--muted-foreground);font-size:12px;text-align:center;margin:10px auto;
    font-family:var(--font-mono);letter-spacing:.02em;max-width:92%}
  .sys.warn{color:var(--warn)}
  .sys.err{color:var(--err)}
  .sys.ok{color:var(--ok)}
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
  .sheet select,.sheet input{
    height:36px;background:transparent;border:1px solid var(--input);
    border-radius:var(--radius-md);color:var(--foreground);padding:0 11px;font:inherit;font-size:14px;width:100%;
    transition:border-color .15s,box-shadow .15s;outline:none}
  .dark .sheet select,.dark .sheet input{
    background:color-mix(in srgb, var(--input) 30%, transparent)}
  .dark .sheet select option{background:var(--popover);color:var(--popover-foreground)}
  .sheet select:focus-visible,.sheet input:focus-visible{
    border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 50%, transparent)}
  .sheet .row{display:flex;gap:8px}
  .sheet .row .btn{flex:1}
  .sheet label{font-size:11px;font-weight:600;color:var(--muted-foreground);
    letter-spacing:.05em;text-transform:uppercase;font-family:var(--font-mono)}
  /* ── Composer ─────────────────────────────────────────── */
  .composer{z-index:6;flex:none;
    background:color-mix(in srgb, var(--background) 92%, transparent);
    backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    border-top:1px solid var(--border);
    padding:10px 14px calc(10px + env(safe-area-inset-bottom))}
  .composer .inner{max-width:900px;margin:0 auto;display:flex;gap:9px;align-items:center}
  /* the composer card: textarea on top, a control row beneath, chips above */
  .cbox{position:relative;max-width:900px;margin:0 auto;
    background:color-mix(in srgb, var(--input) 18%, var(--background));
    border:1px solid var(--input);border-radius:16px;
    padding:10px 12px 8px;transition:border-color .15s,box-shadow .15s}
  .dark .cbox{background:color-mix(in srgb, var(--input) 32%, var(--background))}
  .cbox:focus-within{border-color:var(--ring);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 26%, transparent)}
  /* two lines to start (a chat message is rarely one), grows to a cap, then
     scrolls — never a single cramped line you can't see what you typed in */
  .cinput{display:block;width:100%;box-sizing:border-box;background:transparent;border:0;outline:none;resize:none;
    color:var(--foreground);font:inherit;font-size:14px;line-height:1.55;padding:2px 4px;
    min-height:48px;max-height:200px;overflow-y:auto}
  .cinput::placeholder{color:color-mix(in srgb, var(--muted-foreground) 55%, transparent)}
  /* the control row under the textarea: small, evenly-spaced pills, all the same
     height and vertically centred with the send button */
  .crow{display:flex;align-items:center;gap:6px;padding:8px 1px 0}
  .ctool{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;
    background:transparent;border:1px solid color-mix(in srgb, var(--border) 80%, transparent);border-radius:99px;
    color:var(--muted-foreground);cursor:pointer;font:inherit;font-size:11.5px;transition:background .12s,color .12s,border-color .12s}
  .ctool:hover{background:var(--sidebar-accent);color:var(--foreground);border-color:var(--border)}
  .ctool svg{width:13.5px;height:13.5px}
  .ctool.iconly{width:26px;padding:0;justify-content:center;gap:0}
  .ctool .cchev{width:11px;height:11px;opacity:.6;margin-right:-2px}
  .cmodel{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.01em;max-width:140px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
  /* who the composer talks to — a real button that opens the agent picker, held
     visually apart from the model pill so the two never read as one control */
  .cagent{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 7px 0 8px;border-radius:99px;
    background:color-mix(in srgb, var(--primary) 13%, transparent);
    border:1px solid color-mix(in srgb, var(--primary) 24%, transparent);color:var(--foreground);
    font:inherit;font-size:11.5px;font-weight:500;flex:none;max-width:170px;cursor:pointer;
    transition:background .12s,border-color .12s}
  .cagent:hover{background:color-mix(in srgb, var(--primary) 20%, transparent);
    border-color:color-mix(in srgb, var(--primary) 42%, transparent)}
  .cagent .brand{width:13.5px;height:13.5px;flex:none}
  .cagent .can{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cagent .cchev{width:11px;height:11px;opacity:.55;flex:none;margin-right:-1px}
  /* attachment chips */
  .cchips{display:flex;flex-wrap:wrap;gap:6px;padding:2px 2px 6px}
  .cchip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 8px;
    background:var(--sidebar-accent);border:1px solid var(--border);border-radius:8px;
    font-size:11px;font-family:var(--font-mono);color:var(--foreground);max-width:220px}
  .cchip .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cchip img{width:20px;height:20px;object-fit:cover;border-radius:4px;flex:none}
  .cchip .rm{display:inline-flex;cursor:pointer;color:var(--muted-foreground);border:0;background:none;padding:2px}
  .cchip .rm:hover{color:var(--foreground)}
  .cchip .rm svg{width:12px;height:12px}
  .cchip.up{opacity:.55}
  /* the @ / popover, mounted over the textarea */
  .cmenu{position:absolute;left:8px;right:8px;bottom:calc(100% + 6px);z-index:30;
    background:var(--popover,var(--background));border:1px solid var(--border);border-radius:10px;
    box-shadow:0 12px 34px rgba(0,0,0,.28);max-height:280px;overflow-y:auto;padding:5px}
  .cmi{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:7px;cursor:pointer;font-size:13px;color:var(--foreground)}
  .cmi .ic{display:inline-flex;color:var(--muted-foreground);flex:none}
  .cmi .ic svg{width:15px;height:15px}
  .cmi .sub{color:var(--muted-foreground);font-size:11px;font-family:var(--font-mono);margin-left:auto;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
  .cmi.sel,.cmi:hover{background:var(--sidebar-accent)}
  .cmi .tick{margin-left:auto;color:var(--ring)}
  .cmenu .cmhead{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:var(--muted-foreground);padding:6px 9px 4px}
  .cmenu .cmsearch{position:sticky;top:-5px;z-index:2;display:block;width:100%;box-sizing:border-box;margin:0 0 6px;
    background:var(--popover,var(--background));border:1px solid var(--border);border-radius:7px;padding:6px 9px;
    font-family:var(--font-mono);font-size:12px;color:var(--foreground);outline:none}
  .cmenu .cmsearch:focus{border-color:var(--ring)}
  .cmlist{display:flex;flex-direction:column;gap:1px}
  .cmlist .cmi span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    font-family:var(--font-mono);font-size:12px}
  .cmmore{padding:7px 9px 3px;color:var(--muted-foreground);font-size:11px;font-family:var(--font-mono)}
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
  /* the collapse caret: right-pointing, rotates to down when the project is open */
  .scaret{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;flex:none;
    background:none;border:0;padding:0;margin:-2px 0;color:var(--muted-foreground);cursor:pointer;
    transition:transform .14s,color .12s;border-radius:4px}
  .scaret:hover{color:var(--foreground);background:color-mix(in srgb, var(--foreground) 8%, transparent)}
  .scaret svg{width:13px;height:13px}
  .scaret.open{transform:rotate(90deg)}
  /* new-chat agent picker — a floating popover anchored to the New chat row */
  .pickpop{position:fixed;z-index:60;min-width:190px;max-width:260px;
    background:var(--popover,var(--background));border:1px solid var(--border);border-radius:10px;
    box-shadow:0 14px 40px rgba(0,0,0,.32);padding:5px}
  .pickhead{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:var(--muted-foreground);padding:6px 9px 5px}
  .pickrow{display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border:0;border-radius:7px;
    background:none;cursor:pointer;font:inherit;font-size:13px;color:var(--foreground);text-align:left}
  .pickrow:hover{background:var(--sidebar-accent)}
  .pickrow .brand{width:16px;height:16px;flex:none}
  .pickrow .pnm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pickrow .prole{margin-left:auto;flex:none;font-family:var(--font-mono);font-size:10.5px;color:var(--muted-foreground)}
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
  /* ── chats: a project's conversations, nested under it ── */
  .crow{display:flex;align-items:center;gap:7px;padding:5px 8px 5px 24px;margin-top:1px;
    border-radius:var(--radius-sm);cursor:pointer;color:var(--sidebar-foreground);
    font-size:12.5px;border:1px solid transparent}
  .crow:hover{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground)}
  .crow.cur{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground);border-color:var(--border)}
  .crow .ci{flex:none;display:inline-flex;align-items:center;color:var(--muted-foreground)}
  .crow .ci svg{width:12px;height:12px}
  .crow.cur .ci{color:var(--sidebar-accent-foreground)}
  .crow .cnm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .crow .cx{width:18px;height:18px;margin-left:auto;flex:none;opacity:0;border-radius:4px}
  .crow .cx svg{width:11px;height:11px}
  .crow:hover .cx{opacity:.6}
  .crow .cx:hover{opacity:1;background:color-mix(in srgb, var(--err) 18%, transparent);color:var(--err)}
  .crow.add{color:var(--muted-foreground)}
  .crow.add:hover{color:var(--sidebar-accent-foreground)}
  .chatinput{width:100%;background:var(--background);border:1px solid var(--ring);border-radius:4px;
    color:var(--foreground);font:inherit;font-size:12.5px;padding:0 3px;outline:none}
  /* a role is a name you chose, so it reads as editable text, not a label */
  .role.edit{cursor:text;border-radius:4px;padding:0 3px;margin-right:-3px}
  .role.edit:hover{background:color-mix(in srgb, var(--muted-foreground) 22%, transparent);
    color:var(--sidebar-accent-foreground)}
  .roleinput{width:9ch;background:var(--background);border:1px solid var(--ring);border-radius:4px;
    color:var(--foreground);font-family:var(--font-mono);font-size:10.5px;padding:0 3px;outline:none}
  /* the rail's agent roster: click to aim, click the role to rename it */
  .frow.agentrow{cursor:pointer}
  .frow.agentrow.cur{background:var(--accent);border-radius:var(--radius-sm)}
  .frow .role{margin-left:auto;flex:none;font-family:var(--font-mono);font-size:10.5px;
    color:var(--muted-foreground)}
  .frow.bridge{opacity:.75}
  /* a bridge is read-only: no hover affordance, because it can't be targeted */
  .arow.bridge{cursor:default;opacity:.82}
  .arow.bridge:hover{background:transparent;color:inherit}
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
  .tabstrip .spacer{margin-left:auto}
  .pane{flex:1;min-height:0;overflow-y:auto;padding:16px 16px 20px}
  .dmain .pane > #feed,.dmain .pane > #routebar,.dmain .pane > .agenthead{max-width:840px;margin-inline:auto}
  .dmain .msg .bubble{max-width:82%}
  .pane-inner{max-width:840px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
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
  .dockhead .p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dockhead .spacer{margin-left:auto}
  /* the dock's icon slot — every other icon wrapper centres its glyph; without
     this one the svg sits on the text baseline */
  .dockhead .di{display:inline-flex;align-items:center;flex:none}
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
  /* a real logo brings its own colour, so its tile stays neutral */
  .agenthead .ag.brandbox{background:var(--secondary);border:1px solid var(--border)}
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
  /* every inline icon in a header/row is 14px — an unsized svg fills its
     container and reads as a stray glyph. */
  .dfh svg,.frow svg,.dockhead svg,.rhead svg{width:14px;height:14px;flex:none}
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
  /* one host per tab: xterm mounts into it in pty mode, the line-renderer
     writes into it in pipe mode. Only the active one is displayed. */
  .termpanes{flex:1;min-height:0;position:relative}
  /* ── Source control ───────────────────────────────────
     Staged and unstaged are separate sections on purpose: a file can be in both
     at once, and one list would show a checkbox that lies about the commit. */
  .gbranch{display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--border);
    font-size:11.5px;color:var(--muted-foreground)}
  .gbranch svg{width:13px;height:13px;flex:none}
  .gbranch .bn{color:var(--foreground);font-weight:600;font-family:var(--font-mono);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gcount{font-family:var(--font-mono);font-size:10px;padding:1px 5px;border-radius:8px;
    background:var(--sidebar-accent);flex:none}
  .gcount.dim{opacity:.6}
  .gbranch .gbranchsel{background:transparent;border:1px solid var(--input);border-radius:6px;color:var(--foreground);
    font-family:var(--font-mono);font-size:11px;font-weight:600;padding:2px 4px;cursor:pointer;max-width:130px}
  .gbranch .gbranchsel:focus{outline:none;border-color:var(--ring)}
  .gbranch .iconbtn.xs{margin-left:0}
  .ginit{padding:16px 12px;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
  .ginit .rempty{padding:0}
  /* commit history at the foot of the source-control panel — a fixed-height,
     self-scrolling region so a long history never buries the changes above it */
  .gcommits-h{margin-top:4px;position:sticky;top:0}
  .gcommits{display:flex;flex-direction:column;max-height:230px;overflow-y:auto}
  .gclog{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;column-gap:8px;
    padding:6px 10px;border-bottom:1px solid color-mix(in srgb, var(--border) 60%, transparent)}
  .gclog:hover{background:var(--sidebar-accent)}
  .gcsha{grid-row:1/3;align-self:center;font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);
    background:var(--sidebar-accent);border-radius:5px;padding:2px 5px;height:fit-content}
  .gcsub{font-size:12px;color:var(--foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gcmeta{font-size:10px;color:var(--muted-foreground);font-family:var(--font-mono);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rsec .gn{font-family:var(--font-mono);opacity:.65;margin-left:5px;font-weight:400}
  .rsec .lnk{margin-left:auto;font-size:10.5px;color:var(--muted-foreground);cursor:pointer;
    background:none;border:0;padding:0 2px}
  .rsec .lnk:hover{color:var(--foreground);text-decoration:underline}
  .frow.git{align-items:center}
  .frow.git .fp{cursor:pointer}
  .frow.git .fp:hover{text-decoration:underline}
  .gacts{margin-left:auto;display:none;gap:1px;flex:none}
  /* --- VS Code-style source control --- */
  .scmcommit{padding:10px 10px 6px;display:flex;flex-direction:column;gap:8px}
  .scmmsgwrap{position:relative}
  .scmmsg{width:100%;box-sizing:border-box;min-height:60px;max-height:160px;resize:none;
    background:color-mix(in srgb, var(--input) 30%, var(--background));border:1px solid var(--input);
    border-radius:8px;padding:8px 10px;font:inherit;font-size:12.5px;line-height:1.5;color:var(--foreground);overflow-y:auto}
  .scmmsg::placeholder{color:color-mix(in srgb, var(--muted-foreground) 60%, transparent)}
  .scmmsg:focus{outline:none;border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 24%, transparent)}
  .scmgen{position:absolute;right:6px;bottom:6px;display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;
    background:color-mix(in srgb, var(--primary) 14%, transparent);color:var(--primary);border:1px solid color-mix(in srgb, var(--primary) 30%, transparent);
    border-radius:6px;font:inherit;font-size:10.5px;font-weight:600;cursor:pointer;transition:background .12s}
  .scmgen:hover{background:color-mix(in srgb, var(--primary) 22%, transparent)}
  .scmgen svg{width:12px;height:12px}
  .scmgen.busy svg{animation:spin 1s linear infinite}
  .scmgen:disabled{opacity:.6;cursor:default}
  @keyframes spin{to{transform:rotate(360deg)}}
  .scmcommitrow{display:flex;gap:1px}
  .scmcommitbtn{flex:1;border-top-right-radius:0;border-bottom-right-radius:0;height:32px}
  .scmsplit{width:30px;flex:none;padding:0;border-top-left-radius:0;border-bottom-left-radius:0;
    border-left:1px solid color-mix(in srgb, var(--primary-foreground) 25%, transparent);height:32px}
  .scmsplit svg{width:14px;height:14px;transform:rotate(90deg)}
  .btn.primary:disabled{opacity:.5;cursor:default}
  .scmmenu{position:fixed;z-index:70;min-width:180px;background:var(--popover,var(--background));
    border:1px solid var(--border);border-radius:9px;box-shadow:0 12px 34px rgba(0,0,0,.3);padding:4px}
  .scmmi{display:block;width:100%;text-align:left;padding:7px 10px;border:0;border-radius:6px;background:none;
    color:var(--foreground);font:inherit;font-size:12.5px;cursor:pointer}
  .scmmi:hover{background:var(--sidebar-accent)}
  .scmsec{display:flex;align-items:center;gap:6px;padding:8px 10px 4px;font-size:11px;font-weight:600;
    letter-spacing:.04em;text-transform:uppercase;color:var(--muted-foreground)}
  .scmsec .scmn{font-family:var(--font-mono);font-weight:400;opacity:.7}
  .scmsec .lnk{margin-left:auto;display:inline-flex;color:var(--muted-foreground);cursor:pointer;background:none;border:0;padding:2px;border-radius:4px}
  .scmsec .lnk:hover{color:var(--foreground);background:var(--sidebar-accent)}
  .scmsec .lnk svg{width:14px;height:14px}
  /* the changed-files list: a fixed cap with its own scroll, so a big diff set
     stays a bounded panel instead of pushing the commit box and history away */
  .scmlist{display:flex;flex-direction:column;max-height:34vh;overflow-y:auto}
  .scmrow{display:flex;align-items:center;gap:6px;padding:4px 10px;cursor:default}
  .scmrow:hover{background:var(--sidebar-accent)}
  .scmname{flex:1;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;
    color:var(--foreground)}
  .scmname:hover{text-decoration:underline}
  .scmname .scmdir{color:var(--muted-foreground);opacity:.7}
  .scmacts{display:none;gap:1px;flex:none}
  .scmrow:hover .scmacts{display:flex}
  .scmbadge{flex:none;width:16px;text-align:center;font-family:var(--font-mono);font-size:11px;font-weight:700}
  .scmbadge.mod{color:#e2b341}
  .scmbadge.add{color:#4aa564}
  .scmbadge.del{color:#e5674d}
  .frow.git:hover .gacts{display:flex}
  .iconbtn.xs{width:20px;height:20px;border-radius:5px}
  /* A message that matches, in the sidebar under the projects. */
  .chit{display:flex;gap:7px;padding:5px 10px;cursor:pointer;align-items:baseline;font-size:11px}
  .chit:hover{background:var(--sidebar-accent)}
  .chit .cw{flex:none;color:var(--muted-foreground);font-size:10px;max-width:60px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chit .cs{flex:1;min-width:0;color:var(--foreground);overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap;opacity:.85}
  .stitle .cnt{margin-left:auto;font-family:var(--font-mono);font-size:10px;opacity:.7}
  /* ── Search ───────────────────────────────────────────
     Two modes, one box. Code hits group by file, because twenty hits in one
     file is one answer rather than twenty. */
  .smodes{display:flex;align-items:center;gap:4px;padding:0 8px 6px 8px}
  .smodes .lvl{padding:2px 8px;border-radius:11px;cursor:pointer;font-size:10.5px;
    color:var(--muted-foreground);border:1px solid transparent}
  .smodes .lvl:hover{background:var(--sidebar-accent)}
  .smodes .lvl.on{background:var(--sidebar-accent);border-color:var(--border);color:var(--foreground)}
  .scount{font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground)}
  .hitfile{display:flex;align-items:center;gap:6px;padding:6px 10px 2px 10px;
    font-size:11px;font-weight:600;color:var(--foreground);position:sticky;top:0;
    background:var(--card);border-top:1px solid var(--border)}
  .hitfile .fp{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
  .hitfile .hc{margin-left:auto;font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);flex:none}
  .hitrow{display:flex;gap:8px;padding:2px 10px 2px 14px;cursor:pointer;align-items:baseline}
  .hitrow:hover{background:var(--sidebar-accent)}
  .hitrow .hn{font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);
    flex:none;min-width:26px;text-align:right}
  .hitrow .ht{font-family:var(--font-mono);font-size:10.5px;color:var(--muted-foreground);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
  .hitrow mark,.chit mark{background:color-mix(in srgb,var(--warn) 35%,transparent);
    color:var(--foreground);border-radius:2px;padding:0 1px}
  /* ── Brain ────────────────────────────────────────────
     The tab used to be the projection dumped as grey lines with one button.
     It is the whole premise of the product, so it says what it holds, what it
     read, and exactly what an agent receives — a claim next to its evidence. */
  .pane-inner.brain{display:flex;flex-direction:column;gap:0;max-width:760px;padding-bottom:40px}
  .bstats{display:flex;align-items:center;gap:22px;padding:4px 0 16px 0}
  .bstat{display:flex;flex-direction:column;gap:1px}
  .bstat .n{font-size:20px;font-weight:600;letter-spacing:-.02em;font-family:var(--font-mono)}
  .bstat .l{font-size:10.5px;color:var(--muted-foreground);letter-spacing:.02em}
  .bsec{display:flex;align-items:baseline;gap:8px;font-size:12px;font-weight:600;
    padding:18px 0 8px 0;border-top:1px solid var(--border);margin-top:8px}
  .bsec:first-of-type{border-top:0;margin-top:0}
  .bhint{font-weight:400;font-size:10.5px;color:var(--muted-foreground)}
  .bempty{font-size:11.5px;color:var(--muted-foreground);line-height:1.65;padding:6px 0 4px 0;max-width:60ch}
  .bempty.sm{font-size:11px;padding:4px 0}
  /* --- the learned-memory list --- */
  .bhead{position:sticky;top:0;background:var(--background);padding:2px 0 10px;z-index:2}
  .bkinds{display:flex;flex-wrap:wrap;gap:6px}
  .bkind{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:99px;
    border:1px solid var(--border);background:transparent;color:var(--muted-foreground);cursor:pointer;
    font:inherit;font-size:11.5px;text-transform:capitalize;transition:background .12s,color .12s,border-color .12s}
  .bkind:hover{background:var(--sidebar-accent);color:var(--foreground)}
  .bkind.on{background:var(--foreground);color:var(--background);border-color:transparent;font-weight:600}
  .bkind .kn{font-family:var(--font-mono);font-size:10px;opacity:.7}
  .bseed{display:flex;gap:6px;padding:0 0 12px}
  .bseed input{flex:1;min-width:0;height:34px;background:color-mix(in srgb, var(--input) 30%, var(--background));
    border:1px solid var(--input);border-radius:9px;padding:0 12px;font:inherit;font-size:12.5px;color:var(--foreground)}
  .bseed input::placeholder{color:color-mix(in srgb, var(--muted-foreground) 65%, transparent)}
  .bseed input:focus{outline:none;border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 26%, transparent)}
  .bmems{display:flex;flex-direction:column;gap:8px;padding-bottom:14px}
  .bmem{border:1px solid var(--border);border-radius:11px;padding:10px 11px;background:var(--card);
    transition:border-color .12s,box-shadow .12s}
  .bmem:hover{border-color:color-mix(in srgb, var(--muted-foreground) 32%, transparent)}
  .bmem.low{opacity:.72}
  .bmrow{display:flex;align-items:flex-start;gap:8px}
  .bmtext{flex:1;min-width:0;font-size:12.5px;line-height:1.5;color:var(--foreground);word-break:break-word}
  .bforget{flex:none;opacity:0;transition:opacity .12s;color:var(--muted-foreground)}
  .bmem:hover .bforget{opacity:.75}
  .bforget:hover{opacity:1;color:var(--danger,#e5484d)}
  .bents{display:flex;flex-wrap:wrap;gap:4px;margin:7px 0 2px 0}
  .bent{font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);
    background:var(--sidebar-accent);border-radius:5px;padding:1px 6px;max-width:100%;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bmmeta{display:flex;align-items:center;gap:5px;margin-top:7px;font-size:10.5px;color:var(--muted-foreground);font-family:var(--font-mono)}
  .bmmeta svg{width:12px;height:12px;flex:none}
  .bmmeta .dim{opacity:.75}
  /* kind badges — each carries a word AND a colour (never colour alone) */
  .bbadge{flex:none;font-size:9.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
    padding:2px 6px;border-radius:5px;line-height:1.4;height:fit-content}
  .bk-constraint{color:#e8a13a;background:color-mix(in srgb,#e8a13a 16%,transparent)}
  .bk-failure{color:#e5674d;background:color-mix(in srgb,#e5674d 16%,transparent)}
  .bk-decision{color:#5b8cff;background:color-mix(in srgb,#5b8cff 16%,transparent)}
  .bk-convention{color:#3aa88b;background:color-mix(in srgb,#3aa88b 16%,transparent)}
  .bk-fact{color:var(--muted-foreground);background:var(--sidebar-accent)}
  .bk-task{color:#a07ad6;background:color-mix(in srgb,#a07ad6 16%,transparent)}
  .bkind.bk-failure.on{background:#e5674d;color:#fff}
  .bkind.bk-constraint.on{background:#e8a13a;color:#1a1200}
  .badd{display:flex;gap:6px;padding:2px 0 8px 0}
  .badd input{flex:1;min-width:0;background:var(--input,var(--card));border:1px solid var(--border);
    border-radius:8px;padding:6px 10px;font-size:12px;color:var(--foreground);font-family:var(--font-sans)}
  .badd input:focus{outline:none;border-color:var(--ring,var(--muted-foreground))}
  .bdecs{display:flex;flex-direction:column;gap:1px}
  .bdec{display:flex;gap:9px;padding:5px 8px;border-radius:7px;font-size:12px;line-height:1.55}
  .bdec:hover{background:var(--sidebar-accent)}
  .bdec .dm{color:var(--warn);flex:none}
  .bdec .dt{white-space:pre-wrap;word-break:break-word}
  .bsrcs{display:flex;flex-direction:column;gap:2px}
  .bsrc{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;font-size:12px}
  .bsrc:hover{background:var(--sidebar-accent)}
  .bsrc svg{width:14px;height:14px;flex:none}
  .bsrc .si{font-weight:600}
  .bsrc .sf{color:var(--muted-foreground);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bsrc .sc{margin-left:auto;color:var(--muted-foreground);font-family:var(--font-mono);font-size:10.5px;flex:none}
  .bdoc{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--card);
    max-height:420px;overflow:auto}
  .bl{font-size:11.5px;line-height:1.65;color:var(--muted-foreground);white-space:pre-wrap;word-break:break-word}
  .bl.sp{height:7px}
  .bl.h1,.bl.h2,.bl.h3{color:var(--foreground);font-weight:600;margin-top:8px}
  .bl.h1{font-size:13px}
  .bl.h2{font-size:12px}
  .bl.h3{font-size:11.5px;opacity:.9}
  .bl.li{padding-left:12px;position:relative}
  .bl.li::before{content:"•";position:absolute;left:2px;opacity:.5}
  /* Add-an-agent rows: an ADE you haven't installed is still listed, greyed,
     with the reason — "Codex isn't in the list" and "Codex isn't installed"
     send you to very different places. */
  .addrow{cursor:pointer}
  .addrow .fp{color:var(--foreground)}
  .addrow:hover{background:var(--sidebar-accent)}
  .addrow.off{cursor:default;opacity:.5}
  .addrow.off:hover{background:none}
  .frow.agentrow .gacts,.frow.bridge .gacts{margin-left:4px}
  .iconbtn.xs svg{width:11px;height:11px}
  .gcommit{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border);align-items:center}
  .gcommit input{flex:1;min-width:0;background:var(--input,var(--card));border:1px solid var(--border);
    border-radius:7px;padding:5px 8px;font-size:11.5px;color:var(--foreground);font-family:var(--font-sans)}
  .gcommit input:focus{outline:none;border-color:var(--ring,var(--muted-foreground))}
  .gcommit .btn{flex:none;white-space:nowrap}
  /* ── Console ──────────────────────────────────────────
     Errors live in the terminal's dock: same drawer, same edge. The dot on the
     toolbar button is the only thing that ever asks for attention, and only
     for an error you haven't looked at. */
  .errdot{position:absolute;top:3px;right:3px;width:6px;height:6px;border-radius:50%;
    background:var(--danger,#e5484d);display:none;box-shadow:0 0 0 1.5px var(--card)}
  .errdot.on{display:block}
  #consolebtn{position:relative}
  .conwrap{position:absolute;inset:0;display:none;flex-direction:column;overflow:hidden;
    background:var(--background)}
  /* The console is a pseudo-pane: shown when its tab is active, and the terminal
     panes are deactivated at the same time, so no overlap and no z-index race. */
  .conwrap.on{display:flex;z-index:5}
  /* the Console tab in the terminal bar */
  .termtab.console svg{width:13px;height:13px;flex:none;opacity:.8}
  .termtab.console .ctt{margin:0 1px}
  .conbar{display:flex;align-items:center;gap:6px;flex:none;height:28px;padding:0 8px;
    border-bottom:1px solid var(--border);font-size:11px;color:var(--muted-foreground)}
  .conbar .lvl{padding:2px 7px;border-radius:11px;cursor:pointer;border:1px solid transparent;
    font-family:var(--font-mono);font-size:10px;letter-spacing:.02em}
  .conbar .lvl:hover{background:var(--sidebar-accent)}
  .conbar .lvl.on{background:var(--sidebar-accent);border-color:var(--border);color:var(--foreground)}
  .conlist{flex:1;min-height:0;overflow:auto;font-family:var(--font-mono);font-size:11px;line-height:1.55}
  .conrow{display:flex;gap:8px;padding:3px 10px;border-bottom:1px solid color-mix(in srgb,var(--border) 45%,transparent);
    align-items:baseline}
  .conrow:hover{background:color-mix(in srgb,var(--sidebar-accent) 55%,transparent)}
  .conrow .t{flex:none;color:var(--muted-foreground);opacity:.75}
  .conrow .sc{flex:none;color:var(--muted-foreground);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .conrow .ms{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
  .conrow.error .ms{color:var(--danger,#e5484d)}
  .conrow.warn .ms{color:var(--warn)}
  .conrow .det{cursor:pointer;color:var(--muted-foreground);flex:none;opacity:.7}
  .conrow .det:hover{opacity:1}
  .condetail{padding:6px 10px 8px 10px;white-space:pre-wrap;word-break:break-word;
    color:var(--muted-foreground);background:color-mix(in srgb,var(--sidebar-accent) 40%,transparent);
    border-bottom:1px solid var(--border);font-size:10.5px}
  .conempty{padding:20px 12px;color:var(--muted-foreground);font-family:var(--font-sans);font-size:12px}
  .termpane{position:absolute;inset:0;display:none}
  .termpane.active{display:block}
  .termpane .xterm{height:100%;padding:6px 8px 0 12px}
  .termpane .xterm-viewport{background:transparent!important}
  .termpane .xterm-viewport::-webkit-scrollbar{width:12px}
  .termpane .xterm-viewport::-webkit-scrollbar-thumb{
    background:color-mix(in srgb, var(--muted-foreground) 28%, transparent);
    border:3px solid transparent;border-radius:7px;background-clip:padding-box}
  .termbody{height:100%;overflow-y:auto;padding:8px 12px;font-family:var(--font-mono);font-size:12px;
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
  /* ── Observatory (the fleet in action, the one brain) ── */
  #pane-observatory{padding:18px 20px 40px}
  .obhead{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
  .obtitle{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:650;letter-spacing:-.01em}
  .obtitle svg{width:18px;height:18px;color:var(--primary)}
  .obtitle .obsub{font-weight:400}
  .obsub{color:var(--muted-foreground);font-size:12px}
  .obtraceui{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;
    color:var(--muted-foreground);border:1px solid var(--border);border-radius:var(--radius-sm);
    padding:6px 11px;text-decoration:none;transition:background .15s,color .15s}
  .obtraceui svg{width:13px;height:13px}
  .obtraceui:hover{background:color-mix(in srgb, var(--primary) 14%, transparent);color:var(--foreground);
    border-color:color-mix(in srgb, var(--primary) 45%, transparent)}
  .obmetrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;margin-bottom:18px}
  .obcard{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px}
  .obcard.accent{border-color:color-mix(in srgb, var(--primary) 40%, transparent)}
  .obcl{font-size:11px;color:var(--muted-foreground);font-family:var(--font-mono);letter-spacing:.04em;text-transform:uppercase}
  .obcv{font-size:22px;font-weight:650;letter-spacing:-.02em;margin-top:4px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .obcard.accent .obcv{color:var(--primary)}
  .obcv .live{color:var(--thread-ink)}
  .obcs{font-size:11px;color:var(--muted-foreground);margin-top:2px}
  .obcanvaswrap{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
    padding:8px;margin-bottom:18px;position:relative;overflow:hidden;
    background-image:radial-gradient(color-mix(in srgb, var(--muted-foreground) 16%, transparent) 1px, transparent 1px);
    background-size:22px 22px}
  .obsvg{display:block;width:100%;height:auto;max-height:60vh;touch-action:none}
  .obnode{cursor:grab}
  @media (prefers-reduced-motion:no-preference){
    .obbrainpulse{transform-origin:center;animation:obpulse 2.4s ease-out infinite}
    .obnode.busy .obdotpulse{transform-origin:center;animation:obpulse 1.6s ease-out infinite}
  }
  @keyframes obpulse{0%{transform:scale(1);opacity:.6}70%{transform:scale(1.5);opacity:0}100%{opacity:0}}
  .obagents{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
  .obagentshead{font-size:11px;color:var(--muted-foreground);font-family:var(--font-mono);letter-spacing:.04em;
    text-transform:uppercase;padding:11px 14px 8px}
  .obrow{display:flex;align-items:center;gap:10px;padding:9px 14px;border-top:1px solid var(--border);font-size:13px}
  .obdot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--muted-foreground)}
  .obdot.busy{background:var(--thread)}.obdot.baton{background:var(--shuttle)}
  .obname{font-weight:600}
  .obkind{color:var(--muted-foreground);font-size:12px}
  .obspend{margin-left:auto;font-variant-numeric:tabular-nums}
  .obturns,.obtok{color:var(--muted-foreground);font-size:12px;font-variant-numeric:tabular-nums;min-width:64px;text-align:right}
  .obempty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;text-align:center}
  /* sub-view tabs (Canvas / Graph / Timeline / Metrics) */
  /* Scrolls rather than clips when the pane is narrow (file tree open, small
     window) — all eight views stay reachable; keyboard/arrow nav scrolls the
     focused tab into view. Scrollbar hidden for the pill look. */
  .obtabs{display:flex;gap:2px;background:var(--secondary);border:1px solid var(--border);
    border-radius:var(--radius);padding:3px;margin-bottom:16px;max-width:100%;overflow-x:auto;
    overscroll-behavior-x:contain;scrollbar-width:none}
  .obtabs::-webkit-scrollbar{display:none}
  .obtab{appearance:none;background:none;border:0;color:var(--muted-foreground);font:inherit;font-size:12.5px;flex:none;white-space:nowrap;
    font-weight:500;padding:6px 14px;border-radius:var(--radius-sm);cursor:pointer;transition:background .15s,color .15s}
  .obtab:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
  .obtab:hover{color:var(--foreground)}
  .obtab.on{background:var(--card);color:var(--foreground);box-shadow:0 1px 0 rgb(0 0 0 / .12)}
  .obbody{min-height:200px}
  /* Ask Noz — a docked assistant over the Observatory, not a modal: you keep
     reading the dashboard while it answers. */
  .obask{appearance:none;display:inline-flex;align-items:center;gap:6px;background:var(--primary);color:var(--primary-foreground);
    border:1px solid var(--primary);border-radius:var(--radius-sm);padding:6px 12px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;margin-right:8px}
  .obask:hover{filter:brightness(1.08)}
  .obask svg{width:13px;height:13px}
  .obaskpanel{position:fixed;top:0;right:0;bottom:0;width:min(420px,92vw);background:var(--card);border-left:1px solid var(--border);
    display:none;flex-direction:column;z-index:60;box-shadow:-18px 0 42px -22px rgb(0 0 0 / .55)}
  .obaskpanel.open{display:flex}
  .askhd{display:flex;align-items:center;gap:8px;padding:12px 12px 10px 16px;border-bottom:1px solid var(--border)}
  .askt{display:inline-flex;align-items:center;gap:7px;font-size:13.5px;font-weight:700;flex:1}
  .askt svg{width:15px;height:15px;color:var(--primary)}
  .askempty{flex:1;overflow-y:auto;padding:28px 18px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:9px}
  .askmark{width:42px;height:42px;border-radius:12px;background:color-mix(in srgb,var(--primary) 14%,transparent);
    display:flex;align-items:center;justify-content:center;color:var(--primary)}
  .askmark svg{width:21px;height:21px}
  .askh{font-size:16px;font-weight:700}
  .asksub{font-size:12px;line-height:1.55;color:var(--muted-foreground);max-width:34ch}
  .asksugs{display:flex;flex-direction:column;gap:7px;width:100%;margin-top:8px}
  .asksug{appearance:none;text-align:left;background:var(--secondary);border:1px solid var(--border);border-radius:var(--radius-sm);
    padding:9px 12px;font:inherit;font-size:12px;color:var(--foreground);cursor:pointer;transition:border-color .15s}
  .asksug:hover{border-color:var(--primary)}
  .askmsgs{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:11px}
  .askm{font-size:12.5px;line-height:1.6;border-radius:var(--radius);padding:9px 12px;max-width:100%;overflow-wrap:break-word}
  .askm.user{background:var(--secondary);align-self:flex-end;max-width:85%}
  .askm.askreply{background:transparent;border:1px solid var(--border);align-self:stretch}
  .askm.pending{display:flex;align-items:center;gap:8px;color:var(--muted-foreground)}
  .askdots{display:inline-flex;gap:3px}
  .askdots i{width:4px;height:4px;border-radius:50%;background:var(--primary);animation:askd 1s ease-in-out infinite}
  .askdots i:nth-child(2){animation-delay:.15s}.askdots i:nth-child(3){animation-delay:.3s}
  @keyframes askd{0%,100%{opacity:.3}50%{opacity:1}}
  @media (prefers-reduced-motion:reduce){.askdots i{animation:none;opacity:.7}}
  .askvia{margin-top:7px;padding-top:6px;border-top:1px solid var(--border);font-size:10px;color:var(--muted-foreground);font-family:var(--font-mono)}
  .askform{display:flex;gap:8px;align-items:flex-end;padding:11px 12px;border-top:1px solid var(--border)}
  .askform textarea{flex:1;resize:none;background:var(--secondary);border:1px solid var(--border);border-radius:var(--radius-sm);
    padding:9px 11px;font:inherit;font-size:12.5px;color:var(--foreground);max-height:120px;min-height:38px}
  .askform textarea:focus{outline:none;border-color:var(--primary)}
  .asksend{appearance:none;flex:none;width:38px;height:38px;border-radius:var(--radius-sm);border:0;background:var(--primary);
    color:var(--primary-foreground);cursor:pointer;display:flex;align-items:center;justify-content:center}
  .asksend svg{width:15px;height:15px}
  /* dashboard charts — donuts for composition, lines for behaviour over time */
  .obchartgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin:14px 0}
  .obchart{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px 10px;min-width:0}
  .obchart.wide{grid-column:1/-1}
  .obcht{display:flex;align-items:baseline;gap:8px;margin-bottom:10px}
  .obchtt{font-size:12.5px;font-weight:600;color:var(--foreground)}
  .obchts{font-size:11px;color:var(--muted-foreground)}
  .obchempty{font-size:12px;color:var(--muted-foreground);padding:22px 0;text-align:center}
  .obdonutwrap{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .obdonut{width:132px;height:132px;flex:none}
  .obdcv{font-size:19px;font-weight:700;fill:var(--foreground);text-anchor:middle;font-variant-numeric:tabular-nums}
  .obdcs{font-size:8.5px;fill:var(--muted-foreground);text-anchor:middle;letter-spacing:.08em;text-transform:uppercase}
  .obdlegend{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}
  .obdli{display:flex;align-items:center;gap:7px;font-size:11.5px;min-width:0}
  .obdsw{width:8px;height:8px;border-radius:2px;flex:none}
  .obdlk{color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
  .obdlv{color:var(--foreground);font-variant-numeric:tabular-nums;font-weight:600;flex:none}
  .obsvgline{width:100%;height:130px;display:block}
  .obgl{stroke:var(--border);stroke-width:1}
  .obax{font-size:8px;fill:var(--muted-foreground);font-variant-numeric:tabular-nums}
  .obslegend{display:flex;flex-wrap:wrap;gap:12px;margin-top:6px}
  .obsli{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted-foreground)}
  .obexplain{font-size:12.5px;line-height:1.6;color:var(--muted-foreground);margin:11px 2px 15px;max-width:760px}
  .obexplain b{color:var(--foreground);font-weight:600}
  .obexplain code{font-family:var(--font-mono);font-size:11px;background:var(--secondary);padding:1px 5px;border-radius:5px;color:var(--foreground)}
  .obdraghint{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--muted-foreground);opacity:.8;margin-left:3px}
  .obdraghint svg{width:12px;height:12px;opacity:.8}
  .obnode{transition:filter .12s}
  .obnode.dragging{filter:brightness(1.18)}
  /* A live edge marches from the brain toward the agent that is using it. */
  .obedge.live{stroke-dasharray:5 7;animation:obflow 1.1s linear infinite}
  @keyframes obflow{to{stroke-dashoffset:-24}}
  @media (prefers-reduced-motion:reduce){.obedge.live{animation:none;stroke-dasharray:none}}
  .oblegend{display:flex;flex-wrap:wrap;align-items:center;gap:14px;padding:9px 4px 2px;font-size:11px;color:var(--muted-foreground)}
  .oblg{display:inline-flex;align-items:center;gap:6px}
  .oblgline{width:16px;height:2px;border-radius:2px;flex:none}
  .oblgline.dash{background:repeating-linear-gradient(90deg,var(--border) 0 3px,transparent 3px 7px)}
  .oblglive{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
  .oblgline.recent{box-shadow:0 0 0 2px color-mix(in srgb,var(--shuttle) 30%,transparent)}
  .oblgx{font-family:var(--font-mono);font-size:10px;font-weight:700;color:var(--shuttle-ink)}
  .obhop.recent{filter:drop-shadow(0 0 3px color-mix(in srgb,var(--shuttle) 55%,transparent))}
  .oblgdot{width:6px;height:6px;border-radius:50%;background:var(--live);box-shadow:0 0 0 3px color-mix(in srgb,var(--live) 22%,transparent)}
  .obnote{color:var(--muted-foreground);font-size:12.5px;padding:0 2px 12px;max-width:70ch}
  .obcanvaswrap.graph{padding:8px}
  /* timeline */
  .obtimeline{list-style:none;margin:0;padding:2px 0 2px 2px;position:relative}
  .obtimeline:before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:1px;background:var(--border)}
  .obtl{position:relative;display:flex;align-items:baseline;gap:12px;padding:6px 0 6px 22px;font-size:13px}
  .obtldot{position:absolute;left:1px;top:11px;width:9px;height:9px;border-radius:50%;background:var(--muted-foreground);
    box-shadow:0 0 0 3px var(--background)}
  .obtl.ok .obtldot{background:var(--ok)}.obtl.baton .obtldot{background:var(--shuttle)}
  .obtl.warn .obtldot{background:var(--warn)}.obtl.err .obtldot{background:var(--err)}
  .obtl.info .obtldot{background:var(--thread)}.obtl.mem .obtldot{background:var(--primary)}
  .obtl.heal .obtldot{background:var(--primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 28%,transparent)}
  .obtllabel{flex:1;font-family:var(--font-mono);font-size:12px;color:var(--foreground);letter-spacing:.01em}
  .obtl.err .obtllabel{color:var(--err)}.obtl.warn .obtllabel{color:var(--warn)}
  .obtl.heal .obtllabel{color:var(--primary);font-weight:600}
  .obtltime{color:var(--muted-foreground);font-size:11px;font-variant-numeric:tabular-nums;flex:none}
  /* metrics detail */
  .obmsec{margin-bottom:14px}
  .obmlabel{font-size:11px;color:var(--muted-foreground);font-family:var(--font-mono);letter-spacing:.04em;
    text-transform:uppercase;margin-bottom:8px}
  .obchain{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
  .obchip{background:var(--secondary);border:1px solid var(--border);border-radius:999px;padding:3px 11px;font-size:12px;font-weight:500}
  .obchain .obarrow{color:var(--shuttle-ink)}
  .obmgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:16px}
  .obminicard{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:10px 13px}
  .obcv.sm{font-size:19px}
  /* agent self-triage */
  .obtriage{appearance:none;margin-left:12px;flex:none;background:none;border:1px solid var(--border);
    border-radius:999px;color:var(--muted-foreground);font:inherit;font-size:11px;font-weight:500;
    padding:3px 10px;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
  .obtriage:hover{color:var(--warn);border-color:color-mix(in srgb, var(--warn) 50%, transparent);
    background:color-mix(in srgb, var(--warn) 12%, transparent)}
  .triagemodal{max-width:580px;width:92vw}
  .tmeta{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap}
  .tbadge{font-size:10.5px;font-family:var(--font-mono);letter-spacing:.03em;text-transform:uppercase;
    padding:2px 8px;border-radius:999px;background:var(--secondary);color:var(--muted-foreground)}
  .tbadge.on{background:color-mix(in srgb, var(--primary) 22%, transparent);color:var(--thread-ink)}
  .tlabel{font-size:11px;color:var(--muted-foreground);font-family:var(--font-mono);letter-spacing:.04em;
    text-transform:uppercase;margin:14px 0 6px}
  .trootcause{font-size:14px;line-height:1.55;color:var(--foreground);
    background:color-mix(in srgb, var(--warn) 8%, var(--card));
    border:1px solid color-mix(in srgb, var(--warn) 30%, transparent);border-radius:var(--radius);padding:12px 14px}
  .tfix{font-size:13.5px;line-height:1.5;color:var(--foreground);
    background:color-mix(in srgb, var(--ok) 9%, var(--card));
    border:1px solid color-mix(in srgb, var(--ok) 30%, transparent);border-radius:var(--radius);padding:11px 14px}
  .tevidence{display:flex;flex-direction:column;gap:1px;max-height:210px;overflow:auto;
    border:1px solid var(--border);border-radius:var(--radius)}
  .tev{display:flex;align-items:baseline;gap:8px;padding:5px 10px;font-family:var(--font-mono);font-size:11px}
  .tev.err{background:color-mix(in srgb, var(--err) 10%, transparent)}
  .tev.err .tevn{color:var(--err)}
  .tevn{color:var(--thread-ink);flex:none;min-width:132px}
  .tevm{color:var(--muted-foreground);flex:none;min-width:44px;text-align:right}
  .tevmsg{flex:1;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tevt{color:var(--muted-foreground);flex:none}
  /* health score pill + breakdown */
  .obhealth{appearance:none;flex:none;margin-left:6px;min-width:34px;text-align:center;font:inherit;
    font-size:11px;font-weight:700;font-family:var(--font-mono);padding:2px 8px;border-radius:999px;
    border:1px solid var(--border);background:var(--secondary);color:var(--muted-foreground);cursor:pointer}
  .obhealth.na{cursor:default;opacity:.6}
  .obhealth.healthy{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,transparent);background:color-mix(in srgb,var(--ok) 12%,transparent)}
  .obhealth.degraded{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,transparent);background:color-mix(in srgb,var(--warn) 12%,transparent)}
  .obhealth.unhealthy{color:var(--err);border-color:color-mix(in srgb,var(--err) 45%,transparent);background:color-mix(in srgb,var(--err) 12%,transparent)}
  .healthmodal{max-width:420px;width:90vw}
  .hscore{font-size:46px;font-weight:800;line-height:1;display:flex;align-items:baseline;gap:8px;color:var(--foreground)}
  .hscore.healthy{color:var(--ok)} .hscore.degraded{color:var(--warn)} .hscore.unhealthy{color:var(--err)}
  .hscoremax{font-size:16px;font-weight:600;color:var(--muted-foreground)}
  .hgrade{font-size:11px;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:999px;background:var(--secondary);align-self:center;margin-left:auto}
  .hgrade.healthy{color:var(--ok)} .hgrade.degraded{color:var(--warn)} .hgrade.unhealthy{color:var(--err)}
  .hbk{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:12px}
  .hbkl{flex:none;width:88px;color:var(--muted-foreground)}
  .hbkbar{flex:1;height:7px;border-radius:4px;background:var(--secondary);overflow:hidden}
  .hbkfill{display:block;height:100%;background:var(--warn);border-radius:4px}
  .hbkv{flex:none;width:34px;text-align:right;font-family:var(--font-mono);color:var(--muted-foreground)}
  /* burn rate + budgets */
  .obasync{min-height:180px}
  .burnwrap{display:flex;flex-direction:column}
  .burnsvg{width:100%;height:150px;display:block;margin:4px 0 8px}
  .burnempty{display:flex;align-items:center;gap:10px;margin:4px 0 10px;padding:14px 16px;
    border:1px dashed var(--border);border-radius:var(--radius);color:var(--muted-foreground);
    font-size:12.5px;line-height:1.45;background:color-mix(in oklab,var(--card) 60%,transparent)}
  .burnempty svg{width:16px;height:16px;flex:none;opacity:.6}
  .burnempty b{color:var(--foreground);font-weight:600}
  .burnstats{display:flex;gap:10px;flex-wrap:wrap}
  .budgets{display:flex;flex-direction:column;gap:6px}
  .budrow{display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card)}
  .budrow .obname{flex:none;min-width:110px}
  .budrow .obsub{flex:none}
  .budinput{flex:1;max-width:120px;margin-left:auto;background:var(--secondary);border:1px solid var(--border);border-radius:8px;
    color:var(--foreground);font:inherit;font-size:13px;padding:5px 9px}
  .budsave{flex:none;appearance:none;border:1px solid var(--border);background:var(--secondary);color:var(--foreground);
    font:inherit;font-size:12px;font-weight:600;padding:5px 12px;border-radius:8px;cursor:pointer}
  .budsave:hover{border-color:var(--primary);color:var(--primary)}
  /* span replay */
  .replaywrap{display:flex;flex-direction:column}
  .rpscrubwrap{margin:4px 0 12px}
  .rpscrub{width:100%;accent-color:var(--primary)}
  .rpscrubinfo{font-size:11px;color:var(--muted-foreground);font-family:var(--font-mono);margin-top:4px}
  .rpframe{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);padding:14px 16px}
  .rphead{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .rpagent{font-weight:700;font-size:14px}
  .rpade{font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground)}
  .rpstatus{margin-left:auto;font-family:var(--font-mono);font-size:10px;font-weight:700;letter-spacing:.05em;padding:2px 8px;border-radius:999px}
  .rpstatus.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
  .rpstatus.err{color:var(--err);background:color-mix(in srgb,var(--err) 14%,transparent)}
  .rpmsg{font-size:13.5px;line-height:1.5;color:var(--foreground);margin-bottom:10px}
  .rpmetrics{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .rppill{font-family:var(--font-mono);font-size:11px;color:var(--foreground);background:var(--secondary);border-radius:999px;padding:3px 10px}
  .rppl{color:var(--muted-foreground)}
  .rpactions{display:flex;gap:8px;flex-wrap:wrap}
  .rpwf,.obtrace{appearance:none;text-decoration:none;font:inherit;font-size:12px;font-weight:600;padding:6px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--border)}
  .rpwf{background:color-mix(in srgb,var(--primary) 16%,transparent);color:var(--primary);border-color:color-mix(in srgb,var(--primary) 40%,transparent)}
  .obtrace{background:var(--secondary);color:var(--muted-foreground)}
  .obtrace:hover{color:var(--primary);border-color:var(--primary)}
  .obtrace.wide{display:block;text-align:center;margin-top:12px}
  .rpnote{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;line-height:1.45;color:var(--muted-foreground);background:var(--secondary);border:1px solid var(--border);border-radius:8px;padding:6px 11px}
  .rpnote svg{width:13px;height:13px;flex:none;opacity:.7}
  /* trace waterfall */
  .wfmodal{max-width:640px;width:94vw}
  .wftotal{margin-bottom:8px}
  .wfrows{display:flex;flex-direction:column;gap:3px;max-height:340px;overflow:auto}
  .wfrow{display:flex;align-items:center;gap:8px}
  .wfname{flex:none;width:150px;font-family:var(--font-mono);font-size:11px;color:var(--thread-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .wfname.err{color:var(--err)}
  .wftrack{flex:1;position:relative;height:16px;background:var(--secondary);border-radius:4px}
  .wfbar{position:absolute;top:2px;height:12px;min-width:2px;border-radius:3px;background:var(--primary)}
  .wfbar.err{background:var(--err)}
  .wfms{flex:none;width:56px;text-align:right;font-family:var(--font-mono);font-size:10.5px;color:var(--muted-foreground)}
  .wfsum{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);padding:13px 15px;margin-bottom:14px}
  .wfsumhd{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
  .wfagent{font-size:15px;font-weight:700}
  .wfmodel{font-size:11px;color:var(--muted-foreground);font-family:var(--font-mono)}
  .wfstatus{margin-left:auto;font-family:var(--font-mono);font-size:10px;font-weight:700;letter-spacing:.05em;padding:2px 9px;border-radius:999px}
  .wfstatus.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 13%,transparent)}
  .wfstatus.err{color:var(--err);background:color-mix(in srgb,var(--err) 15%,transparent)}
  .wfsumstats{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
  .wfp{font-family:var(--font-mono);font-size:11px;color:var(--foreground);background:var(--secondary);border-radius:999px;padding:3px 10px}
  .wfp .wfpl{color:var(--muted-foreground)}
  .wflabel{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-foreground);margin:2px 0 8px}
  .wfaxis{display:flex;justify-content:space-between;font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);margin:6px 2px 2px;padding-left:158px}
  .wfempty{font-size:13px;line-height:1.55;color:var(--muted-foreground);padding:8px 2px 4px}
  /* KAIRO dense metrics */
  .kmgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
  .kmcard{position:relative;overflow:hidden;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);padding:12px 14px}
  .kmlabel{font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-foreground);margin-bottom:5px;padding-right:46px}
  .kmvalue{font-size:24px;font-weight:800;line-height:1;color:var(--foreground)}
  .kmvalue .kmcost{color:var(--primary)}
  .kmvalue .kmsm{font-size:13px;font-weight:600;display:inline-block;line-height:1.3}
  .kmsub{font-size:10.5px;color:var(--muted-foreground);margin-top:4px}
  .kmsparkwrap{position:absolute;top:10px;right:10px;opacity:.7}
  .kmspark.tok{color:var(--primary)} .kmspark.cost{color:var(--thread)} .kmspark.blue{color:var(--accentBlue)}
  .kmbar{height:4px;border-radius:99px;background:var(--secondary);overflow:hidden;margin-top:8px}
  .kmbarfill{height:100%;background:var(--primary);border-radius:99px}
  .kmagents{margin-bottom:18px;border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;background:var(--card)}
  .kmarow{display:grid;grid-template-columns:110px 1fr 48px;align-items:center;gap:10px;margin-top:7px}
  .kmaname{font-size:11.5px;color:var(--foreground);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .kmabarwrap{height:6px;background:var(--secondary);border-radius:99px;overflow:hidden}
  .kmabar{display:block;height:100%;background:var(--primary);border-radius:99px}
  .kmatok{font-size:10.5px;color:var(--muted-foreground);text-align:right;font-family:var(--font-mono)}
  @media(max-width:900px){.kmgrid{grid-template-columns:repeat(2,1fr)}}
  /* Decision Explorer */
  .decheader{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}
  .declabel{font-size:11px;letter-spacing:.08em;color:var(--muted-foreground)}
  .deccount{font-size:11px;color:var(--primary)}
  .decfilters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
  .decchip{appearance:none;font:inherit;font-size:11px;padding:3px 11px;border-radius:99px;border:1px solid var(--border);background:transparent;color:var(--muted-foreground);cursor:pointer}
  .decchip.on,.decchip:hover{border-color:var(--primary);color:var(--primary);background:color-mix(in srgb,var(--primary) 10%,transparent)}
  .declayout{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
  .declist{display:flex;flex-direction:column;gap:8px;max-height:520px;overflow:auto}
  .decdetail{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);padding:16px;min-height:200px;position:sticky;top:0}
  .deccard{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);padding:11px 13px;cursor:pointer;transition:border-color .15s}
  .deccard:hover,.deccard.sel{border-color:var(--primary)}
  .decchd{display:flex;justify-content:space-between;margin-bottom:4px}
  .deccat{font-size:9.5px;letter-spacing:.09em;font-weight:700}
  .decconf{font-size:11px;color:var(--muted-foreground);font-family:var(--font-mono)}
  .decctitle{font-size:13px;font-weight:600;margin-bottom:3px;line-height:1.35}
  .deccwhy{font-size:11.5px;line-height:1.5;color:var(--muted-foreground);margin-bottom:7px}
  .deccmeta{font-size:10.5px;color:var(--muted-foreground);font-family:var(--font-mono);display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .deccagent{color:var(--foreground)}
  .deccrole,.deccalt{padding:1px 6px;border:1px solid var(--border);border-radius:99px;font-size:9.5px}
  /* How the decision was extracted — a rated number and a pattern match are
     different claims and must not look identical. */
  .decsrc{display:inline-flex;align-items:center;padding:1px 7px;border-radius:99px;font-size:9.5px;font-weight:600;
    font-family:var(--font-mono);border:1px solid var(--border);color:var(--muted-foreground)}
  .decsrc.llm,.decsrc.cli{color:var(--ch2);border-color:color-mix(in srgb,var(--ch2) 40%,transparent);background:color-mix(in srgb,var(--ch2) 10%,transparent)}
  .decfoot{color:var(--muted-foreground);opacity:.75;font-size:10px}
  /* logs — a dense reading surface, so it is monospace and tightly ruled */
  .lgq{margin-left:auto;min-width:180px;font-size:11.5px}
  .lglist{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
  .lgrow{display:flex;align-items:baseline;gap:10px;padding:5px 11px;border-bottom:1px solid var(--border);
    font-family:var(--font-mono);font-size:11.5px;line-height:1.5}
  .lgrow:last-child{border-bottom:0}
  .lgrow:hover{background:var(--secondary)}
  .lgrow.error{background:color-mix(in srgb,var(--err) 7%,transparent)}
  .lgtime{color:var(--muted-foreground);flex:none;font-variant-numeric:tabular-nums}
  .lgsev{flex:none;width:44px;font-size:9.5px;font-weight:700;letter-spacing:.04em;color:var(--muted-foreground)}
  .lgsev.error{color:var(--err)} .lgsev.warn{color:var(--warn)} .lgsev.info{color:var(--ch2)} .lgsev.debug{opacity:.6}
  .lgagent{flex:none;min-width:88px;color:var(--foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lgbody{flex:1;min-width:0;color:var(--muted-foreground);overflow-wrap:anywhere}
  .lgtrace{flex:none;color:var(--ch2);text-decoration:none;font-size:10.5px}
  .lgtrace:hover{text-decoration:underline}
  .lgtrace.none{color:var(--muted-foreground);opacity:.4}
  /* metric explorer — one row per series, shape not scale */
  .obmexhd{display:flex;align-items:baseline;gap:10px;margin:22px 2px 8px;flex-wrap:wrap}
  .mexwins{margin-left:auto;display:inline-flex;gap:4px}
  .mexlist{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
  .mexrow{display:flex;align-items:center;gap:14px;padding:8px 13px;border-bottom:1px solid var(--border)}
  .mexrow:last-child{border-bottom:0}
  .mexrow:hover{background:var(--secondary)}
  .mexinfo{flex:1;min-width:0}
  .mexname{font-size:12px;font-weight:600;font-family:var(--font-mono);display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  .mextype{font-size:9.5px;font-weight:500;color:var(--muted-foreground);border:1px solid var(--border);border-radius:99px;padding:0 6px}
  .mexlbls{display:flex;gap:6px;flex-wrap:wrap;margin-top:3px}
  .mexlbl{font-size:10px;color:var(--muted-foreground);font-family:var(--font-mono)}
  .mexspark{width:110px;height:20px;flex:none;opacity:.9}
  .mexflat{width:110px;flex:none;font-size:10px;color:var(--muted-foreground);text-align:center}
  .mexval{flex:none;min-width:80px;text-align:right;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
  .mexagg{display:block;font-size:9px;font-weight:500;color:var(--muted-foreground);letter-spacing:.04em;text-transform:uppercase}
  /* self-heal — episodes, not a firehose: what fired, what Loom did, how long */
  .alwrap{display:flex;flex-direction:column}
  .alsec{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-foreground);margin:16px 2px 8px}
  .alsec:first-child{margin-top:4px}
  .alrow{display:flex;align-items:center;gap:11px;padding:10px 13px;background:var(--card);
    border:1px solid var(--border);border-radius:var(--radius);margin-bottom:7px}
  .alrow.paused{border-color:color-mix(in srgb,var(--err) 42%,var(--border))}
  .aldot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--muted-foreground)}
  .aldot.firing{background:var(--err);box-shadow:0 0 0 3px color-mix(in srgb,var(--err) 20%,transparent)}
  .aldot.resolved{background:var(--ok)}
  .alinfo{flex:1;min-width:0}
  .alname{font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .alalert{font-family:var(--font-mono);font-size:10px;font-weight:500;color:var(--muted-foreground);
    border:1px solid var(--border);border-radius:99px;padding:1px 7px}
  .alwhy{font-size:11.5px;color:var(--muted-foreground);margin-top:2px;font-variant-numeric:tabular-nums}
  .alstate{flex:none;font-size:9px;font-weight:700;letter-spacing:.05em;padding:2px 7px;border-radius:99px;border:1px solid}
  .alstate.firing{color:var(--err);border-color:color-mix(in srgb,var(--err) 45%,transparent)}
  .alstate.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,transparent)}
  .allift{appearance:none;flex:none;background:var(--secondary);color:var(--foreground);border:1px solid var(--border);
    border-radius:var(--radius-sm);padding:5px 12px;font:inherit;font-size:11.5px;font-weight:600;cursor:pointer}
  .allift:hover:not(:disabled){border-color:var(--primary)}
  .allift:disabled{opacity:.6;cursor:default}
  .alok{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted-foreground);
    padding:12px 13px;border:1px dashed var(--border);border-radius:var(--radius)}
  .alok svg{width:14px;height:14px;color:var(--ok)}
  .alfoot{font-size:11.5px;color:var(--muted-foreground);margin-top:14px;padding-top:11px;border-top:1px solid var(--border)}
  .alfoot a{color:var(--ch2)}
  .decsl{font-size:9.5px;letter-spacing:.1em;color:var(--muted-foreground);margin:14px 0 5px}
  .decsl:first-child{margin-top:0}
  .decdt{font-size:15px;font-weight:700}
  .decdtext{font-size:13px;line-height:1.55;color:var(--foreground)}
  .decalt{font-size:12px;color:var(--muted-foreground);padding:2px 0}
  .decconfbar{height:6px;background:var(--secondary);border-radius:99px;overflow:hidden}
  .decconffill{height:100%;background:var(--primary);border-radius:99px}
  .decsub2{font-size:10.5px;color:var(--muted-foreground);font-family:var(--font-mono);margin-top:4px}
  .decfile,.decart{font-size:11.5px;font-family:var(--font-mono);color:var(--foreground);padding:2px 0}
  /* Timeline decision line */
  .obtl.decision{cursor:pointer;border-left:2px solid var(--primary);padding-left:8px;margin-left:-10px}
  .obtlconf{font-size:9.5px;color:var(--muted-foreground);font-family:var(--font-mono)}
  /* Time-Travel Replay */
  .ttheader{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
  .ttctrls{display:flex;gap:8px}
  .ttbtn{appearance:none;font:inherit;font-size:13px;padding:6px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--foreground);cursor:pointer}
  .ttbtn:hover{border-color:var(--primary);color:var(--primary)}
  .ttbtn.ttplay{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground,#fff)}
  .ttframe{font-size:12px;color:var(--muted-foreground);font-family:var(--font-mono)}
  .tttimeline{margin-bottom:18px}
  .ttscrub{width:100%;accent-color:var(--primary);margin-bottom:4px}
  .ttmarkers{position:relative;height:8px}
  .ttmarker{position:absolute;top:0;width:2px;height:8px;border-radius:1px;transform:translateX(-50%)}
  .ttbody{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
  .ttsec{margin-bottom:16px}
  .ttsl{font-size:9.5px;letter-spacing:.1em;color:var(--muted-foreground);margin-bottom:7px}
  .ttbaton{font-size:18px;font-weight:800;color:var(--primary)}
  .tttime{font-size:10.5px;color:var(--muted-foreground);font-family:var(--font-mono);margin-top:2px}
  .ttarow{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:5px}
  .ttdot{width:6px;height:6px;border-radius:50%;flex:none}
  .tt-active{background:var(--primary);box-shadow:0 0 6px var(--primary)} .tt-idle{background:var(--muted-foreground)} .tt-errored{background:var(--err)} .tt-waiting{background:var(--warn)}
  .ttaname{flex:1;color:var(--foreground);font-family:var(--font-mono)}
  .ttaturns,.ttacost{color:var(--muted-foreground);font-family:var(--font-mono);font-size:11px}
  .ttdc{font-size:12.5px;margin-bottom:6px;color:var(--foreground)}
  .ttdi{display:flex;gap:8px;font-size:11px;margin-bottom:3px}
  .ttdcat{color:var(--primary);text-transform:uppercase;font-size:9.5px;letter-spacing:.06em}
  .ttdt{color:var(--muted-foreground)}
  .ttfact{font-size:11px;color:var(--muted-foreground);padding:2px 0}
  .ttlm{font-size:11px;background:var(--secondary);padding:8px 10px;border-radius:8px;line-height:1.4}
  .ttlma{color:var(--primary);font-weight:600;margin-right:4px}
  .ttevcard{border:1px solid var(--border);border-radius:var(--radius);background:var(--card);padding:16px;margin-bottom:16px}
  /* The accent is tuned to sit on the dark canvas as a border or a dot. As TEXT
     on a light card it is nearly invisible — #67e8f9 on white is 1.45:1 — so the
     label blends it toward the current foreground: still hued, still colour-coded
     by event type, readable in both themes. The border keeps the pure accent. */
  .ttevtype{font-size:9.5px;letter-spacing:.1em;font-weight:700;margin-bottom:6px;
    color:color-mix(in srgb, var(--ttev, var(--thread)) 45%, var(--foreground))}
  .ttevdesc{font-size:15px;font-weight:600;margin-bottom:8px}
  .ttevmeta{font-size:11.5px;color:var(--muted-foreground);font-family:var(--font-mono)}
  .ttprogbar{height:6px;background:var(--secondary);border-radius:99px;overflow:hidden;margin-bottom:4px}
  .ttprogfill{height:100%;width:100%;background:var(--primary);border-radius:99px;transform-origin:left;transform:scaleX(0);transition:transform .3s ease-out}
  /* the folded-in span replay: the turn running at the scrubbed instant */
  .ttturn{margin-top:12px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:11px 13px}
  .ttturn.err{border-color:color-mix(in srgb,var(--err) 40%,var(--border))}
  .ttthead{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin:5px 0 7px}
  .ttturn .rpmsg{font-size:12px;color:var(--muted-foreground);margin-bottom:7px;overflow-wrap:break-word}
  .ttturn .rpmetrics{display:flex;flex-wrap:wrap;gap:6px}
  .ttturn .rpactions{margin-top:9px;display:flex;gap:8px;flex-wrap:wrap}
  /* per-project settings: gear button + modal */
  .psetbtn{appearance:none;flex:none;margin-left:6px;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;
    border:none;background:none;color:var(--muted-foreground);cursor:pointer;opacity:0;border-radius:6px;transition:opacity .12s,color .12s,background .12s}
  .srow:hover .psetbtn,.srow.sel .psetbtn{opacity:.75}
  .psetbtn:hover{opacity:1;color:var(--primary);background:color-mix(in srgb,var(--primary) 14%,transparent)}
  .psetbtn svg{width:14px;height:14px}
  .psetmodal{max-width:520px;width:92vw}
  .pshdr{margin-bottom:14px}
  .psproj{font-size:17px;font-weight:700}
  .pssec{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted-foreground);margin-bottom:8px}
  .psrows{display:flex;flex-direction:column;gap:8px}
  .psrow{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card)}
  .psrow.off{opacity:.55}
  .psinfo{flex:1;min-width:0}
  .psname{font-size:13.5px;font-weight:600}
  .psbaton{font-size:9px;font-weight:700;letter-spacing:.05em;color:var(--shuttle-ink,var(--shuttle));background:color-mix(in srgb,var(--shuttle) 18%,transparent);padding:1px 6px;border-radius:99px;margin-left:6px}
  .pskind{font-size:11px;color:var(--muted-foreground);font-family:var(--font-mono);margin-top:2px}
  .psrolewrap{display:flex;align-items:center;gap:6px;flex:none}
  .pslabel{font-size:10px;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:.06em}
  .psrole{appearance:none;font:inherit;font-size:12px;padding:4px 26px 4px 10px;border-radius:8px;border:1px solid var(--border);background:var(--secondary);color:var(--foreground);cursor:pointer;
    background-image:linear-gradient(45deg,transparent 50%,var(--muted-foreground) 50%),linear-gradient(135deg,var(--muted-foreground) 50%,transparent 50%);background-position:calc(100% - 14px) 50%,calc(100% - 9px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
  .psrole:disabled{opacity:.5;cursor:default}
  .pshint{font-size:11px;color:var(--muted-foreground);line-height:1.5;margin-top:14px}
  /* toggle switch */
  .psswitch{position:relative;flex:none;width:34px;height:20px;cursor:pointer}
  .psswitch input{position:absolute;opacity:0;width:0;height:0}
  .pssl{position:absolute;inset:0;border-radius:99px;background:var(--secondary);border:1px solid var(--border);transition:background .15s}
  .pssl::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--muted-foreground);transition:transform .15s,background .15s}
  .psswitch input:checked+.pssl{background:color-mix(in srgb,var(--ok) 30%,transparent);border-color:color-mix(in srgb,var(--ok) 50%,transparent)}
  .psswitch input:checked+.pssl::after{transform:translateX(14px);background:var(--ok)}
  .psswitch input:disabled+.pssl{opacity:.6;cursor:default}
  /* ── Board (work flowing from working → needs you → review → merge) ── */
  .boardview{display:flex;flex-direction:column;gap:14px;height:100%}
  .bhead{display:flex;align-items:baseline;gap:12px;flex:none}
  .bhead .bt{font-size:20px;font-weight:650;letter-spacing:-.01em}
  .bhead .bs{font-size:12.5px;color:var(--muted-foreground)}
  .bhead .spacer{margin-left:auto}
  .bcols{display:grid;grid-template-columns:repeat(4,minmax(210px,1fr));gap:12px;
    flex:1;min-height:0;overflow-x:auto}
  .bcol{display:flex;flex-direction:column;min-height:0;border:1px solid var(--border);
    border-radius:var(--radius-xl);background:var(--card);transition:border-color .12s,background .12s}
  /* the live drop target — only the column under the pointer lights up */
  .bcol.over{border-color:color-mix(in srgb, var(--muted-foreground) 55%, transparent);
    background:color-mix(in srgb, var(--accent) 55%, var(--card))}
  .bch{display:flex;align-items:center;gap:8px;padding:12px 13px;flex:none;
    border-bottom:1px solid var(--border);font-size:11px;font-weight:650;letter-spacing:.09em;
    text-transform:uppercase;color:var(--muted-foreground)}
  .bch .bdot{width:7px;height:7px;border-radius:50%;flex:none}
  .bch .bn{margin-left:auto;font-family:var(--font-mono);font-size:11px;letter-spacing:0}
  .bcb{flex:1;min-height:0;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
  .bcard{border:1px solid var(--border);border-radius:var(--radius-md);background:var(--background);
    padding:10px 11px;cursor:grab;transition:border-color .12s,transform .06s,box-shadow .12s}
  .bcard:hover{border-color:color-mix(in srgb, var(--muted-foreground) 40%, transparent)}
  .bcard:active{cursor:grabbing}
  .bcard.drag{opacity:.4}
  .bcr1{display:flex;align-items:center;gap:6px;font-size:11px}
  .bcr1 .st{font-weight:500}
  .bcr1 .who{margin-left:auto;font-family:var(--font-mono);font-size:10.5px;
    color:var(--muted-foreground);display:flex;align-items:center;gap:5px}
  .bct{font-size:13px;font-weight:600;color:var(--foreground);line-height:1.35;margin-top:7px}
  .bcbr{font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);margin-top:5px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bcf{margin-top:9px;padding-top:8px;border-top:1px solid var(--border);
    font-family:var(--font-mono);font-size:10.5px;color:var(--muted-foreground);
    display:flex;align-items:center;gap:6px}
  .bcf a{color:inherit}
  .bcf a:hover{color:var(--foreground)}
  .bpin{margin-left:auto;font-family:var(--font-sans);font-size:9.5px;letter-spacing:.04em;
    color:var(--muted-foreground);border:1px solid var(--border);border-radius:999px;padding:0 5px;
    cursor:pointer}
  .bpin:hover{color:var(--foreground);border-color:var(--muted-foreground)}
  .bempty{padding:14px 4px;text-align:center;font-size:11.5px;color:color-mix(in srgb, var(--muted-foreground) 70%, transparent)}
  /* your own cards: a hairline accent, because these you can really move */
  .bcard.own{border-left:2px solid color-mix(in srgb, var(--muted-foreground) 45%, transparent)}
  .bcard.own .bct{cursor:text;border-radius:4px;margin:7px -3px 0;padding:0 3px}
  .bcard.own .bct:hover{background:color-mix(in srgb, var(--muted-foreground) 14%, transparent)}
  .bcedit{width:100%;background:var(--background);border:1px solid var(--ring);border-radius:4px;
    color:var(--foreground);font:inherit;font-size:13px;font-weight:600;padding:1px 3px;outline:none}
  .bpin.del{border:none;padding:0;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center}
  .bpin.del svg{width:10px;height:10px}
  .bpin.del:hover{color:var(--err);background:color-mix(in srgb, var(--err) 16%, transparent)}
  .badd{width:100%;flex:none;height:24px;border:1px dashed var(--border);border-radius:var(--radius-sm);
    background:transparent;color:var(--muted-foreground);cursor:pointer;font-size:13px;opacity:0;
    transition:opacity .12s,border-color .12s}
  .bcol:hover .badd{opacity:.7}
  .badd:hover{opacity:1;border-color:var(--muted-foreground);color:var(--foreground)}
  .bstart{margin-left:auto;height:20px;padding:0 7px;font-size:10.5px}
  .qbox.bq{flex:none;width:min(340px,34vw);height:28px}
  .qbox.bq input{font-size:11.5px}
  .bnote{flex:none;font-size:11.5px;color:var(--muted-foreground);display:flex;align-items:center;gap:6px}

  /* the board's search box */
  .qbox{flex:1;min-width:0;display:flex;align-items:center;gap:8px;height:32px;padding:0 11px;
    border:1px solid var(--input);border-radius:9px;transition:border-color .15s,box-shadow .15s}
  .dark .qbox{background:color-mix(in srgb, var(--input) 30%, transparent)}
  .qbox:focus-within{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 40%, transparent)}
  .qbox svg{width:14px;height:14px;flex:none;color:var(--muted-foreground)}
  .qbox input{flex:1;min-width:0;background:none;border:none;outline:none;box-shadow:none!important;
    color:var(--foreground);font-family:var(--font-mono);font-size:12.5px}
  /* board sources: GitHub / Projects / Linear — one board, three feeds */
  .bsrc{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:10px;
    background:color-mix(in srgb, var(--muted-foreground) 6%, transparent)}
  .bsrcb{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px;border:0;border-radius:8px;
    background:transparent;color:var(--muted-foreground);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;
    transition:background .12s,color .12s}
  .bsrcb svg{width:14px;height:14px}
  .bsrcb:hover{color:var(--foreground)}
  .bsrcb.on{background:var(--background);color:var(--foreground);box-shadow:0 1px 3px rgba(0,0,0,.12)}
  .dark .bsrcb.on{background:color-mix(in srgb, var(--foreground) 12%, transparent)}
  /* per-card actions: Review / Worktree */
  .bca{display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}
  .bca .btn svg{width:12px;height:12px;margin-right:-1px}
  .bempty2{color:var(--muted-foreground);font-size:13px;text-align:center;padding:44px 20px}
  /* GitHub Projects: a list, then one project's items grouped by Status */
  .prjlist{display:flex;flex-direction:column;gap:6px;margin-top:6px}
  .prjrow{display:flex;align-items:center;gap:10px;height:46px;padding:0 12px;border:1px solid var(--border);
    border-radius:var(--radius-md);background:var(--background);color:var(--foreground);font:inherit;font-size:13px;
    cursor:pointer;text-align:left;transition:border-color .12s,background .12s}
  .prjrow:hover{border-color:color-mix(in srgb, var(--muted-foreground) 40%, transparent);background:var(--muted)}
  .prjrow > svg{width:16px;height:16px;color:var(--muted-foreground);flex:none}
  .prjrow .prjt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
  .prjrow .prjn{font-size:11px;color:var(--muted-foreground);flex:none}
  .prjrow .prja{display:inline-flex;color:var(--muted-foreground);padding:5px;border-radius:6px;flex:none}
  .prjrow .prja:hover{color:var(--foreground);background:var(--accent)}
  .prjrow .prja svg{width:14px;height:14px}
  .prjhead{display:flex;align-items:center;gap:10px;margin:2px 0 12px}
  .prjhead .prjtitle{font-size:14px;font-weight:600}
  .pcols{grid-auto-flow:column;grid-auto-columns:minmax(200px,1fr);grid-template-columns:none;overflow-x:auto}
  /* Linear: recent issues, and the New-issue form's home */
  .lnlist{display:flex;flex-direction:column;gap:4px;margin-top:6px}
  .lnrow{display:flex;align-items:center;gap:11px;height:40px;padding:0 12px;border:1px solid var(--border);
    border-radius:var(--radius-md);color:var(--foreground);text-decoration:none;transition:background .12s}
  .lnrow:hover{background:var(--muted)}
  .lnrow .lnid{font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground);flex:none;min-width:66px}
  .lnrow .lnt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
  .lnrow .lnst{font-size:10.5px;color:var(--muted-foreground);flex:none;border:1px solid var(--border);border-radius:999px;padding:1px 8px}
  /* PR review modal: metadata, the diff, a comment box, three verbs */
  .modal.prmodal{max-width:780px}
  .prbody{gap:0;max-height:72vh}
  .prmeta{margin-bottom:10px}
  .prmeta .prttl{font-size:15px;font-weight:600;line-height:1.35}
  .prmeta .prsub{font-size:12px;color:var(--muted-foreground);margin-top:4px}
  .prmeta .prbr{font-family:var(--font-mono)}
  .prdiff{border:1px solid var(--border);border-radius:8px;max-height:46vh;overflow:auto;
    background:color-mix(in srgb, var(--muted-foreground) 5%, transparent);padding:6px 4px}
  .prcap{font-size:11.5px;color:var(--muted-foreground);text-align:center;padding:8px}
  .prcomment{width:100%;box-sizing:border-box;margin-top:12px;min-height:64px;border:1px solid var(--input);
    border-radius:8px;background:transparent;color:var(--foreground);font:inherit;font-size:13px;padding:9px 11px;resize:vertical;outline:none}
  .dark .prcomment{background:color-mix(in srgb, var(--input) 30%, transparent)}
  .prcomment:focus-visible{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 40%, transparent)}
  .prfoot{flex-wrap:wrap}
  .btn.prdanger{color:var(--err);border-color:color-mix(in srgb, var(--err) 40%, transparent)}
  .btn.prdanger:hover{background:color-mix(in srgb, var(--err) 12%, transparent)}
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
  /* the command palette (⌘K): a top-anchored search over everything */
  .pscrim{align-items:flex-start;padding-top:12vh}
  .palette{width:100%;max-width:640px;background:var(--popover);color:var(--popover-foreground);
    border:1px solid var(--glass-border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;
    box-shadow:0 28px 80px rgba(0,0,0,.5), inset 0 1px 0 var(--glass-highlight);animation:pop .16s ease;max-height:70vh}
  .phead{display:flex;align-items:center;gap:10px;padding:0 14px;height:52px;flex:none;border-bottom:1px solid var(--border)}
  .phead > svg{width:18px;height:18px;color:var(--muted-foreground);flex:none}
  .phead input{flex:1;min-width:0;background:none;border:0;outline:none;color:var(--foreground);font:inherit;font-size:16px}
  .phead input::placeholder{color:color-mix(in srgb, var(--muted-foreground) 60%, transparent)}
  .pkbd{font-size:10px;font-family:var(--font-mono);color:var(--muted-foreground);border:1px solid var(--border);
    border-radius:5px;padding:2px 6px;flex:none}
  .pbody{flex:1;min-height:0;overflow-y:auto;padding:6px}
  .psec{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-foreground);
    padding:10px 10px 4px}
  .prow{display:flex;align-items:center;gap:10px;height:38px;padding:0 10px;border-radius:9px;cursor:pointer}
  .prow .pic{width:18px;height:18px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--muted-foreground)}
  .prow .pic svg{width:15px;height:15px}
  .prow .plabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
  .prow .plabel .ppath{font-family:var(--font-mono);font-size:11.5px;color:var(--muted-foreground)}
  .prow .psub{flex:none;font-size:11px;color:var(--muted-foreground);font-family:var(--font-mono);
    max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .prow.on{background:color-mix(in srgb, var(--primary) 15%, transparent)}
  .prow.on .pic{color:var(--foreground)}
  .pmore{font-size:12px;color:var(--muted-foreground);padding:10px 12px}
  .pfoot{flex:none;display:flex;gap:16px;padding:8px 14px;border-top:1px solid var(--border);font-size:11px;color:var(--muted-foreground)}
  .pfoot b{font-family:var(--font-mono);font-weight:500;border:1px solid var(--border);border-radius:4px;padding:0 4px;margin-right:4px}
  /* ⌘K affordance in the sidebar search, and the status-bar GitHub badge */
  .snkbd{flex:none;font-size:10px;font-family:var(--font-mono);color:var(--muted-foreground);
    border:1px solid var(--border);border-radius:5px;padding:1px 5px;background:transparent;cursor:pointer;transition:color .12s,border-color .12s}
  .snkbd:hover{color:var(--foreground);border-color:color-mix(in srgb, var(--muted-foreground) 45%, transparent)}
  .statusbar .ghok{display:inline-flex;align-items:center;gap:5px;color:var(--muted-foreground)}
  .statusbar .ghok svg{width:12px;height:12px}
  .statusbar .ghconnect{display:inline-flex;align-items:center;gap:5px;border:1px solid color-mix(in srgb, var(--primary) 45%, transparent);
    border-radius:6px;padding:1px 8px;color:var(--primary);background:color-mix(in srgb, var(--primary) 12%, transparent);
    cursor:pointer;font:inherit;font-size:11px;transition:background .12s}
  .statusbar .ghconnect:hover{background:color-mix(in srgb, var(--primary) 22%, transparent)}
  .statusbar .ghconnect svg{width:12px;height:12px}
  .statusbar .lppill{display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:0;
    font:inherit;letter-spacing:inherit;color:var(--muted-foreground);cursor:pointer;transition:color .12s}
  .statusbar .lppill:hover{color:var(--foreground)}
  .statusbar .lppill.on{color:var(--foreground)}
  .statusbar .lppill.on .sdot{background:var(--ok)}
  .statusbar .usagepill{background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer}
  .statusbar .usagepill:hover{color:var(--foreground)}
  .usagemodal{max-width:400px}
  .usagerows{display:flex;flex-direction:column;gap:13px}
  .usagerow{display:flex;flex-direction:column;gap:5px}
  .usagetop{display:flex;align-items:center;justify-content:space-between;font-size:13px}
  .usagename{color:var(--muted-foreground);display:inline-flex;align-items:center}
  .usagerow.cur .usagename{color:var(--foreground)}
  .usagecur{font-size:10.5px;color:var(--primary);border:1px solid color-mix(in srgb,var(--primary) 40%,transparent);border-radius:999px;padding:1px 6px;margin-left:6px}
  .usageval{color:var(--foreground);font-variant-numeric:tabular-nums}
  .usagebar{height:6px;border-radius:3px;background:color-mix(in srgb,var(--foreground) 10%,transparent);overflow:hidden}
  .usagebar i{display:block;height:100%;background:var(--primary)}
  .usagepct{font-size:11px;color:var(--muted-foreground)}
  .lpmodal .lpstatus{min-height:22px}
  .lpstat{display:flex;align-items:center;gap:7px;font-size:14px;flex-wrap:wrap}
  .lpstat b{font-weight:600}
  .modalhead{display:flex;align-items:center;height:48px;padding:0 12px 0 16px;
    border-bottom:1px solid var(--border);font-size:15px;font-weight:600}
  .modalhead .iconbtn{margin-left:auto}
  .modalbody{padding:16px;display:flex;flex-direction:column;gap:14px;max-height:70vh;overflow-y:auto}
  .field{display:flex;flex-direction:column;gap:6px}
  /* Setup lives inside Settings now (a status list, not a form). Its rows carry
     shell commands you copy, so the pane is wide enough that a flag never wraps. */
  .sgrouph{font-size:11px;font-weight:560;letter-spacing:.04em;text-transform:uppercase;
    color:var(--muted-foreground);margin:18px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--border)}
  .sgrouph:first-child{margin-top:8px}
  .srow2{display:flex;gap:10px;align-items:flex-start;padding:7px 0}
  .sdot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:6px;background:var(--muted-foreground)}
  .sdot.ok{background:var(--ok)}
  .sdot.warn{background:var(--warn)}
  .sdot.bad{background:var(--danger,#e5484d)}
  .sdot.off{background:var(--border)}
  .sdot.info{background:var(--muted-foreground);opacity:.5}
  .sdot.no{background:transparent;border:1px solid var(--border)}
  .sbody{min-width:0;flex:1}
  .st{font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px}
  .st svg{width:13px;height:13px;flex:none}
  .sd{font-size:12px;color:var(--muted-foreground);line-height:1.5;margin-top:1px}
  .sd.how{color:var(--foreground);opacity:.75;margin-top:3px}
  .sport{font-size:10px;color:var(--muted-foreground);font-weight:400;border:1px solid var(--border);
    border-radius:4px;padding:0 4px;line-height:15px}
  .scmd{display:block;margin-top:5px;font-size:11.5px;background:var(--muted);color:var(--foreground);
    border:1px solid var(--border);border-radius:5px;padding:5px 7px;overflow-x:auto;white-space:pre;
    user-select:all}
  .snote{font-size:12px;color:var(--muted-foreground);background:var(--muted);border:1px solid var(--border);
    border-radius:6px;padding:8px 10px;margin:4px 0 8px;line-height:1.5}
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
  .field label .opt{font-weight:450;letter-spacing:.02em;text-transform:none;
    color:color-mix(in srgb, var(--muted-foreground) 80%, transparent)}
  .pickrow{display:flex;gap:8px}
  .pickrow input{flex:1;min-width:0;font-family:var(--font-mono);font-size:12px}
  .pickrow .btn{flex:none;height:38px}
  .disclose{font-size:12px;color:var(--muted-foreground);cursor:pointer;user-select:none;
    display:inline-flex;align-items:center;gap:5px;font-family:var(--font-mono)}
  .modalfoot{display:flex;gap:8px;justify-content:flex-end;align-items:center;
    padding:12px 16px;border-top:1px solid var(--border)}
  .modalfoot .kbd{font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground);
    border:1px solid var(--border);border-radius:4px;padding:1px 6px;margin-left:6px}
  /* Connect a phone: a QR (or copy link) to pair the app over the LAN or tailnet */
  .phonemodal{max-width:400px}
  .phonemodal .modalbody{gap:12px}
  .phseg{display:flex;gap:4px;padding:4px;background:var(--muted);border-radius:9px}
  .phseg .pho{flex:1;padding:7px 10px;border:0;border-radius:6px;background:transparent;
    color:var(--muted-foreground);font-size:12.5px;font-weight:500;cursor:pointer;font-family:inherit}
  .phseg .pho:hover{color:var(--foreground)}
  .phseg .pho.on{background:var(--background);color:var(--foreground);box-shadow:0 1px 2px rgba(0,0,0,.12)}
  .phseg .pho.dim{opacity:.5}
  .phstage{min-height:232px;display:flex;align-items:center;justify-content:center;padding:6px 2px}
  .phqrcard{background:#fff;padding:12px;border-radius:12px;line-height:0;box-shadow:0 1px 3px rgba(0,0,0,.14)}
  .phqrcard svg{width:208px;height:208px;display:block}
  .phmsg{text-align:center;font-size:13px;color:var(--foreground);line-height:1.5;max-width:308px}
  .phmsg .phdim{margin-top:7px;font-size:12px;color:var(--muted-foreground);line-height:1.5}
  .phmsg code{font-family:var(--font-mono);font-size:11.5px;background:var(--muted);
    padding:1px 5px;border-radius:4px;color:var(--foreground)}
  .phmsg .btn{margin-top:14px}
  .phlinkrow{display:flex;gap:6px;align-items:center}
  .phlinkrow #phlink{flex:1;min-width:0;font-family:var(--font-mono);font-size:11.5px;
    padding:7px 9px;border:1px solid var(--border);border-radius:7px;
    background:var(--input,var(--muted));color:var(--foreground)}
  .phhint{font-size:11.5px;color:var(--muted-foreground);line-height:1.5;text-align:center}
  .phexp{font-family:var(--font-mono);font-size:10px;color:var(--muted-foreground)}
  /* Settings: a sectioned modal. A nav rail on the left, one pane on the right —
     Setup folded in as one section among Diagnostics, Preferences, Updates,
     Devices, About, instead of its own lonely modal. */
  .modal.settings{max-width:780px}
  .setwrap{display:flex;min-height:60vh;max-height:74vh}
  .setnav{flex:none;width:186px;border-right:1px solid var(--border);padding:12px 10px;
    display:flex;flex-direction:column;gap:2px;overflow-y:auto}
  .setnav .navh{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:var(--muted-foreground);padding:6px 10px 4px}
  .setnav button{display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;width:100%;
    border-radius:var(--radius-md);border:0;background:transparent;color:var(--muted-foreground);
    font:inherit;font-size:13px;cursor:pointer;text-align:left;transition:background .12s,color .12s}
  .setnav button svg{width:15px;height:15px;flex:none;opacity:.9}
  .setnav button:hover{background:var(--muted);color:var(--foreground)}
  .setnav button.on{background:color-mix(in srgb, var(--primary) 15%, transparent);color:var(--foreground);font-weight:500}
  .setpane{flex:1;min-width:0;overflow-y:auto;padding:6px 22px 20px}
  .setpane .sgrouph:first-child{margin-top:12px}
  .setpane .snote{margin-top:10px}
  .setphead{font-size:15px;font-weight:600;margin:14px 0 2px}
  .setpsub{font-size:12.5px;color:var(--muted-foreground);line-height:1.5;margin-bottom:6px}
  /* a preference row: label+description on the left, control on the right */
  .prow{display:flex;align-items:center;gap:16px;padding:13px 0;border-bottom:1px solid var(--border)}
  .prow:last-child{border-bottom:0}
  .prow .pl{flex:1;min-width:0}
  .prow .pt{font-size:13px;font-weight:500}
  .prow .pd{font-size:12px;color:var(--muted-foreground);line-height:1.5;margin-top:2px}
  .prow .pc{flex:none;display:flex;align-items:center;gap:8px}
  .prow.col{flex-direction:column;align-items:stretch;gap:8px}
  /* segmented toggle, e.g. Auto | Off */
  .seg{display:inline-flex;border:1px solid var(--input);border-radius:var(--radius-md);overflow:hidden;flex:none}
  .seg button{border:0;background:transparent;color:var(--muted-foreground);font:inherit;font-size:12px;
    height:30px;padding:0 13px;cursor:pointer;transition:background .12s,color .12s}
  .seg button+button{border-left:1px solid var(--input)}
  .seg button.on{background:var(--primary);color:var(--primary-foreground);font-weight:500}
  .prow select{height:32px;min-width:150px;background:transparent;border:1px solid var(--input);
    border-radius:var(--radius-md);color:var(--foreground);font:inherit;font-size:13px;padding:0 9px;outline:none}
  .dark .prow select{background:color-mix(in srgb, var(--input) 30%, transparent)}
  .dark .prow select option{background:var(--popover);color:var(--popover-foreground)}
  /* a paired device row */
  .dev{display:flex;align-items:center;gap:11px;padding:11px 0;border-bottom:1px solid var(--border)}
  .dev:last-child{border-bottom:0}
  .dev .di{width:32px;height:32px;border-radius:9px;background:var(--muted);flex:none;
    display:flex;align-items:center;justify-content:center;color:var(--muted-foreground)}
  .dev .di svg{width:15px;height:15px}
  .dev .dn{flex:1;min-width:0}
  .dev .dnt{font-size:13px;font-weight:500;display:flex;align-items:center;gap:7px}
  .dev .dnd{font-size:11.5px;color:var(--muted-foreground);margin-top:1px}
  .devme{font-size:9.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
    color:var(--primary);border:1px solid color-mix(in srgb, var(--primary) 40%, transparent);
    border-radius:4px;padding:0 5px;line-height:15px}
  /* the About block: a big version, a grid of facts, link buttons */
  .abhead{display:flex;align-items:center;gap:12px;margin:16px 0 6px}
  .abmark{font-size:24px;font-weight:700;letter-spacing:-.02em}
  .abmark b{color:var(--primary)}
  .abver{font-size:12px;color:var(--muted-foreground);font-family:var(--font-mono)}
  .abgrid{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:12.5px;margin:12px 0}
  .abgrid dt{color:var(--muted-foreground)}
  .abgrid dd{font-family:var(--font-mono);word-break:break-all}
  .ablinks{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
  .ablinks a{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px;
    border:1px solid var(--input);border-radius:var(--radius-md);color:var(--foreground);
    font-size:12.5px;text-decoration:none;transition:background .12s}
  .ablinks a:hover{background:var(--muted)}
  .ablinks a svg{width:14px;height:14px}
  /* one loom-doctor check line */
  .dchk{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border)}
  .dchk:last-child{border-bottom:0}
  .dchk .dct{font-size:13px;font-weight:500}
  .dchk .dcd{font-size:12px;color:var(--muted-foreground);line-height:1.5;margin-top:1px;white-space:pre-wrap}
  .setpane .pillrow{display:flex;align-items:center;gap:8px;margin:14px 0 2px}
  .updpill{font-size:11px;font-weight:600;border-radius:999px;padding:2px 10px;line-height:18px}
  .updpill.ok{color:var(--ok);background:color-mix(in srgb, var(--ok) 14%, transparent)}
  .updpill.warn{color:var(--warn);background:color-mix(in srgb, var(--warn) 16%, transparent)}
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
  /* per-agent role assignment for a task — one row per picked agent, in order */
  .rolelist{display:none;flex-direction:column;gap:6px;margin-top:8px}
  .rolerow{display:flex;align-items:center;gap:8px;font-size:12.5px}
  .rolerow .rn{font-family:var(--font-mono);font-size:10px;width:16px;height:16px;border-radius:50%;flex:none;
    display:inline-flex;align-items:center;justify-content:center;background:var(--sidebar-accent);color:var(--muted-foreground)}
  .rolerow .brand{width:16px;height:16px;flex:none}
  .rolerow .rid{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:11.5px}
  .rolerow .roleselect{height:28px;border:1px solid var(--input);border-radius:7px;background:var(--background);
    color:var(--foreground);font:inherit;font-size:12px;padding:0 8px;cursor:pointer;max-width:150px}
  .rolerow .roleselect:focus{outline:none;border-color:var(--ring)}
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
<!-- ADE brand marks, defined once (see brand-icons.ts). Every agent glyph on
     the page is a <use> of one of these symbols. -->
${BRAND_SPRITE}
<div id="root"></div>
<div id="toast"></div>
<!-- xterm.js, served by the daemon from node_modules: the app has no build
     step and must work offline on a tailnet, so no bundler and no CDN. Only
     used when the daemon has a real pty; the fallback needs none of it. -->
<script src="/app/vendor/xterm.js"></script>
<script src="/app/vendor/addon-fit.js"></script>
<script src="/app/vendor/addon-web-links.js"></script>
<script>
(function(){
  "use strict";
  var TOKEN_KEY = "loomClientToken";
  // The id (not the token) of this paired client, so Settings > Devices can mark
  // "this device" and warn before you revoke the seat you're sitting in.
  var CLIENT_ID_KEY = "loomClientId";
  var THEME_KEY = "loomTheme";
  // Shown once, unprompted, on a client that has never seen it.
  var SETUP_SEEN_KEY = "loomSetupSeen";
  var state = { token: localStorage.getItem(TOKEN_KEY) || "", clientId: localStorage.getItem(CLIENT_ID_KEY) || "", projects: [], pid: null,
                project: null, selected: null, lastId: 0, ws: null, timers: [],
                tab: "thread", tree: null, wsLive: false, lastQuestion: null };
  var root = document.getElementById("root");

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]; }); }

  /**
   * A small, safe markdown renderer for agent output.
   *
   * No dependency, no build step — the app has neither. The whole input is
   * HTML-escaped FIRST, so every transform below only ever adds tags around
   * already-safe text; nothing an agent prints can inject markup. Backticks are
   * written as \\x60 throughout because a literal backtick would close this
   * template literal and take the app down.
   *
   * Handles: fenced code, inline code, bold/italic/strike, headings, lists,
   * blockquotes, rules, links (http/https only), and paragraphs with soft
   * line breaks — the subset agents actually emit.
   */
  function mdInline(s){
    // s is already HTML-escaped.
    s = s.replace(/\\x60([^\\x60]+?)\\x60/g, '<code class="mdi">$1</code>');
    s = s.replace(/\\*\\*([^*]+?)\\*\\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\\w*])\\*([^*\\n]+?)\\*(?!\\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+?)~~/g, "<del>$1</del>");
    // [text](url) — only http(s); the url is already entity-escaped, so &amp; etc. are safe in the attribute.
    s = s.replace(/\\[([^\\]]+?)\\]\\((https?:\\/\\/[^)\\s]+?)\\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }
  function mdToHtml(src){
    var lines = esc(String(src == null ? "" : src)).split("\\n");
    var out = [], i = 0;
    var FENCE = /^\\s*\\x60\\x60\\x60(.*)$/, FENCE_END = /^\\s*\\x60\\x60\\x60\\s*$/;
    var HEAD = /^(#{1,6})\\s+(.*)$/, QUOTE = /^\\s*&gt;\\s?/, RULE = /^\\s*(?:---|\\*\\*\\*|___)\\s*$/;
    var ULI = /^\\s*[-*+]\\s+/, OLI = /^\\s*\\d+\\.\\s+/;
    while (i < lines.length) {
      var line = lines[i];
      if (FENCE.test(line)) {
        var code = [], j = i + 1;
        while (j < lines.length && !FENCE_END.test(lines[j])) { code.push(lines[j]); j++; }
        out.push('<pre class="mdcode"><code>' + code.join("\\n") + "</code></pre>");
        i = j + 1; continue;
      }
      var h = line.match(HEAD);
      if (h) { out.push('<div class="mdh mdh' + Math.min(6, h[1].length) + '">' + mdInline(h[2]) + "</div>"); i++; continue; }
      if (QUOTE.test(line)) {
        var q = [];
        while (i < lines.length && QUOTE.test(lines[i])) { q.push(lines[i].replace(QUOTE, "")); i++; }
        out.push('<blockquote class="mdq">' + mdInline(q.join(" ")) + "</blockquote>"); continue;
      }
      if (RULE.test(line)) { out.push('<hr class="mdhr">'); i++; continue; }
      if (ULI.test(line) || OLI.test(line)) {
        var ordered = OLI.test(line), items = [];
        while (i < lines.length && (ULI.test(lines[i]) || OLI.test(lines[i]))) {
          items.push("<li>" + mdInline(lines[i].replace(/^\\s*(?:[-*+]|\\d+\\.)\\s+/, "")) + "</li>"); i++;
        }
        out.push("<" + (ordered ? "ol" : "ul") + ' class="mdlist">' + items.join("") + "</" + (ordered ? "ol" : "ul") + ">"); continue;
      }
      if (!line.trim()) { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEAD.test(lines[i]) &&
             !QUOTE.test(lines[i]) && !RULE.test(lines[i]) && !ULI.test(lines[i]) && !OLI.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push('<div class="mdp">' + mdInline(para.join("<br>")) + "</div>");
    }
    return out.join("");
  }
  /**
   * Mark the match inside a line.
   *
   * Module scope, not inside a render function: the code search (renderProject)
   * and the chat search (renderShell) both call it, and when it lived in the
   * first of those the second threw a ReferenceError inside a .then() — the
   * header rendered, the rows silently didn't, and nothing reached the console.
   * That is the fourth time today a function has been called from the wrong
   * scope in this file.
   *
   * esc() first, always: this is a line of someone's source code and it will
   * contain angle brackets. Escaping after inserting the mark would eat the
   * mark; escaping the query too means a search for "<div" highlights rather
   * than injects.
   */
  function highlight(text, q){
    var safe = esc(String(text));
    var needle = esc(String(q));
    var at = safe.toLowerCase().indexOf(needle.toLowerCase());
    if (at < 0) return safe;
    return safe.slice(0, at) + "<mark>" + safe.slice(at, at + needle.length) + "</mark>" + safe.slice(at + needle.length);
  }

  function toast(msg){ var t = document.getElementById("toast"); t.textContent = msg;
    t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(function(){ t.classList.remove("show"); }, 2600); }
  function hue(id){ var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; }
  function money(n){ return "$" + (n >= 0.01 ? n.toFixed(2) : n.toFixed(4)); }
  /** A tiny action menu anchored under a button (the SCM commit split, etc.). */
  function openScmMenu(anchor, items){
    var ex = document.getElementById("scmmenu"); if (ex) ex.remove();
    var m = document.createElement("div"); m.id = "scmmenu"; m.className = "scmmenu";
    m.innerHTML = items.map(function(it, i){ return '<button class="scmmi" data-i="' + i + '">' + esc(it.label) + "</button>"; }).join("");
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.round(r.right - m.offsetWidth)) + "px";
    m.style.top = Math.round(r.bottom + 4) + "px";
    if (r.bottom + 4 + m.offsetHeight > window.innerHeight) m.style.top = Math.max(8, Math.round(r.top - m.offsetHeight - 4)) + "px";
    Array.prototype.forEach.call(m.querySelectorAll(".scmmi"), function(b){
      b.onclick = function(ev){ ev.stopPropagation(); closeScmMenu(); items[Number(b.getAttribute("data-i"))].run(); };
    });
    setTimeout(function(){ document.addEventListener("mousedown", scmMenuAway); }, 0);
  }
  function scmMenuAway(ev){ var m = document.getElementById("scmmenu"); if (m && !m.contains(ev.target)) closeScmMenu(); }
  function closeScmMenu(){ document.removeEventListener("mousedown", scmMenuAway); var m = document.getElementById("scmmenu"); if (m) m.remove(); }
  /** Compact "3m ago" / "2h ago" / "5d ago" from an epoch-ms timestamp. */
  function rel(ts){
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  // ---- ADE brand marks -----------------------------------------------------
  var BRAND_TITLES = ${JSON.stringify(BRAND_TITLES)};
  /**
   * The agent's own logo, drawn from the sprite in <body>. Keyed by adapter
   * kind, not by the instance id — you can name an agent anything, but its
   * kind is what it actually is. An unknown kind (a custom adapter, "echo")
   * has no logo to show, so callers fall back to the hue monogram rather than
   * guessing with someone else's brand.
   */
  function brandMark(kind, cls){
    if (!kind || !BRAND_TITLES[kind]) return "";
    return '<svg class="' + (cls || "brand") + '" aria-hidden="true"><use href="#brand-' + kind + '"></use></svg>';
  }
  function hasBrand(kind){ return !!(kind && BRAND_TITLES[kind]); }
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
        inp.value = was === "\\u2026" ? "" : was;
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
            .then(function(){ toast("role \\u2192 " + next); redraw(); })
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
  var LOADER = '<div class="loader"><i></i><i></i><i></i><i></i></div>';

  // Inline icon set — 24px grid, stroke 2, currentColor (no emoji, no CDN).
  function svg(inner){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>";
  }
  var ICONS = {
    // lucide sliders-horizontal: setup is knobs, not a spinning cog
    gear: svg('<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>'),
    back: svg('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
    up: svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
    thread: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    memory: svg('<path d="m12 3 8.5 4.7L12 12.5 3.5 7.7 12 3Z"/><path d="m3.5 12.2 8.5 4.8 8.5-4.8"/><path d="m3.5 16.6 8.5 4.8 8.5-4.8"/>'),
    telescope: svg('<path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.673-4.418"/><path d="m13.56 11.747 4.332-.924"/><path d="m16 21-3.105-6.21"/><path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z"/><path d="m6.158 8.633 1.114 4.456"/><path d="m8 21 3.105-6.21"/><circle cx="12" cy="13" r="2"/>'),
    // a changed file: document outline with a small +/- pair inside
    tree: svg('<path d="M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z"/><path d="M14 3v5h5"/><path d="M12 11.5v4"/><path d="M10 13.5h4"/><path d="M10 18h4"/>'),
    route: svg('<circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="5.5" r="2.5"/><path d="M8 18.5h5.5a4 4 0 0 0 4-4V8"/>'),
    // three columns of differing fill — a kanban board at 13px
    board: svg('<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="6" rx="1.5"/>'),
    chat: svg('<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'),
    branch: svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M15.5 8.5H11a5 5 0 0 0-5 5"/>'),
    refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>'),
    moon: svg('<path d="M20 12.5A8.5 8.5 0 1 1 11.5 4a6.7 6.7 0 0 0 8.5 8.5Z"/>'),
    unpair: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>'),
    help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.2 9a2.9 2.9 0 0 1 5.6 1c0 1.8-2.6 2.2-2.6 3.6"/><path d="M12 17h.01"/>'),
    plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
    minus: svg('<path d="M5 12h14"/>'),
    panelRight: svg('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M15 4.5v15"/>'),
    terminal: svg('<path d="m5 8 4 4-4 4"/><path d="M12 16h6"/>'),
    // lines of output with one flagged — the Console
    console: svg('<path d="M4 6h16"/><path d="M4 11h9"/><path d="M4 16h6"/><circle cx="18" cy="15.5" r="2.5"/>'),
    // a phone — "connect a device"
    phone: svg('<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18.5h2"/>'),
    x: svg('<path d="M18 6 6 18"/><path d="M6 6l12 12"/>'),
    tasks: svg('<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="m4 6 1 1 2-2"/><path d="m4 12 1 1 2-2"/><path d="m4 18 1 1 2-2"/>'),
    // the rail's roster: two figures, because it lists who works here
    agents: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    files: svg('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><path d="M14 2v6h6"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    folderPlus: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v6"/><path d="M9 14h6"/>'),
    file: svg('<path d="M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z"/><path d="M14 3v5h5"/>'),
    chevron: svg('<path d="m9 6 6 6-6 6"/>'),
    chevronLeft: svg('<path d="m15 6-6 6 6 6"/>'),
    spark: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>'),
    external: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>'),
    issue: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>'),
    pr: svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7"/><circle cx="18" cy="18" r="2.5"/><path d="M18 15.5V9a3 3 0 0 0-3-3h-4"/><path d="m13 3-2 3 2 3"/>'),
    // Brand marks, filled — the one place brand assets are warranted. GitLab
    // and Linear ride along disabled: the row says which providers exist and
    // which one Loom can actually read.
    gitlab:
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.65 14.39 12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58.11l.11.15 2.44 7.53h8.1l2.44-7.51a.42.42 0 0 1 .11-.19.43.43 0 0 1 .58.11l.11.15 2.44 7.53L23 13.45a.84.84 0 0 1-.35.94z"/></svg>',
    linear:
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.14 13.5a10 10 0 0 0 8.36 8.36zM2 11.66 12.34 22a10 10 0 0 0 2.2-.45L2.45 9.46a10 10 0 0 0-.45 2.2M3.1 7.65l13.25 13.25a10 10 0 0 0 1.55-1.06L4.16 6.1a10 10 0 0 0-1.06 1.55M5.6 4.53l13.87 13.87a10 10 0 1 0-13.87-13.87"/></svg>',
    github:
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>'
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
      if (state.retheme) state.retheme(); // live terminals repaint too
    };
  }
  var THEME_BTN = '<button id="themebtn" class="iconbtn" title="toggle theme"></button>';
  function isElectron(){ return document.documentElement.hasAttribute("data-electron"); }

  function clearTimers(){ state.timers.forEach(clearInterval); state.timers = [];
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; } }

  // A 401 means one of two opposite things. A remote client's token really was
  // revoked, and that is a logout. A same-machine window's token merely went
  // stale — the daemon restarted and minted a new one — and that window can get
  // a fresh token from /api/bootstrap without the human doing anything. Telling
  // that person to "pair again" is telling them to re-authorise the machine
  // they are sitting at, and it threw away the session over a *background poll*:
  // the LoomPad health pill polls every 5s, and the first tick after a restart
  // logged you out and dropped you on the pairing screen mid-demo.
  //
  // So a 401 re-bootstraps once and replays the request. Only a bootstrap that
  // refuses us — i.e. we are not on loopback — is a real logout. One in-flight
  // bootstrap is shared, so a burst of concurrent 401s re-auths once, not once
  // per request.
  var reauthing = null;
  function reauth(){
    if (!reauthing) {
      reauthing = bootstrapAdmin().then(
        function(ok){ reauthing = null; return ok; },
        function(){ reauthing = null; return false; },
      );
    }
    return reauthing;
  }

  function api(path, opts, retried){
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers["Authorization"] = "Bearer " + state.token;
    if (opts.body) opts.headers["Content-Type"] = "application/json";
    return fetch(path, opts).then(function(r){
      if (r.status === 401 && !retried) {
        return reauth().then(function(ok){
          if (!ok) { logout(); throw new Error("session revoked — pair again"); }
          return api(path, { method: opts.method, body: opts.body }, true);
        });
      }
      if (r.status === 401) { logout(); throw new Error("session revoked — pair again"); }
      return r.json().then(function(j){
        if (!r.ok) throw new Error(j.message || j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }
  function logout(){ state.token = ""; state.clientId = ""; localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(CLIENT_ID_KEY); route(); }

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
      if (j.clientId) { state.clientId = j.clientId; localStorage.setItem(CLIENT_ID_KEY, j.clientId); }
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
    function pair(){
      var v = (document.getElementById("ptok").value || "").trim();
      if (!v) return toast("paste the token from loom pair");
      try { var j = JSON.parse(v); if (j && j.token) v = j.token; } catch (e) {}
      var m = v.match(/pair=([A-Za-z0-9]+)/); if (m) v = m[1];
      claim(v).then(route).catch(function(err){ toast(err.message); });
    }
    document.getElementById("pgo").onclick = pair;
    // paste-then-Enter is the whole gesture on this screen
    document.getElementById("ptok").onkeydown = function(e){
      if (e.key === "Enter") { e.preventDefault(); pair(); }
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
        // Your own messages: markdown too, so a pasted snippet or list reads right.
        return '<div class="msg user"><div class="bubble md">' + mdToHtml(p.text) + "</div></div>";
      }
      var h = hue(e.agentId);
      // Reasoning / thinking (codex, grok, and now claude) renders as a distinct
      // collapsible block above the reply — dimmed, folded by default, so it's
      // there when you want it and out of the way when you don't.
      if (p.reasoning) {
        return '<div class="msg agent thinking"><div class="who" style="color:hsl(' + h + ',60%,var(--agent-l))">' +
          brandMark(kindOf(e.agentId)) + esc(e.agentId) + '<span class="thinktag">thinking</span></div>' +
          '<details class="thinkbox"><summary>reasoning</summary><div class="md">' + mdToHtml(p.text) + "</div></details></div>";
      }
      return '<div class="msg agent"><div class="who" style="color:hsl(' + h + ',60%,var(--agent-l))">' +
        brandMark(kindOf(e.agentId)) + esc(e.agentId) +
        '</div><div class="bubble md" style="border-left-color:hsl(' + h + ',50%,var(--selvage-l))">' + mdToHtml(p.text) + "</div></div>";
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
    // Which conversation this view is showing. The daemon streams the whole
    // project over one socket, so the thread filters to this chat itself.
    var chatId = state.currentChat ? state.currentChat() : "main";
    state.chat = chatId;
    // Point state.project at the new project NOW. refresh() below replaces it
    // with the fuller per-project payload, but that lands a fetch later — and
    // everything drawn in the meantime (the Explorer's title above all) would
    // otherwise render the project we just navigated away from.
    state.project = (state.projects || []).filter(function(p){ return p.id === pid; })[0] || null;
    // A chat just created with a chosen agent leaves its pick here, so the
    // composer opens aimed at that agent instead of snapping back to the holder.
    state.pid = pid; state.lastId = 0;
    state.selected = state.pendingSelect || null;
    state.pendingSelect = null;
    state.tab = "thread"; state.tree = null; state.lastQuestion = null;
    var expl = { kids: {}, open: {} }; // explorer tree cache — declared before any drawRail() call

    var headerActions =
      // Nothing of the agent's lives up here on desktop any more.
      //
      // The theme toggle went to the sidebar foot (a cosmetic switch has no
      // business one pixel from Interrupt) and Interrupt went into the
      // composer. What's left beside the panel toggle is the panel toggle:
      // this strip is about the window, not about the turn.
      (desktop ? "" :
        '<button id="brainbtn" class="iconbtn" title="unified memory">' + ICONS.memory + "</button>" +
        '<button id="treebtn" class="iconbtn" title="working tree">' + ICONS.tree + "</button>" +
        '<button id="routebtn" class="iconbtn" title="routes">' + ICONS.route + "</button>");

    // Send and stop are one button, because they answer the same question — is
    // this turn running? — and it's never both. It belongs where you're already
    // looking when you decide to stop it, not across the window next to a panel
    // toggle. Every chat app does this; so does Antigravity, whose own send
    // swaps to a cancel mid-turn.
    // The composer is a card, not a bare input: a textarea that grows with what
    // you type, a row of controls under it (attach, model), and a place for
    // attachment chips. The @ and / menus mount into #cmenu, positioned over the
    // textarea. #cfile is the hidden file input the paperclip drives.
    var composerHtml =
      '<div class="composer" id="composerwrap"><form class="cbox" id="cform">' +
      '<div class="cmenu" id="cmenu" style="display:none"></div>' +
      '<div class="cchips" id="cchips" style="display:none"></div>' +
      '<textarea id="box" class="cinput" rows="2" placeholder="Message&hellip;  @ for files, / for actions" autocomplete="off"></textarea>' +
      '<div class="crow">' +
      '<button class="ctool iconly" id="attach" type="button" title="attach an image or file" aria-label="attach a file">' + ICONS.plus + '</button>' +
      '<button class="cagent" id="cagent" type="button" title="switch the agent this chat talks to" aria-label="switch agent" style="display:none"><span class="can">agent</span><span class="cchev">' + ICONS.chevron + "</span></button>" +
      '<button class="ctool" id="modelpick" type="button" title="pick a model" aria-label="pick a model">' + '<span class="cmodel" id="cmodellabel">model</span>' + '<span class="cchev">' + ICONS.chevron + "</span></button>" +
      '<span style="flex:1"></span>' +
      '<button class="sendbtn" id="send" type="submit" title="send">' + ICONS.up + "</button>" +
      '<button class="sendbtn stopbtn" id="stop" type="button" title="interrupt" aria-label="interrupt" style="display:none">' +
      ICONS.stop + "</button>" +
      '</div>' +
      '<input type="file" id="cfile" accept="image/*,.md,.txt,.markdown" multiple style="display:none">' +
      "</form>" +
      '<div class="hint" id="hint"></div></div>';

    if (desktop) {
      mount.innerHTML =
        '<div class="panel">' +
        // Orca chrome: the strip is the window top — context, tabs, actions.
        '<div class="tabstrip" id="tabstrip">' +
        // No project title here. The sidebar already names every project and
        // highlights the open one, so this printed it a second time three
        // inches away — and for a project called "loom" that's the word "loom"
        // twice in one bar, under a window called Loom. Cost and needs-input
        // live on the sidebar row too, so nothing is lost with it.
        '<span id="tabsbox" style="display:contents"></span>' +
        '<span class="spacer"></span>' +
        // &#96; is a backtick — a literal one would close this template literal
        '<button id="termbtn" class="iconbtn" title="toggle terminal (\\u2303&#96;)">' + ICONS.terminal + "</button>" +
        // Connect a phone: a QR (or copy link) that pairs the native app over the
        // LAN or the tailnet. Sits by the terminal because both are "reach this
        // machine from somewhere else".
        '<button id="phonebtn" class="iconbtn" title="connect a phone" aria-label="connect a phone">' + ICONS.phone + "</button>" +
        // The Console shares the terminal's dock — both are "the drawer at the
        // bottom where output goes", and giving errors their own panel would
        // mean two drawers fighting for the same edge. The dot appears when
        // something has gone wrong since you last looked.
        '<button id="consolebtn" class="iconbtn" title="console \\u00b7 errors and logs">' +
        ICONS.console + '<span class="errdot" id="errdot"></span></button>' +
        '<button id="railbtn" class="iconbtn" title="toggle right panel">' + ICONS.panelRight + "</button>" +
        headerActions +
        "</div>" +
        '<div class="paneswrap">' +
        '<div class="mainpane" id="mainpane">' +
        '<div class="pane scroll" id="pane-thread"><div id="agenthead" class="agenthead" style="display:none"></div><div id="routebar"></div><div id="feed">' + LOADER + "</div></div>" +
        '<div class="pane scroll" id="pane-brain" style="display:none">' + LOADER + "</div>" +
        '<div class="pane scroll" id="pane-observatory" style="display:none">' + LOADER + "</div>" +
        '<div class="pane scroll" id="pane-board" style="display:none"></div>' +
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
        '<div class="termpanes" id="termpanes">' +
        '<div class="conwrap" id="conwrap">' +
        '<div class="conbar">' +
        '<span class="lvl on" data-lvl="all">all</span>' +
        '<span class="lvl" data-lvl="error">errors</span>' +
        '<span class="lvl" data-lvl="warn">warnings</span>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<span id="concount"></span>' +
        '<button id="conclear" class="iconbtn" title="clear">' + ICONS.x + "</button>" +
        "</div>" +
        '<div class="conlist" id="conlist"></div>' +
        "</div></div>" +
        '<form class="terminput" id="termform" style="display:none"><span class="pr">&#10095;</span>' +
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

    // ---- desktop tabs (Thread / Tasks / Brain / Routes) --------------------
    // mobile has no #tabsbox, so this is a no-op there by construction
    function drawTabs(){
      var box = document.getElementById("tabsbox"); if (!box) return;
      var tabs = ["thread", "board", "brain", "observatory"];
      if (tabs.indexOf(state.tab) < 0) state.tab = "thread";
      var LBL = { thread: [ICONS.thread, "Thread"], board: [ICONS.board, "Board"],
                  brain: [ICONS.memory, "Brain"], observatory: [ICONS.telescope, "Observatory"] };
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
      ["thread", "board", "brain", "observatory"].forEach(function(t){
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
      // first open fetches; later opens keep the board (and your pins)
      if (name === "board") { if (board.data) drawBoardPane(); else loadBoard(); }
      if (name === "observatory") drawObservatory();
      if (name === "thread") {
        var sc = document.getElementById("pane-thread");
        if (sc) sc.scrollTop = sc.scrollHeight;
      }
    }

    // ---- Observatory: the fleet in action, the one brain -------------------
    // A live canvas of every agent as a node linked to the shared brain, the
    // baton drawn in shuttle, plus fleet metrics — the same numbers Loom ships
    // as gen_ai spans over OTLP. Kept dependency-free, rendered from strings.
    var obNodePos = {};        // agent id -> {x,y} once dragged, persists across redraws
    var obRefreshT = null;
    var OBS_LIVE_KINDS = { run_complete: 1, handoff: 1, status: 1, route_started: 1,
      route_completed: 1, route_failed: 1, agent_join: 1, agent_leave: 1, needs_input: 1 };
    function scheduleObsRefresh(){
      if (obRefreshT || state.tab !== "observatory") return;
      obRefreshT = setTimeout(function(){ obRefreshT = null; if (state.tab === "observatory") drawObservatory(); }, 700);
    }
    function tokfmt(n){ n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); }
    function trunc(s, m){ s = String(s || ""); return s.length > m ? s.slice(0, m - 1) + "\\u2026" : s; }
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
        canvas: "<b>Right now.</b> Who is running this second, who is idle, and where the " + fx + "baton</b> is \\u2014 the ring pulses on whoever holds it. Every agent hangs off the <b>one shared brain</b> in the middle: that is the memory they all read and write, which is the whole point of the fleet. Updates live as turns start and finish. " + drag,
        graph: "<b>What already happened.</b> The baton\\u2019s actual route through the fleet, left to right, oldest handoff first. Each " + fx + "\\u2192</b> is one real handoff from the event log; <code>19t</code> under a name is turns that agent took. Live view is the <b>Live fleet</b> tab \\u2014 this one is history. " + drag,
        timeline: "<b>The run, in the order it happened.</b> Every turn, handoff, route, memory fold, budget pause and self-heal line on one spine \\u2014 so \\u201cwhy did it do that?\\u201d is answered by scrolling rather than by guessing. The \\ud83d\\udca1 lines are <b>decisions</b>; click one to read the reasoning behind it.",
        metrics: "<b>Where the run\\u2019s time and money actually went.</b> Nothing here is estimated: tokens and cost are what each agent\\u2019s own CLI reported for the turn, and the durations are the spans Loom exports. Every agent carries a 0\\u2013100 <b>health score</b>, and <b>\\u26a0 Triage</b> root-causes a bad one from that agent\\u2019s own spans.",
        decisions: "<b>The reasoning, not just the result.</b> Every choice an agent made, with what it weighed and rejected \\u2014 mined out of its own prose after each turn, so it survives the agent that made it. A confidence it actually measured and one merely pattern-matched are labelled differently, because a number you cannot source is worse than no number.",
        alerts: "<b>What your monitoring told Loom, and what Loom did about it.</b> A firing alert takes the named agent out of rotation \\u2014 it is refused the baton until the alert resolves \\u2014 and a resolved one puts it back. This is the part your dashboards cannot show you: they know the alert fired, only Loom knows the fleet reacted.",
        logs: "<b>The third signal, read back out of the telemetry store.</b> Every message, tool call, file edit and error at the severity it was recorded, filterable by both. Each line carries the <b>trace</b> of the turn that produced it, so a log and the span it came from are one click apart. This is the one view with no local fallback: if ClickHouse is not answering it says so, rather than showing an empty list that looks like a quiet run.",
        travel: "<b>Rewind the whole run.</b> Drag the scrubber (or hit Play) to any moment and the whole app rewinds to it: who held the baton, every agent\\u2019s state, the decisions made so far, the thread \\u2014 and the <b>turn running at that instant</b> with its model, tokens, cost and trace. All reconstructed from the event log."
      };
      return E[view] ? '<div class="obexplain">' + E[view] + "</div>" : "";
    }

    // ---- Ask — the fleet's own telemetry, asked in English --------------
    // Backed by POST /observatory/ask, which assembles the evidence from the
    // same sources this screen renders (status, metrics, health, spans,
    // decisions) and hands any configured telemetry MCP server to the model. So an
    // answer can only ever cite numbers that are also on the screen.
    var ASK_SUGGESTIONS = [
      "Which agent is costing me the most, and why?",
      "Is anything unhealthy right now?",
      "What did the fleet decide so far?",
      "Where did the baton spend most of its time?",
      "Show me the slowest turns and what they were doing."
    ];
    function askPanelHtml(){
      var st = state.obAsk || { msgs: [], busy: false };
      var body;
      if (!st.msgs.length){
        body = '<div class="askempty"><div class="askmark">' + (ICONS.spark || "") + "</div>" +
          '<div class="askh">Ask</div>' +
          '<div class="asksub">Questions about this fleet\\u2019s traces, spend, health and decisions \\u2014 answered from its own telemetry.</div>' +
          '<div class="asksugs">' + ASK_SUGGESTIONS.map(function(s){
            return '<button class="asksug" type="button" data-q="' + esc(s) + '">' + esc(s) + "</button>";
          }).join("") + "</div></div>";
      } else {
        body = '<div class="askmsgs" id="askmsgs">' + st.msgs.map(function(m){
          if (m.role === "user") return '<div class="askm user">' + esc(m.text) + "</div>";
          if (m.role === "pending") return '<div class="askm noz pending"><span class="askdots"><i></i><i></i><i></i></span>reading the fleet\\u2019s telemetry\\u2026</div>';
          return '<div class="askm noz">' + esc(m.text).replace(/\\n/g, "<br>") +
            (m.via ? '<div class="askvia">answered by ' + esc(m.via) + (m.mcp && m.mcp.length ? " \\u00b7 via telemetry MCP: " + esc(m.mcp.join(", ")) : "") +
              (m.spanSource === "local-log" ? " \\u00b7 local event log (backend unreachable)" : m.spanSource === "backend" ? " \\u00b7 exported spans" : "") + "</div>" : "") + "</div>";
        }).join("") + "</div>";
      }
      return '<div class="askhd"><span class="askt">' + (ICONS.spark || "") + "Ask</span>" +
        '<button class="iconbtn" id="askclear" title="new conversation" aria-label="new conversation">' + (ICONS.plus || "+") + "</button>" +
        '<button class="iconbtn" id="askclose" title="close" aria-label="close">' + ICONS.x + "</button></div>" +
        body +
        '<div class="askform"><textarea id="askinput" rows="1" placeholder="Ask anything about this fleet\\u2026"></textarea>' +
        '<button class="asksend" id="asksend" type="button" aria-label="send">' + (ICONS.arrowUp || ICONS.chevron || "\\u2191") + "</button></div>";
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
          st.msgs.push({ role: "noz", text: "Couldn\\u2019t reach the daemon \\u2014 " + (err && err.message ? err.message : "unknown error") + ". Try again." });
        })
        .then(function(){ st.busy = false; renderAskPanel(); });
    }

    // ---- Dashboard charts ---------------------------------------------------
    // Donuts for composition ("what is the spend made of"), lines for behaviour
    // over time. Every value here comes from /metrics byAgent or the real event
    // log — there is no sample data path, so an empty fleet draws an empty state
    // rather than a decorative shape.
    var OBPAL = ["var(--ch1)", "var(--ch2)", "var(--ch3)", "var(--ch4)", "var(--ch5)", "var(--ch6)"];
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
        var seg = '<circle cx="70" cy="70" r="' + r + '" fill="none" stroke="' + OBPAL[i % OBPAL.length] +
          '" stroke-width="20" stroke-dasharray="' + len.toFixed(2) + " " + (circ - len).toFixed(2) +
          '" stroke-dashoffset="' + (-off).toFixed(2) + '"><title>' + esc(s.k + " \\u00b7 " + s.label) + "</title></circle>";
        off += len; return seg;
      }).join("");
      var legend = slices.map(function(s, i){
        return '<div class="obdli"><span class="obdsw" style="background:' + OBPAL[i % OBPAL.length] + '"></span>' +
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
        return '<polyline points="' + pts + '" fill="none" stroke="' + OBPAL[i % OBPAL.length] + '" stroke-width="1.6" stroke-linejoin="round"/>';
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
        return '<span class="obsli"><span class="obdsw" style="background:' + OBPAL[i % OBPAL.length] + '"></span>' + esc(s.k) + "</span>";
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
        return { k: a.agentId + (modelOf[a.agentId] ? " \\u00b7 " + modelOf[a.agentId] : ""), v: t, label: tokfmt(t) };
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
        obChartCard("Token distribution", "by agent \\u00b7 model", obDonut(tokSlices, tokfmt(totalTok), "tokens")) +
        obChartCard("Turns", "by agent", obDonut(callSlices, String(totalCalls), "turns")) +
        obChartCard("Turn duration over time", "seconds \\u00b7 per agent", obSeries(durSeries, function(v){ return v.toFixed(1) + "s"; }, xl), true) +
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
        card("Baton", esc(p.holder || "\\u2014"), "who holds it now", false, p.holder || "") +
        card("Spend", money(totalUsd), "across all agents", true) +
        card("Turns", String(turns), "completed") +
        card("Tokens", tokfmt(tin + tout), tokfmt(tin) + " in \\u00b7 " + tokfmt(tout) + " out");
      // Six views, ordered by the question people arrive with. "Replay" is the
      // old Time Travel: it absorbed the separate span-replay tab, which scrubbed
      // the same run on a second slider and left everyone asking which was which.
      var VIEWS = [["metrics", "Metrics"], ["canvas", "Live fleet"], ["graph", "Handoffs"], ["alerts", "Self-heal"], ["timeline", "Timeline"], ["decisions", "Decisions"], ["logs", "Logs"], ["travel", "Replay"]];
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
          '<div id="obburn" class="obasync">' + LOADER + "</div>" +
          '<div id="obmex" class="obasync">' + LOADER + "</div>";
      else if (state.obView === "decisions") body = '<div id="obdecisions" class="obasync">' + LOADER + "</div>";
      else if (state.obView === "logs") body = '<div id="oblogs" class="obasync">' + LOADER + "</div>";
      else if (state.obView === "alerts") body = '<div id="obalerts" class="obasync">' + LOADER + "</div>";
      else if (state.obView === "travel") body = '<div id="obtravel" class="obasync">' + LOADER + "</div>";
      else body = '<div class="obcanvaswrap">' + observatoryCanvas(agents, p.holder, byAgent) + "</div>";
      el.innerHTML =
        '<div class="obhead"><div class="obtitle">' + ICONS.telescope +
          '<span>Observatory</span> <span class="obsub">agents in action \\u00b7 the one brain</span></div>' +
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
      if (state.obView === "metrics") observatoryBurn(p);
      if (state.obView === "metrics") observatoryMetricExplorer(p);
      if (state.obView === "decisions") observatoryDecisions(p);
      if (state.obView === "logs") observatoryLogs(p);
      if (state.obView === "alerts") observatoryAlerts(p, events);
      if (state.obView === "travel") observatoryTravel(p);
    }
    // "Why did I fail?" — pull the agent's own traces and root-cause them.
    function openTriage(p, agent){
      if (document.querySelector(".scrim")) return;
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal triagemodal"><div class="modalhead">Triage \\u00b7 ' + esc(agent) +
        '<button class="iconbtn" id="tx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="modalbody"><div class="loader"><i></i><i></i><i></i><i></i></div>' +
        '<div class="obsub" style="text-align:center;margin-top:10px">Reading ' + esc(agent) + "\\u2019s traces\\u2026</div></div></div>";
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
            '<div class="tmeta">' + src + frm + '<span class="obsub">' + (t.spanCount || 0) + " spans \\u00b7 " + (t.errorCount || 0) + " error(s)</span></div>" +
            '<div class="tlabel">Root cause</div><div class="trootcause">' + esc(t.rootCause || "\\u2014") + "</div>" +
            '<div class="tlabel">Suggested fix</div><div class="tfix">' + esc(t.suggestedFix || "\\u2014") + "</div>" +
            (evs ? '<div class="tlabel">Evidence <span class="obsub">(its own spans)</span></div><div class="tevidence">' + evs + "</div>" : "");
        })
        .catch(function(){
          var body = document.querySelector(".triagemodal .modalbody");
          if (body) body.innerHTML = '<div class="obsub">Triage failed \\u2014 the daemon or the telemetry store is unreachable.</div>';
        });
    }
    // Agent Health Score breakdown — the 4 penalty buckets behind the pill.
    function openHealth(agent){
      if (document.querySelector(".scrim")) return;
      var h = ((state.obHealth || {}).byAgent || {})[agent] || {}, b = h.buckets || {};
      function bucket(l, v, max){
        var pct = Math.max(0, Math.min(100, Math.round((v / max) * 100)));
        return '<div class="hbk"><span class="hbkl">' + l + '</span><span class="hbkbar"><span class="hbkfill" style="width:' + pct + '%"></span></span><span class="hbkv">' + (v ? "\\u2212" + v : "0") + "</span></div>";
      }
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal healthmodal"><div class="modalhead">Health \\u00b7 ' + esc(agent) +
        '<button class="iconbtn" id="hx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="modalbody"><div class="hscore ' + (h.grade || "") + '">' + (h.score != null ? h.score : "\\u2014") +
        '<span class="hscoremax">/100</span><span class="hgrade ' + (h.grade || "") + '">' + esc(h.grade || "") + "</span></div>" +
        '<div class="obsub" style="margin:2px 0 12px">' + (h.turns || 0) + " turns \\u00b7 " + (h.errorCount || 0) + " error(s) \\u00b7 penalties subtracted from 100</div>" +
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
    function backendBase(){ var u = window.__loomTraceUrl; return (u && u.charAt(0) !== "%" ? u : "").replace(/\\/+$/, ""); }
    function backendTraceUrl(id){ var b = backendBase(); return b ? b + "/trace/" + encodeURIComponent(id || "") : ""; }
    function traceUiLink(){
      var b = backendBase();
      return b ? '<a class="obtraceui" href="' + b + '" target="_blank" rel="noreferrer">' + ICONS.route + " View traces</a>" : "";
    }
    // BURN: per-agent cost over time (real ClickHouse), linear projection, budgets.
    function observatoryBurn(p){
      var host = document.getElementById("obburn"); if (!host) return;
      api("/api/projects/" + p.id + "/insights/burn?hours=24&buckets=12").then(function(r){
        host.innerHTML = burnView(p, r.burn || { buckets: [], totalUsd: 0, ratePerHour: 0, projected24h: 0 }, r.budgets || {});
        wireBurnBudgets(p, host);
      }).catch(function(){ host.innerHTML = '<div class="obnote">Burn data unavailable \\u2014 the telemetry store is unreachable.</div>'; });
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
      return '<div class="burnwrap"><div class="obmlabel">Burn rate \\u00b7 per-agent cost, last 24h</div>' + svg + summary + empty +
        '<div class="obmlabel" style="margin-top:16px">Per-agent budgets</div><div class="budgets">' + budrows + "</div></div>";
    }
    function wireBurnBudgets(p, host){
      Array.prototype.forEach.call(host.querySelectorAll(".budsave"), function(btn){
        btn.onclick = function(){
          var agent = btn.getAttribute("data-agent"), inp = host.querySelector('.budinput[data-agent="' + agent + '"]');
          var v = inp ? Number(inp.value) : 0;
          btn.textContent = "\\u2026";
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
      }).catch(function(){ host.innerHTML = '<div class="obnote">Span replay unavailable \\u2014 the telemetry store is unreachable.</div>'; });
    }
    function renderReplay(p, host){
      var turns = state.obReplayTurns || [], ix = state.obReplayIx || 0, t = turns[ix] || {};
      var d = new Date(t.ts || Date.now()), hh = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
      function pill(l, v){ return '<span class="rppill"><span class="rppl">' + l + "</span>" + v + "</span>"; }
      var frame = '<div class="rpframe">' +
        '<div class="rphead"><span class="rpagent">' + esc(t.agent || "agent") + "</span>" +
          '<span class="rpade">' + esc(t.ade || "") + (t.model ? " \\u00b7 " + esc(t.model) : "") + "</span>" +
          '<span class="rpstatus ' + (t.code === 2 ? "err" : "ok") + '">' + (t.code === 2 ? "ERROR" : "OK") + "</span></div>" +
        (t.msg ? '<div class="rpmsg">' + esc(t.msg) + "</div>" : "") +
        '<div class="rpmetrics">' + pill("duration ", (t.ms || 0) + "ms") + pill("in ", tokfmt(t.tin || 0)) + pill("out ", tokfmt(t.tout || 0)) + pill("cost ", money(t.cost || 0)) + "</div>" +
        '<div class="rpactions">' +
          (t.traceId
            ? '<button class="rpwf" data-trace="' + esc(t.traceId) + '">Trace waterfall</button><a class="obtrace" href="' + backendTraceUrl(t.traceId) + '" target="_blank" rel="noreferrer">Open trace \\u2197</a>'
            : '<span class="rpnote">' + ICONS.route + " The trace waterfall lights up once the telemetry store is reachable \\u2014 this turn is from the local event log.</span>") +
          "</div></div>";
      var src = state.obReplaySrc === "local-log";
      var scrub = '<div class="rpscrubwrap"><input class="rpscrub" type="range" aria-label="Scrub turns" aria-valuetext="turn ' + (ix + 1) + " of " + turns.length + (t.agent ? ", " + esc(t.agent) : "") + '" min="0" max="' + (turns.length - 1) + '" value="' + ix + '"/>' +
        '<div class="rpscrubinfo">turn ' + (ix + 1) + " / " + turns.length + " \\u00b7 " + hh + "</div></div>";
      host.innerHTML = '<div class="replaywrap"><div class="obmlabel">Span replay \\u00b7 scrub the fleet\\u2019s turns \\u00b7 ' + (src ? "local event log" : "from exported spans") + "</div>" + scrub + frame + "</div>";
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
        '\\u2026</span><button class="iconbtn" id="wfx" aria-label="close">' + ICONS.x + "</button></div>" +
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
        if (!spans.length){ body.innerHTML = '<div class="wfempty">No spans in this trace yet \\u2014 they land within about a second of the turn finishing.</div>' + traceDeepLink(traceId); return; }
        var t0 = Math.min.apply(null, spans.map(function(s){ return s.ts; }));
        var t1 = Math.max.apply(null, spans.map(function(s){ return s.ts + (s.ms || 0); }));
        var dur = Math.max(1, t1 - t0);
        var turn = spans.filter(function(s){ return s.name === "gen_ai.agent.turn"; })[0] || spans[0];
        var err = spans.some(function(s){ return s.code === 2; });
        var summary = '<div class="wfsum"><div class="wfsumhd"><span class="wfagent">' + esc(turn.agent || "agent") + "</span>" +
          (turn.model ? '<span class="wfmodel">' + esc(turn.ade ? turn.ade + " \\u00b7 " : "") + esc(turn.model) + "</span>" : "") +
          '<span class="wfstatus ' + (err ? "err" : "ok") + '">' + (err ? "ERROR" : "OK") + "</span></div>" +
          '<div class="wfsumstats">' + wfpill("duration ", fmtMs(dur)) + (turn.tin ? wfpill("in ", tokfmt(turn.tin)) : "") + (turn.tout ? wfpill("out ", tokfmt(turn.tout)) : "") + (turn.cost ? wfpill("cost ", money(turn.cost)) : "") + wfpill("spans ", spans.length) + "</div></div>";
        var rows = spans.map(function(s){
          var left = ((s.ts - t0) / dur) * 100, w = Math.max(2, ((s.ms || 0) / dur) * 100);
          var short = String(s.name).replace(/^gen_ai\\./, "").replace(/^loom\\./, "");
          return '<div class="wfrow"><span class="wfname' + (s.code === 2 ? " err" : "") + '" title="' + esc(s.name) + '">' + esc(short) + "</span>" +
            '<span class="wftrack"><span class="wfbar' + (s.code === 2 ? " err" : "") + '" style="left:' + left.toFixed(1) + "%;width:" + w.toFixed(1) + '%"></span></span>' +
            '<span class="wfms">' + (s.ms || 0) + "ms</span></div>";
        }).join("");
        body.innerHTML = summary +
          '<div class="wflabel">Spans \\u00b7 each bar is one span, placed by when it started</div>' +
          '<div class="wfrows">' + rows + "</div>" +
          '<div class="wfaxis"><span>0ms</span><span>' + fmtMs(dur) + "</span></div>" + traceDeepLink(traceId);
      }).catch(function(){ var body = scrim.querySelector(".modalbody"); if (body) body.innerHTML = '<div class="wfempty">Trace unavailable \\u2014 the telemetry store is unreachable.</div>' + traceDeepLink(traceId); });
    }
    function traceDeepLink(traceId){
      var u = backendTraceUrl(traceId);
      return u ? '<a class="obtrace wide" href="' + u + '" target="_blank" rel="noreferrer">View full trace \\u2197</a>' : "";
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
          (k.filesCreated || 0) + " new \\u00b7 " + (k.filesModified || 0) + " changed",
          '<div class="kmsparkwrap cost">' + kmSpark(k.costSparkline, "cost") + "</div>") +
        c("Avg turn time", fmtMs(k.avgReasoningTimeMs), "reasoning time") +
        c("Token usage", tokfmt(totalTok), tokfmt(k.totalTokensIn) + "\\u2191 " + tokfmt(k.totalTokensOut) + "\\u2193", '<div class="kmsparkwrap blue">' + kmSpark(k.tokenSparkline, "blue") + "</div>") +
        c("Est. cost", '<span class="kmcost">' + money(k.totalCostUsd || 0) + "</span>", "from CLI usage") +
        c("Critical path", '<span class="kmsm">' + (k.criticalPath && k.criticalPath.length ? esc(k.criticalPath.join(" \\u2192 ")) : "\\u2014") + "</span>", (k.decisionsRecorded || 0) + " decisions") +
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
                heuristic: ["pattern-matched", "found by text patterns \\u2014 no confidence is claimed"],
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
      var alts = (d.alternatives || []).length ? '<div class="decsl">ALTERNATIVES</div>' + d.alternatives.map(function(a){ return '<div class="decalt">\\u25cb ' + esc(a) + "</div>"; }).join("") : "";
      var files = (d.filesCreated || []).concat(d.filesModified || []);
      var filesH = files.length ? '<div class="decsl">FILES</div>' + files.map(function(f){ return '<div class="decfile">\\u25a1 ' + esc(f) + "</div>"; }).join("") : "";
      var arts = (d.artifactNames || []).length ? '<div class="decsl">ARTIFACTS</div>' + d.artifactNames.map(function(a){ return '<div class="decart">\\u25c6 ' + esc(a) + "</div>"; }).join("") : "";
      // Confidence is only drawn when something actually measured it. The turn's
      // totals are labelled as the TURN's, because that is what they are — every
      // decision mined from one turn used to display that turn's full cost as if
      // it were its own.
      var conf = d.confidence != null
        ? '<div class="decsl">CONFIDENCE</div><div class="decconfbar"><div class="decconffill" style="width:' + d.confidence + '%"></div></div>' +
          '<div class="decsub2">' + d.confidence + "% \\u00b7 " + decSourceBadge(d) + "</div>"
        : '<div class="decsl">CONFIDENCE</div><div class="decsub2">not measured \\u00b7 ' + decSourceBadge(d) + "</div>";
      var tTok = d.turnTokensUsed != null ? d.turnTokensUsed : d.tokensUsed;
      var tUsd = d.turnCostUsd != null ? d.turnCostUsd : d.costUsd;
      var turnLine = (tTok || tUsd)
        ? '<div class="decsl">THE TURN IT CAME FROM</div><div class="decsub2">used ' + tokfmt(tTok || 0) + " tokens \\u00b7 " + money(tUsd || 0) +
          ' <span class="decfoot">whole-turn totals, not this decision alone</span></div>'
        : "";
      return '<div class="decsl">DECISION</div><div class="decdt">' + esc(d.title) + "</div>" +
        '<div class="decsl">REASON</div><div class="decdtext">' + esc(d.reasoning || "\\u2014") + "</div>" + alts +
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
        if (!decisions.length){ host.innerHTML = '<div class="obnote">No decisions captured yet. Run a turn \\u2014 with <code>ANTHROPIC_API_KEY</code> set for rich extraction \\u2014 and each agent\\u2019s choices appear here.</div>'; return; }
        var agents = []; decisions.forEach(function(d){ if (agents.indexOf(d.agentId) < 0) agents.push(d.agentId); });
        var chips = '<button class="decchip on" data-filter="all">All</button>' + agents.map(function(a){ return '<button class="decchip" data-filter="' + esc(a) + '">' + esc(a) + "</button>"; }).join("");
        // Only average what was actually measured; a fleet of pattern-matched
        // decisions has no average confidence to report.
        var rated = decisions.filter(function(d){ return d.confidence != null; });
        var avg = rated.length ? Math.round(rated.reduce(function(s, d){ return s + d.confidence; }, 0) / rated.length) : null;
        host.innerHTML = '<div class="decheader"><span class="declabel">DECISIONS</span><span class="deccount">' + (stats.total || decisions.length) + " recorded" +
          (avg != null ? " \\u00b7 avg " + avg + "% over " + rated.length + " rated" : "") + "</span></div>" +
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
      }).catch(function(){ host.innerHTML = '<div class="obnote">Decisions unavailable \\u2014 the daemon didn\\u2019t answer. Switch tabs and back to retry.</div>'; });
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
        host.innerHTML = '<div class="obnote">Self-heal state unavailable \\u2014 the daemon didn\\u2019t answer. Switch tabs and back to retry.</div>';
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
              '<div class="alwhy">' + esc(it.reason) + " \\u00b7 paused " + dur(Date.now() - it.since) + " ago" +
              (it.displaced ? " \\u00b7 the baton was taken off it" : "") + "</div></div>" +
              '<button class="allift" data-lift="' + esc(a) + '">Lift</button></div>';
          }).join("")
        : '<div class="alsec">PAUSED RIGHT NOW</div><div class="alok">' + (ICONS.check || "\\u2713") +
          " Nothing is paused. Every agent can take the baton.</div>";

      var hist = episodes.length
        ? episodes.slice(0, 25).map(function(ep){
            var live = ep.from && !ep.to && Object.prototype.hasOwnProperty.call(q, ep.agent);
            var lost = ep.from && !ep.to && !live;
            return '<div class="alrow"><span class="aldot ' + (live ? "firing" : "resolved") + '"></span>' +
              '<div class="alinfo"><div class="alname">' + esc(ep.agent) +
                '<span class="alalert">' + esc(ep.alert) + "</span></div>" +
                '<div class="alwhy">' +
                  (ep.from ? new Date(ep.from).toLocaleTimeString() : "\\u2014") +
                  (ep.to ? " \\u2192 " + new Date(ep.to).toLocaleTimeString() + " \\u00b7 held " + dur(ep.to - ep.from)
                         : live ? " \\u00b7 still paused" : " \\u00b7 ended (no recovery recorded)") +
                  (ep.fallback ? " \\u00b7 baton moved to " + esc(ep.fallback) : "") +
                  (ep.retried ? " \\u00b7 baton handed back" : "") +
                  (ep.via && ep.via !== "resolved" ? " \\u00b7 via " + esc(ep.via) : "") +
                "</div></div>" +
              '<span class="alstate ' + (live ? "firing" : lost ? "" : "ok") + '">' + (live ? "FIRING" : lost ? "ENDED" : "RECOVERED") + "</span></div>";
          }).join("")
        : '<div class="obnote">No alert has fired yet. Point your monitoring\\u2019s webhook at <code>/api/webhooks/alerts</code> and every fire and recovery lands here.</div>';

      return '<div class="alwrap">' + nowCard +
        '<div class="alsec">HISTORY \\u00b7 ' + episodes.length + " episode" + (episodes.length === 1 ? "" : "s") + "</div>" + hist +
        '<div class="alfoot">Alert rules live in your monitoring backend. ' +
        "A firing alert refuses that agent the baton; a resolved one gives it back.</div></div>";
    }

    /** Lift a pause by hand, then redraw from the map the API returns. */
    function wireAlertLifts(host, p, events){
      Array.prototype.forEach.call(host.querySelectorAll("[data-lift]"), function(b){
        b.onclick = function(){
          var agent = b.getAttribute("data-lift");
          b.disabled = true; b.textContent = "\u2026";
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
            '<div class="obnote">' + ICONS.route + " Metrics live in the telemetry store, and it isn\u2019t answering. Bring your collector up and the series appear.</div>";
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
            .map(function(k){ return '<span class="mexlbl">' + esc(k.replace(/^gen_ai\./, "")) + "=" + esc(String(sr.labels[k])) + "</span>"; }).join("");
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
          var shown = sr.prefer === "avg" ? (last == null ? "\u2014" : (Math.round(last * 100) / 100)) : Math.round(total * 100) / 100;
          return '<div class="mexrow"><div class="mexinfo"><div class="mexname">' + esc(sr.metric) +
            '<span class="mextype">' + esc(sr.type || "") + (sr.unit ? " \u00b7 " + esc(sr.unit) : "") + "</span></div>" +
            '<div class="mexlbls">' + (labels || '<span class="mexlbl">no labels</span>') + "</div></div>" +
            spark +
            '<div class="mexval">' + shown + '<span class="mexagg">' + (sr.prefer === "avg" ? "latest" : "total") + "</span></div></div>";
        }).join("");
        host.innerHTML =
          '<div class="obmexhd"><span class="declabel">METRIC EXPLORER</span>' +
            '<span class="deccount">' + series.length + " series \u00b7 from the telemetry store</span>" +
            '<span class="mexwins">' + chips + "</span></div>" +
          (rows ? '<div class="mexlist">' + rows + "</div>"
                : '<div class="obnote">No series in this window. Loom records turns, cost, tokens, handoffs, live agent count and turn duration \u2014 run a turn, or widen the window.</div>');
        Array.prototype.forEach.call(host.querySelectorAll("[data-win]"), function(b){
          b.onclick = function(){ st.sinceMs = Number(b.getAttribute("data-win")); observatoryMetricExplorer(p); };
        });
      }).catch(function(){
        host.innerHTML = '<div class="obnote">Metric explorer unavailable \u2014 the daemon didn\u2019t answer. Switch tabs and back to retry.</div>';
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
          host.innerHTML = '<div class="obnote">' + ICONS.route + " Logs live in the telemetry store, and it isn\\u2019t answering \\u2014 so there is nothing to read. Unlike spans, logs have no local fallback. Bring your collector up and this fills in.</div>";
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
            '<span class="lgagent">' + esc(l.agent || "\\u2014") + "</span>" +
            '<span class="lgbody">' + esc(l.body || "") + "</span>" +
            (l.traceId ? '<a class="lgtrace" href="' + backendTraceUrl(l.traceId) + '" target="_blank" rel="noreferrer" title="open this trace">' + esc(l.traceId.slice(0, 8)) + "</a>" : '<span class="lgtrace none">\\u2014</span>') +
            "</div>";
        }).join("");
        host.innerHTML =
          '<div class="decheader"><span class="declabel">LOGS</span><span class="deccount">' + logs.length + " lines \\u00b7 from the telemetry store</span></div>" +
          '<div class="decfilters">' + chips +
            '<input class="mcpin lgq" id="lgq" placeholder="filter text\\u2026" value="' + esc(st.q) + '"/></div>' +
          (rows ? '<div class="lglist">' + rows + "</div>"
                : '<div class="obnote">No log lines match. Loom ships every message, tool call, file edit and error \\u2014 widen the filter.</div>');
        Array.prototype.forEach.call(host.querySelectorAll(".decchip"), function(c){
          c.onclick = function(){ st.severity = c.getAttribute("data-sev"); observatoryLogs(p); };
        });
        var qEl = host.querySelector("#lgq"), t = null;
        if (qEl) qEl.oninput = function(){
          if (t) clearTimeout(t);
          t = setTimeout(function(){ st.q = qEl.value.trim(); observatoryLogs(p); }, 320);
        };
      }).catch(function(){
        host.innerHTML = '<div class="obnote">Logs unavailable \\u2014 the daemon didn\\u2019t answer. Switch tabs and back to retry.</div>';
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
        if (!snaps.length){ host.innerHTML = '<div class="obnote">No replay data yet \\u2014 run some agents to build a timeline.</div>'; return; }
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
          '<div class="ttheader"><div class="ttctrls"><button class="ttbtn" id="ttprev">\\u25c0</button><button class="ttbtn ttplay" id="ttplay">\\u25b6 Play</button><button class="ttbtn" id="ttnext">\\u25b6</button></div><div class="ttframe">Frame <span id="ttnum">1</span> / ' + snaps.length + "</div></div>" +
          '<div class="tttimeline"><input type="range" class="ttscrub" id="ttscrub" aria-label="Scrub the run timeline" aria-valuetext="frame 1 of ' + snaps.length + '" min="0" max="' + (snaps.length - 1) + '" value="0"><div class="ttmarkers">' + markers + "</div></div>" +
          '<div class="ttbody"><div class="ttstate" id="ttstate"></div><div class="ttevent" id="ttevent"></div></div>';
        var scrub = host.querySelector("#ttscrub");
        function go(i){ state.obTravel.i = i; scrub.value = i; scrub.setAttribute("aria-valuetext", "frame " + (i + 1) + " of " + snaps.length); updateTravelFrame(); }
        scrub.oninput = function(){ go(Number(scrub.value)); };
        host.querySelector("#ttprev").onclick = function(){ if (state.obTravel.i > 0) go(state.obTravel.i - 1); };
        host.querySelector("#ttnext").onclick = function(){ if (state.obTravel.i < snaps.length - 1) go(state.obTravel.i + 1); };
        host.querySelector("#ttplay").onclick = function(){
          var t = state.obTravel, btn = this;
          if (t.timer){ clearInterval(t.timer); t.timer = null; btn.textContent = "\\u25b6 Play"; }
          else { btn.textContent = "\\u23f8 Pause"; t.timer = setInterval(function(){ if (t.i < snaps.length - 1) go(t.i + 1); else { clearInterval(t.timer); t.timer = null; btn.textContent = "\\u25b6 Play"; } }, 800); }
        };
        updateTravelFrame();
      }).catch(function(){ host.innerHTML = '<div class="obnote">Time-travel unavailable \\u2014 the daemon didn\\u2019t answer. Switch tabs and back to retry.</div>'; });
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
        var facts = (s.memorySnapshot.keyFacts || []).map(function(f){ return '<div class="ttfact">\\u00b7 ' + esc(f) + "</div>"; }).join("");
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
        evEl.innerHTML = '<div class="ttevcard" style="border-color:' + col + '"><div class="ttevtype" style="--ttev:' + col + '">' + esc(String(s.triggerEvent.type).toUpperCase().replace(/_/g, " ")) + '</div><div class="ttevdesc">' + esc(s.triggerEvent.description) + '</div><div class="ttevmeta">Agent: ' + esc(s.triggerEvent.agentId) + " \\u00b7 " + new Date(s.timestampMs).toLocaleTimeString() + "</div></div>" +
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
            '<a class="obtrace" href="' + backendTraceUrl(cur.traceId) + '" target="_blank" rel="noreferrer">Open trace \\u2197</a></div>'
          : '<div class="rpnote">' + ICONS.route + " Trace waterfall lights up once the telemetry store is reachable \\u2014 this turn came from the local event log.</div>") +
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
        if (f && t && idset[f] && idset[t] && f !== t) em[f + "\\u0001" + t] = (em[f + "\\u0001" + t] || 0) + 1;
      });
      var edges = Object.keys(em).map(function(k){ var pr = k.split("\\u0001"); return { from: pr[0], to: pr[1], n: em[k] }; });
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
      ids.forEach(function(id){ if (obNodePos["g:" + id]) pos[id] = obNodePos["g:" + id]; });
      var W = PADX * 2 + maxLayer * COL + NW, H = Math.max(220, PADY * 2 + (maxRows - 1) * ROW + NH);
      // The last handoff that actually happened, so "where the baton just came
      // from" is visible instead of inferred.
      var lastHop = null;
      for (var li = (events || []).length - 1; li >= 0; li--){
        var le = events[li];
        if (le.kind === "handoff" && le.payload && le.payload.from && le.payload.to){ lastHop = le.payload.from + "\\u0001" + le.payload.to; break; }
      }
      var maxN = edges.reduce(function(m, e){ return Math.max(m, e.n); }, 1);
      var edgeSvg = edges.map(function(e){
        var a = pos[e.from], b = pos[e.to]; if (!a || !b) return "";
        var x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, mid = (x1 + x2) / 2;
        var recent = lastHop === (e.from + "\\u0001" + e.to);
        // Thickness carries how heavily this route was used — a path walked 12
        // times and one walked once are not the same fact.
        var w = 1.2 + (e.n / maxN) * 2.4;
        var lx = (x1 + x2) / 2, ly = (y1 + y2) / 2 - 7;
        return '<path class="' + (recent ? "obhop recent" : "obhop") + '" d="M ' + x1 + " " + y1 + " C " + mid + " " + y1 + ", " + mid + " " + y2 + ", " + x2 + " " + y2 +
          '" fill="none" stroke="var(--shuttle)" stroke-width="' + w.toFixed(1) + '" opacity="' + (recent ? "0.95" : "0.5") + '" marker-end="url(#obarrow)"><title>' +
          esc(e.from + " \\u2192 " + e.to + ": " + e.n + (e.n === 1 ? " handoff" : " handoffs")) + "</title></path>" +
          '<text x="' + lx.toFixed(0) + '" y="' + ly.toFixed(0) + '" text-anchor="middle" font-size="9" font-weight="700" fill="var(--shuttle-ink)">\\u00d7' + e.n + "</text>";
      }).join("");
      var nodeSvg = ids.map(function(id){
        var a = byId[id] || { id: id }, c = byAgent[id] || {}, baton = id === holder, busy = a.busy, pp = pos[id];
        var stroke = baton ? "var(--shuttle)" : busy ? "var(--thread)" : "var(--border)";
        var dot = busy ? "var(--thread)" : baton ? "var(--shuttle)" : "var(--muted-foreground)";
        return '<g class="obnode' + (busy ? " busy" : "") + '" data-agent="g:' + esc(id) + '" transform="translate(' + pp.x + " " + pp.y + ')">' +
          '<rect x="0" y="0" width="' + NW + '" height="' + NH + '" rx="10" fill="var(--card)" stroke="' + stroke + '" stroke-width="' + (busy || baton ? 2 : 1) + '"/>' +
          '<circle cx="15" cy="' + (NH / 2) + '" r="4" fill="' + dot + '"' + (busy ? ' class="obdotpulse"' : "") + "/>" +
          '<text x="28" y="' + (NH / 2 - 2) + '" fill="var(--card-foreground)" font-size="12" font-weight="600">' + esc(trunc(id, 15)) + "</text>" +
          '<text x="28" y="' + (NH / 2 + 12) + '" fill="var(--muted-foreground)" font-size="10">' + esc(a.kind || "agent") + (c.turns ? " \\u00b7 " + c.turns + "t" : "") + "</text>" +
          (baton ? '<text x="' + (NW - 8) + '" y="12" text-anchor="end" fill="var(--shuttle-ink)" font-size="8.5" font-weight="700" letter-spacing="0.06em">BATON</text>' : "") +
          "</g>";
      }).join("");
      var note = edges.length ? "" : '<div class="obnote">No baton handoffs yet \\u2014 the flow graph draws itself as the baton moves between agents.</div>';
      var totalHops = edges.reduce(function(s, e){ return s + e.n; }, 0);
      var legend = edges.length ? '<div class="oblegend">' +
        '<span class="oblg"><span class="oblgline" style="background:var(--shuttle)"></span>a handoff \\u2014 thicker means walked more often</span>' +
        '<span class="oblg"><span class="oblgx">\\u00d7n</span>times the baton took that route</span>' +
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
      var isDecision = function(e){ return e.kind === "status" && (e.payload || {}).state === "agent_decision"; };
      var evs = (events || []).filter(function(e){ return KINDS[e.kind] || isHeal(e) || isRecover(e) || isDecision(e) || isBudget(e) || isMcp(e); }).sort(function(a, b){ return a.ts - b.ts; });
      if (!evs.length) return '<div class="obnote">No fleet events yet. Run a turn and the trace fills in.</div>';
      var base = evs[0].ts;
      var rows = evs.map(function(e){
        var p = e.payload || {};
        var cls = isHeal(e) ? "heal" : isRecover(e) ? "ok" : isDecision(e) ? "decision"
          : isBudget(e) ? (p.state === "budget_exceeded" ? "warn" : "ok")
          : isMcp(e) ? "info" : KINDS[e.kind][0];
        var label, extra = "";
        if (isBudget(e)) label = p.state === "budget_exceeded"
          ? "\\ud83d\\udcb8 " + esc(e.agentId || "agent") + " paused \\u2014 over its daily budget" +
            (p.budgetUsd != null ? " (" + money(p.spentTodayUsd || 0) + " of " + money(p.budgetUsd) + ")" : "")
          : "\\u2713 " + esc(e.agentId || "agent") + " back under budget \\u2014 pause lifted";
        else if (isMcp(e)) label = "\\ud83d\\udd0c " + esc(e.agentId || "agent") + " got MCP: " + esc(((p.servers || []).join(", ")) || "no servers");
        else if (isHeal(e)) label = "\\u26a1 Alert \\u00b7 " + esc(p.alert || "alert") + " \\u2192 baton forced off " + esc(e.agentId || "agent") + (p.fallback ? " to " + esc(p.fallback) : "");
        else if (isRecover(e)) label = "\\u2713 Recovery \\u00b7 " + esc(p.alert || "alert") + " resolved \\u2192 " + (p.retried ? "baton retried on " + esc(e.agentId || "agent") : "quarantine lifted on " + esc(e.agentId || "agent"));
        else if (isDecision(e)){ label = "\\ud83d\\udca1 " + esc(e.agentId || "agent") + " decided: <strong>" + esc(p.title || "decision") + "</strong>" +
          (p.confidence != null ? ' <span class="obtlconf">' + p.confidence + "%</span>" : ""); extra = ' data-decid="' + esc(p.decisionId || "") + '"'; }
        else if (e.kind === "run_complete") label = esc(e.agentId || "agent") + " finished a turn" + (p.durationMs ? " \\u00b7 " + (Math.round(p.durationMs / 100) / 10) + "s" : "");
        else if (e.kind === "handoff") label = p.from ? "baton \\u00b7 " + esc(p.from) + " \\u2192 " + esc(p.to || "\\u2014") : "baton \\u00b7 " + esc(p.to || "agent") + " takes it first";
        else if (e.kind.indexOf("route_") === 0) label = "route " + e.kind.slice(6) + (p.error ? " \\u00b7 " + esc(p.error) : "");
        else if (e.kind.indexOf("memory_") === 0) label = "brain \\u00b7 " + e.kind.slice(7) + (p.kind ? " (" + esc(p.kind) + ")" : "");
        else if (e.kind === "needs_input") label = esc(e.agentId || "agent") + " needs input";
        else if (e.kind === "error") label = esc(p.message || "error");
        else label = "decision \\u00b7 " + esc(trunc(p.text || "", 56));
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
      if (!h || h.score == null) return '<span class="obhealth na" title="No health data yet">\\u2014</span>';
      var g = h.grade || "healthy";
      return '<button class="obhealth ' + g + '" data-health="' + esc(agent) + '" title="Agent Health ' + h.score +
        '/100 (' + g + ') \\u2014 click for the breakdown">' + h.score + "</button>";
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
        ? (trimmed ? '<span class="obsub">+' + (chain.length - CAP) + ' earlier</span> <span class="obarrow">\\u2192</span> ' : "") +
          shownChain.map(function(a, i){ return (i ? ' <span class="obarrow">\\u2192</span> ' : "") + '<span class="obchip">' + esc(a) + "</span>"; }).join("")
        : '<span class="obsub">no handoffs yet</span>';
      var rows = agents.map(function(a){
        var c = byAgent[a.id] || {}, baton = a.id === p.holder, cls = a.busy ? "busy" : baton ? "baton" : "idle";
        return '<div class="obrow"><span class="obdot ' + cls + '"></span><span class="obname">' + esc(a.id) + "</span>" +
          '<span class="obkind">' + esc(a.kind || "") + (a.role ? " \\u00b7 " + esc(a.role) : "") + "</span>" +
          healthBadge(hb[a.id], a.id) +
          '<span class="obspend">' + money(c.usd || 0) + '</span><span class="obturns">' + (c.turns || 0) + " turns</span>" +
          '<span class="obtok">' + tokfmt((c.tokensIn || 0) + (c.tokensOut || 0)) + " tok</span>" +
          '<button class="obtriage" data-triage="' + esc(a.id) + '" title="Why did I fail? Root-cause this agent from its own traces">\\u26a0 Triage</button></div>';
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
        var pos = obNodePos[a.id];
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
        var statusText = a.enabled === false ? "off" : busy ? "running now" : baton ? "holds the baton \\u00b7 idle" : "idle";
        var statusCol = busy ? "var(--thread-ink)" : baton ? "var(--shuttle-ink)" : "var(--muted-foreground)";
        var work = (c.turns ? c.turns + (c.turns === 1 ? " turn" : " turns") : "no turns yet") + (c.usd ? " \\u00b7 " + money(c.usd) : "");
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
        '<span class="oblg"><span class="oblgline live" style="background:var(--shuttle)"></span>holds the baton \\u2014 only this one may edit code</span>' +
        '<span class="oblg"><span class="oblgline live" style="background:var(--thread)"></span>running a turn now</span>' +
        '<span class="oblg"><span class="oblgline dash"></span>idle \\u2014 still shares the same memory</span>' +
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
        var t = (g.getAttribute("transform") || "").match(/translate\\(\\s*([-\\d.]+)[\\s,]+([-\\d.]+)/);
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
          obNodePos[drag.id] = { x: x, y: y };
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

    // ---- diff/preview dock (right of the chat, opens on click) --------------
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
      // The terminal button wants the terminal. If the console tab is the active
      // pane, switch to a terminal rather than closing the dock out from under it.
      document.getElementById("termbtn").onclick = function(){
        var opening = !termOpen();
        toggleTerm(); // flips the dock; applyTerm ensures a terminal when opening
        if (opening && activeTerm === CONSOLE_TAB) {
          activeTerm = terms.length ? terms[terms.length - 1].id : null;
          drawTermTabs(); showTermPane(); focusTerm();
        }
      };
      bindConsole();
      var phb = document.getElementById("phonebtn");
      if (phb) phb.onclick = openConnectPhone;
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

    // ---- terminal dock -----------------------------------------------------
    // Two backends, chosen by the daemon (see terminals.ts). With a real pty
    // we hand the bytes to xterm.js and get a true terminal; without one we
    // drive a line at a time and render it ourselves.
    var TERM_KEY = "loomTerm";
    var terms = [], activeTerm = null, termSeq = 0, termMode = null;
    // The console is a pseudo-tab in the terminal dock's tab bar: it shares the
    // dock and the pane area, and is switched to like any terminal. This
    // sentinel is its "id" for activeTerm.
    var CONSOLE_TAB = "__console__";
    function curTerm(){ for (var i = 0; i < terms.length; i++) if (terms[i].id === activeTerm) return terms[i]; return null; }
    function termOpen(){ return desktop && localStorage.getItem(TERM_KEY) === "1"; }
    function wsSend(msg){
      var ws = state.ws;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    }
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
    /** Map the design tokens onto an xterm palette so it matches the theme. */
    function xtermTheme(){
      var cs = getComputedStyle(document.documentElement);
      var v = function(n, fallback){ var x = cs.getPropertyValue(n).trim(); return x && x.charAt(0) === "#" ? x : fallback; };
      var fg = v("--foreground", "#fafafa");
      var dim = v("--muted-foreground", "#a1a1a1");
      return {
        background: v("--editor-surface", "#141414"),
        foreground: fg,
        cursor: fg,
        cursorAccent: v("--editor-surface", "#141414"),
        selectionBackground: "rgba(103,232,249,0.28)",
        black: dim,
        red: v("--git-del", "#c74e39"),
        green: v("--git-add", "#81b88b"),
        yellow: v("--warn", "#eab308"),
        blue: v("--thread", "#67e8f9"),
        magenta: v("--shuttle", "#e879f9"),
        cyan: v("--thread", "#67e8f9"),
        white: fg,
        brightBlack: dim,
        brightRed: v("--err", "#ff6568"),
        brightGreen: v("--ok", "#10b981"),
        brightYellow: v("--warn", "#eab308"),
        brightBlue: v("--thread", "#67e8f9"),
        brightMagenta: v("--shuttle", "#e879f9"),
        brightCyan: v("--thread", "#67e8f9"),
        brightWhite: fg
      };
    }
    function applyTerm(){
      var dock = document.getElementById("termdock"); if (!dock) return;
      var on = termOpen();
      dock.classList.toggle("open", on);
      var tb = document.getElementById("termbtn");
      if (tb) tb.classList.toggle("active", on);
      if (on) { ensureTerm(); fitActive(); focusTerm(); }
    }
    function toggleTerm(){
      localStorage.setItem(TERM_KEY, termOpen() ? "0" : "1");
      applyTerm();
    }
    function ensureTerm(){ if (!terms.length) addTerm(); }
    function focusTerm(){
      var t = curTerm(); if (!t || !termOpen()) return;
      setTimeout(function(){
        if (t.xterm) t.xterm.focus();
        else { var i = document.getElementById("terminput"); if (i) i.focus(); }
      }, 0);
    }
    /**
     * Re-measure the active terminal. Refuses to fit a pane with no box —
     * measuring a hidden element yields a 1x1 grid, and the pty gets resized
     * to match, which mangles the shell's line editing.
     */
    function fitActive(){
      var t = curTerm();
      if (!t || !t.fit) return;
      var host = document.querySelector('.termpane[data-t="' + t.id + '"]');
      if (!host || host.clientWidth < 40 || host.clientHeight < 20) return;
      try {
        t.fit.fit();
      } catch (e) {}
    }
    function paneFor(t){
      var el = document.querySelector('.termpane[data-t="' + t.id + '"]');
      if (el) return el;
      el = document.createElement("div");
      el.className = "termpane";
      el.setAttribute("data-t", t.id);
      document.getElementById("termpanes").appendChild(el);
      return el;
    }
    function addTerm(){
      termSeq++;
      var id = "t" + termSeq;
      var t = { id: id, title: "Terminal " + termSeq, html: "", busy: false,
                cwd: (state.project && state.project.dir) || "", hist: [], hi: -1, draft: "" };
      terms.push(t);
      activeTerm = id;
      // the pane must exist AND be visible before xterm opens into it —
      // measuring a display:none element yields a 1x1 grid, and the pty would
      // be sized to match.
      var host = paneFor(t);
      drawTermTabs();
      showTermPane();
      api("/api/projects/" + pid + "/term/open",
          { method: "POST", body: JSON.stringify({ term: id, cols: 80, rows: 24 }) })
        .then(function(r){
          t.cwd = r.cwd || t.cwd;
          termMode = r.mode || "pipe";
          if (termMode === "pty" && window.Terminal) mountXterm(t, host, r.scrollback || "");
          else mountLines(t, host, r.scrollback || "");
          showTermPane();
          fitActive();
          focusTerm();
        })
        .catch(function(err){
          host.innerHTML = '<div class="termbody"><div class="eo">loom: ' + esc(err.message) + "</div></div>";
        });
    }
    /** A real terminal: xterm.js speaking raw bytes to the pty over the WS. */
    function mountXterm(t, host, scrollback){
      var term = new window.Terminal({
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
        fontSize: 12,
        lineHeight: 1.2,
        theme: xtermTheme(),
        cursorBlink: true,
        scrollback: 10000,
        allowProposedApi: true,
        macOptionIsMeta: true
      });
      var fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      try { term.loadAddon(new window.WebLinksAddon.WebLinksAddon()); } catch (e) {}
      term.open(host);
      t.xterm = term; t.fit = fit;
      fitActive();
      // one more after layout settles — the dock may still be sizing
      requestAnimationFrame(function(){ fitActive(); });
      // scrollback is authoritative up to the open response; only fall back to
      // what we buffered when this is a fresh session with none.
      if (scrollback) term.write(scrollback);
      else if (t.pendingOut) term.write(t.pendingOut);
      t.pendingOut = "";
      // Cmd/Ctrl+C must copy when there's a selection and interrupt when there
      // isn't — the shortcut a terminal user expects, and xterm won't guess.
      // Cmd/Ctrl+V pastes; everything else falls through to the pty.
      term.attachCustomKeyEventHandler(function(e){
        if (e.type !== "keydown") return true;
        var mod = e.metaKey || e.ctrlKey;
        if (mod && e.key === "c" && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(function(){});
          return false;
        }
        if (mod && e.key === "v") {
          navigator.clipboard.readText().then(function(txt){
            if (txt) wsSend({ type: "term-input", term: t.id, data: txt });
          }).catch(function(){});
          return false;
        }
        if (mod && e.shiftKey && e.key.toLowerCase() === "k") { term.clear(); return false; }
        return true;
      });
      term.onData(function(d){ wsSend({ type: "term-input", term: t.id, data: d }); });
      term.onResize(function(size){ wsSend({ type: "term-resize", term: t.id, cols: size.cols, rows: size.rows }); });
      if (term.onTitleChange) term.onTitleChange(function(title){
        if (!title) return;
        t.title = title.length > 22 ? title.slice(0, 21) + "…" : title;
        drawTermTabs();
      });
      // the pty needs to know the real window, not the 80x24 we opened with
      wsSend({ type: "term-resize", term: t.id, cols: term.cols, rows: term.rows });
      if (!t.ro && window.ResizeObserver) {
        t.ro = new ResizeObserver(function(){ if (t.id === activeTerm) { try { fit.fit(); } catch (e) {} } });
        t.ro.observe(host);
      }
    }
    /** No pty: render lines ourselves and drive the shell one command at a time. */
    function mountLines(t, host, scrollback){
      host.innerHTML = '<div class="termbody"></div>';
      t.body = host.querySelector(".termbody");
      t.html = '<div class="hintl">shell in ' + esc(shortCwd(t.cwd)) +
        " · ⌃C interrupt · ⌃L clear · ↑ history</div>";
      var replay = scrollback || t.pendingOut || "";
      t.pendingOut = "";
      if (replay) t.html += "<span>" + esc(replay) + "</span>";
      t.body.innerHTML = t.html;
      var form = document.getElementById("termform");
      if (form) form.style.display = "";
      t.body.addEventListener("mousedown", function(ev){
        if (String(window.getSelection() || "")) return;
        if (ev.target.closest && ev.target.closest("a")) return;
        setTimeout(focusTerm, 0);
      });
      drawPrompt();
    }
    function closeTerm(id){
      var idx = -1;
      for (var i = 0; i < terms.length; i++) if (terms[i].id === id) idx = i;
      if (idx < 0) return;
      var t = terms[idx];
      if (t.ro) { try { t.ro.disconnect(); } catch (e) {} }
      if (t.xterm) { try { t.xterm.dispose(); } catch (e) {} }
      var pane = document.querySelector('.termpane[data-t="' + id + '"]');
      if (pane) pane.remove();
      api("/api/projects/" + pid + "/term/close", { method: "POST", body: JSON.stringify({ term: id }) }).catch(function(){});
      terms.splice(idx, 1);
      if (activeTerm === id) activeTerm = terms.length ? terms[Math.max(0, idx - 1)].id : null;
      if (!terms.length) { localStorage.setItem(TERM_KEY, "0"); applyTerm(); return; }
      drawTermTabs();
      showTermPane();
      focusTerm();
    }
    function drawTermTabs(){
      var box = document.getElementById("termtabs"); if (!box) return;
      var html = terms.map(function(t){
        return '<span class="termtab' + (t.id === activeTerm ? " active" : "") + '" data-t="' + t.id + '">' +
          (t.busy ? '<span class="busy" style="width:8px;height:8px;color:var(--live)"></span>' : "") +
          esc(t.title) + '<span class="tx" data-close="' + t.id + '">' + ICONS.x + "</span></span>";
      }).join("");
      // The console rides in the same bar as a closeable tab.
      if (con.present) {
        var unseen = con.logs.filter(function(r){ return r.level === "error" && r.id > con.seen; }).length;
        html += '<span class="termtab console' + (activeTerm === CONSOLE_TAB ? " active" : "") + '" data-console="1">' +
          (unseen ? '<span class="busy" style="width:7px;height:7px;color:var(--err)"></span>' : ICONS.console) +
          '<span class="ctt">Console</span>' +
          '<span class="tx" data-conclose="1" title="close console" aria-label="close console">' + ICONS.x + "</span></span>";
      }
      box.innerHTML = html;
      Array.prototype.forEach.call(box.querySelectorAll(".termtab[data-t]"), function(el){
        el.onclick = function(ev){
          var c = ev.target.closest ? ev.target.closest("[data-close]") : null;
          if (c) { closeTerm(c.getAttribute("data-close")); return; }
          // Switching to a terminal just changes which pane shows; the console
          // tab stays in the bar.
          activeTerm = el.getAttribute("data-t");
          drawTermTabs(); showTermPane(); drawPrompt(); fitActive(); focusTerm();
        };
      });
      var ct = box.querySelector(".termtab.console");
      if (ct) ct.onclick = function(ev){
        var c = ev.target.closest ? ev.target.closest("[data-conclose]") : null;
        if (c) { closeConsole(); return; }
        activeTerm = CONSOLE_TAB;
        // seeing the console clears the "unread errors" dot
        con.logs.forEach(function(r){ if (r.id > con.seen) con.seen = r.id; });
        drawTermTabs(); showTermPane(); drawConsole(); drawErrDot();
      };
    }
    function showTermPane(){
      var conActive = activeTerm === CONSOLE_TAB;
      var wrap = document.getElementById("conwrap");
      if (wrap) wrap.classList.toggle("on", conActive);
      Array.prototype.forEach.call(document.querySelectorAll(".termpane"), function(p){
        p.classList.toggle("active", !conActive && p.getAttribute("data-t") === activeTerm);
      });
      var t = conActive ? null : curTerm();
      var form = document.getElementById("termform");
      // the input line belongs to the fallback only — a pty takes keys directly
      if (form) form.style.display = t && !t.xterm && termMode === "pipe" ? "" : "none";
      if (t && t.fit) { try { t.fit.fit(); } catch (e) {} }
    }
    // Show the console as the active tab in the dock (called from the console
    // button, which lives at module scope and reaches this via state.showConsole).
    function showConsolePane(){
      con.present = true; con.open = true;
      if (!termOpen()) toggleTerm(); // opens the dock (and ensures a terminal)
      activeTerm = CONSOLE_TAB;
      drawTermTabs(); showTermPane();
    }
    // Close the console tab; fall back to a terminal, or shut the dock if the
    // console was the only thing in it.
    function hideConsolePane(){
      con.present = false; con.open = false;
      if (activeTerm === CONSOLE_TAB) activeTerm = terms.length ? terms[terms.length - 1].id : null;
      if (!terms.length) { localStorage.setItem(TERM_KEY, "0"); applyTerm(); return; }
      drawTermTabs(); showTermPane(); focusTerm();
    }
    state.showConsole = showConsolePane;
    state.hideConsole = hideConsolePane;
    state.consoleActive = function(){ return activeTerm === CONSOLE_TAB; };
    state.redrawTermTabs = drawTermTabs; // so a new error can refresh the tab's dot
    function drawPrompt(){
      var t = curTerm(); if (!t || t.xterm) return;
      var pr = document.querySelector(".terminput .pr");
      if (pr) pr.innerHTML = esc(shortCwd(t.cwd)) + " <b>❯</b>";
      var row = document.querySelector(".terminput");
      if (row) row.classList.toggle("busy", !!t.busy);
      var st = document.querySelector(".terminput .st");
      if (st) st.textContent = t.busy ? "running · ⌃C to stop" : "";
    }
    function termAppend(t, html){
      t.html += html;
      if (t.id === activeTerm && t.body) {
        var atBottom = t.body.scrollHeight - t.body.scrollTop - t.body.clientHeight < 40;
        t.body.insertAdjacentHTML("beforeend", html);
        if (atBottom) t.body.scrollTop = t.body.scrollHeight;
      }
    }
    /**
     * Fallback renderer only: SGR colour/bold/underline become spans, other
     * escapes are dropped. (In pty mode xterm does all of this properly.)
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
          var other = /^\\u001b[\\[\\]][0-9;?]*[a-zA-Z]?/.exec(text.slice(i));
          i += other ? other[0].length : 1;
          continue;
        }
        if (ch === "\\r") { i++; continue; }
        out += esc(ch);
        i++;
      }
      out += closeSpan();
      openRef.cls = cls;
      return out;
    }
    function runCmd(cmd){
      var t = curTerm(); if (!t) return;
      termAppend(t, '<div><span class="pl">' + esc(shortCwd(t.cwd)) + " <b>❯</b></span> " +
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
        // The shell prints its prompt the moment it spawns — before the open
        // response lands and the renderer is mounted. Hold anything that
        // arrives in that window instead of dropping it on the floor.
        if (!t.xterm && !t.body) { t.pendingOut = (t.pendingOut || "") + frame.chunk; return; }
        if (t.xterm) { t.xterm.write(frame.chunk); return; }
        if (!t.ansi) t.ansi = { cls: [] };
        termAppend(t, ansiToHtml(String(frame.chunk), t.ansi));
        return;
      }
      if (frame.title && t.xterm) return; // xterm reports its own title
      if (frame.exit !== undefined) {
        t.busy = false;
        if (frame.cwd) t.cwd = frame.cwd;
        var code = Number(frame.exit);
        if (code !== 0) termAppend(t, '<div class="exbad">└ exit ' + code + "</div>");
        drawTermTabs(); drawPrompt();
      }
      if (frame.closed) {
        t.busy = false;
        if (t.xterm) t.xterm.write("\\r\\n\\u001b[2m└ shell exited\\u001b[0m\\r\\n");
        else termAppend(t, '<div class="ex">└ shell exited</div>');
        drawTermTabs(); drawPrompt();
      }
    }
    if (desktop) {
      document.getElementById("termhide").onclick = function(){ localStorage.setItem(TERM_KEY, "0"); applyTerm(); };
      document.getElementById("termadd").onclick = function(){ addTerm(); };
      var tin = document.getElementById("terminput");
      tin.addEventListener("keydown", function(e){
        var t = curTerm(); if (!t) return;
        if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
          if (!String(window.getSelection() || "")) { e.preventDefault(); interruptTerm(); }
          return;
        }
        if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
          e.preventDefault(); t.html = ""; t.ansi = { cls: [] }; if (t.body) t.body.innerHTML = ""; return;
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
        if (cmd === "clear") { t.html = ""; t.ansi = { cls: [] }; if (t.body) t.body.innerHTML = ""; return; }
        runCmd(cmd);
      });
      var rz = document.getElementById("termresize");
      rz.addEventListener("mousedown", function(ev){
        ev.preventDefault();
        var dock = document.getElementById("termdock");
        var startY = ev.clientY, startH = dock.offsetHeight;
        document.body.classList.add("resizing-x");
        function mv(e){
          dock.style.height = Math.max(110, Math.min(window.innerHeight * 0.7, startH + (startY - e.clientY))) + "px";
          fitActive();
        }
        function up(){
          document.body.classList.remove("resizing-x");
          localStorage.setItem("loomTermH", String(dock.offsetHeight));
          fitActive();
          document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
        }
        document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
      });
      var savedH = Number(localStorage.getItem("loomTermH"));
      if (savedH) document.getElementById("termdock").style.height = savedH + "px";
      window.addEventListener("resize", fitActive);
      state.toggleTerm = toggleTerm;
      state.retheme = function(){
        terms.forEach(function(t){ if (t.xterm) t.xterm.options.theme = xtermTheme(); });
      };
      // Run a command in the terminal, opening the dock (and a shell) first if
      // need be — the palette's "cd into a worktree" and the status bar's
      // "Connect GitHub" both drive gh/git through the real terminal you already
      // have, rather than reimplementing an interactive login.
      state.termRun = function(cmd){
        var live = termOpen() && curTerm();
        if (!termOpen()) toggleTerm(); else ensureTerm();
        var fire = function(){
          var t = curTerm(); if (!t) return;
          if (t.xterm) {
            // pty: type the line and press Enter (\\r); the shell runs it
            api("/api/projects/" + pid + "/term/input",
                { method: "POST", body: JSON.stringify({ term: t.id, data: cmd + "\\r" }) }).catch(function(){});
          } else {
            runCmd(cmd); // pipe-backed shell: one command per line
          }
          focusTerm();
        };
        // a shell we just spawned needs a beat before it will accept input
        if (live) fire(); else setTimeout(fire, 650);
      };
      // NB: applyTerm() runs after connect() below — opening a shell before
      // the socket is listening broadcasts its prompt to nobody.
      state.startTerminals = applyTerm;
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
    // Which kind of memory the Brain tab is filtered to ("" = all).
    var brainKind = "";
    var BRAIN_KINDS = ["constraint", "failure", "decision", "convention", "fact", "task"];

    function refreshBrain(){
      var el = document.getElementById("pane-brain"); if (!el) return;
      if (!el.querySelector(".brain")) el.innerHTML = '<div class="pane-inner">' + LOADER + "</div>";
      // Two reads: the learned memory units (the star), and the imported ADE
      // sources (context — what Loom pulled in from CLAUDE.md and friends).
      Promise.all([
        api("/api/projects/" + pid + "/brain?limit=200"),
        api("/api/projects/" + pid + "/memory").catch(function(){ return { memory: {} }; }),
      ]).then(function(r){
        el = document.getElementById("pane-brain"); if (!el) return;
        var memories = (r[0] && r[0].memories) || [];
        var stats = (r[0] && r[0].stats) || { total: 0, byKind: {} };
        var m = (r[1] && r[1].memory) || {};
        var sources = m.sources || [];

        // Filter chips — All, then each kind that has memories, with its count.
        var chips = '<button class="bkind' + (brainKind === "" ? " on" : "") + '" data-kind="">All <span class="kn">' + (stats.total || 0) + "</span></button>";
        BRAIN_KINDS.forEach(function(k){
          var n = (stats.byKind && stats.byKind[k]) || 0;
          if (!n && brainKind !== k) return; // hide empty kinds unless selected
          chips += '<button class="bkind bk-' + k + (brainKind === k ? " on" : "") + '" data-kind="' + k + '">' + k + ' <span class="kn">' + n + "</span></button>";
        });
        var head = '<div class="bhead"><div class="bkinds">' + chips + "</div></div>";

        // The memory list — the learned units. This is what phase 2 fills.
        var shown = brainKind ? memories.filter(function(x){ return x.kind === brainKind; }) : memories;
        var list;
        if (!shown.length) {
          list = '<div class="bempty">' + (memories.length
            ? "No " + esc(brainKind) + " memories yet."
            : "Nothing learned yet. As agents finish turns, Loom reads each one and records what's worth keeping — constraints, decisions, and the failures worth not repeating. Add a decision below to seed it, or let an agent take a turn.") + "</div>";
        } else {
          list = '<div class="bmems">' + shown.map(function(x){
            var ents = (x.entities || []).slice(0, 6).map(function(e){ return '<span class="bent">' + esc(e) + "</span>"; }).join("");
            var conf = Math.round((x.confidence == null ? 1 : x.confidence) * 100);
            var who = (x.provenance && x.provenance.agentId) || "user";
            var when = x.updatedAt ? rel(x.updatedAt) : "";
            var low = conf < 60;
            return '<div class="bmem' + (low ? " low" : "") + '" data-mid="' + esc(x.id) + '">' +
              '<div class="bmrow"><span class="bbadge bk-' + esc(x.kind) + '">' + esc(x.kind) + "</span>" +
              '<span class="bmtext">' + esc(x.text) + "</span>" +
              '<button class="bforget iconbtn xs" data-forget="' + esc(x.id) + '" title="forget this" aria-label="forget this memory">' + ICONS.x + "</button></div>" +
              (ents ? '<div class="bents">' + ents + "</div>" : "") +
              '<div class="bmmeta">' + brandMark(kindOf(who)) + esc(who) +
              (when ? ' <span class="dim">\\u00b7 ' + esc(when) + "</span>" : "") +
              (low ? ' <span class="dim">\\u00b7 ' + conf + '% \\u2014 shown, not injected</span>' : "") +
              "</div></div>";
          }).join("") + "</div>";
        }

        // Seed box — a decision you type. It dual-writes into the brain, so it's
        // the manual counterpart to what the extractor does automatically.
        var seed = '<form class="bseed" id="decform">' +
          '<input id="decbox" placeholder="Record a decision or fact this project has made\\u2026" autocomplete="off">' +
          '<button class="btn primary sm" type="submit">Add</button></form>';

        // Imported ADE memory — secondary, folded under a quiet header.
        var src = '<div class="bsec">Imported from your agents<span class="bhint">their own memory files</span>' +
          '<button class="lnk" id="reimport" style="margin-left:auto">re-import</button></div>';
        src += sources.length
          ? '<div class="bsrcs">' + sources.map(function(s){
              return '<div class="bsrc">' + brandMark(s.kind) +
                '<span class="si">' + esc(s.agentId) + "</span>" +
                '<span class="sf mono">' + esc(s.file) + "</span>" +
                '<span class="sc">' + Math.round(s.chars / 1024 * 10) / 10 + "k</span></div>";
            }).join("") + "</div>"
          : '<div class="bempty sm">No native ADE memory found (CLAUDE.md, AGENTS.md, .kiro/steering). Loom reads these but never writes to them.</div>';

        el.innerHTML = '<div class="pane-inner brain">' + head + seed + list + src + "</div>";

        Array.prototype.forEach.call(el.querySelectorAll(".bkind"), function(b){
          b.onclick = function(){ brainKind = b.getAttribute("data-kind"); refreshBrain(); };
        });
        Array.prototype.forEach.call(el.querySelectorAll("[data-forget]"), function(b){
          b.onclick = function(ev){
            ev.stopPropagation();
            var id = b.getAttribute("data-forget");
            var reason = window.prompt("Forget this memory — why? (kept in history)", "no longer true");
            if (reason === null) return;
            api("/api/projects/" + pid + "/brain/" + id + "?reason=" + encodeURIComponent(reason.trim() || "forgotten"), { method: "DELETE" })
              .then(function(){ toast("forgotten \\u00b7 its history stays"); refreshBrain(); })
              .catch(function(err){ toast(err.message); });
          };
        });
        var reimp = document.getElementById("reimport");
        if (reimp) reimp.onclick = function(){
          api("/api/projects/" + pid + "/memory/import", { method: "POST", body: "{}" })
            .then(function(rr){ toast(rr.imported ? "imported " + rr.imported + " source(s)" : "already current"); refreshBrain(); })
            .catch(function(err){ toast(err.message); });
        };
        document.getElementById("decform").onsubmit = function(ev){
          ev.preventDefault();
          var box = document.getElementById("decbox");
          var text = (box.value || "").trim();
          if (!text) return;
          api("/api/projects/" + pid + "/decisions", { method: "POST", body: JSON.stringify({ text: text }) })
            .then(function(){ box.value = ""; refreshBrain(); })
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
      function start(){
        var task = (document.getElementById("rtask").value || "").trim();
        if (!task) return toast("describe the task first");
        var spec = sel.value === "__custom" ? (document.getElementById("rsteps").value || "").trim() : sel.value;
        if (!spec) return toast("give steps like planner,executor");
        api("/api/projects/" + pid + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: spec }) })
          .then(function(){ refresh(); toast("route started"); if (after) after(); })
          .catch(function(err){ toast(err.message); });
      }
      document.getElementById("rgo").onclick = start;
      // Enter submits from either field, like every other input in the app
      ["rtask", "rsteps"].forEach(function(id){
        var el = document.getElementById(id); if (!el) return;
        el.onkeydown = function(e){ if (e.key === "Enter") { e.preventDefault(); start(); } };
      });
    }
    // ---- board pane ---------------------------------------------------------
    // Cards are derived from live state (see board.ts): which agents are
    // running or blocked, and what GitHub says about each PR. Nothing here is
    // stored except your pins.
    var board = { data: null, loading: false, pins: null, q: "",
                  // GitHub | Projects (GH Projects v2) | Linear — one board, three sources
                  source: "github",
                  ghProjects: null, ghProject: null, ghItems: null, ghItemsLoading: false,
                  linear: null, linearTeams: null, linearLoading: false };
    var BCOLS = [
      ["working", "Working", "var(--warn)"],
      ["needs-you", "Needs you", "var(--warn)"],
      ["in-review", "In review", "var(--muted-foreground)"],
      ["ready", "Ready to merge", "var(--ok)"],
    ];
    // your card's badge follows the column you put it in — mirrors board.ts
    var OWN_STATE = { "working": "working", "needs-you": "input-needed",
                      "in-review": "review-pending", "ready": "ready" };
    var BSTATES = {
      "working": ["Working", "var(--warn)"],
      "input-needed": ["Input needed", "var(--warn)"],
      "issue": ["Open issue", "var(--thread-ink)"],
      "ci-failed": ["CI failed", "var(--err)"],
      "changes-requested": ["Changes requested", "var(--warn)"],
      "review-pending": ["Review pending", "var(--muted-foreground)"],
      "draft": ["Draft PR", "var(--muted-foreground)"],
      "approved": ["Approved", "var(--ok)"],
      "ready": ["Ready", "var(--ok)"],
    };
    var PINKEY = "loomBoardPins:" + pid;
    function boardPins(){
      if (board.pins) return board.pins;
      try { board.pins = JSON.parse(localStorage.getItem(PINKEY) || "{}"); }
      catch (e) { board.pins = {}; }
      return board.pins;
    }
    function savePins(){ try { localStorage.setItem(PINKEY, JSON.stringify(board.pins || {})); } catch (e) {} }
    function loadBoard(){
      board.loading = true;
      drawBoardPane();
      api("/api/projects/" + pid + "/board" + (board.q ? "?search=" + encodeURIComponent(board.q) : ""))
        .then(function(r){ board.data = r; board.loading = false; drawBoardPane(); })
        .catch(function(err){
          board.data = { available: false, reason: "error", detail: err.message };
          board.loading = false; drawBoardPane();
        });
    }
    // One board, three sources. GitHub is the live kanban; Projects browses the
    // owner's GitHub Project boards; Linear lists and files issues.
    function boardSourceBar(){
      var srcs = [["github", "GitHub", ICONS.github], ["projects", "Projects", ICONS.board], ["linear", "Linear", ICONS.linear]];
      return '<div class="bsrc" role="tablist">' + srcs.map(function(s){
        return '<button class="bsrcb' + (board.source === s[0] ? " on" : "") + '" data-src="' + s[0] +
          '" type="button" role="tab" aria-selected="' + (board.source === s[0]) + '">' + s[2] + "<span>" + s[1] + "</span></button>";
      }).join("") + "</div>";
    }
    function wireSourceBar(){
      Array.prototype.forEach.call(document.querySelectorAll("#pane-board [data-src]"), function(b){
        b.onclick = function(){
          var s = b.getAttribute("data-src");
          if (s === board.source) return;
          board.source = s; board.ghProject = null;
          drawBoardPane();
          if (s === "github" && !board.data) loadBoard();
          else if (s === "projects" && !board.ghProjects) loadGhProjects();
          else if (s === "linear" && (!board.linear || !board.linearTeams)) loadLinear();
        };
      });
    }
    function drawBoardPane(){
      if (board.source === "projects") return drawProjectsView();
      if (board.source === "linear") return drawLinearView();
      drawGithubBoard();
    }
    function drawGithubBoard(){
      var el = document.getElementById("pane-board"); if (!el) return;
      var d = board.data;
      var head = '<div class="bhead">' + boardSourceBar() +
        '<span class="spacer"></span>' +
        // gh's own query language, straight through — same box the Tasks tab had
        '<div class="qbox bq">' + ICONS.search +
          '<input id="bq" value="' + esc(board.q) + '" spellcheck="false" autocomplete="off"' +
          ' placeholder="search issues and PRs \\u2014 is:pr is:open author:@me" aria-label="search issues and PRs"></div>' +
        '<button class="btn outline xs" id="bnew" title="add a card of your own">+ Task</button>' +
        '<button class="iconbtn' + (board.loading ? " spin" : "") + '" id="brefresh" title="refresh" aria-label="refresh">' + ICONS.refresh + "</button></div>";
      // Wire the head even while loading: the gh round-trip is slow enough that
      // a dead search box is dead for exactly as long as anyone would use it.
      if (!d) {
        el.innerHTML = '<div class="boardview">' + head + LOADER + "</div>";
        wireBoardHead();
        return;
      }
      if (!d.available) {
        el.innerHTML = '<div class="boardview">' + head +
          '<div class="tsetup"><div class="th">Couldn\\u2019t build the board</div>' +
          '<div class="td">' + esc(d.detail) + "</div></div></div>";
        wireBoardHead();
        return;
      }

      var pins = boardPins();
      var cards = (d.cards || []).slice();
      // a pin only moves a card; it never edits what the card reports
      cards.forEach(function(c){ c.shown = pins[c.id] || c.column; });

      var cols = BCOLS.map(function(col){
        var key = col[0];
        var mine = cards.filter(function(c){ return c.shown === key; });
        return '<div class="bcol" data-col="' + key + '">' +
          '<div class="bch"><span class="bdot" style="background:' + col[2] + '"></span>' + esc(col[1]) +
            '<span class="bn">' + mine.length + "</span></div>" +
          '<div class="bcb" data-drop="' + key + '">' +
            (mine.length ? mine.map(boardCard).join("") : '<div class="bempty">nothing here</div>') +
            '<button class="badd" data-add="' + key + '" title="add a card here">+</button>' +
          "</div></div>";
      }).join("");

      el.innerHTML = '<div class="boardview">' + head +
        '<div class="bcols">' + cols + "</div>" +
        (d.ghError
          ? '<div class="bnote">' + ICONS.info + " Pull requests aren\\u2019t shown: " + esc(d.ghError.detail) + "</div>"
          : "") +
        "</div>";
      wireBoardHead();
      wireBoardDnd();
      wireBoardTasks(el);
    }
    function boardCard(c){
      var st = BSTATES[c.state] || [c.state, "var(--muted-foreground)"];
      var pinned = (board.pins || {})[c.id];
      // Review a PR, or open a worktree from any task — the "no context switch"
      // half of the board. A PR worktree checks the branch out for you (forks
      // included); an issue worktree cuts a fresh branch to start it.
      var acts = "";
      if (c.pr) {
        acts = '<div class="bca">' +
          '<button class="btn outline xs" data-review="' + c.pr.number + '" data-rtitle="' + esc(c.title) + '">Review</button>' +
          '<button class="btn ghost xs" data-wtpr="' + c.pr.number + '" title="open a worktree on this PR\\u2019s branch">' + ICONS.branch + " Worktree</button></div>";
      } else if (c.issue) {
        acts = '<div class="bca"><button class="btn ghost xs" data-wtissue="' + c.issue.number +
          '" title="cut a fresh branch for this issue in its own worktree">' + ICONS.branch + " Worktree</button></div>";
      }
      return '<div class="bcard' + (c.own ? " own" : "") + '" draggable="true" data-card="' + esc(c.id) +
        '" data-home="' + esc(c.column) + '"' + (c.own ? ' data-own="1"' : "") + ">" +
        '<div class="bcr1"><span class="bdot" style="background:' + st[1] + '"></span>' +
          '<span class="st" style="color:' + st[1] + '">' + esc(st[0]) + "</span>" +
          '<span class="who">' + brandMark(c.kind) + esc(c.agent || "\\u2014") + "</span></div>" +
        '<div class="bct"' + (c.own ? ' data-edit="' + esc(c.id) + '" title="click to edit"' : "") + ">" +
          esc(c.title) + "</div>" +
        (c.branch ? '<div class="bcbr">' + esc(c.branch) + "</div>" : "") +
        '<div class="bcf">' +
          (c.own
            ? "yours"
            : c.pr
              ? '<a href="' + esc(c.pr.url) + '" target="_blank" rel="noreferrer">PR #' + c.pr.number + "</a> \\u00b7 " +
                esc(c.pr.draft ? "draft" : c.pr.state)
              : c.issue
                ? '<a href="' + esc(c.issue.url) + '" target="_blank" rel="noreferrer">#' + c.issue.number + "</a>" +
                  '<button class="btn outline xs bstart" data-start="' + c.issue.number +
                  '" title="hand this issue to an agent">Start \\u2192</button>'
                : "no PR yet") +
          (c.own
            ? '<button class="bpin del" data-deltask="' + esc(c.id) + '" title="delete this card" aria-label="delete card">' + ICONS.x + "</button>"
            : pinned
              ? '<span class="bpin" data-unpin="' + esc(c.id) + '" title="you moved this card \\u2014 click to let its real state place it">pinned</span>'
              : "") +
        "</div>" + acts + "</div>";
    }
    function wireBoardHead(){
      wireSourceBar();
      var r = document.getElementById("brefresh");
      if (r) r.onclick = loadBoard;
      var q = document.getElementById("bq");
      if (q) q.onkeydown = function(e){
        if (e.key !== "Enter") return;
        e.preventDefault();
        board.q = this.value.trim();
        loadBoard();
      };
      var n = document.getElementById("bnew");
      if (n) n.onclick = function(){ addTask("working"); };
      // add straight into a column — including Ready, if that's where it is
      Array.prototype.forEach.call(document.querySelectorAll("[data-add]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); addTask(b.getAttribute("data-add")); };
      });
    }
    /** A card of your own — same modal as Create task, minus the ceremony. */
    function addTask(column){
      openBoardTaskModal(pid, column, loadBoard);
    }
    function wireBoardTasks(el){
      // retitle in place — it's your card
      Array.prototype.forEach.call(el.querySelectorAll("[data-edit]"), function(t){
        t.onclick = function(ev){
          ev.stopPropagation();
          if (t.querySelector("input")) return;
          var id = t.getAttribute("data-edit");
          var was = t.textContent;
          var inp = document.createElement("input");
          inp.className = "bcedit";
          inp.value = was;
          inp.maxLength = 200;
          t.textContent = "";
          t.appendChild(inp);
          inp.focus(); inp.select();
          var done = false;
          function finish(save){
            if (done) return; done = true;
            var next = inp.value.trim();
            if (!save || !next || next === was) { drawBoardPane(); return; }
            api("/api/projects/" + pid + "/board/tasks/" + id.replace(/^task-/, ""),
                { method: "POST", body: JSON.stringify({ title: next }) })
              .then(function(){ loadBoard(); })
              .catch(function(err){ toast(err.message); drawBoardPane(); });
          }
          inp.onkeydown = function(e){
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            else if (e.key === "Escape") { e.preventDefault(); finish(false); }
          };
          inp.onblur = function(){ finish(true); };
          // a card is draggable; don't let selecting text start a drag
          inp.ondragstart = function(e){ e.preventDefault(); e.stopPropagation(); };
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-deltask]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var id = b.getAttribute("data-deltask");
          api("/api/projects/" + pid + "/board/tasks/" + id.replace(/^task-/, ""), { method: "DELETE" })
            .then(loadBoard)
            .catch(function(err){ toast(err.message); });
        };
      });
      // Start an issue — the same brief the Tasks tab used to draft, now here
      Array.prototype.forEach.call(el.querySelectorAll("[data-start]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var n = Number(b.getAttribute("data-start"));
          var card = (board.data.cards || []).filter(function(c){
            return c.issue && c.issue.number === n;
          })[0];
          if (!card) return;
          openTaskModal(pid, null,
            "issue #" + n + ": " + card.title + "\\n" + card.issue.url +
            "\\n\\nRead the issue, then implement it.");
        };
      });
      // Review a PR in-app
      Array.prototype.forEach.call(el.querySelectorAll("[data-review]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          openPrReview(Number(b.getAttribute("data-review")), b.getAttribute("data-rtitle") || "");
        };
      });
      // Open a worktree from a PR (checks the branch out) or an issue (fresh branch)
      Array.prototype.forEach.call(el.querySelectorAll("[data-wtpr]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); openWorktree(b, { pr: Number(b.getAttribute("data-wtpr")) }); };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-wtissue]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); openWorktree(b, { issue: Number(b.getAttribute("data-wtissue")) }); };
      });
    }

    /**
     * Open a worktree from a task and say where it landed. A worktree is a real
     * directory on the daemon host, so the honest confirmation is its path — you
     * cd there, or point a fresh Loom project at it.
     */
    function openWorktree(btn, body){
      if (btn) { btn.disabled = true; btn.textContent = "Opening\\u2026"; }
      api("/api/projects/" + pid + "/worktrees", { method: "POST", body: JSON.stringify(body) })
        .then(function(r){
          toast("worktree ready \\u00b7 " + (r.branch || r.source || "") + " \\u2192 " + r.path);
          loadBoard();
        })
        .catch(function(err){ toast(err.message); if (btn) { btn.disabled = false; btn.textContent = "Worktree"; } });
    }
    // ---- Projects (GitHub Projects v2), browsed in-app ----------------------
    function loadGhProjects(){
      board.ghProjects = null; drawProjectsView();
      api("/api/projects/" + pid + "/gh/projects")
        .then(function(r){ board.ghProjects = r; drawProjectsView(); })
        .catch(function(err){ board.ghProjects = { available: false, detail: err.message }; drawProjectsView(); });
    }
    function loadGhProjectItems(num){
      board.ghItems = null; board.ghItemsLoading = true; drawProjectsView();
      api("/api/projects/" + pid + "/gh/projects/" + num + "/items")
        .then(function(r){ board.ghItems = r; board.ghItemsLoading = false; drawProjectsView(); })
        .catch(function(err){ board.ghItems = { available: false, detail: err.message }; board.ghItemsLoading = false; drawProjectsView(); });
    }
    function drawProjectsView(){
      var el = document.getElementById("pane-board"); if (!el) return;
      var head = '<div class="bhead">' + boardSourceBar() + '<span class="spacer"></span>' +
        '<button class="iconbtn" id="brefresh" title="refresh" aria-label="refresh">' + ICONS.refresh + "</button></div>";
      var d = board.ghProjects, body;
      if (board.ghProject) body = drawProjectItems();
      else if (!d) body = LOADER;
      else if (!d.available) body = '<div class="tsetup"><div class="th">Couldn\\u2019t list projects</div><div class="td">' + esc(d.detail) + "</div></div>";
      else if (!d.projects.length) body = '<div class="bempty2">No GitHub Projects for ' + esc(d.owner) + " yet.</div>";
      else body = '<div class="prjlist">' + d.projects.map(function(p){
        return '<button class="prjrow" data-prj="' + p.number + '" data-prjt="' + esc(p.title) + '">' +
          ICONS.board + '<span class="prjt">' + esc(p.title) + "</span>" +
          '<span class="prjn">' + p.items + " item" + (p.items === 1 ? "" : "s") + "</span>" +
          '<a class="prja" href="' + esc(p.url) + '" target="_blank" rel="noreferrer" title="open on GitHub">' + ICONS.external + "</a></button>";
      }).join("") + "</div>";
      el.innerHTML = '<div class="boardview">' + head + body + "</div>";
      wireBoardHead();
      Array.prototype.forEach.call(el.querySelectorAll("[data-prj]"), function(b){
        b.onclick = function(ev){
          if (ev.target.closest(".prja")) return; // the GitHub link is its own action
          board.ghProject = { number: Number(b.getAttribute("data-prj")), title: b.getAttribute("data-prjt") };
          loadGhProjectItems(board.ghProject.number);
        };
      });
      var back = document.getElementById("prjback");
      if (back) back.onclick = function(){ board.ghProject = null; board.ghItems = null; drawProjectsView(); };
    }
    function drawProjectItems(){
      var pr = board.ghProject;
      var head2 = '<div class="prjhead"><button class="btn ghost xs" id="prjback">' + ICONS.chevronLeft + " Projects</button>" +
        '<span class="prjtitle">' + esc(pr.title) + "</span></div>";
      var d = board.ghItems;
      if (board.ghItemsLoading || !d) return head2 + LOADER;
      if (!d.available) return head2 + '<div class="tsetup"><div class="td">' + esc(d.detail) + "</div></div>";
      var items = d.items || [];
      if (!items.length) return head2 + '<div class="bempty2">This project has no items.</div>';
      var groups = {}, order = [];
      items.forEach(function(it){ if (!groups[it.status]) { groups[it.status] = []; order.push(it.status); } groups[it.status].push(it); });
      var cols = order.map(function(s){
        return '<div class="bcol"><div class="bch">' + esc(s) + '<span class="bn">' + groups[s].length + "</span></div>" +
          '<div class="bcb">' + groups[s].map(function(it){
            var tag = it.type === "PullRequest" ? "PR #" + (it.number || "") : it.type === "Issue" ? "#" + (it.number || "") : "note";
            return '<div class="bcard"><div class="bct">' + esc(it.title) + "</div><div class=\\"bcf\\">" +
              (it.url ? '<a href="' + esc(it.url) + '" target="_blank" rel="noreferrer">' + esc(tag) + "</a>" : '<span class="who">' + esc(tag) + "</span>") + "</div></div>";
          }).join("") + "</div></div>";
      }).join("");
      return head2 + '<div class="bcols pcols">' + cols + "</div>";
    }

    // ---- Linear — list issues, and file a new one with a team selector ------
    function loadLinear(){
      board.linearLoading = true; drawLinearView();
      Promise.all([
        api("/api/projects/" + pid + "/linear/teams").catch(function(e){ return { available: false, detail: e.message }; }),
        api("/api/projects/" + pid + "/linear/issues").catch(function(e){ return { available: false, detail: e.message }; }),
      ]).then(function(res){
        board.linearTeams = res[0]; board.linear = res[1]; board.linearLoading = false; drawLinearView();
      });
    }
    function drawLinearView(){
      var el = document.getElementById("pane-board"); if (!el) return;
      var configured = board.linearTeams && board.linearTeams.available;
      var head = '<div class="bhead">' + boardSourceBar() + '<span class="spacer"></span>' +
        (configured ? '<button class="btn primary xs" id="lnew">+ New issue</button>' : "") +
        '<button class="iconbtn" id="brefresh" title="refresh" aria-label="refresh">' + ICONS.refresh + "</button></div>";
      var body;
      if (board.linearLoading || (!board.linearTeams && !board.linear)) body = LOADER;
      else if (!configured) {
        var det = (board.linearTeams && board.linearTeams.detail) || "Set LINEAR_API_KEY to enable Linear.";
        body = '<div class="tsetup"><div class="th">Linear isn\\u2019t connected</div>' +
          '<div class="td">' + esc(det) + "</div>" +
          '<code class="scmd">export LINEAR_API_KEY=lin_api_\\u2026\\nloom up --restart</code>' +
          '<div class="td" style="margin-top:8px">Loom reads the key from its own environment and never stores it \\u2014 the same bet it makes with the GitHub CLI.</div></div>';
      } else {
        var issues = (board.linear && board.linear.available) ? board.linear.issues : [];
        body = issues.length
          ? '<div class="lnlist">' + issues.map(function(it){
              return '<a class="lnrow" href="' + esc(it.url) + '" target="_blank" rel="noreferrer">' +
                '<span class="lnid">' + esc(it.identifier) + "</span>" +
                '<span class="lnt">' + esc(it.title) + "</span>" +
                (it.state ? '<span class="lnst">' + esc(it.state) + "</span>" : "") + "</a>";
            }).join("") + "</div>"
          : '<div class="bempty2">No recent issues \\u2014 file one with + New issue.</div>';
      }
      el.innerHTML = '<div class="boardview">' + head + body + "</div>";
      wireBoardHead();
      var nb = document.getElementById("lnew");
      if (nb) nb.onclick = openLinearForm;
    }
    function openLinearForm(){
      if (document.querySelector(".scrim")) return;
      var teams = (board.linearTeams && board.linearTeams.teams) || [];
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal"><div class="modalhead">New Linear issue<button class="iconbtn" id="lx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="modalbody">' +
          '<div class="field"><label>Team</label><select id="lteam">' +
            teams.map(function(t){ return '<option value="' + esc(t.id) + '">' + esc(t.key) + " \\u00b7 " + esc(t.name) + "</option>"; }).join("") + "</select></div>" +
          '<div class="field"><label>Title</label><input id="ltitle" spellcheck="false" autocomplete="off" placeholder="what needs doing"></div>' +
          '<div class="field"><label>Description <span class="opt">optional</span></label><textarea id="ldesc" spellcheck="false" placeholder="details, acceptance criteria\\u2026"></textarea></div>' +
        "</div>" +
        '<div class="modalfoot"><button class="btn ghost" id="lcancel">Cancel</button><button class="btn primary" id="lcreate">Create issue</button></div></div>';
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
      function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
      document.addEventListener("keydown", onKey);
      scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
      document.getElementById("lx").onclick = close;
      document.getElementById("lcancel").onclick = close;
      setTimeout(function(){ var t = document.getElementById("ltitle"); if (t) t.focus(); }, 30);
      document.getElementById("lcreate").onclick = function(){
        var teamId = document.getElementById("lteam").value;
        var title = (document.getElementById("ltitle").value || "").trim();
        var desc = (document.getElementById("ldesc").value || "").trim();
        if (!title) return toast("give the issue a title");
        var btn = this; btn.disabled = true;
        api("/api/projects/" + pid + "/linear/issues", { method: "POST", body: JSON.stringify({ teamId: teamId, title: title, description: desc }) })
          .then(function(r){ close(); toast("created " + (r.issue ? r.issue.identifier : "issue")); loadLinear(); })
          .catch(function(err){ btn.disabled = false; toast(err.message); });
      };
    }

    /**
     * Review a PR without leaving the board: its diff, and the three things a
     * reviewer does — comment, request changes, approve. The review is posted
     * through the user's own gh, signed as them; approve asks first, because it
     * publishes to GitHub.
     */
    function openPrReview(num, title){
      if (document.querySelector(".scrim")) return;
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal prmodal"><div class="modalhead">Review PR #' + num +
        '<button class="iconbtn" id="prx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="modalbody prbody" id="prbody">' + LOADER + "</div>" +
        '<div class="modalfoot prfoot" id="prfoot"></div></div>';
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
      function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
      document.addEventListener("keydown", onKey);
      scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
      document.getElementById("prx").onclick = close;
      api("/api/projects/" + pid + "/prs/" + num).then(function(r){
        var bodyEl = document.getElementById("prbody");
        if (!r.available) { bodyEl.innerHTML = '<div class="snote">' + esc(r.detail) + "</div>"; return; }
        var p = r.pr;
        var dec = p.reviewDecision ? " \\u00b7 " + esc(p.reviewDecision.toLowerCase().replace(/_/g, " ")) : "";
        var meta = '<div class="prmeta"><div class="prttl">' + esc(p.title) + "</div>" +
          '<div class="prsub"><span class="prbr">' + esc(p.headRefName) + " \\u2192 " + esc(p.baseRefName) + "</span>" +
          " \\u00b7 " + esc(p.author) +
          ' \\u00b7 <span style="color:var(--git-add)">+' + p.additions + '</span> <span style="color:var(--git-del)">\\u2212' + p.deletions + "</span>" +
          " \\u00b7 " + p.changedFiles + " file" + (p.changedFiles === 1 ? "" : "s") + dec + "</div></div>";
        var diff = r.diff
          ? '<div class="dcode prdiff">' + renderDiffLines(r.diff.split("\\n")) + "</div>" +
            (r.diffCapped ? '<div class="prcap">\\u2026 diff truncated \\u2014 open on GitHub for the rest.</div>' : "")
          : '<div class="snote">No diff to show.</div>';
        bodyEl.innerHTML = meta + diff +
          '<textarea class="prcomment" id="prcomment" spellcheck="false" placeholder="Comment (required to request changes or comment)"></textarea>';
        var foot = document.getElementById("prfoot");
        foot.innerHTML = '<a class="btn ghost" href="' + esc(p.url) + '" target="_blank" rel="noreferrer">Open on GitHub</a><span class="spacer"></span>' +
          '<button class="btn outline" id="prcmt">Comment</button>' +
          '<button class="btn outline prdanger" id="prreq">Request changes</button>' +
          '<button class="btn primary" id="prapp">Approve</button>';
        function review(action){
          var body = (document.getElementById("prcomment").value || "").trim();
          if ((action === "request-changes" || action === "comment") && !body) return toast("add a comment first");
          if (action === "approve" && !window.confirm("Approve PR #" + num + "? This posts an approval to GitHub under your gh identity.")) return;
          Array.prototype.forEach.call(foot.querySelectorAll("button"), function(x){ x.disabled = true; });
          api("/api/projects/" + pid + "/prs/" + num + "/review", { method: "POST", body: JSON.stringify({ action: action, body: body }) })
            .then(function(){
              toast(action === "approve" ? "approved PR #" + num : action === "request-changes" ? "requested changes on #" + num : "commented on #" + num);
              close(); loadBoard();
            })
            .catch(function(err){ toast(err.message); Array.prototype.forEach.call(foot.querySelectorAll("button"), function(x){ x.disabled = false; }); });
        }
        document.getElementById("prapp").onclick = function(){ review("approve"); };
        document.getElementById("prreq").onclick = function(){ review("request-changes"); };
        document.getElementById("prcmt").onclick = function(){ review("comment"); };
      }).catch(function(err){
        var bodyEl = document.getElementById("prbody"); if (bodyEl) bodyEl.innerHTML = '<div class="snote">' + esc(err.message) + "</div>";
      });
    }

    /**
     * Drag to move a card. This pins it where you dropped it — it does not tell
     * GitHub anything. A PR is "ready" when a human approved it and CI passed,
     * and dragging a card can't make either true, so the badge keeps saying what
     * is actually so and the card just wears a "pinned" mark.
     */
    function wireBoardDnd(){
      var el = document.getElementById("pane-board"); if (!el) return;
      var dragging = null;
      Array.prototype.forEach.call(el.querySelectorAll(".bcard"), function(card){
        card.ondragstart = function(ev){
          dragging = card.getAttribute("data-card");
          card.classList.add("drag");
          ev.dataTransfer.effectAllowed = "move";
          // Firefox won't start a drag without payload
          ev.dataTransfer.setData("text/plain", dragging);
        };
        card.ondragend = function(){ card.classList.remove("drag"); dragging = null; };
      });
      Array.prototype.forEach.call(el.querySelectorAll(".bcb"), function(body){
        var col = body.closest(".bcol");
        body.ondragover = function(ev){ ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; col.classList.add("over"); };
        body.ondragleave = function(){ col.classList.remove("over"); };
        body.ondrop = function(ev){
          ev.preventDefault();
          col.classList.remove("over");
          var id = dragging || ev.dataTransfer.getData("text/plain");
          if (!id) return;
          var target = body.getAttribute("data-drop");
          var card = (board.data.cards || []).filter(function(c){ return c.id === id; })[0];
          if (!card) return;
          if (card.own) {
            // your card: the column IS its state, so this is a real move —
            // persisted, and it survives everyone else's refresh
            card.column = target;
            card.state = OWN_STATE[target] || "working";
            drawBoardPane();
            api("/api/projects/" + pid + "/board/tasks/" + id.replace(/^task-/, ""),
                { method: "POST", body: JSON.stringify({ column: target }) })
              .catch(function(err){ toast(err.message); loadBoard(); });
            return;
          }
          // derived card: we can move where you SEE it, not what it is
          var pins = boardPins();
          if (target === card.column) delete pins[id]; else pins[id] = target;
          savePins();
          drawBoardPane();
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-unpin]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          delete boardPins()[b.getAttribute("data-unpin")];
          savePins();
          drawBoardPane();
        };
      });
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
      if (state.railView === "tasks") return drawAgentsView(el);
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
    // Actions the module-level command palette (and status bar) drive back in.
    state.openFile = openFileFromTree;
    state.showTab = showTab;
    state.reloadBoard = loadBoard;
    state.showRail = function(view){ state.railView = view; drawRail(); };
    state.selectAgent = function(id){
      if (!id) return;
      state.selected = id;
      drawStatus();
      showTab("thread");
      var b = document.getElementById("box"); if (b) b.focus();
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
    /**
     * Search this project: its files, and its code.
     *
     * Finding a file by name was all of it, which is the half you need least —
     * you remember a line, not a filename. Two modes, one box; the mode you
     * chose persists, because whichever one you use, you use it repeatedly.
     */
    function drawSearch(el){
      railTitle('<span class="b">Search</span>');
      var mode = state.railSearchMode || "code";
      el.innerHTML = '<div class="rsearch">' +
        '<input id="rsearchi" placeholder="' + (mode === "code" ? "search the code…" : "find files by name…") + '" autocomplete="off" spellcheck="false"></div>' +
        '<div class="smodes">' +
        '<span class="lvl' + (mode === "code" ? " on" : "") + '" data-mode="code">Code</span>' +
        '<span class="lvl' + (mode === "files" ? " on" : "") + '" data-mode="files">Files</span>' +
        '<span style="flex:1"></span><span class="scount" id="scount"></span>' +
        "</div>" +
        '<div class="sres" id="sres"></div>' +
        '<div class="rempty" id="shint">' +
        (mode === "code" ? "type to search inside every file in this project" : "type to find files by name") +
        "</div>";
      var inp = document.getElementById("rsearchi");
      if (state.railSearchQ) inp.value = state.railSearchQ;
      var to;
      inp.oninput = function(){ state.railSearchQ = this.value; clearTimeout(to); to = setTimeout(runSearch, 220); };
      inp.onkeydown = function(e){ if (e.key === "Enter") { clearTimeout(to); runSearch(); } };
      Array.prototype.forEach.call(el.querySelectorAll("[data-mode]"), function(b){
        b.onclick = function(){
          state.railSearchMode = b.getAttribute("data-mode");
          drawRail();
        };
      });
      setTimeout(function(){ inp.focus(); }, 20);
      if (state.railSearchQ) runSearch();
    }

    function runSearch(){
      var q = (state.railSearchQ || "").trim();
      var res = document.getElementById("sres"); if (!res) return;
      var hint = document.getElementById("shint");
      var cnt = document.getElementById("scount");
      if (hint) hint.style.display = q ? "none" : "";
      if (cnt) cnt.textContent = "";
      if (!q) { res.innerHTML = ""; return; }
      res.innerHTML = '<div class="rempty">searching…</div>';

      if ((state.railSearchMode || "code") === "files") {
        api("/api/projects/" + pid + "/find?q=" + encodeURIComponent(q)).then(function(j){
          res = document.getElementById("sres"); if (!res) return;
          var m = j.matches || [];
          if (cnt) cnt.textContent = m.length ? m.length + (m.length === 200 ? "+" : "") + " files" : "";
          if (!m.length) { res.innerHTML = '<div class="rempty">no file names match “' + esc(q) + '”</div>'; return; }
          res.innerHTML = m.map(function(f){
            return '<div class="frow" data-open="' + esc(f) + '"><span class="fp">' + esc(f) + "</span></div>";
          }).join("");
          wireSearchRows(res);
        }).catch(function(e){ res.innerHTML = '<div class="rempty">' + esc(e.message) + "</div>"; });
        return;
      }

      api("/api/projects/" + pid + "/grep?q=" + encodeURIComponent(q)).then(function(j){
        res = document.getElementById("sres"); if (!res) return;
        var hits = j.hits || [];
        if (cnt) cnt.textContent = hits.length ? hits.length + (j.truncated ? "+" : "") + " hits" : "";
        if (!hits.length) { res.innerHTML = '<div class="rempty">nothing in this project contains “' + esc(q) + '”</div>'; return; }
        // Grouped by file: twenty hits in one file is one answer, not twenty.
        var byFile = {};
        var order = [];
        hits.forEach(function(h){
          if (!byFile[h.path]) { byFile[h.path] = []; order.push(h.path); }
          byFile[h.path].push(h);
        });
        res.innerHTML = order.map(function(f){
          var rows = byFile[f].map(function(h){
            return '<div class="hitrow" data-open="' + esc(f) + '" data-line="' + h.line + '">' +
              '<span class="hn">' + h.line + "</span>" +
              '<span class="ht">' + highlight(h.text, q) + "</span></div>";
          }).join("");
          return '<div class="hitfile"><span class="fp">' + esc(f) + '</span><span class="hc">' + byFile[f].length + "</span></div>" + rows;
        }).join("");
        wireSearchRows(res);
      }).catch(function(e){ res.innerHTML = '<div class="rempty">' + esc(e.message) + "</div>"; });
    }

    function wireSearchRows(res){
      Array.prototype.forEach.call(res.querySelectorAll("[data-open]"), function(row){
        row.onclick = function(){ openFileFromTree(row.getAttribute("data-open")); };
      });
    }


    function drawScm(el){
      railTitle('<span class="b">Source control</span>');
      var p = state.project, r = p && p.route;
      var g = state.git;
      var html = "";
      if (p && p.needsInput) {
        html += '<div class="railcard warnc"><div class="rt"><span class="dot hot"></span>needs input</div>' +
          '<div class="rm">' + esc(state.lastQuestion || (r && r.pendingQuestion) || "an agent is waiting for you") + "</div></div>";
      }
      if (r && (r.status === "running" || r.status === "waiting_human")) {
        html += '<div class="railcard threadc"><div class="rt">' + esc(r.name || "route") + " · " +
          (r.mode === "dynamic" ? "hop " + (r.current + 1) : "step " + (r.current + 1) + "/" + r.steps.length) +
          '</div><div class="rm">▸ ' + esc(r.steps[r.current] || "") + "</div></div>";
      }
      if (!g) { el.innerHTML = html + '<div class="rempty">loading…</div>'; refreshGit(); return; }
      if (!g.branch) {
        // Not a repo yet — offer to make one, rather than a dead end.
        el.innerHTML = html +
          '<div class="ginit"><div class="rempty">not a git repository</div>' +
          '<button class="btn primary sm" id="gitinit">' + ICONS.branch + " Initialise repository</button></div>";
        var ib = document.getElementById("gitinit");
        if (ib) ib.onclick = function(){
          ib.disabled = true;
          api("/api/projects/" + pid + "/git/init", { method: "POST", body: "{}" })
            .then(function(r){ toast("initialised on " + r.branch); refreshGit(); refreshTree(false); })
            .catch(function(e){ toast(e.message); ib.disabled = false; });
        };
        return;
      }

      // Branch and distance from upstream: "3 ahead" is the difference between
      // "I pushed" and "I thought I pushed". The branch name is a picker when
      // there's more than one; Push sets the upstream on the first push.
      var brs = state.gitBranches;
      var branchEl;
      if (brs && brs.all && brs.all.length > 1) {
        branchEl = '<select class="gbranchsel" id="gcheckout">' +
          brs.all.map(function(b){ return '<option value="' + esc(b) + '"' + (b === g.branch ? " selected" : "") + ">" + esc(b) + "</option>"; }).join("") +
          "</select>";
      } else {
        branchEl = '<span class="bn">' + esc(g.branch) + "</span>";
      }
      html += '<div class="gbranch">' + ICONS.branch + branchEl +
        (g.ahead ? '<span class="gcount">↑' + g.ahead + "</span>" : "") +
        (g.behind ? '<span class="gcount">↓' + g.behind + "</span>" : "") +
        (g.upstream ? "" : '<span class="gcount dim">no upstream</span>') +
        '<span style="flex:1"></span>' +
        '<button class="iconbtn xs" id="gitpush" title="push to the remote" aria-label="push">' + ICONS.up + "</button>" +
        "</div>";

      var staged = g.staged || [], unstaged = g.unstaged || [], untracked = g.untracked || [];
      var changeCount = staged.length + unstaged.length + untracked.length;

      // The commit box — always at the top, VS Code style: a message field with
      // a Generate button, then a full-width Commit with a split menu. Kept even
      // when the tree is clean, so the panel's shape doesn't jump around.
      html += '<div class="scmcommit">' +
        '<div class="scmmsgwrap">' +
        '<textarea id="gmsg" class="scmmsg" rows="1" placeholder="Message (\\u2318\\u21b5 to commit)"></textarea>' +
        '<button class="scmgen" id="gitgen" type="button" title="Draft a message from the staged diff">' + ICONS.spark + " Generate</button>" +
        "</div>" +
        '<div class="scmcommitrow">' +
        '<button class="btn primary scmcommitbtn" id="gcommitbtn"' + (staged.length ? "" : " disabled") + '>Commit' + (staged.length ? " " + staged.length : "") + "</button>" +
        '<button class="btn primary scmsplit" id="gcommitmore" type="button" aria-label="more commit actions">' + ICONS.chevron + "</button>" +
        "</div></div>";

      if (!changeCount) {
        html += '<div class="rempty">No changes — the working tree is clean.</div>';
        el.innerHTML = html + gitLogHtml();
        wireGitRows(el);
        return;
      }

      // One file row, VS Code style: name (with dimmed directory), hover actions,
      // and the porcelain status letter as a coloured badge on the right.
      function fileRow(f, kind){
        var st = String(f.status || "?").trim() || "?";
        var pth = f.path, base = pth.split("/").pop(), dir = pth.slice(0, pth.length - base.length);
        var letter = st === "?" ? "U" : st.charAt(0);
        var bc = letter === "D" ? "del" : (letter === "U" || letter === "A" ? "add" : "mod");
        return '<div class="scmrow" data-file="' + esc(pth) + '" title="' + esc(pth) + '">' +
          '<span class="scmname" data-open="' + esc(pth) + '">' + (dir ? '<span class="scmdir">' + esc(dir) + "</span>" : "") + esc(base) + "</span>" +
          '<span class="scmacts">' +
          (kind === "staged"
            ? '<button class="iconbtn xs" data-unstage="' + esc(pth) + '" title="unstage" aria-label="unstage">' + ICONS.minus + "</button>"
            : '<button class="iconbtn xs" data-discard="' + esc(pth) + '" data-untracked="' + (kind === "untracked" ? "1" : "") + '" title="discard changes" aria-label="discard changes">' + ICONS.refresh + "</button>" +
              '<button class="iconbtn xs" data-stage="' + esc(pth) + '" title="stage" aria-label="stage">' + ICONS.plus + "</button>") +
          "</span>" +
          '<span class="scmbadge ' + bc + '" title="' + esc(st) + '">' + esc(letter) + "</span>" +
          "</div>";
      }

      if (staged.length) {
        html += '<div class="scmsec">Staged Changes<span class="scmn">' + staged.length + "</span>" +
          '<button class="lnk" id="unstageall">' + ICONS.minus + "</button></div>";
        html += '<div class="scmlist">' + staged.map(function(f){ return fileRow(f, "staged"); }).join("") + "</div>";
      }
      if (unstaged.length) {
        html += '<div class="scmsec">Changes<span class="scmn">' + unstaged.length + "</span>" +
          '<button class="lnk" id="stageall">' + ICONS.plus + "</button></div>";
        html += '<div class="scmlist">' + unstaged.map(function(f){ return fileRow(f, "unstaged"); }).join("") + "</div>";
      }
      if (untracked.length) {
        html += '<div class="scmsec">Untracked<span class="scmn">' + untracked.length + "</span>" +
          '<button class="lnk" id="stageuntracked">' + ICONS.plus + "</button></div>";
        html += '<div class="scmlist">' + untracked.map(function(f){ return fileRow({ path: f, status: "?" }, "untracked"); }).join("") + "</div>";
      }
      el.innerHTML = html + gitLogHtml();
      wireGitRows(el);
    }

    /** The commit history, newest first — shown at the foot of the SCM panel. */
    function gitLogHtml(){
      var log = state.gitLog || [];
      if (!log.length) return "";
      return '<div class="rsec gcommits-h">Commits</div>' +
        '<div class="gcommits">' + log.map(function(c){
          return '<div class="gclog" title="' + esc(c.sha) + '">' +
            '<span class="gcsha">' + esc(c.short) + "</span>" +
            '<span class="gcsub">' + esc(c.subject) + "</span>" +
            '<span class="gcmeta">' + esc(c.author) + " \\u00b7 " + esc(c.relative) + "</span></div>";
        }).join("") + "</div>";
    }

    /** Every control in the Source control view. */
    function wireGitRows(el){
      function act(path, body, said){
        return api("/api/projects/" + pid + "/git/" + path, { method: "POST", body: JSON.stringify(body) })
          .then(function(){ refreshGit(); if (said) toast(said); })
          .catch(function(e){ toast(e.message); });
      }
      Array.prototype.forEach.call(el.querySelectorAll("[data-stage]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); act("stage", { paths: [b.getAttribute("data-stage")] }); };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-unstage]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); act("unstage", { paths: [b.getAttribute("data-unstage")] }); };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-discard]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var f = b.getAttribute("data-discard");
          // The only control in Loom that destroys work, so it's the only one
          // that asks first.
          // The newline escape below is doubled. This whole file is one TS
          // template literal: a single backslash is eaten here and the browser
          // receives a real newline inside a string literal, which is a syntax
          // error that takes the entire app down — not just this button.
          // (Writing the un-doubled form even in THIS comment broke it once.)
          if (!confirm("Discard your changes to " + f + "?\\n\\nThis cannot be undone.")) return;
          var un = b.getAttribute("data-untracked") === "1";
          act("discard", un ? { untracked: [f] } : { paths: [f] }, "discarded " + f);
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-open]"), function(f){
        f.onclick = function(){ openChangesDock(f.getAttribute("data-open")); };
      });
      var sa = document.getElementById("stageall");
      if (sa) sa.onclick = function(){
        var g = state.git || {};
        var all = (g.unstaged || []).map(function(f){ return f.path; });
        if (all.length) act("stage", { paths: all });
      };
      var su = document.getElementById("stageuntracked");
      if (su) su.onclick = function(){
        var all = (state.git && state.git.untracked) || [];
        if (all.length) act("stage", { paths: all });
      };
      var ua = document.getElementById("unstageall");
      if (ua) ua.onclick = function(){
        var g = state.git || {};
        var all = (g.staged || []).map(function(f){ return f.path; });
        if (all.length) act("unstage", { paths: all });
      };

      // Commit box. The message is a textarea now; ⌘/Ctrl+Enter commits, and the
      // split button opens a small menu of the fuller actions.
      var msgbox = document.getElementById("gmsg");
      function autosizeMsg(){ if (!msgbox) return; msgbox.style.height = "auto"; msgbox.style.height = Math.min(160, msgbox.scrollHeight) + "px"; }
      if (msgbox) { msgbox.addEventListener("input", autosizeMsg); autosizeMsg(); }
      function doCommit(alsoStageAll, alsoPush){
        var msg = ((msgbox && msgbox.value) || "").trim();
        if (!msg) { toast("a commit needs a message"); if (msgbox) msgbox.focus(); return; }
        var btn = document.getElementById("gcommitbtn");
        if (btn) btn.disabled = true;
        var pre = Promise.resolve();
        if (alsoStageAll) {
          var g = state.git || {};
          var all = (g.unstaged || []).map(function(f){ return f.path; }).concat(g.untracked || []);
          if (all.length) pre = api("/api/projects/" + pid + "/git/stage", { method: "POST", body: JSON.stringify({ paths: all }) });
        }
        pre.then(function(){
          return api("/api/projects/" + pid + "/git/commit", { method: "POST", body: JSON.stringify({ message: msg }) });
        }).then(function(r){
          if (msgbox) { msgbox.value = ""; autosizeMsg(); }
          toast("committed " + r.sha + " · " + r.files + " file" + (r.files === 1 ? "" : "s"));
          if (alsoPush) {
            toast("pushing\\u2026");
            return api("/api/projects/" + pid + "/git/push", { method: "POST", body: "{}" })
              .then(function(pr){ toast("pushed " + pr.branch); });
          }
        }).then(function(){ refreshGit(); refreshTree(false); })
          .catch(function(e){ toast(e.message); })
          .then(function(){ if (btn) btn.disabled = false; });
      }
      var cbtn = document.getElementById("gcommitbtn");
      if (cbtn) cbtn.onclick = function(){ doCommit(false, false); };
      if (msgbox) msgbox.addEventListener("keydown", function(e){
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); doCommit((state.git && !state.git.staged.length) || false, false); }
      });
      var more = document.getElementById("gcommitmore");
      if (more) more.onclick = function(ev){
        ev.stopPropagation();
        openScmMenu(more, [
          { label: "Commit & Push", run: function(){ doCommit(false, true); } },
          { label: "Stage all & Commit", run: function(){ doCommit(true, false); } },
          { label: "Stage all, Commit & Push", run: function(){ doCommit(true, true); } },
        ]);
      };
      // Generate a commit message from the diff (the ✨ button).
      var gen = document.getElementById("gitgen");
      if (gen) gen.onclick = function(){
        gen.disabled = true; gen.classList.add("busy");
        api("/api/projects/" + pid + "/git/suggest-message", { method: "POST", body: "{}" })
          .then(function(r){ if (msgbox) { msgbox.value = r.message; autosizeMsg(); msgbox.focus(); } })
          .catch(function(e){ toast(e.message); })
          .then(function(){ gen.disabled = false; gen.classList.remove("busy"); });
      };
      // Push — network-bound, so show it working and surface git's own words.
      var pushBtn = document.getElementById("gitpush");
      if (pushBtn) pushBtn.onclick = function(){
        pushBtn.disabled = true;
        toast("pushing\\u2026");
        api("/api/projects/" + pid + "/git/push", { method: "POST", body: "{}" })
          .then(function(r){ toast("pushed " + r.branch); refreshGit(); })
          .catch(function(e){ toast(e.message); })
          .then(function(){ pushBtn.disabled = false; });
      };
      // Checkout — git refuses on its own if it would lose work; we relay that.
      var co = document.getElementById("gcheckout");
      if (co) co.onchange = function(){
        var ref = co.value;
        api("/api/projects/" + pid + "/git/checkout", { method: "POST", body: JSON.stringify({ ref: ref }) })
          .then(function(r){ toast("on " + r.branch); refreshGit(); refreshTree(false); })
          .catch(function(e){ toast(e.message); refreshGit(); });
      };
    }

    /** What git thinks, then redraw if that's what you're looking at. */
    function refreshGit(){
      return api("/api/projects/" + pid + "/git/status").then(function(g){
        state.git = g;
        if (state.railView === "scm") drawRail();
        // The log and branch list come alongside — cheap, and the panel shows
        // both. Failures are non-fatal: a repo with no commits has neither.
        if (g && g.branch) {
          api("/api/projects/" + pid + "/git/log?limit=30")
            .then(function(j){ state.gitLog = j.commits || []; if (state.railView === "scm") drawRail(); })
            .catch(function(){ state.gitLog = []; });
          api("/api/projects/" + pid + "/git/branches")
            .then(function(j){ state.gitBranches = j; if (state.railView === "scm") drawRail(); })
            .catch(function(){ state.gitBranches = null; });
        } else { state.gitLog = []; state.gitBranches = null; }
      }).catch(function(){ /* not a repo, or the daemon went away — drawScm says so */ });
    }


    // The agent roster. Keeps the internal "tasks" key so a persisted
    // loomRailView from an older build still resolves to a real view.
    function drawAgentsView(el){
      railTitle('<span class="b">Agents</span>');
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
      // The agents live here now — the sidebar belongs to the project's chats.
      // Agents work the whole project, not one conversation, so this is the
      // honest place for them.
      html += '<div class="rsec">Agents</div>';
      if (!adapters.length) html += '<div class="rempty">no agents configured</div>';
      else adapters.forEach(function(a){
        var hh = hue(a.id);
        var curA = a.id === state.selected;
        html += '<div class="frow agentrow' + (curA ? " cur" : "") + '" data-agent="' + esc(a.id) + '"' +
          ' title="click to aim your next message at ' + esc(a.id) + '">' +
          '<span class="adot' + (a.busy ? " busy" : "") + '"></span>' +
          brandMark(a.kind) +
          '<span class="fp" style="color:hsl(' + hh + ',55%,var(--agent-l))">' + esc(a.id) + "</span>" +
          (a.id === p.holder ? ' <span class="abadge">baton</span>' : "") +
          // your project decides what jobs exist — click and type
          '<span class="role edit" data-role-p="' + esc(pid) + '" data-role-a="' + esc(a.id) +
          '" title="click to rename this job">' + esc(a.role || "\\u2026") + "</span></div>";
      });
      var bridges = p ? p.agents.filter(function(a){ return a.tier === "bridge"; }) : [];
      bridges.forEach(function(a){
        html += '<div class="frow bridge" title="' + esc(a.id) +
          ' is a bridge \\u2014 Loom reads it, but it never holds the baton">' +
          '<span class="adot"></span>' + brandMark(a.kind) +
          '<span class="fp">' + esc(a.id) + '</span> <span class="abadge">bridge</span>' +
          '<span class="role" style="margin-left:auto">' + esc(a.role) + "</span>" +
          '<span class="gacts"><button class="iconbtn xs" data-remove="' + esc(a.id) +
          '" title="remove from this project">' + ICONS.x + "</button></span></div>";
      });
      // Add an agent. A project's roster used to be frozen at creation: install
      // a new ADE and your existing projects never heard of it, so a machine
      // with six agents had a board offering two. That looked like a bug in the
      // board; the board was telling the truth about a config that couldn't
      // learn.
      html += '<div class="rsec">Add<button class="lnk" id="agentrefresh">rescan</button></div>';
      html += '<div id="addagents"><div class="rempty">looking\\u2026</div></div>';

      el.innerHTML = html;
      document.getElementById("railnewtask").onclick = function(){ openTaskModal(pid); };
      Array.prototype.forEach.call(el.querySelectorAll(".frow[data-agent]"), function(row){
        row.onclick = function(ev){
          if (ev.target.closest("[data-remove]") || ev.target.closest(".role")) return;
          state.selected = row.getAttribute("data-agent");
          drawRail();
          drawStatus();
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-remove]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var id = b.getAttribute("data-remove");
          api("/api/projects/" + pid + "/agents/" + encodeURIComponent(id), { method: "DELETE" })
            .then(function(){
              toast(id + " removed \\u00b7 its history stays in the thread");
              state.avail = null;
              refreshProject();
            })
            .catch(function(e){ toast(e.message); });
        };
      });
      var rescan = document.getElementById("agentrefresh");
      if (rescan) rescan.onclick = function(){ state.avail = null; drawAddAgents(); };
      wireRoleEditors(el, function(){ drawRail(); });
      drawAddAgents();
    }

    /**
     * What you could add: every ADE Loom can drive that isn't in this project.
     *
     * Installed and in-project are different questions and the daemon answers
     * both — an ADE you haven't installed is offered greyed out with the reason,
     * because "Codex isn't in the list" and "Codex isn't installed" send you to
     * very different places.
     */
    function drawAddAgents(){
      var box = document.getElementById("addagents");
      if (!box) return;
      function render(){
        var list = (state.avail || []).filter(function(a){ return !a.inProject; });
        if (!list.length) {
          box.innerHTML = '<div class="rempty">every agent Loom can drive is already here</div>';
          return;
        }
        box.innerHTML = list.map(function(a){
          var can = a.installed !== false; // bridges report null: presence is live
          return '<div class="frow addrow' + (can ? "" : " off") + '" data-add="' + esc(a.kind) + '"' +
            ' title="' + (can ? "add " + esc(a.label) + " to this project" : esc(a.label) + " isn\\u2019t installed") + '">' +
            brandMark(a.kind) +
            '<span class="fp">' + esc(a.label) + "</span>" +
            (a.tier === "bridge" ? '<span class="abadge">bridge</span>' : "") +
            (can ? '<span class="gacts"><button class="iconbtn xs" title="add">' + ICONS.plus + "</button></span>"
                 : '<span class="role" style="margin-left:auto">not installed</span>') +
            "</div>";
        }).join("");
        Array.prototype.forEach.call(box.querySelectorAll(".addrow:not(.off)"), function(row){
          row.onclick = function(){
            var kind = row.getAttribute("data-add");
            api("/api/projects/" + pid + "/agents", { method: "POST", body: JSON.stringify({ kind: kind }) })
              .then(function(a){
                // The role is the kind until you say otherwise — a description,
                // not an opinion. Click it to name the job you actually have.
                toast(a.id + " added \\u00b7 click its role to name the job");
                state.avail = null;
                refreshProject();
              })
              .catch(function(e){ toast(e.message); });
          };
        });
      }
      if (state.avail) return render();
      api("/api/projects/" + pid + "/agents/available")
        .then(function(j){ state.avail = j.ades || []; render(); })
        .catch(function(){ box.innerHTML = '<div class="rempty">couldn\\u2019t ask the daemon what\\u2019s installed</div>'; });
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
          brandMark(a.kind) + esc(a.id) + ' <span class="role">' + esc(a.role) + (a.id === p.holder ? " \\u2190" : "") + "</span>" +
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

      // Send ⇄ stop. While an adapter is mid-turn the composer offers the
      // interrupt, in the one place you're already looking. Driven by the
      // agents' own busy flag rather than a local guess, so a turn you started
      // from your phone shows a stop here too.
      var anyBusy = adapters.some(function(a){ return a.busy; });
      var sendBtn = document.getElementById("send");
      var stopBtn = document.getElementById("stop");
      if (sendBtn && stopBtn) {
        sendBtn.style.display = anyBusy ? "none" : "";
        stopBtn.style.display = anyBusy ? "" : "none";
      }

      var hint = document.getElementById("hint");
      if (hint) hint.textContent = state.selected && state.selected !== p.holder
        ? "send will shift the baton to " + state.selected
        : (desktop ? "click the agent to switch \\u00b7 baton: " : "tap a chip to shift agents \\u00b7 baton: ") + (p.holder || "\\u2014");
      updateModelLabel(); // the picker button reflects whoever's selected now
      if (!desktop) drawChips();
      // agent header block — who the composer talks to, and where
      var ah = document.getElementById("agenthead");
      if (ah) {
        // Resolve over EVERY agent, bridges included — selecting Kiro or
        // Antigravity must show Kiro or Antigravity, not fall through to the
        // first adapter (which read as "the header says Claude").
        var wanted = state.selected || p.holder;
        var focus = null;
        (p.agents || []).forEach(function(a){ if (a.id === wanted) focus = a; });
        if (!focus) focus = adapters[0] || (p.agents || [])[0] || null;
        if (focus) {
          var hh = hue(focus.id);
          ah.innerHTML =
            // the agent's own logo when we have it; the hue monogram is only
            // for kinds with no mark (a custom adapter, echo)
            (hasBrand(focus.kind)
              ? '<span class="ag brandbox" title="' + esc(BRAND_TITLES[focus.kind]) + '">' + brandMark(focus.kind, "brand xl") + "</span>"
              : '<span class="ag" style="background:color-mix(in srgb, hsl(' + hh + ',60%,50%) 18%, transparent);color:hsl(' + hh + ',60%,var(--agent-l))">' + esc(focus.id.slice(0, 2)) + "</span>") +
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
    api("/api/projects/" + pid + "/events?limit=60&chat=" + encodeURIComponent(chatId))
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
      // Carry the bearer token in the subprotocol, not the URL — a query token
      // lands in browser history and proxy logs; a header does not.
      var ws = new WebSocket(proto + location.host + "/ws?project=" + encodeURIComponent(pid), ["loom.bearer." + state.token]);
      state.ws = ws;
      ws.onopen = function(){
        state.wsLive = true; drawStatusbar();
        // Open shells only once the socket is truly listening, or the pty's
        // first output (its prompt) is broadcast into the void. Runs once —
        // a reconnect must not spawn another set of terminals.
        var start = state.startTerminals;
        if (start) { state.startTerminals = null; start(); }
      };
      ws.onmessage = function(ev){
        try {
          var frame = JSON.parse(ev.data);
          if (frame.type === "term") { onTermFrame(frame); return; }
          // A log record belongs to no chat — a daemon fault has no
          // conversation, and it's the one you most need to see.
          if (frame.type === "log" && frame.record) { addLogRecord(frame.record); return; }
          if (frame.type === "event" && frame.event) {
            // one socket carries the whole project; this thread is one chat.
            // An event with no chat predates chats and belongs to main.
            if ((frame.event.chat || "main") !== chatId) return;
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

    // Attachments live here for the life of this project view. A pasted image
    // or dropped file is uploaded to .loom/attachments/ and referenced by path
    // in the outgoing message — the CLIs take text, not blobs, so the path IS
    // the attachment. Cleared after each send.
    var attach = [];

    function send(){
      var box = document.getElementById("box");
      var text = (box.value || "").trim();
      // A message can be pure attachments — "look at this" with an image.
      if (!text && !attach.length) return;
      if (attach.some(function(a){ return a.uploading; })) { toast("still uploading\\u2026"); return; }

      // Path references go first, so an agent reads the file before the ask.
      var refs = attach.map(function(a){
        return (a.kind === "image" ? "[image] " : "[file] ") + a.path;
      });
      var full = refs.length ? refs.join("\\n") + (text ? "\\n\\n" + text : "") : text;

      box.value = ""; autosizeBox(); attach = []; drawAttach();
      var p = state.project || {};

      // A bridge is driven, not handed a turn: Loom types into Antigravity's or
      // Kiro's own window and waits for the panel to settle. No handoff, because
      // it never takes the baton — whichever adapter holds it keeps it.
      var sel = (p.agents || []).filter(function(a){ return a.id === state.selected; })[0];
      if (sel && sel.tier === "bridge") {
        toast("typing into " + sel.id + "\\u2026");
        api("/api/projects/" + pid + "/bridge/" + encodeURIComponent(sel.id) + "/ask", {
          method: "POST", body: JSON.stringify({ text: full, chat: chatId }),
        }).then(function(){ refresh(); }).catch(function(err){
          // The bridge's own words ("log in from its window", "launch it
          // with…") are the actionable part; don't bury them.
          toast(err.message);
          refresh();
        });
        refresh();
        return;
      }

      var chain = Promise.resolve();
      if (state.selected && state.selected !== p.holder) {
        chain = api("/api/projects/" + pid + "/handoff", { method: "POST", body: JSON.stringify({ to: state.selected }) });
      }
      chain.then(function(){
        // into the chat you're looking at — the agent's reply comes back here
        return api("/api/projects/" + pid + "/messages", { method: "POST",
          body: JSON.stringify({ text: full, agentId: state.selected || undefined, chat: chatId }) });
      }).then(refresh).catch(function(err){ toast(err.message); });
    }

    // ---- composer plumbing -------------------------------------------------

    function autosizeBox(){
      var box = document.getElementById("box"); if (!box) return;
      box.style.height = "auto";
      // floor at two lines (48px), grow to a cap, then let it scroll
      box.style.height = Math.max(48, Math.min(200, box.scrollHeight)) + "px";
    }

    function drawAttach(){
      var wrap = document.getElementById("cchips"); if (!wrap) return;
      if (!attach.length) { wrap.style.display = "none"; wrap.innerHTML = ""; return; }
      wrap.style.display = "flex";
      wrap.innerHTML = attach.map(function(a, i){
        var thumb = a.thumb ? '<img src="' + a.thumb + '" alt="">' : ICONS.file;
        return '<span class="cchip' + (a.uploading ? " up" : "") + '">' + thumb +
          '<span class="nm">' + esc(a.uploading ? a.name + "\\u2026" : (a.path || a.name)) + "</span>" +
          '<button class="rm" type="button" data-rm="' + i + '" aria-label="remove attachment">' + ICONS.x + "</button></span>";
      }).join("");
      Array.prototype.forEach.call(wrap.querySelectorAll("[data-rm]"), function(b){
        b.onclick = function(){ attach.splice(Number(b.getAttribute("data-rm")), 1); drawAttach(); };
      });
    }

    function uploadFile(file){
      var isImg = /^image\\//.test(file.type);
      var rec = { name: file.name || (isImg ? "pasted-image" : "file"), kind: isImg ? "image" : "file", uploading: true, thumb: null, path: null };
      attach.push(rec); drawAttach();
      var reader = new FileReader();
      reader.onload = function(){
        var dataUrl = reader.result;
        if (isImg) rec.thumb = dataUrl;
        api("/api/projects/" + pid + "/attachments", {
          method: "POST", body: JSON.stringify({ name: rec.name, dataUrl: dataUrl }),
        }).then(function(j){
          rec.uploading = false; rec.path = j.path; drawAttach();
        }).catch(function(err){
          var i = attach.indexOf(rec); if (i >= 0) attach.splice(i, 1);
          drawAttach(); toast("attach failed: " + err.message);
        });
      };
      reader.onerror = function(){
        var i = attach.indexOf(rec); if (i >= 0) attach.splice(i, 1);
        drawAttach(); toast("could not read that file");
      };
      reader.readAsDataURL(file);
    }

    // The @ / popover. menuState remembers what kind of menu is open and where
    // in the text the trigger started, so accepting an item replaces exactly the
    // token you were typing.
    var menuState = null;

    function closeMenu(){
      menuState = null;
      document.removeEventListener("mousedown", menuAway);
      var m = document.getElementById("cmenu"); if (m) { m.style.display = "none"; m.innerHTML = ""; }
    }
    // The model/agent pickers open from a button, not the textarea, so a blur
    // won't close them — a click anywhere outside the card does.
    function menuAway(e){
      var cb = document.querySelector(".cbox");
      if (cb && !cb.contains(e.target)) closeMenu();
    }

    function renderMenu(items, head){
      var m = document.getElementById("cmenu"); if (!m) return;
      if (!items.length) { closeMenu(); return; }
      menuState.items = items; if (menuState.sel == null) menuState.sel = 0;
      if (menuState.sel >= items.length) menuState.sel = items.length - 1;
      m.style.display = "block";
      m.innerHTML = (head ? '<div class="cmhead">' + esc(head) + "</div>" : "") +
        items.map(function(it, i){
          return '<div class="cmi' + (i === menuState.sel ? " sel" : "") + '" data-i="' + i + '">' +
            '<span class="ic">' + (it.icon || ICONS.file) + "</span>" +
            "<span>" + esc(it.label) + "</span>" +
            (it.sub ? '<span class="sub">' + esc(it.sub) + "</span>" : "") + "</div>";
        }).join("");
      Array.prototype.forEach.call(m.querySelectorAll(".cmi"), function(row){
        row.onmousedown = function(ev){ ev.preventDefault(); acceptMenu(Number(row.getAttribute("data-i"))); };
      });
    }

    function acceptMenu(i){
      if (!menuState || !menuState.items) return;
      var it = menuState.items[i]; if (!it) return;
      var act = menuState.kind;
      if (act === "file") {
        var box = document.getElementById("box");
        var v = box.value, from = menuState.at, to = box.selectionStart;
        box.value = v.slice(0, from) + it.value + " " + v.slice(to);
        var caret = from + it.value.length + 1;
        box.setSelectionRange(caret, caret); box.focus(); autosizeBox();
        closeMenu();
      } else if (act === "cmd") {
        // A command consumes the whole "/word" it matched.
        var box2 = document.getElementById("box");
        box2.value = box2.value.slice(0, menuState.at) + box2.value.slice(box2.selectionStart);
        box2.setSelectionRange(menuState.at, menuState.at); autosizeBox();
        closeMenu();
        it.run();
      }
    }

    // Static, and every one runs something real — no decorative commands.
    function slashCommands(){
      return [
        { label: "New task", sub: "hand work to one or more agents", icon: ICONS.tasks, run: function(){ openTaskModal(pid); } },
        { label: "Record a decision", sub: "save it to the brain", icon: ICONS.memory, run: function(){
            var box = document.getElementById("box");
            var t = (box.value || "").trim();
            if (!t) { toast("type the decision first, then /"); return; }
            box.value = ""; autosizeBox();
            api("/api/projects/" + pid + "/decisions", { method: "POST", body: JSON.stringify({ text: t }) })
              .then(function(){ toast("decision saved to the brain"); if (typeof refreshBrain === "function") refreshBrain(); })
              .catch(function(err){ toast(err.message); });
          } },
        { label: "Pick a model", sub: "for " + (state.selected || "this agent"), icon: ICONS.gear, run: openModelMenu },
        { label: "Attach a file", sub: "image, .md, .txt", icon: ICONS.file, run: function(){ var f = document.getElementById("cfile"); if (f) f.click(); } },
      ];
    }

    function openFileMenu(q, at){
      menuState = { kind: "file", at: at, sel: 0, items: [] };
      api("/api/projects/" + pid + "/find?q=" + encodeURIComponent(q))
        .then(function(j){
          if (!menuState || menuState.kind !== "file") return;
          var items = (j.matches || []).slice(0, 40).map(function(pth){
            var base = pth.split("/").pop();
            return { label: base, sub: pth, value: "@" + pth, icon: ICONS.file };
          });
          renderMenu(items, "files");
        })
        .catch(function(){ closeMenu(); });
    }

    function openModelMenu(){
      var agentId = state.selected;
      var p = state.project || {};
      var cur = (p.agents || []).filter(function(a){ return a.id === agentId; })[0];
      if (!cur || cur.tier === "bridge") { toast("pick an adapter first \\u2014 bridges choose their own model"); return; }
      var m = document.getElementById("cmenu"); if (!m) return;
      menuState = { kind: "modelmenu", at: 0, sel: 0, items: [] };
      m.style.display = "block";
      m.innerHTML = '<div class="cmhead">model \\u00b7 ' + esc(cur.id) + '</div>' +
        '<input class="cmsearch" id="cmsearch" placeholder="search real models\\u2026" spellcheck="false" autocomplete="off">' +
        '<div class="cmlist" id="cmlist">' + LOADER + '</div>';
      setTimeout(function(){ document.addEventListener("mousedown", menuAway); }, 0);
      var active = cur.model || "";
      var allModels = [];
      function choose(val){
        if (val === "__custom__"){ closeMenu(); var typed = window.prompt("Model for " + cur.id + " (blank = default):", active); if (typed === null) return; val = typed.trim(); }
        else closeMenu();
        setModel(agentId, val);
      }
      // The real models the tool itself reports (opencode ~500 across providers,
      // grok its own); codex/claude are their shipped sets.
      function render(filter){
        var f = (filter || "").trim().toLowerCase();
        var shown = f ? allModels.filter(function(mm){ return mm.toLowerCase().indexOf(f) >= 0; }) : allModels;
        var cap = 200; // don't paint 500 rows — the search narrows it
        var head = [{ label: "Default", sub: cur.kind + "'s own choice", value: "" }];
        if (!f) head.push({ label: "Custom\\u2026", value: "__custom__", plus: true });
        var rows = head.concat(shown.slice(0, cap).map(function(mm){ return { label: mm, value: mm }; }));
        var list = document.getElementById("cmlist"); if (!list) return;
        list.innerHTML = rows.map(function(it){
          var tick = it.value === active;
          return '<div class="cmi" data-mv="' + esc(String(it.value)) + '"><span class="ic">' + (it.plus ? ICONS.plus : ICONS.gear) + '</span><span>' +
            esc(it.label) + '</span>' + (tick ? '<span class="tick">' + ICONS.info + '</span>' : (it.sub ? '<span class="sub">' + esc(it.sub) + '</span>' : '')) + '</div>';
        }).join("") +
          (shown.length > cap ? '<div class="cmmore">' + (shown.length - cap) + ' more \\u2014 keep typing to narrow</div>' : "") +
          (f && !shown.length ? '<div class="cmmore">no match \\u00b7 Enter to use \\u201c' + esc(filter) + '\\u201d</div>' : "");
        Array.prototype.forEach.call(list.querySelectorAll("[data-mv]"), function(row){
          row.onmousedown = function(ev){ ev.preventDefault(); choose(row.getAttribute("data-mv")); };
        });
      }
      api("/api/projects/" + pid + "/agents/" + encodeURIComponent(agentId) + "/models").then(function(j){
        allModels = (j && j.models) || [];
        var sb = document.getElementById("cmsearch");
        if (sb){
          var head0 = document.getElementById("cmlist");
          sb.oninput = function(){ render(sb.value); };
          sb.onkeydown = function(e){ if (e.key === "Enter"){ var v = sb.value.trim(); if (v) choose(v); } if (e.key === "Escape"){ closeMenu(); } };
          sb.focus();
        }
        render("");
      }).catch(function(err){
        var list = document.getElementById("cmlist"); if (list) list.innerHTML = '<div class="cmmore">could not list models</div>';
        clog("error", "models", "list failed: " + (err && err.message), err && err.stack);
      });
    }

    /**
     * Who this chat talks to. The agent chip in the composer was a dead label —
     * you could see "opencode" but not change it without hunting the sidebar.
     * Now it's a real picker: every agent in the project, brand mark and role,
     * the current one ticked. Selecting one aims the composer (state.selected);
     * send then hands it the baton.
     */
    function openAgentMenu(){
      var p = state.project || {};
      var agents = p.agents || [];
      if (!agents.length) { toast("no agents in this project yet"); return; }
      menuState = { kind: "agentmenu", at: 0, sel: 0, items: [] };
      var m = document.getElementById("cmenu"); if (!m) return;
      m.style.display = "block";
      m.innerHTML = '<div class="cmhead">talk to</div>' +
        agents.map(function(a, i){
          var tick = a.id === state.selected;
          var sub = a.tier === "bridge" ? "bridge" : (a.role || "");
          return '<div class="cmi" data-ai="' + i + '"><span class="ic">' + brandMark(a.kind) + "</span><span>" + esc(a.id) + "</span>" +
            (tick ? '<span class="tick">' + ICONS.info + "</span>" : (sub ? '<span class="sub">' + esc(sub) + "</span>" : "")) + "</div>";
        }).join("");
      Array.prototype.forEach.call(m.querySelectorAll("[data-ai]"), function(row){
        row.onmousedown = function(ev){
          ev.preventDefault();
          var a = agents[Number(row.getAttribute("data-ai"))];
          closeMenu();
          if (!a || a.id === state.selected) return;
          state.selected = a.id;
          drawStatus(); // repaints the chip, the model label, and the hint
          var box = document.getElementById("box"); if (box) box.focus();
        };
      });
      setTimeout(function(){ document.addEventListener("mousedown", menuAway); }, 0);
    }

    function setModel(agentId, model){
      api("/api/projects/" + pid + "/agents/" + encodeURIComponent(agentId) + "/model", {
        method: "POST", body: JSON.stringify({ model: model }),
      }).then(function(){
        toast(model ? (agentId + " \\u2192 " + model) : (agentId + " \\u2192 default model"));
        refresh();
      }).catch(function(err){ toast(err.message); });
    }

    // What's under the caret: an @file token, or a /command at a word start.
    function scanTrigger(){
      var box = document.getElementById("box");
      if (!box || box.selectionStart !== box.selectionEnd) return closeMenu();
      var upto = box.value.slice(0, box.selectionStart);
      var at = upto.match(/(^|\\s)@([\\w./-]*)$/);
      if (at) { openFileMenu(at[2], box.selectionStart - at[2].length - 1); return; }
      var sl = upto.match(/(^|\\s)\\/(\\w*)$/);
      if (sl) {
        var start = box.selectionStart - sl[2].length - 1;
        menuState = { kind: "cmd", at: start, sel: 0, items: [] };
        var q = sl[2].toLowerCase();
        renderMenu(slashCommands().filter(function(c){ return c.label.toLowerCase().indexOf(q) >= 0; }), "actions");
        return;
      }
      if (menuState && (menuState.kind === "file" || menuState.kind === "cmd")) closeMenu();
    }

    function bindComposer(){
      var box = document.getElementById("box");
      var form = document.getElementById("cform");
      if (!box || !form || box.getAttribute("data-bound")) return;
      box.setAttribute("data-bound", "1");
      autosizeBox();

      box.addEventListener("input", function(){ autosizeBox(); scanTrigger(); });
      box.addEventListener("keydown", function(e){
        // Menu open: arrows move, Enter/Tab accept, Esc closes.
        if (menuState && menuState.items && menuState.items.length && (menuState.kind === "file" || menuState.kind === "cmd")) {
          if (e.key === "ArrowDown") { e.preventDefault(); menuState.sel = (menuState.sel + 1) % menuState.items.length; renderMenu(menuState.items, menuState.kind === "cmd" ? "actions" : "files"); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); menuState.sel = (menuState.sel - 1 + menuState.items.length) % menuState.items.length; renderMenu(menuState.items, menuState.kind === "cmd" ? "actions" : "files"); return; }
          if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptMenu(menuState.sel); return; }
          if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
        }
        // Enter sends; Shift+Enter is a newline.
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      });
      box.addEventListener("paste", function(e){
        var items = (e.clipboardData && e.clipboardData.items) || [];
        var imgs = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === "file" && /^image\\//.test(items[i].type)) {
            var f = items[i].getAsFile(); if (f) imgs.push(f);
          }
        }
        if (imgs.length) { e.preventDefault(); imgs.forEach(uploadFile); }
      });
      box.addEventListener("blur", function(){ setTimeout(closeMenu, 120); });

      form.addEventListener("submit", function(ev){ ev.preventDefault(); send(); });

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
        if (menuState && menuState.kind === "modelmenu") { closeMenu(); return; }
        openModelMenu();
      };
      var ap = document.getElementById("cagent");
      if (ap) ap.onclick = function(){
        if (menuState && menuState.kind === "agentmenu") { closeMenu(); return; }
        openAgentMenu();
      };

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

    function updateModelLabel(){
      var lbl = document.getElementById("cmodellabel");
      var p = state.project || {};
      var cur = (p.agents || []).filter(function(a){ return a.id === state.selected; })[0];
      if (lbl) lbl.textContent = (cur && cur.model) ? cur.model : "model";
      // The agent chip shows who the composer talks to — brand mark + id.
      var chip = document.getElementById("cagent");
      if (chip) {
        if (cur) {
          chip.style.display = "";
          chip.innerHTML = brandMark(cur.kind) + '<span class="can">' + esc(cur.id) + "</span>" +
            '<span class="cchev">' + ICONS.chevron + "</span>";
        } else { chip.style.display = "none"; }
      }
    }

    bindComposer();
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
    // GitHub connection — the whole PR/Projects/review half rides on gh being
    // logged in, so it lives in the corner you glance at, with a one-click
    // Connect when it isn't.
    var gh = state.github, ghSeg = "";
    if (gh && gh.connected) ghSeg = '<span class="sit ghok" title="GitHub connected as ' + esc(gh.user || "") + '">' + ICONS.github + " " + esc(gh.user || "connected") + "</span>";
    else if (gh && gh.installed) ghSeg = '<button class="sit ghconnect" id="ghconnect" title="sign in to GitHub in a terminal">' + ICONS.github + " Connect GitHub</button>";
    // LoomPad voice backend — when it's up, the physical pad gets its spoken
    // replies. Green pill = connected; grey = offline. Click to re-check.
    var lp = state.loompad, lpUp = !!(lp && lp.up);
    var lpSeg = '<button class="sit lppill' + (lpUp ? " on" : "") + '" id="lppill" title="' +
      (lpUp
        ? "LoomPad voice backend connected" + (lp && lp.brain ? " \\u00b7 brain " + esc(String(lp.brain)) : "") + " \\u2014 the pad can speak"
        : "LoomPad voice backend offline \\u2014 start it so the pad can speak") +
      '"><span class="sdot' + (lpUp ? "" : " off") + '"></span>LoomPad' + (lpUp ? "" : " offline") + "</button>";
    el.innerHTML =
      '<span class="sit"><span class="sdot' + (state.wsLive ? "" : " off") + '"></span>' + (state.wsLive ? "live" : "offline") + "</span>" +
      '<span class="sit">' + esc(location.host) + "</span>" +
      (p ? '<span class="sit">baton ' + esc(p.holder || "\\u2014") + "</span>" : "") +
      (p && p.costUsd > 0
        ? '<button class="sit usagepill" id="usagepill" title="usage breakdown"><span class="meter"><i style="width:' + share + '%"></i></span>' + money(p.costUsd) + " \\u00b7 " + share + "% of \\u03a3</button>"
        : "") +
      '<span class="spacer"></span>' +
      lpSeg +
      ghSeg +
      (busy ? '<span class="sit" style="color:var(--live)">' + busy + " working</span>" : "") +
      '<span class="sit">' + (state.projects || []).length + " project" + ((state.projects || []).length === 1 ? "" : "s") + "</span>" +
      (total > 0 ? '<span class="sit">\\u03a3 ' + money(total) + "</span>" : "");
    var gc = document.getElementById("ghconnect");
    if (gc) gc.onclick = connectGithub;
    var lpp = document.getElementById("lppill");
    if (lpp) lpp.onclick = openLoomPad;
    var upill = document.getElementById("usagepill");
    if (upill) upill.onclick = openUsage;
  }

  // GitHub connection, fetched once and after a connect. Machine-wide (gh auth
  // is per-host), so it's cached on state and shown in the status bar.
  function loadGithub(){
    if (!state.token) return;
    api("/api/github/status").then(function(s){ state.github = s; drawStatusbar(); }).catch(function(){});
  }
  // LoomPad voice-backend health, shown as a pill in the status bar and polled so
  // the demo can see the pad go live the moment the backend starts.
  function loadLoomPad(){
    if (!state.token) return;
    api("/api/loompad/health")
      .then(function(s){ state.loompad = s; drawStatusbar(); })
      .catch(function(){ state.loompad = { up:false }; drawStatusbar(); });
  }
  if (!window.__loompadPoll){ window.__loompadPoll = setInterval(function(){ loadLoomPad(); }, 5000); }
  // Click the $ pill: a usage breakdown — this project's share and every
  // project's spend against the running total.
  function openUsage(){
    if (document.querySelector(".scrim")) return;
    var projs = (state.projects || []);
    var total = 0; projs.forEach(function(pr){ total += pr.costUsd > 0 ? pr.costUsd : 0; });
    var cur = state.project;
    var rows = projs.slice().sort(function(a,b){ return (b.costUsd||0)-(a.costUsd||0); });
    var body;
    if (!total){ body = '<div class="phmsg">No spend yet on this daemon.</div>'; }
    else {
      body = '<div class="usagerows">';
      rows.forEach(function(pr){
        var pct = total > 0 ? Math.round(((pr.costUsd||0)/total)*100) : 0;
        var isCur = cur && pr.id === cur.id;
        body += '<div class="usagerow' + (isCur ? " cur" : "") + '">' +
          '<div class="usagetop"><span class="usagename">' + esc(pr.name || pr.id) + (isCur ? ' <span class="usagecur">this project</span>' : "") + '</span><span class="usageval">' + money(pr.costUsd||0) + '</span></div>' +
          '<div class="usagebar"><i style="width:' + pct + '%"></i></div>' +
          '<div class="usagepct">' + pct + '% of total</div></div>';
      });
      body += '</div>';
    }
    var scrim = document.createElement("div"); scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal usagemodal">' +
      '<div class="modalhead">Usage<button class="iconbtn" id="ux" aria-label="close">' + ICONS.x + '</button></div>' +
      '<div class="modalbody">' + body + '</div>' +
      '<div class="modalfoot"><span class="phdim">' + rows.length + ' project' + (rows.length===1?"":"s") + '</span><span class="spacer"></span><span class="sit">\\u03a3 ' + money(total) + '</span></div>' +
    '</div>';
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if (e.key === "Escape"){ e.preventDefault(); close(); } }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("ux").onclick = close;
  }

  // Click the LoomPad pill: is the voice backend up, and how the physical pad
  // reaches it — on your Wi-Fi (LAN) or from anywhere (Tailscale Funnel).
  function openLoomPad(){
    if (document.querySelector(".scrim")) return;
    var scrim = document.createElement("div"); scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal phonemodal lpmodal">' +
      '<div class="modalhead">LoomPad<button class="iconbtn" id="lpx" aria-label="close">' + ICONS.x + '</button></div>' +
      '<div class="modalbody">' +
        '<div class="lpstatus" id="lpstatus">' + LOADER + '</div>' +
        '<div class="phseg" id="lpseg" role="tablist" style="display:none">' +
          '<button class="pho on" data-net="local" role="tab">Local network</button>' +
          '<button class="pho" data-net="tailnet" role="tab">Tailnet</button>' +
        '</div>' +
        '<div class="phstage" id="lpstage"></div>' +
        '<div class="phlinkrow" id="lplinkrow" style="display:none">' +
          '<input id="lplink" readonly spellcheck="false" aria-label="backend URL">' +
          '<button class="btn ghost" id="lpcopy">Copy</button>' +
        '</div>' +
        '<div class="phhint" id="lphint"></div>' +
      '</div>' +
      '<div class="modalfoot"><span class="phdim" id="lpfoot"></span><span class="spacer"></span><button class="btn ghost" id="lprecheck">Re-check</button></div>' +
    '</div>';
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if (e.key === "Escape"){ e.preventDefault(); close(); } }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("lpx").onclick = close;
    function q(id){ return document.getElementById(id); }
    var data = null, current = "local";
    function setSeg(){ Array.prototype.forEach.call(scrim.querySelectorAll("#lpseg .pho"), function(b){ b.classList.toggle("on", b.getAttribute("data-net") === current); }); }
    function showLink(url){ q("lplinkrow").style.display = ""; q("lplink").value = url; }
    function render(){
      setSeg(); q("lplinkrow").style.display = "none"; q("lphint").innerHTML = "";
      if (current === "local"){
        if (data.local && data.local.url){
          q("lpstage").innerHTML = '<div class="phmsg">Point the pad here on your Wi-Fi.<div class="phdim">Enter this as the backend URL in the pad\\u2019s setup portal. A blank token is fine on your own network.</div></div>';
          showLink(data.local.url);
          q("lphint").innerHTML = "The pad and this Mac must share the same Wi-Fi.";
        } else { q("lpstage").innerHTML = '<div class="phmsg">No local network address right now.</div>'; }
        return;
      }
      if (!data.tailnet.installed){
        q("lpstage").innerHTML = '<div class="phmsg">Tailscale isn\\u2019t installed.<div class="phdim">Install it to reach the pad from anywhere.</div></div>';
      } else if (!data.tailnet.loggedIn){
        q("lpstage").innerHTML = '<div class="phmsg">Sign in to Tailscale to reach the pad from anywhere.<div class="phdim">Opens the same Start Tailscale flow as Connect a phone.</div><button class="btn primary" id="lptsstart">Start Tailscale</button></div>';
        q("lptsstart").onclick = function(){ close(); openConnectPhone(); };
      } else {
        q("lpstage").innerHTML = '<div class="phmsg">Expose the backend to the internet for the pad.<div class="phdim">Tailscale Funnel serves it over HTTPS at the address below. Set the same <code>PAD_TOKEN</code> on the pad and the backend.</div><button class="btn primary" id="lpfunnel">Enable tailnet access</button></div>';
        if (data.tailnet.url) showLink(data.tailnet.url);
        q("lpfunnel").onclick = function(){
          var b = this; b.disabled = true; b.textContent = "Enabling\\u2026";
          api("/api/loompad/funnel", { method: "POST", body: "{}" }).then(function(r){
            q("lpstage").innerHTML = '<div class="phmsg">Live on the internet \\u2014 enter this in the pad.</div>';
            showLink((r && r.url) || data.tailnet.url || "");
            q("lphint").innerHTML = "Public HTTPS via Funnel. The pad needs your PAD_TOKEN.";
          }).catch(function(e){
            b.disabled = false; b.textContent = "Enable tailnet access";
            clog("error", "loompad", "funnel failed: " + (e && e.message), e && e.stack); toast((e && e.message) || "could not enable Funnel");
          });
        };
      }
    }
    function load(){
      q("lpstatus").innerHTML = LOADER; q("lpseg").style.display = "none"; q("lpstage").innerHTML = ""; q("lplinkrow").style.display = "none"; q("lphint").textContent = ""; q("lpfoot").textContent = "";
      api("/api/loompad/connect").then(function(r){
        data = r;
        var dot = '<span class="sdot' + (r.up ? "" : " off") + '"></span>';
        q("lpstatus").innerHTML = '<div class="lpstat">' + dot + '<b>' + (r.up ? "Backend running" : "Backend offline") + '</b>' + (r.up && r.brain ? ' <span class="phdim">brain ' + esc(String(r.brain)) + '</span>' : "") + ' <span class="phdim">:' + (r.port||8080) + '</span></div>' + (r.up ? "" : '<div class="phdim" style="margin-top:6px">Start it: <code>cd orchestrator-pad/backend &amp;&amp; npm start</code></div>');
        q("lpseg").style.display = "";
        q("lpfoot").textContent = r.backend || "";
        render();
      }).catch(function(e){
        q("lpstatus").innerHTML = '<div class="phmsg">Could not read LoomPad status.</div>';
        clog("error", "loompad", "connect failed: " + (e && e.message), e && e.stack);
      });
    }
    Array.prototype.forEach.call(scrim.querySelectorAll("#lpseg .pho"), function(b){ b.onclick = function(){ current = b.getAttribute("data-net"); render(); }; });
    q("lpcopy").onclick = function(){ var v = q("lplink").value; if (!v) return; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(function(){ toast("copied"); }).catch(function(){ toast("copy failed"); }); else toast("copy not available"); };
    q("lprecheck").onclick = load;
    load();
  }
  /**
   * Sign in to GitHub. gh's login is an interactive device flow, so the honest
   * place to run it is the real terminal you already have — Loom never touches
   * the token; gh stores it. We run it there, then poll until gh reports in and
   * light the board up.
   */
  function connectGithub(){
    if (!state.termRun) { toast("open a project first \\u2014 sign-in runs in its terminal"); return; }
    toast("opening a terminal to sign in to GitHub\\u2026");
    state.termRun("gh auth login --web --git-protocol https");
    var tries = 0;
    var poll = setInterval(function(){
      tries++;
      api("/api/github/status").then(function(s){
        state.github = s; drawStatusbar();
        if (s.connected) {
          clearInterval(poll);
          toast("GitHub connected \\u00b7 " + (s.user || ""));
          if (state.reloadBoard) try { state.reloadBoard(); } catch (e) {}
        }
      }).catch(function(){});
      if (tries > 80) clearInterval(poll); // ~4 min ceiling; then stop polling
    }, 3000);
  }

  // ---- right rail toggle — open by default (shows the file tree) -----------
  // ---- Console ------------------------------------------------------------
  // Everything that went wrong, in the drawer with the terminals.
  //
  // Errors used to have two fates: ~/.loom/daemon.log, which you have to know
  // exists and tail, or one of the many empty catch blocks, where they stopped
  // existing. Neither reaches the person looking at the window wondering why
  // nothing happened. Records arrive live over the same socket as events.
  var con = { logs: [], level: "all", open: false, present: false, seen: 0, expanded: {} };

  function conLevelOk(r){ return con.level === "all" || r.level === con.level; }

  function drawConsole(){
    var list = document.getElementById("conlist"); if (!list) return;
    var rows = con.logs.filter(conLevelOk);
    var cnt = document.getElementById("concount");
    if (cnt) {
      var errs = con.logs.filter(function(r){ return r.level === "error"; }).length;
      cnt.textContent = con.logs.length
        ? con.logs.length + " record" + (con.logs.length === 1 ? "" : "s") + (errs ? " \\u00b7 " + errs + " error" + (errs === 1 ? "" : "s") : "")
        : "";
    }
    if (!rows.length) {
      list.innerHTML = '<div class="conempty">' +
        (con.logs.length ? "nothing at this level" : "nothing has gone wrong \\u2014 errors from the daemon, the API and your agents land here") +
        "</div>";
      return;
    }
    // Pinned to the bottom unless you've scrolled up to read something: yanking
    // the view away mid-read is how a log becomes unusable.
    var atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
    list.innerHTML = rows.map(function(r){
      var t = new Date(r.at);
      var hh = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0") + ":" + String(t.getSeconds()).padStart(2, "0");
      var open = !!con.expanded[r.id];
      return '<div class="conrow ' + esc(r.level) + '" data-id="' + r.id + '">' +
        '<span class="t">' + hh + "</span>" +
        '<span class="sc">' + esc(r.scope) + "</span>" +
        '<span class="ms">' + esc(r.message) + "</span>" +
        (r.detail ? '<span class="det" data-det="' + r.id + '">' + (open ? "\\u2212" : "+") + "</span>" : "") +
        "</div>" +
        (open && r.detail ? '<div class="condetail">' + esc(r.detail) + "</div>" : "");
    }).join("");
    Array.prototype.forEach.call(list.querySelectorAll("[data-det]"), function(b){
      b.onclick = function(){
        var id = b.getAttribute("data-det");
        con.expanded[id] = !con.expanded[id];
        drawConsole();
      };
    });
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  /** The dot: something went wrong that you haven't looked at. */
  function drawErrDot(){
    var dot = document.getElementById("errdot"); if (!dot) return;
    var unseen = con.logs.filter(function(r){ return r.level === "error" && r.id > con.seen; }).length;
    dot.classList.toggle("on", unseen > 0 && !con.open);
  }

  function addLogRecord(r){
    con.logs.push(r);
    if (con.logs.length > 500) con.logs.splice(0, con.logs.length - 500);
    if (state.consoleActive && state.consoleActive()) { drawConsole(); con.seen = r.id; }
    if (con.present && state.redrawTermTabs) state.redrawTermTabs(); // refresh the tab's error dot
    drawErrDot();
  }

  function openConsole(){
    // The console is a tab in the terminal dock now; renderProject owns the tab
    // machinery and publishes state.showConsole for exactly this cross-scope
    // call. (These functions live at module scope; terms/activeTerm/drawTermTabs
    // do not.)
    if (state.showConsole) state.showConsole();
    // Mark what's on screen as seen — the dot is about news, not history.
    con.logs.forEach(function(r){ if (r.id > con.seen) con.seen = r.id; });
    drawConsole();
    drawErrDot();
  }

  function closeConsole(){
    if (state.hideConsole) state.hideConsole();
    else { con.open = false; con.present = false; }
    drawErrDot();
  }

  function bindConsole(){
    var btn = document.getElementById("consolebtn");
    // Toggle: if the console is the pane you're looking at, close it; else show it.
    if (btn) btn.onclick = function(){ (state.consoleActive && state.consoleActive()) ? closeConsole() : openConsole(); };
    var clear = document.getElementById("conclear");
    if (clear) clear.onclick = function(){
      api("/api/logs", { method: "DELETE" }).then(function(){
        con.logs = []; con.seen = 0; con.expanded = {};
        drawConsole(); drawErrDot();
      }).catch(function(e){ toast(e.message); });
    };
    Array.prototype.forEach.call(document.querySelectorAll(".conbar .lvl"), function(el){
      el.onclick = function(){
        con.level = el.getAttribute("data-lvl");
        Array.prototype.forEach.call(document.querySelectorAll(".conbar .lvl"), function(o){
          o.classList.toggle("on", o === el);
        });
        drawConsole();
      };
    });
    // Backfill: the daemon has been running longer than this window has been
    // open, and its errors are exactly the ones you want on a fresh load.
    api("/api/logs").then(function(j){
      con.logs = j.logs || [];
      // Everything from before this window opened counts as already seen —
      // a dot for yesterday's error is noise, not news.
      con.logs.forEach(function(r){ if (r.id > con.seen) con.seen = r.id; });
      drawConsole();
      drawErrDot();
    }).catch(function(){ /* no logs endpoint on an old daemon — the tab just stays empty */ });
  }

  // ---- client-side logging: the window's own errors, in the Console ---------
  /**
   * Report a client-side problem into the same Console tab as the daemon's.
   * Raw fetch on purpose (not api()) so a stray error report can never trip the
   * 401 -> logout path. The daemon streams the record straight back, and that
   * is what puts it on screen; if the post cannot get out, show it locally so
   * it is never lost.
   */
  function clog(level, scope, message, detail){
    try {
      var p = { level: level, scope: scope || "app", message: String(message == null ? "" : message).slice(0, 500) };
      if (detail != null && String(detail)) p.detail = String(detail).slice(0, 4000);
      if (state && state.token) {
        fetch("/api/logs", { method: "POST", headers: { "Authorization": "Bearer " + state.token, "Content-Type": "application/json" }, body: JSON.stringify(p) })
          .catch(function(){ localLog(p); });
      } else {
        localLog(p);
      }
    } catch (_e) { /* logging must never throw */ }
  }
  function localLog(p){
    try { addLogRecord({ id: -Date.now(), at: Date.now(), level: p.level, scope: p.scope, message: p.message, detail: p.detail }); } catch (_e) {}
    try { (console[p.level] || console.log).call(console, "[" + p.scope + "] " + p.message, p.detail || ""); } catch (_e) {}
  }
  // Catch what escapes user code: uncaught errors and rejected promises. Once.
  if (!window.__loomErrHooked) {
    window.__loomErrHooked = true;
    window.addEventListener("error", function(e){
      clog("error", "window", (e && e.message) || "script error", (e && e.error && e.error.stack) || (e && e.filename ? e.filename + ":" + e.lineno + ":" + e.colno : ""));
    });
    window.addEventListener("unhandledrejection", function(e){
      var r = e && e.reason;
      clog("error", "window", "unhandled rejection: " + ((r && r.message) || r), (r && r.stack) || "");
    });
  }

  // ---- connect a phone ------------------------------------------------------
  /**
   * A QR (or copy link) that pairs the native app. Two networks to choose from —
   * the LAN and the tailnet — and, when the daemon is bound to localhost, a
   * one-click "enable phone access" that binds it to 0.0.0.0 so the phone can
   * actually reach it. Every failure is reported into the Console.
   */
  function openConnectPhone(){
    if (document.querySelector(".scrim")) return;
    var scrim = document.createElement("div"); scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal phonemodal">' +
      '<div class="modalhead">Connect a phone<button class="iconbtn" id="phx" aria-label="close">' + ICONS.x + '</button></div>' +
      '<div class="modalbody">' +
        '<div class="phseg" id="phseg" role="tablist">' +
          '<button class="pho" data-net="localnet" role="tab">Local network</button>' +
          '<button class="pho" data-net="tailnet" role="tab">Tailnet</button>' +
        '</div>' +
        '<div class="phstage" id="phstage">' + LOADER + '</div>' +
        '<div class="phlinkrow" id="phlinkrow" style="display:none">' +
          '<input id="phlink" readonly spellcheck="false" aria-label="pairing link">' +
          '<button class="btn ghost" id="phcopy">Copy</button>' +
        '</div>' +
        '<div class="phhint" id="phhint"></div>' +
      '</div>' +
      '<div class="modalfoot"><span class="phexp" id="phexp"></span><span class="spacer"></span><button class="btn ghost" id="phregen">New code</button></div>' +
    '</div>';
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("phx").onclick = close;

    var nets = null, current = "localnet", pollIv = null;
    function q(id){ return document.getElementById(id); }
    function stage(html){ q("phstage").innerHTML = html; q("phlinkrow").style.display = "none"; q("phhint").textContent = ""; q("phexp").textContent = ""; }
    function loadNets(){ return api("/api/pair/networks").then(function(r){ nets = r; }); }
    function setSeg(){
      Array.prototype.forEach.call(scrim.querySelectorAll(".pho"), function(b){
        var net = b.getAttribute("data-net");
        var avail = net === "tailnet" ? !!(nets && nets.tailnet && nets.tailnet.available) : true;
        b.classList.toggle("on", net === current);
        b.classList.toggle("dim", !avail);
      });
    }
    function pickDefault(){
      if (nets.tailnet && nets.tailnet.reachable) return "tailnet";
      if (nets.localnet && nets.localnet.reachable) return "localnet";
      if (nets.tailnet && nets.tailnet.available) return "tailnet";
      return "localnet";
    }
    function mint(){
      var net = nets[current];
      if (!net || !net.ip) return;
      q("phstage").innerHTML = LOADER;
      q("phlinkrow").style.display = "none";
      api("/api/pair/new", { method: "POST", body: JSON.stringify({ host: net.ip }) }).then(function(r){
        q("phstage").innerHTML = r.qrSvg
          ? '<div class="phqrcard">' + r.qrSvg + '</div>'
          : '<div class="phmsg">Scan is not available here &#8212; use the link below.</div>';
        q("phlinkrow").style.display = "";
        q("phlink").value = r.link;
        q("phhint").innerHTML = 'Scan with your phone camera, or ' + (current === "tailnet" ? "on the same tailnet " : "on the same Wi-Fi ") + 'open the link. Single use.';
        q("phexp").textContent = r.expiresAt ? "expires " + new Date(r.expiresAt).toLocaleTimeString() : "";
      }).catch(function(e){
        q("phstage").innerHTML = '<div class="phmsg">Could not create a pairing code.</div>';
        clog("error", "phone", "mint failed: " + (e && e.message), e && e.stack); toast((e && e.message) || "error");
      });
    }
    function pollTailscale(){
      pollIv = setInterval(function(){
        if (!document.body.contains(scrim)){ clearInterval(pollIv); return; } // modal closed
        api("/api/tailscale/status").then(function(s){
          if (s && s.loggedIn && s.ip){
            clearInterval(pollIv);
            loadNets().then(function(){ current = "tailnet"; render(); });
          }
        }).catch(function(){});
      }, 2500);
    }
    function startTailscale(){
      q("phstage").innerHTML = LOADER; q("phhint").textContent = "";
      api("/api/tailscale/up", { method: "POST", body: "{}" }).then(function(r){
        if (r && r.ip){ return loadNets().then(function(){ current = "tailnet"; render(); }); } // already up
        if (r && r.loginUrl){
          stage('<div class="phmsg">Almost there. Sign in to Tailscale to finish.' +
            '<div class="phdim">Open the link, approve this Mac, and this continues on its own.</div>' +
            '<a class="btn primary" href="' + esc(r.loginUrl) + '" target="_blank" rel="noreferrer">Open Tailscale sign-in</a>' +
            '<div class="phdim" id="phtswait">Waiting for you to authorize...</div></div>');
          pollTailscale();
        } else {
          stage('<div class="phmsg">Could not start Tailscale.</div>');
        }
      }).catch(function(e){
        stage('<div class="phmsg">Could not start Tailscale.</div>');
        clog("error", "phone", "tailscale up failed: " + (e && e.message), e && e.stack); toast((e && e.message) || "could not start Tailscale");
      });
    }
    function render(){
      setSeg();
      var net = nets[current];
      if (current === "tailnet" && (!nets.tailnet || !nets.tailnet.available)){
        if (nets.tailnet && nets.tailnet.signedOut){
          stage('<div class="phmsg">Tailscale is installed but signed out.' +
            '<div class="phdim">Start it here so a phone on your tailnet can reach Loom from anywhere. No shared Wi-Fi, no terminal.</div>' +
            '<button class="btn primary" id="phtsup">Start Tailscale</button></div>');
          q("phtsup").onclick = startTailscale;
        } else {
          stage('<div class="phmsg">' + esc((nets.tailnet && nets.tailnet.reason) || "Tailscale is not installed on this machine.") + '<div class="phdim">Install Tailscale on this Mac and your phone, then reopen this.</div></div>');
        }
        return;
      }
      if (!net || !net.ip){
        stage('<div class="phmsg">No ' + (current === "tailnet" ? "tailnet" : "local network") + ' address on this machine right now.</div>');
        return;
      }
      if (!net.reachable){
        stage('<div class="phmsg">Loom is bound to <code>' + esc(nets.boundHost) + '</code>, so a phone cannot reach it yet.' +
          '<div class="phdim">Enable phone access to also listen on <code>' + esc(net.ip) + '</code> so a phone on the ' + (current === "tailnet" ? "tailnet" : "same Wi-Fi") + ' can reach it. It stays behind the single-use pairing code.</div>' +
          '<button class="btn primary" id="phexpose">Enable phone access</button></div>');
        q("phexpose").onclick = function(){
          var b = this; b.disabled = true; b.textContent = "Enabling...";
          api("/api/pair/expose", { method: "POST", body: JSON.stringify({ host: net.ip }) }).then(function(){
            return loadNets();
          }).then(function(){ render(); }).catch(function(e){
            b.disabled = false; b.textContent = "Enable phone access";
            clog("error", "phone", "expose failed: " + (e && e.message), e && e.stack); toast((e && e.message) || "could not enable phone access");
          });
        };
        return;
      }
      mint();
    }

    Array.prototype.forEach.call(scrim.querySelectorAll(".pho"), function(b){
      b.onclick = function(){ current = b.getAttribute("data-net"); render(); };
    });
    q("phcopy").onclick = function(){
      var v = q("phlink").value; if (!v) return;
      function fallbackCopy(){ var el = q("phlink"); el.focus(); el.select(); try { document.execCommand("copy"); toast("link copied"); } catch (_e){ toast("copy failed"); } }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(function(){ toast("link copied"); }).catch(fallbackCopy);
      else fallbackCopy();
    };
    q("phregen").onclick = function(){ render(); };
    stage(LOADER);
    loadNets().then(function(){ current = pickDefault(); render(); }).catch(function(e){
      stage('<div class="phmsg">Could not read the network options.</div>');
      clog("error", "phone", "networks failed: " + (e && e.message), e && e.stack); toast((e && e.message) || "error");
    });
  }

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
  function openTaskModal(prefillPid, prefillAgents, prefillText){
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
          '<div class="rolelist" id="magroles"></div>' +
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
    // The job each picked agent does THIS task — keyed by agent id, seeded from
    // the agent's own role but freely overridable here without changing it.
    var taskRoles = {};
    function drawChips(){
      var box = document.getElementById("magsel"); if (!box) return;
      var agents = agentsFor(pid);
      picked = picked.filter(function(id){ return agents.some(function(a){ return a.id === id; }); });
      box.innerHTML = agents.map(function(a){
        var order = picked.indexOf(a.id);
        return '<button type="button" class="agchip' + (order >= 0 ? " sel" : "") + '" data-id="' + esc(a.id) + '">' +
          '<span class="num">' + (order >= 0 ? order + 1 : "") + "</span>" +
          brandMark(a.kind) + esc(a.id) +
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
      drawRoles();
      var hint = document.getElementById("maghint");
      if (hint) hint.textContent = picked.length > 1
        ? "runs as a pipeline: " + picked.join(" \\u2192 ")
        : picked.length === 1
          ? "one ADE runs the whole task"
          : "pick one ADE \\u2014 or several to run them in order";
    }
    // The roles you can hand out. Only the first three carry distinct prompt
    // behaviour today (plan / execute / review); the rest are honest labels the
    // agent still gets told to act on.
    var TASK_ROLES = ["planner","executor","reviewer","general","researcher","tester","architect","documenter"];
    function drawRoles(){
      var wrap = document.getElementById("magroles"); if (!wrap) return;
      if (!picked.length) { wrap.innerHTML = ""; wrap.style.display = "none"; return; }
      wrap.style.display = "flex";
      var agents = agentsFor(pid);
      wrap.innerHTML = picked.map(function(id, i){
        var a = agents.filter(function(x){ return x.id === id; })[0] || {};
        var role = taskRoles[id] || a.role || "general";
        // ensure whatever the agent's own role is can still be selected
        var opts = TASK_ROLES.slice();
        if (opts.indexOf(role) < 0) opts.unshift(role);
        return '<div class="rolerow">' +
          '<span class="rn">' + (i + 1) + "</span>" + brandMark(a.kind) +
          '<span class="rid">' + esc(id) + "</span>" +
          '<select class="roleselect" data-roleid="' + esc(id) + '">' +
          opts.map(function(r){ return '<option value="' + esc(r) + '"' + (r === role ? " selected" : "") + ">" + esc(r) + "</option>"; }).join("") +
          "</select></div>";
      }).join("");
      Array.prototype.forEach.call(wrap.querySelectorAll(".roleselect"), function(sel){
        sel.onchange = function(){ taskRoles[sel.getAttribute("data-roleid")] = sel.value; };
      });
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
    setTimeout(function(){
      var ta = document.getElementById("mtask"); if (!ta) return;
      if (prefillText) {
        ta.value = prefillText;
        // land the caret at the end so a Start-ed issue reads as a draft to
        // extend, not a field to overwrite
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } else ta.focus();
    }, 30);
    function create(){
      var mproj = document.getElementById("mproj").value;
      var task = (document.getElementById("mtask").value || "").trim();
      var pipeline = document.getElementById("mroute").value;
      if (!task) return toast("describe the task first");
      if (!pipeline && !picked.length) return toast("pick at least one agent");
      var btn = document.getElementById("mcreate"); btn.disabled = true;
      var work, note;
      // The spec carries each step's assigned role, so a route can say "this one
      // plans, that one executes" without touching either agent's own role.
      var specWithRoles = picked.map(function(id){
        var r = taskRoles[id];
        return r ? { step: id, role: r } : { step: id };
      });
      var rolesNote = picked.map(function(id){ return id + (taskRoles[id] ? " (" + taskRoles[id] + ")" : ""); });
      if (pipeline) {
        work = api("/api/projects/" + mproj + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: pipeline }) });
        note = "pipeline " + pipeline + " started";
      } else if (picked.length > 1) {
        work = api("/api/projects/" + mproj + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: specWithRoles }) });
        note = picked.length + " agents \\u00b7 " + rolesNote.join(" \\u2192 ");
      } else if (taskRoles[picked[0]]) {
        // A single agent with an explicit role runs as a one-step route, so the
        // role's instruction is actually injected into its turn.
        work = api("/api/projects/" + mproj + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: specWithRoles }) });
        note = "task sent to " + picked[0] + " as " + taskRoles[picked[0]];
      } else {
        var agent = picked[0];
        var holder = (proj(mproj) || {}).holder;
        var chain = agent !== holder
          ? api("/api/projects/" + mproj + "/handoff", { method: "POST", body: JSON.stringify({ to: agent }) })
          : Promise.resolve();
        work = chain.then(function(){
          // a new task starts in the project's main chat, not in whichever
          // conversation happened to be open when you hit N
          return api("/api/projects/" + mproj + "/messages", { method: "POST",
            body: JSON.stringify({ text: task, agentId: agent, chat: "main" }) });
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

  /**
   * A card of your own on the board. Same chrome as Create task, but this
   * writes a card rather than starting a run — so it also offers to do both:
   * "Create & start" hands the text to the agent and drops the card in
   * Working, which is where that work actually is.
   */
  function openBoardTaskModal(pid, column, onDone){
    if (document.querySelector(".scrim")) return;
    var p = state.project;
    var adapters = (p && p.agents ? p.agents : []).filter(function(a){ return a.tier === "adapter"; });
    var picked = null;
    var cols = [["working", "Working"], ["needs-you", "Needs you"],
                ["in-review", "In review"], ["ready", "Ready to merge"]];
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal">' +
      '<div class="modalhead">New card<button class="iconbtn" id="bmclose" aria-label="close">' + ICONS.x + "</button></div>" +
      '<div class="modalbody">' +
        '<div class="field"><label>Task</label>' +
          '<textarea id="bmtitle" placeholder="what needs doing?"></textarea></div>' +
        '<div class="field"><label>Column</label><select id="bmcol">' +
          cols.map(function(c){
            return '<option value="' + c[0] + '"' + (c[0] === column ? " selected" : "") + ">" + c[1] + "</option>";
          }).join("") + "</select></div>" +
        '<div class="field"><label>For <span class="opt">optional</span></label>' +
          '<div class="agsel" id="bmagsel"></div>' +
          '<span class="hintx" id="bmhint">just a note to yourself unless you pick someone</span></div>' +
      "</div>" +
      '<div class="modalfoot"><button class="btn ghost" id="bmcancel">Cancel</button>' +
        '<button class="btn outline" id="bmstart" style="display:none">Create &amp; start</button>' +
        '<button class="btn primary" id="bmcreate">Create card<span class="kbd">\\u2318\\u21b5</span></button></div>' +
    "</div>";
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("bmclose").onclick = close;
    document.getElementById("bmcancel").onclick = close;

    function drawChips(){
      var box = document.getElementById("bmagsel"); if (!box) return;
      box.innerHTML = adapters.length
        ? adapters.map(function(a){
            return '<button type="button" class="agchip' + (picked === a.id ? " sel" : "") + '" data-id="' + esc(a.id) + '">' +
              brandMark(a.kind) + esc(a.id) + '<span class="role">' + esc(a.role || "") + "</span></button>";
          }).join("")
        : '<span class="hintx">no agents configured for this project</span>';
      Array.prototype.forEach.call(box.querySelectorAll(".agchip"), function(ch){
        ch.onclick = function(){
          var id = ch.getAttribute("data-id");
          picked = picked === id ? null : id; // click again to unassign
          drawChips();
        };
      });
      var hint = document.getElementById("bmhint");
      if (hint) hint.textContent = picked
        ? "the card is for " + picked + " \\u2014 Create & start also sends it the task now"
        : "just a note to yourself unless you pick someone";
      var sb = document.getElementById("bmstart");
      if (sb) sb.style.display = picked ? "" : "none";
    }
    drawChips();
    setTimeout(function(){ var t = document.getElementById("bmtitle"); if (t) t.focus(); }, 30);

    function create(alsoStart){
      var title = (document.getElementById("bmtitle").value || "").trim();
      if (!title) return toast("what needs doing?");
      var col = document.getElementById("bmcol").value;
      // starting it means an agent is on it now, so the card belongs in Working
      var body = { title: title, column: alsoStart ? "working" : col };
      if (picked) body.agent = picked;
      document.getElementById("bmcreate").disabled = true;
      api("/api/projects/" + pid + "/board/tasks", { method: "POST", body: JSON.stringify(body) })
        .then(function(){
          if (!alsoStart) { close(); toast("card added"); if (onDone) onDone(); return; }
          var holder = (state.project || {}).holder;
          var chain = picked !== holder
            ? api("/api/projects/" + pid + "/handoff", { method: "POST", body: JSON.stringify({ to: picked }) })
            : Promise.resolve();
          return chain
            .then(function(){
              return api("/api/projects/" + pid + "/messages", {
                method: "POST",
                body: JSON.stringify({ text: title, agentId: picked, chat: "main" }),
              });
            })
            .then(function(){ close(); toast("sent to " + picked); if (onDone) onDone(); });
        })
        .catch(function(err){
          document.getElementById("bmcreate").disabled = false;
          toast(err.message);
        });
    }
    document.getElementById("bmcreate").onclick = function(){ create(false); };
    document.getElementById("bmstart").onclick = function(){ create(true); };
    function onKey(e){
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); create(false); }
    }
    document.addEventListener("keydown", onKey);
  }

  /**
   * Add a project. The daemon does the real work (writes .loom/config.json,
   * detects which ADEs are installed, registers it); this only collects a
   * folder. Inside Electron that folder comes from the OS picker — in a
   * browser the daemon may be on another host, so the path is typed.
   */
  /**
   * Settings — one sectioned modal for everything about this Loom. A nav rail on
   * the left; one pane on the right. Setup is folded in as the first section
   * rather than living in its own lonely modal, joined by Diagnostics (loom
   * doctor), Preferences (how the brain and handoffs behave), Updates, Devices,
   * and About.
   *
   * Setup and Diagnostics read from the daemon that can actually see the machine
   * (/api/setup, /api/doctor) rather than anything baked into the page: a
   * checklist that says the same thing everywhere is a brochure. Preferences are
   * per-project and land live on the next turn/handoff \\u2014 no restart.
   */
  function openSettingsModal(section){
    if (document.querySelector(".scrim")) return;
    // The project whose brain/handoff prefs we edit \\u2014 the open one, if any.
    var pid = (location.hash.match(/^#p\\/(.+)$/) || [])[1] || state.pid || null;
    var SECTIONS = [
      { id: "setup", label: "Setup", icon: ICONS.tasks },
      { id: "diagnostics", label: "Diagnostics", icon: ICONS.console },
      { id: "preferences", label: "Preferences", icon: ICONS.gear },
      { id: "updates", label: "Updates", icon: ICONS.up },
      { id: "devices", label: "Devices", icon: ICONS.agents },
      { id: "about", label: "About", icon: ICONS.info }
    ];
    var cur = section || "setup";
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal settings">' +
      '<div class="modalhead">Settings<button class="iconbtn" id="sclose" aria-label="close">' + ICONS.x + "</button></div>" +
      '<div class="setwrap"><nav class="setnav" id="setnav"></nav>' +
      '<div class="setpane" id="setpane">' + LOADER + "</div></div>" +
    "</div>";
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("sclose").onclick = close;

    var nav = document.getElementById("setnav");
    var pane = document.getElementById("setpane");
    function drawNav(){
      nav.innerHTML = '<div class="navh">Settings</div>' + SECTIONS.map(function(s){
        return '<button data-sec="' + s.id + '" class="' + (s.id === cur ? "on" : "") + '">' + s.icon + "<span>" + esc(s.label) + "</span></button>";
      }).join("");
      Array.prototype.forEach.call(nav.querySelectorAll("button"), function(b){
        b.onclick = function(){ cur = b.getAttribute("data-sec"); drawNav(); render(); };
      });
    }
    function busy(){ pane.innerHTML = LOADER; }
    function fail(err){ pane.innerHTML = '<div class="snote">' + esc(err && err.message ? err.message : String(err)) + "</div>"; }

    // A segmented control (Auto | Off), and the wiring that makes exactly one
    // button live and calls back with the chosen value.
    function seg(name, opts, val){
      return '<div class="seg" data-seg="' + name + '">' + opts.map(function(o){
        return '<button data-val="' + o.v + '" class="' + (o.v === val ? "on" : "") + '">' + esc(o.l) + "</button>";
      }).join("") + "</div>";
    }
    function bindSeg(name, fn){
      var box = pane.querySelector('[data-seg="' + name + '"]');
      if (!box) return;
      Array.prototype.forEach.call(box.querySelectorAll("button"), function(b){
        b.onclick = function(){
          if (b.classList.contains("on")) return;
          Array.prototype.forEach.call(box.querySelectorAll("button"), function(x){ x.classList.remove("on"); });
          b.classList.add("on");
          fn(b.getAttribute("data-val"));
        };
      });
    }

    // ---- Setup: what this machine still needs (from the daemon) --------------
    function srow(st, title, detail, cmd){
      return '<div class="srow2"><span class="sdot ' + st + '"></span>' +
        '<div class="sbody"><div class="st">' + title + "</div>" +
        (detail ? '<div class="sd">' + detail + "</div>" : "") +
        (cmd ? '<code class="scmd">' + esc(cmd) + "</code>" : "") + "</div></div>";
    }
    function renderSetup(){
      busy();
      api("/api/setup").then(function(s){
        var osname = s.platform === "darwin" ? "macOS" : s.platform === "win32" ? "Windows" : "Linux";
        var h = '<div class="setphead">Setup</div><div class="setpsub">What this machine still needs to run agents.</div>';
        h += '<div class="sgrouph">Runtime</div>';
        h += srow(s.node.ok ? "ok" : "bad", "Node " + esc(s.node.version),
          s.node.ok ? "new enough for the event log"
            : "Loom needs \\u2265" + esc(s.node.needed) + " \\u2014 on anything older your history is silently dropped",
          s.node.ok ? "" : (s.platform === "darwin" ? "brew install node"
            : s.platform === "win32" ? "winget install OpenJS.NodeJS" : "install node 22.5 or newer"));
        h += '<div class="sgrouph">Agents that can take a turn</div>';
        if (!s.ready) h += '<div class="snote">Nothing here can hold the baton yet \\u2014 install one and Loom has something to drive.</div>';
        s.agents.forEach(function(a){
          // Three states, not two. "Installed" was the lie that cost an
          // afternoon: claude answered --version happily while refusing every
          // turn with "Not logged in".
          var st = !a.found ? "warn" : a.authed === false ? "bad" : a.authed === true ? "ok" : "warn";
          var detail = !a.found ? "not installed"
            : a.authed === true ? "signed in \\u00b7 ready to take a turn"
            : a.authed === false ? (a.authDetail || "signed out") + " \\u2014 it will refuse every turn until you:"
            : "installed \\u2014 couldn\\u2019t confirm it\\u2019s signed in:";
          h += srow(st, brandMark(a.kind) + " " + esc(a.label), esc(detail), !a.found ? a.install : a.authed === true ? "" : a.auth);
        });
        h += '<div class="sgrouph">Agents you drive in their own window</div>';
        s.bridges.forEach(function(b){
          h += srow(b.driveable ? "ok" : b.reachable ? "warn" : "off",
            brandMark(b.kind) + " " + esc(b.label) + ' <span class="sport">:' + b.port + "</span>",
            b.driveable ? "ready to drive" : esc(b.reason || "not running"), b.driveable ? "" : b.launch);
        });
        h += '<div class="sgrouph">Permissions on ' + osname + "</div>";
        s.permissions.forEach(function(p){
          h += '<div class="srow2"><span class="sdot ' + (p.refused ? "no" : "info") + '"></span>' +
            '<div class="sbody"><div class="st">' + esc(p.title) + (p.refused ? ' <span class="sport">not needed</span>' : "") + "</div>" +
            '<div class="sd">' + esc(p.why) + '</div><div class="sd how">' + esc(p.how) + "</div></div></div>";
        });
        h += '<div class="sgrouph">Your phone</div>';
        h += srow("info", "Let it reach this machine", "Loom listens on localhost by default, which your phone can\\u2019t see.", "loom up --restart --tailnet");
        h += srow("info", "Pair the device", "Single use \\u2014 or add one under Devices.", "loom pair");
        h += '<div class="pillrow"><button class="btn ghost sm" id="setuprecheck">Re-check</button>' +
          '<span class="hintx">' + (s.ready ? "This machine can run agents." : "No agents installed yet.") + "</span></div>";
        pane.innerHTML = h;
        document.getElementById("setuprecheck").onclick = renderSetup;
      }).catch(fail);
    }

    // ---- Diagnostics: loom doctor, live -------------------------------------
    function renderDiag(){
      busy();
      api("/api/doctor" + (pid ? "?project=" + encodeURIComponent(pid) : "")).then(function(d){
        var checks = d.checks || [];
        var bad = checks.filter(function(c){ return c.status === "fail"; }).length;
        var warn = checks.filter(function(c){ return c.status === "warn"; }).length;
        var h = '<div class="setphead">Diagnostics</div>' +
          '<div class="setpsub">loom doctor, run live on this daemon' + (pid ? " \\u00b7 including the open project" : "") + ".</div>";
        h += '<div class="pillrow">';
        if (!bad && !warn) h += '<span class="updpill ok">All ' + checks.length + " checks pass</span>";
        else h += '<span class="updpill warn">' + (bad ? bad + " failing" : "") + (bad && warn ? " \\u00b7 " : "") + (warn ? warn + " warning" + (warn > 1 ? "s" : "") : "") + "</span>";
        h += '<button class="btn ghost sm" id="diagrerun">Re-run</button></div>';
        checks.forEach(function(c){
          var st = c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "bad";
          h += '<div class="dchk"><span class="sdot ' + st + '" style="margin-top:5px"></span>' +
            '<div class="sbody"><div class="dct">' + esc(c.name) + "</div>" +
            (c.detail ? '<div class="dcd">' + esc(c.detail) + "</div>" : "") + "</div></div>";
        });
        pane.innerHTML = h;
        document.getElementById("diagrerun").onclick = renderDiag;
      }).catch(fail);
    }

    // ---- Preferences: theme, and per-project brain/handoff knobs -------------
    function patchCfg(body, okMsg){
      api("/api/projects/" + pid + "/config", { method: "PATCH", body: JSON.stringify(body) })
        .then(function(){ if (okMsg) toast(okMsg); })
        .catch(function(e){ toast(e.message); renderPrefs(); });
    }
    function renderPrefs(){
      var h = '<div class="setphead">Preferences</div>';
      h += '<div class="sgrouph">Appearance</div>';
      h += '<div class="prow"><div class="pl"><div class="pt">Theme</div>' +
        '<div class="pd">Light or dark. Open terminals repaint to match.</div></div>' +
        '<div class="pc">' + seg("theme", [{ v: "light", l: "Light" }, { v: "dark", l: "Dark" }], themeNow()) + "</div></div>";
      h += '<div id="projprefs"></div>';
      pane.innerHTML = h;
      bindSeg("theme", function(v){
        localStorage.setItem(THEME_KEY, v === "light" ? "light" : "dark");
        applyTheme();
        if (state.retheme) state.retheme();
      });
      var pp = document.getElementById("projprefs");
      if (!pid) { pp.innerHTML = '<div class="snote">Open a project to change how its brain learns and how handoff briefs are written.</div>'; return; }
      pp.innerHTML = LOADER;
      api("/api/projects/" + pid + "/config").then(function(cfg){
        var pname = state.project && state.project.name ? state.project.name : "this project";
        var hh = '<div class="sgrouph">Brain \\u00b7 ' + esc(pname) + "</div>";
        hh += '<div class="prow"><div class="pl"><div class="pt">Memory extractor</div>' +
          '<div class="pd">After each turn a small Claude reads what changed and files what\\u2019s worth keeping. Off means the brain holds only what you write by hand.</div></div>' +
          '<div class="pc">' + seg("extractor", [{ v: "auto", l: "Auto" }, { v: "off", l: "Off" }], cfg.brain.extractor) + "</div></div>";
        hh += '<div class="sgrouph">Handoffs</div>';
        hh += '<div class="prow"><div class="pl"><div class="pt">Brief style</div>' +
          '<div class="pd">How the baton note is written when one agent hands to the next. Template is instant and free; LLM distills it with a small Claude.</div></div>' +
          '<div class="pc">' + seg("projection", [{ v: "template", l: "Template" }, { v: "llm", l: "LLM" }], cfg.projection.mode) + "</div></div>";
        var agents = cfg.agents || [];
        hh += '<div class="prow"><div class="pl"><div class="pt">Default agent</div>' +
          '<div class="pd">Who receives a message when nobody holds the baton.</div></div>' +
          '<div class="pc"><select id="defagent"><option value="">First available</option>' +
          agents.map(function(a){ return '<option value="' + esc(a.id) + '"' + (a.id === cfg.defaultAgent ? " selected" : "") + ">" + esc(a.id) + "</option>"; }).join("") +
          "</select></div></div>";
        pp.innerHTML = hh;
        bindSeg("extractor", function(v){ patchCfg({ brain: { extractor: v } }, v === "off" ? "Extractor off" : "Extractor on"); });
        bindSeg("projection", function(v){ patchCfg({ projection: { mode: v } }, "Briefs: " + v); });
        document.getElementById("defagent").onchange = function(){ patchCfg({ defaultAgent: this.value }, "Default agent saved"); };
      }).catch(function(e){ pp.innerHTML = '<div class="snote">' + esc(e.message) + "</div>"; });
    }

    // ---- Updates: is this build current -------------------------------------
    function renderUpdates(){
      busy();
      api("/api/updates").then(function(u){
        var g = u.git;
        var behind = g && g.behind ? g.behind : 0;
        var shortRev = (u.rev || "").slice(0, 7);
        var h = '<div class="setphead">Updates</div>' +
          '<div class="setpsub">Whether this Loom is current \\u2014 the running build, and the code on disk.</div>';
        h += '<div class="pillrow">';
        if (u.root && behind > 0) h += '<span class="updpill warn">' + behind + " commit" + (behind > 1 ? "s" : "") + " behind</span>";
        else if (u.root && g && g.hasUpstream) h += '<span class="updpill ok">Up to date</span>';
        else h += '<span class="updpill ok">Build ' + esc(shortRev || "unknown") + "</span>";
        h += '<button class="btn ghost sm" id="updcheck">Check again</button></div>';
        h += '<dl class="abgrid"><dt>Version</dt><dd>' + esc(u.version) + "</dd>" +
          "<dt>Build</dt><dd>" + esc(shortRev || "\\u2014") + "</dd>";
        if (u.root) h += "<dt>Source</dt><dd>" + esc(u.root) + "</dd>";
        if (g && g.branch) h += "<dt>Branch</dt><dd>" + esc(g.branch) + (g.ahead ? " (+" + g.ahead + " local)" : "") + "</dd>";
        h += "</dl>";
        if (u.root && behind > 0) {
          h += '<div class="snote">A newer version is on your remote. Update in place, then restart the daemon:</div>';
          h += '<code class="scmd">cd ' + esc(u.root) + " && git pull --ff-only && npm install && npm run build\\nloom up --restart</code>";
        } else if (u.root && g && g.hasUpstream) {
          h += '<div class="snote">Your checkout matches its remote. If you just rebuilt, restart to pick it up:</div><code class="scmd">loom up --restart</code>';
        } else if (!u.root) {
          h += '<div class="snote">This Loom isn\\u2019t a git checkout, so there\\u2019s nothing to pull \\u2014 update it the way you installed it (npm, or the desktop app\\u2019s own updater).</div>';
        }
        pane.innerHTML = h;
        document.getElementById("updcheck").onclick = renderUpdates;
      }).catch(fail);
    }

    // ---- Devices: paired clients, revoke, add -------------------------------
    function pairNewDevice(){
      var out = document.getElementById("devpairout");
      out.innerHTML = LOADER;
      api("/api/pair/new", { method: "POST", body: "{}" }).then(function(p){
        var mins = p.expiresAt ? Math.max(1, Math.round((p.expiresAt - Date.now()) / 60000)) : 10;
        out.innerHTML = '<div class="snote">On the other device, open <b>' + esc(p.url) +
          "</b> and it will pair automatically from this link. It works once and expires in about " + mins + " minutes.</div>" +
          '<code class="scmd">' + esc(p.url) + "/#pair=" + esc(p.token) + "</code>";
      }).catch(function(e){
        // Only an admin client (the one holding the daemon's own token, i.e. the
        // desktop shell) may mint pairing tokens. A paired phone can't — say so,
        // and point at the CLI path that always works from this machine.
        var adminOnly = /admin/i.test(e.message || "");
        out.innerHTML = adminOnly
          ? '<div class="snote">Only an admin client can add a device from here. From a terminal on this machine:</div><code class="scmd">loom pair</code>'
          : '<div class="snote">' + esc(e.message) + "</div>";
      });
    }
    function revokeDevice(id){
      var me = id === state.clientId;
      if (!window.confirm(me ? "Revoke THIS device? You\\u2019ll be signed out and have to pair again."
        : "Revoke this device? Its token stops working immediately.")) return;
      api("/api/pair/clients/" + encodeURIComponent(id), { method: "DELETE" }).then(function(){
        if (me) { close(); logout(); return; }
        toast("device revoked");
        renderDevices();
      }).catch(function(e){ toast(e.message); });
    }
    function renderDevices(){
      busy();
      api("/api/pair/clients").then(function(d){
        var clients = d.clients || [];
        var h = '<div class="setphead">Devices</div>' +
          '<div class="setpsub">Every client paired to this Loom. Revoke one and its token stops working at once.</div>';
        h += '<div class="pillrow"><button class="btn primary sm" id="devpair">Pair a new device</button></div><div id="devpairout"></div>';
        if (!clients.length) h += '<div class="snote">No devices paired yet.</div>';
        clients.forEach(function(c){
          var me = c.id === state.clientId;
          h += '<div class="dev"><div class="di">' + ICONS.agents + "</div>" +
            '<div class="dn"><div class="dnt">' + esc(c.name || "device") + (me ? ' <span class="devme">this device</span>' : "") + "</div>" +
            '<div class="dnd">paired ' + rel(c.createdAt) + (c.push ? " \\u00b7 push on" : "") + "</div></div>" +
            '<button class="btn ghost sm" data-revoke="' + esc(c.id) + '">Revoke</button></div>';
        });
        pane.innerHTML = h;
        document.getElementById("devpair").onclick = pairNewDevice;
        Array.prototype.forEach.call(pane.querySelectorAll("[data-revoke]"), function(b){
          b.onclick = function(){ revokeDevice(b.getAttribute("data-revoke")); };
        });
      }).catch(fail);
    }

    // ---- About --------------------------------------------------------------
    function renderAbout(){
      busy();
      api("/api/health").then(function(hh){
        var shortRev = (hh.rev || "").slice(0, 7);
        var h = '<div class="abhead"><div class="abmark">lo<b>om</b></div>' +
          '<div><div style="font-size:13px;font-weight:600">Agent orchestration</div>' +
          '<div class="abver">v' + esc(hh.version) + " \\u00b7 " + esc(shortRev) + "</div></div></div>";
        h += '<div class="setpsub">One thread, many agents \\u2014 they share a working tree, a baton, and a brain.</div>';
        h += '<dl class="abgrid"><dt>Version</dt><dd>' + esc(hh.version) + "</dd>" +
          "<dt>Build</dt><dd>" + esc(hh.rev || "\\u2014") + "</dd>" +
          "<dt>Terminal</dt><dd>" + esc(hh.terminal || "\\u2014") + "</dd></dl>";
        h += '<div class="ablinks">' +
          '<a href="https://github.com/nickthelegend/loom" target="_blank" rel="noreferrer">' + ICONS.github + "GitHub</a>" +
          '<a href="https://github.com/nickthelegend/loom/blob/main/README.md" target="_blank" rel="noreferrer">' + ICONS.info + "Docs</a></div>";
        h += '<div class="setpsub" style="margin-top:16px">Brand marks by @lobehub/icons. The memory layer follows mem0.</div>';
        pane.innerHTML = h;
      }).catch(fail);
    }

    function render(){
      if (cur === "diagnostics") renderDiag();
      else if (cur === "preferences") renderPrefs();
      else if (cur === "updates") renderUpdates();
      else if (cur === "devices") renderDevices();
      else if (cur === "about") renderAbout();
      else renderSetup();
    }
    drawNav();
    render();
  }
  // The sidebar foot and the first-run nudge open Settings on its Setup section.
  function openSetupModal(){ openSettingsModal("setup"); }

  function openProjectModal(){
    if (document.querySelector(".scrim")) return;
    var native = !!(window.loomNative && window.loomNative.pickFolder);
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal">' +
      '<div class="modalhead">New project<button class="iconbtn" id="pclose" aria-label="close">' + ICONS.x + "</button></div>" +
      '<div class="modalbody">' +
        '<div class="field"><label>Project folder</label>' +
          '<div class="pickrow"><input id="pdir" spellcheck="false" autocomplete="off" placeholder="' +
            (native ? "choose a folder\\u2026" : "/path/to/repo on the daemon host") + '">' +
            (native ? '<button class="btn outline" id="pbrowse">Choose\\u2026</button>' : "") + "</div>" +
          '<span class="hintx">Loom writes a <code>.loom/</code> folder here and leaves the rest of the repo alone.</span></div>' +
        '<div class="field"><label>Name <span class="opt">optional</span></label>' +
          '<input id="pname" spellcheck="false" autocomplete="off" placeholder="defaults to the folder name"></div>' +
      "</div>" +
      '<div class="modalfoot"><button class="btn ghost" id="pcancel">Cancel</button>' +
      '<button class="btn primary" id="pcreate">Create project<span class="kbd">\\u2318\\u21b5</span></button></div>' +
    "</div>";
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("pclose").onclick = close;
    document.getElementById("pcancel").onclick = close;
    var dirEl = document.getElementById("pdir");
    if (native) document.getElementById("pbrowse").onclick = function(){
      window.loomNative.pickFolder().then(function(p){
        if (!p) return;
        dirEl.value = p;
        var nm = document.getElementById("pname");
        if (!nm.value) nm.placeholder = p.split(/[\\\\/]/).filter(Boolean).pop() || "";
      }).catch(function(err){ toast(String(err.message || err)); });
    };
    setTimeout(function(){ dirEl.focus(); }, 30);
    function create(){
      var dir = (dirEl.value || "").trim();
      if (!dir) return toast(native ? "choose a folder first" : "enter a directory path");
      var name = (document.getElementById("pname").value || "").trim();
      var btn = document.getElementById("pcreate"); btn.disabled = true;
      api("/api/projects", {
        method: "POST",
        body: JSON.stringify(name ? { dir: dir, name: name } : { dir: dir }),
      }).then(function(j){
        close();
        var p = j.project || {};
        // say what was actually detected rather than a bare "added"
        var found = ((j.config && j.config.agents) || []).filter(function(a){ return a.tier === "adapter"; });
        toast(found.length
          ? p.name + " \\u00b7 " + found.length + (found.length === 1 ? " ADE" : " ADEs") + ": " + found.map(function(a){ return a.id; }).join(", ")
          : p.name + " added \\u00b7 no ADE CLIs detected on this host");
        if (state.refreshProjects) state.refreshProjects();
        if (p.id) { if (state.selectProject) state.selectProject(p.id); else location.hash = "#p/" + p.id; }
      }).catch(function(err){ btn.disabled = false; toast(err.message); });
    }
    document.getElementById("pcreate").onclick = create;
    function onKey(e){
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); create(); }
    }
    document.addEventListener("keydown", onKey);
  }

  /**
   * The command palette — one search across the whole workspace, opened with
   * \\u2318K / Ctrl+K. Commands, agents and worktrees filter instantly; files,
   * code and conversations are asked of the daemon as you type. \\u2191\\u2193
   * move, \\u21b5 acts, esc closes. A flat item list drives the keyboard, so a
   * command and a code hit navigate the same way.
   */
  function openPalette(){
    if (document.querySelector(".scrim")) return; // one overlay at a time
    var pid = state.pid;
    var scrim = document.createElement("div");
    scrim.className = "scrim pscrim";
    scrim.innerHTML = '<div class="palette" role="dialog" aria-label="Search everything">' +
      '<div class="phead">' + ICONS.search +
        '<input id="pq" placeholder="Search files, code, agents, worktrees, commands\\u2026" autocomplete="off" spellcheck="false" aria-label="search everything">' +
        '<span class="pkbd">esc</span></div>' +
      '<div class="pbody" id="pbody"></div>' +
      '<div class="pfoot"><span><b>\\u2191\\u2193</b> navigate</span><span><b>\\u21b5</b> open</span><span><b>esc</b> close</span></div>' +
    "</div>";
    document.body.appendChild(scrim);
    var inp = document.getElementById("pq");
    var body = document.getElementById("pbody");
    var items = [], sel = 0, reqId = 0, curQ = "", acc = {}, wt = null, to = null;

    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey, true); }
    function onKey(e){
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); move(-1); return; }
      if (e.key === "Enter") { e.preventDefault(); activate(sel); return; }
    }
    document.addEventListener("keydown", onKey, true);
    scrim.addEventListener("mousedown", function(ev){ if (ev.target === scrim) close(); });

    function move(d){ if (!items.length) return; sel = (sel + d + items.length) % items.length; paint(); }
    function activate(i){ var it = items[i]; if (!it || !it.run) return; close(); try { it.run(); } catch (e) { toast(String((e && e.message) || e)); } }

    // subsequence match, so "brd" finds "Board" and "apst" finds "app-page.ts"
    function fuzzy(hay, q){
      hay = String(hay).toLowerCase(); q = q.toLowerCase();
      if (!q) return true;
      var i = 0;
      for (var c = 0; c < q.length; c++){ i = hay.indexOf(q.charAt(c), i); if (i < 0) return false; i++; }
      return true;
    }
    function shq(s){ return "'" + String(s).replace(/'/g, "'\\\\''") + "'"; } // POSIX single-quote

    var CMDS = buildCommands();
    function buildCommands(){
      var C = [];
      if (pid && state.showTab) {
        C.push({ icon: ICONS.thread, label: "Go to Thread", run: function(){ state.showTab("thread"); } });
        C.push({ icon: ICONS.board, label: "Go to Board", run: function(){ state.showTab("board"); } });
        C.push({ icon: ICONS.memory, label: "Go to Brain", run: function(){ state.showTab("brain"); } });
      }
      if (pid && state.showRail) {
        C.push({ icon: ICONS.files, label: "Explorer", sub: "panel", run: function(){ state.showRail("explorer"); } });
        C.push({ icon: ICONS.search, label: "Search in files", sub: "panel", run: function(){ state.showRail("search"); } });
        C.push({ icon: ICONS.branch, label: "Source Control", sub: "panel", run: function(){ state.showRail("scm"); } });
        C.push({ icon: ICONS.agents, label: "Agents", sub: "panel", run: function(){ state.showRail("tasks"); } });
      }
      C.push({ icon: ICONS.tasks, label: "New task", run: function(){ openTaskModal(pid); } });
      C.push({ icon: ICONS.folderPlus, label: "New project", run: function(){ openProjectModal(); } });
      C.push({ icon: ICONS.gear, label: "Settings", run: function(){ openSettingsModal("setup"); } });
      C.push({ icon: ICONS.console, label: "Diagnostics", sub: "loom doctor", run: function(){ openSettingsModal("diagnostics"); } });
      if (pid && state.toggleTerm) C.push({ icon: ICONS.terminal, label: "Toggle terminal", run: function(){ state.toggleTerm(); } });
      C.push({ icon: ICONS.sun, label: "Toggle theme", run: function(){ localStorage.setItem(THEME_KEY, themeNow() === "light" ? "dark" : "light"); applyTheme(); if (state.retheme) state.retheme(); } });
      return C;
    }

    function section(title, rows){
      if (!rows.length) return "";
      var h = '<div class="psec">' + esc(title) + "</div>";
      rows.forEach(function(r){
        r._i = items.length; items.push(r);
        h += '<div class="prow" data-i="' + r._i + '"><span class="pic">' +
          (r.markKind ? brandMark(r.markKind) : (r.icon || ICONS.file)) + "</span>" +
          '<span class="plabel">' + (r.html || esc(r.label)) + "</span>" +
          (r.sub ? '<span class="psub">' + esc(r.sub) + "</span>" : "") + "</div>";
      });
      return h;
    }

    function draw(){
      var q = curQ;
      items = [];
      var h = "";
      h += section("Commands", CMDS.filter(function(c){ return fuzzy(c.label + " " + (c.sub || ""), q); }).slice(0, q ? 8 : 24));
      var ags = (state.project && state.project.agents) || [];
      if (state.selectAgent) h += section("Agents", ags.filter(function(a){ return fuzzy(a.id + " " + (a.role || ""), q); }).map(function(a){
        return { markKind: a.kind, label: a.id, sub: (a.tier === "bridge" ? "bridge" : (a.role || "agent")) + " \\u00b7 talk to", run: function(){ state.selectAgent(a.id); } };
      }));
      if (state.termRun && wt) {
        var wts = wt.filter(function(w){ return !w.main && fuzzy((w.branch || "") + " " + w.path, q); });
        h += section("Worktrees", wts.map(function(w){
          return { icon: ICONS.branch, label: w.branch || "(detached)", sub: w.path,
                   run: function(){ state.termRun("cd " + shq(w.path)); toast("cd \\u2192 " + (w.branch || w.path)); } };
        }));
      }
      if (q && pid) {
        if (state.openFile && acc.files && acc.files.length) h += section("Files", acc.files.map(function(f){
          return { icon: ICONS.file, label: f, run: function(){ state.openFile(f); } };
        }));
        if (state.openFile && acc.code && acc.code.length) h += section("Code", acc.code.map(function(hit){
          return { icon: ICONS.search, label: hit.path,
                   html: '<span class="ppath">' + esc(hit.path) + ":" + hit.line + "</span> " + esc((hit.text || "").trim().slice(0, 90)),
                   run: function(){ state.openFile(hit.path); } };
        }));
        if (state.setChat && acc.chats && acc.chats.length) h += section("Conversations", acc.chats.map(function(c){
          return { icon: ICONS.chat, label: (c.snippet || "").trim().slice(0, 72) || c.chat, sub: c.chat,
                   run: function(){ state.setChat(pid, c.chat); } };
        }));
        var pending = acc.files === undefined || acc.code === undefined || acc.chats === undefined;
        if (pending) h += '<div class="pmore">searching the project\\u2026</div>';
      }
      if (!items.length && !q) h += '<div class="pmore">type to search \\u2014 files, code, agents, worktrees, commands</div>';
      body.innerHTML = h;
      if (sel >= items.length) sel = items.length ? items.length - 1 : 0;
      paint(); wireRows();
    }

    function paint(){
      Array.prototype.forEach.call(body.querySelectorAll(".prow"), function(el){
        el.classList.toggle("on", Number(el.getAttribute("data-i")) === sel);
      });
      var on = body.querySelector(".prow.on"); if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
    }
    function wireRows(){
      Array.prototype.forEach.call(body.querySelectorAll(".prow"), function(el){
        var i = Number(el.getAttribute("data-i"));
        el.onmousemove = function(){ if (sel !== i) { sel = i; paint(); } };
        el.onclick = function(){ activate(i); };
      });
    }
    function runAsync(){
      var my = reqId, q = curQ;
      var land = function(key, val){ if (my === reqId) { acc[key] = val; draw(); } };
      api("/api/projects/" + pid + "/find?q=" + encodeURIComponent(q))
        .then(function(j){ land("files", (j.matches || []).slice(0, 6)); }).catch(function(){ land("files", []); });
      api("/api/projects/" + pid + "/grep?q=" + encodeURIComponent(q))
        .then(function(j){ land("code", (j.hits || []).slice(0, 6)); }).catch(function(){ land("code", []); });
      api("/api/projects/" + pid + "/chats/search?q=" + encodeURIComponent(q))
        .then(function(j){ land("chats", (j.hits || []).slice(0, 5)); }).catch(function(){ land("chats", []); });
    }

    inp.oninput = function(){
      curQ = this.value.trim();
      acc = {}; reqId++;            // invalidate any in-flight async for the old query
      clearTimeout(to);
      draw();                       // instant: commands + agents + worktrees, filtered
      if (curQ && pid) to = setTimeout(runAsync, 170);
    };
    // worktrees once, up front — few, and useful in the default (empty) menu
    if (pid) api("/api/projects/" + pid + "/worktrees").then(function(j){ wt = j.worktrees || []; draw(); }).catch(function(){});
    draw();
    setTimeout(function(){ inp.focus(); }, 20);
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
        '<div class="topnav"><button class="navitem" id="newtask">' + ICONS.tasks + "New task<span class=\\"kbd\\">N</span></button>" +
        '<button class="navitem" id="newproj">' + ICONS.folderPlus + "New project<span class=\\"kbd\\">P</span></button></div>" +
        '<div class="snav">' + ICONS.search + '<input id="sfilter" placeholder="Search" autocomplete="off" spellcheck="false">' +
          '<button class="snkbd" id="palettebtn" type="button" title="Search everything (\\u2318K)" aria-label="open command palette">\\u2318K</button></div>' +
        '<div class="stitle">projects<button id="addproj" class="iconbtn" title="new project" aria-label="new project">' + ICONS.plus + "</button></div>" +
        '<div class="slist" id="slist">' + LOADER + "</div>" +
        '<div class="sfoot">' +
        '<a class="iconbtn" title="Loom on GitHub" href="https://github.com/nickthelegend/loom" target="_blank" rel="noreferrer">' + ICONS.help + "</a>" +
        '<button id="setupbtn" class="iconbtn" title="Settings" aria-label="settings">' + ICONS.gear + "</button>" +
        '<span class="spacer"></span>' +
        THEME_BTN +
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
          '<button class="iconbtn rvbtn" data-view="tasks" title="Agents" aria-label="Agents">' + ICONS.agents + "</button>" +
          '<span class="spacer"></span>' +
          '<button id="railrefresh" class="iconbtn" title="refresh">' + ICONS.refresh + "</button>" +
          // No second panel toggle. #railbtn in the tab strip is the one control
          // and it works both ways; this one wore the same icon a few inches
          // away and could only ever close — two buttons for one job, and you
          // had to learn which was which.
        "</div>" +
        '<div class="rhead" id="railtitle"><span class="b">Explorer</span></div>' +
        '<div class="rbody" id="railbody"><div class="rempty">select a project</div></div></aside>' +
      '<div class="statusbar" id="statusbar"></div>' +
      "</div>";
    document.getElementById("unpair").onclick = logout;
    document.getElementById("setupbtn").onclick = openSetupModal;
    // First run: show it rather than wait to be found. Someone who has just
    // paired has no agents set up and no reason to guess that the small icon in
    // the sidebar foot is where that happens — and Loom with nothing to drive
    // is a window with nothing in it. Once only; the button is always there.
    try {
      if (!localStorage.getItem(SETUP_SEEN_KEY)) {
        localStorage.setItem(SETUP_SEEN_KEY, "1");
        setTimeout(openSetupModal, 400);
      }
    } catch (e) {
      // private mode, no storage — the button still works
    }
    // The toggle lives in the shell's foot now, so bind it here — renderProject
    // also calls bindTheme, but it never runs when no project is selected.
    bindTheme();
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
    // The box narrows the project list instantly — that's a local filter over
    // names you already have — and a beat later searches inside the open
    // project's conversations. Two speeds on purpose: the list must not lag
    // your typing, and the search must not fire a request per keystroke.
    var chatTo;
    document.getElementById("sfilter").oninput = function(){
      filter = (this.value || "").trim().toLowerCase();
      drawList();
      clearTimeout(chatTo);
      chatTo = setTimeout(runChatSearch, 260);
    };
    document.getElementById("sfilter").onkeydown = function(e){
      if (e.key === "Escape") {
        this.value = ""; filter = ""; state.chatHits = null; drawList();
      }
    };
    document.getElementById("addproj").onclick = openProjectModal;
    document.getElementById("newproj").onclick = openProjectModal;
    var pbtn = document.getElementById("palettebtn");
    if (pbtn) pbtn.onclick = function(ev){ ev.preventDefault(); openPalette(); };
    state.refreshProjects = refresh;
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
    /**
     * Search the open project's conversations.
     *
     * Scoped to the open project: that's the thread you remember, and searching
     * every project's log on every keystroke is a different feature with a
     * different cost. Two characters minimum — one letter matches everything
     * and answers nothing.
     */
    function runChatSearch(){
      var q = (filter || "").trim();
      if (!cur || q.length < 2) {
        if (state.chatHits) { state.chatHits = null; drawList(); }
        return;
      }
      api("/api/projects/" + cur + "/chats/search?q=" + encodeURIComponent(q))
        .then(function(j){
          state.chatHits = { q: q, hits: j.hits || [], truncated: !!j.truncated };
          drawList();
        })
        .catch(function(){ /* the list still filters; a failed search shouldn't blank it */ });
    }

    /**
     * Matching messages, appended under whatever the list showed.
     *
     * Both paths call this — the one with projects and the one without —
     * because "no project called that" is usually the start of a search, not
     * the end of one.
     */
    function drawChatHits(el){
      var ch = state.chatHits;
      if (!ch || !ch.q || (filter || "").trim() !== ch.q) return;
      el.innerHTML += '<div class="stitle">in this conversation' +
        (ch.hits.length ? '<span class="cnt">' + ch.hits.length + (ch.truncated ? "+" : "") + "</span>" : "") +
        "</div>";
      el.innerHTML += ch.hits.length
        ? ch.hits.map(function(h){
            var who = h.agentId || "you";
            return '<div class="chit" data-hit-chat="' + esc(h.chat) + '" data-hit-id="' + h.eventId + '"' +
              ' title="open this message in ' + esc(h.chat) + '">' +
              '<span class="cw">' + esc(who) + "</span>" +
              '<span class="cs">' + highlight(h.snippet, ch.q) + "</span></div>";
          }).join("")
        : '<div class="rempty" style="padding:8px 10px">nothing in this project\u2019s messages either</div>';
      Array.prototype.forEach.call(el.querySelectorAll("[data-hit-chat]"), function(row){
        row.onclick = function(){ setChat(cur, row.getAttribute("data-hit-chat")); };
      });
    }

    // Which projects are expanded, remembered across reloads. Absent from the
    // map means "follow selection" — the current project opens on its own, so a
    // fresh user needs no clicks, and only an explicit toggle is persisted.
    function projOpenMap(){
      try { return JSON.parse(localStorage.getItem("loomProjOpen") || "{}"); } catch (e) { return {}; }
    }
    function isProjOpen(id, sel){
      var m = projOpenMap();
      return Object.prototype.hasOwnProperty.call(m, id) ? !!m[id] : !!sel;
    }
    function toggleProj(id, sel){
      var m = projOpenMap();
      var now = Object.prototype.hasOwnProperty.call(m, id) ? !!m[id] : !!sel;
      m[id] = !now;
      localStorage.setItem("loomProjOpen", JSON.stringify(m));
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
        // No project by that name is not the end of the search — it is usually the
        // start of one. The early return here meant the chat hits below never
        // rendered in the exact case you were searching for a message rather than
        // a project, which is the common case.
        el.innerHTML = '<div class="sys" style="padding:16px 8px">no project called \u201c' + esc(filter) + '\u201d</div>';
        drawChatHits(el);
        return;
      }
      el.innerHTML = shown.map(function(p){
        var r = p.route, act = r && (r.status === "running" || r.status === "waiting_human");
        var adapters = (p.agents || []).filter(function(a){ return a.tier === "adapter"; });
        var sel = p.id === cur;
        var open = isProjOpen(p.id, sel);
        var gh = hue(p.id + p.name);
        var rows = '<div class="srow' + (sel ? " sel" : "") + '" data-id="' + esc(p.id) + '">' +
          '<div class="n">' +
          '<button class="scaret' + (open ? " open" : "") + '" data-caret="' + esc(p.id) + '" aria-label="' + (open ? "collapse " : "expand ") + esc(p.name) + '" aria-expanded="' + (open ? "true" : "false") + '">' + ICONS.chevron + "</button>" +
          '<span class="pglyph' + (p.needsInput ? " hot" : "") + '" style="background:color-mix(in srgb, hsl(' + gh + ',60%,50%) 20%, transparent);color:hsl(' + gh + ',60%,var(--agent-l))">' + esc((p.name || "?").slice(0, 1).toUpperCase()) + '</span><span class="nm">' + esc(p.name) + "</span>" +
          (act ? '<span class="badge live" style="margin-left:auto">' + (r.current + 1) + "/" + r.steps.length + "</span>" : '<span class="cnt">' + adapters.length + "</span>") + "</div>" +
          '<div class="m">baton ' + esc(p.holder || "\\u2014") +
          (p.costUsd > 0 ? " \\u00b7 " + money(p.costUsd) : "") + "</div></div>";
        if (open) {
          // A project holds conversations. The agents that work them live in
          // the rail's roster — they belong to the project, not to one chat.
          var chats = p.chats || [{ id: "main", title: "Main", createdAt: 0 }];
          rows += chats.map(function(c){
            var curC = c.id === currentChat();
            return '<div class="crow' + (curC ? " cur" : "") + '" data-p="' + esc(p.id) +
              '" data-chat="' + esc(c.id) + '"' + (curC ? ' data-current="true"' : "") + ">" +
              '<span class="ci">' + ICONS.chat + "</span>" +
              '<span class="cnm">' + esc(c.title) + "</span>" +
              (c.id === "main"
                ? ""
                : '<button class="cx iconbtn" data-delchat="' + esc(c.id) +
                  '" title="forget this chat" aria-label="forget chat ' + esc(c.title) + '">' + ICONS.x + "</button>") +
              "</div>";
          }).join("");
          rows += '<div class="crow add" data-newchat="' + esc(p.id) + '">' +
            '<span class="ci">' + ICONS.plus + '</span><span class="cnm">New chat</span></div>';
        }
        return '<div class="sgroup">' + rows + "</div>";
      }).join("");

      drawChatHits(el);

      Array.prototype.forEach.call(el.querySelectorAll(".srow"), function(row){
        row.onclick = function(){ select(row.getAttribute("data-id")); };
      });
      // The caret opens/closes a project's chats without selecting it — so you
      // can peek at another project's conversations while staying in this one.
      // Selecting a project still auto-opens it (isProjOpen falls back to sel),
      // so the common path needs no extra click.
      Array.prototype.forEach.call(el.querySelectorAll("[data-caret]"), function(btn){
        btn.onclick = function(ev){
          ev.stopPropagation();
          var id = btn.getAttribute("data-caret");
          toggleProj(id, id === cur);
          drawList();
        };
      });
      // A hit takes you to the conversation it's in. It doesn't scroll to the
      // message yet — the thread loads its own tail — so this is honest about
      // being "open the chat", not "jump to line".
      Array.prototype.forEach.call(el.querySelectorAll("[data-hit-chat]"), function(row){
        row.onclick = function(){ setChat(cur, row.getAttribute("data-hit-chat")); };
      });
      // Switch conversation. Same project, same brain, same baton — a
      // different thread of talking.
      Array.prototype.forEach.call(el.querySelectorAll(".crow[data-chat]"), function(row){
        row.onclick = function(){
          var pidC = row.getAttribute("data-p"), cid = row.getAttribute("data-chat");
          setChat(pidC, cid);
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-delchat]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var cid = b.getAttribute("data-delchat");
          api("/api/projects/" + cur + "/chats/" + cid, { method: "DELETE" })
            .then(function(){
              // its events stay in the log; only the listing goes
              if (currentChat() === cid) setChat(cur, "main");
              refresh();
              toast("chat forgotten \\u00b7 its history stays in the brain");
            })
            .catch(function(err){ toast(err.message); });
        };
      });
      // Double-click to rename a conversation — it's your name for it.
      Array.prototype.forEach.call(el.querySelectorAll(".crow[data-chat]"), function(row){
        var cid = row.getAttribute("data-chat");
        if (cid === "main") return; // main's name isn't yours to change
        row.ondblclick = function(ev){
          ev.stopPropagation();
          var nm = row.querySelector(".cnm");
          if (!nm || nm.querySelector("input")) return;
          var was = nm.textContent;
          var inp = document.createElement("input");
          inp.className = "chatinput";
          inp.value = was;
          inp.maxLength = 60;
          nm.textContent = "";
          nm.appendChild(inp);
          inp.focus(); inp.select();
          var done = false;
          function finish(save){
            if (done) return; done = true;
            var next = inp.value.trim();
            if (!save || !next || next === was) { drawList(); return; }
            api("/api/projects/" + cur + "/chats/" + cid + "/rename",
                { method: "POST", body: JSON.stringify({ title: next }) })
              .then(function(){ refresh(); })
              .catch(function(err){ toast(err.message); drawList(); });
          }
          inp.onkeydown = function(e){
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            else if (e.key === "Escape") { e.preventDefault(); finish(false); }
          };
          inp.onblur = function(){ finish(true); };
          inp.onclick = function(e){ e.stopPropagation(); };
        };
      });
      // Every open project has a New chat row now, not just the selected one.
      Array.prototype.forEach.call(el.querySelectorAll("[data-newchat]"), function(addRow){
        addRow.onclick = function(ev){
          ev.stopPropagation();
          var pidN = addRow.getAttribute("data-newchat");
          var proj = (state.projects || []).filter(function(p){ return p.id === pidN; })[0];
          openChatAgentPick(addRow, proj, function(agentId){ createChatWith(pidN, agentId); });
        };
      });
    }

    /**
     * Make a chat and start it on the agent you chose.
     *
     * The baton is per-project, so "which agent answers this chat" is "who holds
     * the baton" — picking one hands it over. That's why a new chat used to
     * always land on opencode: nobody was asked, so it stayed with whoever held
     * it. A bridge can't hold the baton, so choosing one just aims the composer
     * at it (pendingSelect), and its own ask-flow does the rest.
     */
    function createChatWith(pidN, agentId){
      api("/api/projects/" + pidN + "/chats", { method: "POST", body: "{}" })
        .then(function(j){
          var chatId = j.chat.id;
          var proj = (state.projects || []).filter(function(p){ return p.id === pidN; })[0];
          var picked = proj && (proj.agents || []).filter(function(a){ return a.id === agentId; })[0];
          state.pendingSelect = agentId || null;
          var done = function(){ refresh(); setChat(pidN, chatId); };
          if (picked && picked.tier === "adapter" && proj.holder !== agentId) {
            api("/api/projects/" + pidN + "/handoff", { method: "POST", body: JSON.stringify({ to: agentId }) })
              .then(done).catch(function(err){ toast(err.message); done(); });
          } else { done(); }
        })
        .catch(function(err){ toast(err.message); });
    }

    /** A little popover of a project's agents, anchored to the New chat row. */
    function openChatAgentPick(anchor, proj, onPick){
      closeAgentPick();
      var agents = (proj && proj.agents) || [];
      if (!agents.length) { onPick(null); return; } // nothing to choose — just make it
      var pop = document.createElement("div");
      pop.className = "pickpop"; pop.id = "chatpick";
      pop.innerHTML = '<div class="pickhead">start this chat with</div>' +
        agents.map(function(a){
          var bridge = a.tier === "bridge";
          return '<button class="pickrow" data-pick="' + esc(a.id) + '">' +
            brandMark(a.kind) + '<span class="pnm">' + esc(a.id) + "</span>" +
            '<span class="prole">' + esc(bridge ? "bridge" : a.role) + "</span></button>";
        }).join("");
      document.body.appendChild(pop);
      var r = anchor.getBoundingClientRect();
      pop.style.left = Math.round(r.left) + "px";
      pop.style.top = Math.round(r.bottom + 4) + "px";
      // If it would fall off the bottom, flip above the row.
      var ph = pop.getBoundingClientRect().height;
      if (r.bottom + 4 + ph > window.innerHeight) pop.style.top = Math.max(8, Math.round(r.top - ph - 4)) + "px";
      Array.prototype.forEach.call(pop.querySelectorAll("[data-pick]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); var id = b.getAttribute("data-pick"); closeAgentPick(); onPick(id); };
      });
      setTimeout(function(){
        document.addEventListener("mousedown", agentPickAway);
      }, 0);
    }
    function agentPickAway(ev){
      var pop = document.getElementById("chatpick");
      if (pop && !pop.contains(ev.target)) closeAgentPick();
    }
    function closeAgentPick(){
      document.removeEventListener("mousedown", agentPickAway);
      var pop = document.getElementById("chatpick");
      if (pop) pop.remove();
    }
    function select(pid){
      cur = pid;
      history.replaceState(null, "", "#p/" + pid);
      renderProject(pid, dmain, true);
      drawList();
    }
    state.selectProject = select;
    state.setChat = setChat; // the palette jumps to a conversation by id
    /** The conversation you're in, per project, remembered across reloads. */
    function currentChat(){
      if (!cur) return "main";
      try { return localStorage.getItem("loomChat:" + cur) || "main"; } catch (e) { return "main"; }
    }
    function setChat(pidC, cid){
      try { localStorage.setItem("loomChat:" + pidC, cid); } catch (e) {}
      if (pidC !== cur) { select(pidC); return; }
      state.chat = cid;
      renderProject(cur, dmain, true); // reload the thread for this chat
      drawList();
    }
    state.currentChat = currentChat;
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
    loadGithub(); // fills the status-bar GitHub badge
    loadLoomPad(); // fills the status-bar LoomPad connectivity pill
    state.shellTimer = setInterval(refresh, 5000);
  }

  function route(){
    applyTheme();
    // drop every hook the old view installed — each closes over that render's
    // DOM and state (retheme holds its terminals), and the next view reinstalls
    // whichever ones it owns
    state.toggleTerm = null;
    state.selectProject = null;
    state.drawRail = null;
    state.startTerminals = null;
    state.retheme = null;
    // palette hooks close over the old render's DOM — drop them too
    state.openFile = null; state.showTab = null; state.showRail = null;
    state.selectAgent = null; state.termRun = null; state.setChat = null;
    state.reloadBoard = null;
    if (!state.token) return renderPair();
    if (isDesktop()) return renderShell();
    var m = location.hash.match(/^#p\\/(.+)$/);
    if (m) return renderProject(m[1], root, false);
    renderBoard();
  }
  window.addEventListener("hashchange", function(){
    if (!isDesktop()) return route();
    // The desktop shell navigates with replaceState, so this only fires for a
    // hash someone typed or pasted — honour it instead of ignoring the URL.
    var m = location.hash.match(/^#p\\/(.+)$/);
    if (!m || !state.selectProject) return;
    var known = (state.projects || []).some(function(p){ return p.id === m[1]; });
    if (known) state.selectProject(m[1]);
  });
  mq.addEventListener("change", function(){ clearShell(); route(); });
  // Global shortcuts: Ctrl+backtick toggles the terminal; "n" opens New task
  // (both only while a desktop workspace is mounted, never while typing).
  function typingInField(t){
    if (!t) return false;
    var tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
  }
  document.addEventListener("keydown", function(e){
    // ⌘K / Ctrl+K — the command palette, from anywhere (even mid-type)
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
      if (state.token && !document.querySelector(".scrim")) { e.preventDefault(); openPalette(); }
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "\`" || e.key === "~")) {
      if (state.toggleTerm) { e.preventDefault(); state.toggleTerm(); }
      return;
    }
    if ((e.key === "n" || e.key === "p") && !e.metaKey && !e.ctrlKey && !e.altKey &&
        isDesktop() && state.token && !typingInField(e.target) && !document.querySelector(".scrim")) {
      e.preventDefault();
      if (e.key === "n") openTaskModal(state.pid); else openProjectModal();
    }
  });
  // Same-machine window? Ask the daemon for the admin token so this becomes the
  // local admin console — pair phones, open phone access. Remote windows (a phone
  // on the tailnet) get 403 here and pair like any other device. In-memory only:
  // we never persist the admin token, so a stale one can't outlive a restart.
  function bootstrapAdmin(){
    return fetch("/api/bootstrap").then(function(r){
      if (!r.ok) return false;
      return r.json().then(function(j){
        if (j && j.token) { state.token = j.token; state.admin = true; return true; }
        return false;
      });
    }).catch(function(){ return false; });
  }
  bootstrapAdmin().then(function(){
    return pairFromHash();
  }).then(function(paired){
    if (paired) toast("paired \\u2713");
    route();
  }).catch(function(err){ toast(err.message); route(); });
})();
</script>
</body>
</html>`;
