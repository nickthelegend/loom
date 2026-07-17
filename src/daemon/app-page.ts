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
    width:34px;height:34px;border-radius:17px;background:var(--primary);color:var(--primary-foreground);
    transition:opacity .15s,transform .1s}
  .sendbtn:hover{opacity:.9}
  .sendbtn:active{transform:scale(.96)}
  .sendbtn svg{width:16px;height:16px}
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
  .rsec .gn{font-family:var(--font-mono);opacity:.65;margin-left:5px;font-weight:400}
  .rsec .lnk{margin-left:auto;font-size:10.5px;color:var(--muted-foreground);cursor:pointer;
    background:none;border:0;padding:0 2px}
  .rsec .lnk:hover{color:var(--foreground);text-decoration:underline}
  .frow.git{align-items:center}
  .frow.git .fp{cursor:pointer}
  .frow.git .fp:hover{text-decoration:underline}
  .gacts{margin-left:auto;display:none;gap:1px;flex:none}
  .frow.git:hover .gacts{display:flex}
  .iconbtn.xs{width:20px;height:20px;border-radius:5px}
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
  .conwrap{position:absolute;inset:0;display:none;flex-direction:column;overflow:hidden}
  .conwrap.on{display:flex}
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
  /* Setup: a status list, not a form. Wider than the other modals because every
     row carries a command you're meant to copy, and wrapping a shell command
     mid-flag makes it useless. */
  .modal.wide{max-width:620px}
  .setupbody{gap:0;padding:8px 16px 16px}
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
  var THEME_KEY = "loomTheme";
  // Shown once, unprompted, on a client that has never seen it.
  var SETUP_SEEN_KEY = "loomSetupSeen";
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
        return '<div class="msg user"><div class="bubble">' + esc(p.text) + "</div></div>";
      }
      var h = hue(e.agentId);
      return '<div class="msg agent"><div class="who" style="color:hsl(' + h + ',60%,var(--agent-l))">' +
        brandMark(kindOf(e.agentId)) + esc(e.agentId) +
        '</div><div class="bubble" style="border-left-color:hsl(' + h + ',50%,var(--selvage-l))">' + esc(p.text) + "</div></div>";
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
    state.pid = pid; state.lastId = 0; state.selected = null;
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
    var composerHtml =
      '<div class="composer" id="composerwrap"><form class="inner" id="cform">' +
      '<input id="box" placeholder="Message&hellip;" autocomplete="off">' +
      '<button class="sendbtn" id="send" type="submit" title="send">' + ICONS.up + "</button>" +
      '<button class="sendbtn stopbtn" id="stop" type="button" title="interrupt" aria-label="interrupt" style="display:none">' +
      ICONS.stop + "</button></form>" +
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
      var tabs = ["thread", "board", "brain"];
      if (tabs.indexOf(state.tab) < 0) state.tab = "thread";
      var LBL = { thread: [ICONS.thread, "Thread"], board: [ICONS.board, "Board"],
                  brain: [ICONS.memory, "Brain"] };
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
      ["thread", "board", "brain"].forEach(function(t){
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
      if (name === "thread") {
        var sc = document.getElementById("pane-thread");
        if (sc) sc.scrollTop = sc.scrollHeight;
      }
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
      document.getElementById("termbtn").onclick = toggleTerm;
      bindConsole();
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
      box.innerHTML = terms.map(function(t){
        return '<span class="termtab' + (t.id === activeTerm ? " active" : "") + '" data-t="' + t.id + '">' +
          (t.busy ? '<span class="busy" style="width:8px;height:8px;color:var(--live)"></span>' : "") +
          esc(t.title) + '<span class="tx" data-close="' + t.id + '">' + ICONS.x + "</span></span>";
      }).join("");
      Array.prototype.forEach.call(box.querySelectorAll(".termtab"), function(el){
        el.onclick = function(ev){
          var c = ev.target.closest ? ev.target.closest("[data-close]") : null;
          if (c) { closeTerm(c.getAttribute("data-close")); return; }
          activeTerm = el.getAttribute("data-t");
          drawTermTabs(); showTermPane(); drawPrompt(); fitActive(); focusTerm();
        };
      });
    }
    function showTermPane(){
      Array.prototype.forEach.call(document.querySelectorAll(".termpane"), function(p){
        p.classList.toggle("active", p.getAttribute("data-t") === activeTerm);
      });
      var t = curTerm();
      var form = document.getElementById("termform");
      // the input line belongs to the fallback only — a pty takes keys directly
      if (form) form.style.display = t && !t.xterm && termMode === "pipe" ? "" : "none";
      if (t && t.fit) { try { t.fit.fit(); } catch (e) {} }
    }
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
    function refreshBrain(){
      var el = document.getElementById("pane-brain"); if (!el) return;
      el.innerHTML = '<div class="pane-inner">' + LOADER + "</div>";
      api("/api/projects/" + pid + "/memory").then(function(j){
        el = document.getElementById("pane-brain"); if (!el) return;
        var m = j.memory || {};
        var sources = m.sources || [], decisions = m.decisions || [], doc = m.document || "";

        // What the brain is, in three numbers. "0 sources" is the single most
        // useful thing this tab can tell you — it means every handoff carries
        // the thread and nothing your agents wrote down.
        var head = '<div class="bstats">' +
          '<div class="bstat"><span class="n">' + sources.length + '</span><span class="l">ADE source' + (sources.length === 1 ? "" : "s") + "</span></div>" +
          '<div class="bstat"><span class="n">' + decisions.length + '</span><span class="l">decision' + (decisions.length === 1 ? "" : "s") + "</span></div>" +
          '<div class="bstat"><span class="n">' + Math.round(doc.length / 1024 * 10) / 10 + 'k</span><span class="l">projected</span></div>' +
          '<span style="flex:1"></span>' +
          '<button class="btn sm" id="reimport">Re-import</button>' +
          "</div>";

        // Decisions: the part of the brain you write. They ride in every
        // briefing, so they're the one thing here that changes what an agent
        // does rather than just what it could read.
        var dec = '<div class="bsec">Decisions<span class="bhint">carried into every handoff</span></div>' +
          '<form class="badd" id="decform">' +
          '<input id="decbox" placeholder="A decision this project has made…" autocomplete="off">' +
          '<button class="btn primary sm" type="submit">Add</button></form>';
        dec += decisions.length
          ? '<div class="bdecs">' + decisions.map(function(d){
              return '<div class="bdec"><span class="dm">•</span><span class="dt">' + esc(d) + "</span></div>";
            }).join("") + "</div>"
          : '<div class="bempty">Nothing decided yet. Anything you write here is repeated to every agent on every handoff — the things you would otherwise say twice.</div>';

        // Sources: what each ADE wrote down, and what Loom found.
        var src = '<div class="bsec">Imported from your agents<span class="bhint">their own memory files</span></div>';
        src += sources.length
          ? '<div class="bsrcs">' + sources.map(function(s){
              return '<div class="bsrc">' + brandMark(s.kind) +
                '<span class="si">' + esc(s.agentId) + "</span>" +
                '<span class="sf mono">' + esc(s.file) + "</span>" +
                '<span class="sc">' + Math.round(s.chars / 1024 * 10) / 10 + "k</span></div>";
            }).join("") + "</div>"
          : '<div class="bempty">No agent memory found in this repo. Loom reads what your ADEs already keep — CLAUDE.md, AGENTS.md, .kiro/steering — and never writes to them. Nothing here means there is nothing to read yet, not that it failed.</div>';

        // The projection: the actual text an agent receives. Shown because
        // "shared memory" is a claim, and this is the evidence.
        var body = '<div class="bsec">What every agent receives<span class="bhint">the projection, verbatim</span></div>' +
          '<div class="bdoc">' + renderBrainDoc(doc) + "</div>";

        el.innerHTML = '<div class="pane-inner brain">' + head + dec + src + body + "</div>";

        document.getElementById("reimport").onclick = function(){
          api("/api/projects/" + pid + "/memory/import", { method: "POST", body: "{}" })
            .then(function(r){
              toast(r.imported ? "imported " + r.imported + " source(s)" : "brain already current — nothing new to read");
              refreshBrain();
            })
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

    /**
     * The brain document, with its shape kept.
     *
     * It used to be one grey line per line of text, headings included, which
     * made a structured document look like a log dump. Headings are headings,
     * bullets are bullets, and the rest is prose — the projection has structure
     * and hiding it doesn't make it shorter.
     */
    function renderBrainDoc(doc){
      if (!String(doc).trim()) return '<div class="bempty">nothing projected yet</div>';
      // Every escape below is doubled. This file is one TS template literal, so
      // a lone \\s or \\d isn't merely eaten — an unrecognised escape is a hard
      // parse error in an untagged template, and the whole app fails to build.
      return String(doc).split("\\n").map(function(line){
        var t = line.trim();
        if (!t) return '<div class="bl sp"></div>';
        if (t.charAt(0) === "#") {
          var depth = t.length - t.replace(/^#+/, "").length;
          return '<div class="bl h' + Math.min(depth, 3) + '">' + esc(t.replace(/^#+\\s*/, "")) + "</div>";
        }
        if (t.charAt(0) === "-" || t.charAt(0) === "*" || /^\\d+\\./.test(t)) {
          return '<div class="bl li">' + esc(t.replace(/^[-*]\\s*/, "")) + "</div>";
        }
        return '<div class="bl">' + esc(line) + "</div>";
      }).join("");
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
    var board = { data: null, loading: false, pins: null, q: "" };
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
    function drawBoardPane(){
      var el = document.getElementById("pane-board"); if (!el) return;
      var d = board.data;
      var head = '<div class="bhead"><span class="bt">Board</span>' +
        '<span class="bs">Work flowing from working \\u2192 review \\u2192 merge.</span>' +
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
        "</div></div>";
    }
    function wireBoardHead(){
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

    /**
     * Mark the match inside a line.
     *
     * esc() first, always: this is a line of someone's source code, and it will
     * contain angle brackets. Escaping after inserting the mark would eat the
     * mark; escaping the query too means a search for "<div" highlights rather
     * than injects.
     */
    function highlight(text, q){
      var safe = esc(String(text));
      var needle = esc(String(q));
      var at = safe.toLowerCase().indexOf(needle.toLowerCase());
      if (at < 0) return safe;
      return safe.slice(0, at) + '<mark>' + safe.slice(at, at + needle.length) + "</mark>" + safe.slice(at + needle.length);
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
      if (!g.branch) { el.innerHTML = html + '<div class="rempty">not a git repository</div>'; return; }

      // Branch and distance from upstream: "3 ahead" is the difference between
      // "I pushed" and "I thought I pushed".
      html += '<div class="gbranch">' + ICONS.branch + '<span class="bn">' + esc(g.branch) + "</span>" +
        (g.ahead ? '<span class="gcount">↑' + g.ahead + "</span>" : "") +
        (g.behind ? '<span class="gcount">↓' + g.behind + "</span>" : "") +
        (g.upstream ? "" : '<span class="gcount dim">no upstream</span>') + "</div>";

      var staged = g.staged || [], unstaged = g.unstaged || [], untracked = g.untracked || [];
      if (!staged.length && !unstaged.length && !untracked.length) {
        el.innerHTML = html + '<div class="rempty">clean — nothing to commit</div>';
        return;
      }

      function fileRow(f, kind){
        var st = String(f.status || "?").trim() || "?";
        var pth = f.path;
        var cls = st.indexOf("D") >= 0 ? "del" : (st === "?" || st === "A" ? "add" : "mod");
        return '<div class="frow git" data-file="' + esc(pth) + '">' +
          '<span class="fst ' + cls + '">' + esc(st) + "</span>" +
          '<span class="fp" data-open="' + esc(pth) + '">' + esc(pth) + "</span>" +
          '<span class="gacts">' +
          (kind === "staged"
            ? '<button class="iconbtn xs" data-unstage="' + esc(pth) + '" title="unstage">' + ICONS.minus + "</button>"
            : '<button class="iconbtn xs" data-discard="' + esc(pth) + '" data-untracked="' + (kind === "untracked" ? "1" : "") + '" title="discard changes">' + ICONS.x + "</button>" +
              '<button class="iconbtn xs" data-stage="' + esc(pth) + '" title="stage">' + ICONS.plus + "</button>") +
          "</span></div>";
      }

      if (staged.length) {
        html += '<div class="rsec">Staged <span class="gn">' + staged.length + "</span>" +
          '<button class="lnk" id="unstageall">unstage all</button></div>';
        html += staged.map(function(f){ return fileRow(f, "staged"); }).join("");
        html += '<form class="gcommit" id="gcommitform">' +
          '<input id="gmsg" placeholder="Message · what changed and why" autocomplete="off">' +
          '<button class="btn primary sm" type="submit" id="gcommitbtn">Commit ' + staged.length + " file" + (staged.length === 1 ? "" : "s") + "</button>" +
          "</form>";
      }
      if (unstaged.length) {
        html += '<div class="rsec">Changes <span class="gn">' + unstaged.length + "</span>" +
          '<button class="lnk" id="stageall">stage all</button></div>';
        html += unstaged.map(function(f){ return fileRow(f, "unstaged"); }).join("");
      }
      if (untracked.length) {
        html += '<div class="rsec">Untracked <span class="gn">' + untracked.length + "</span></div>";
        html += untracked.map(function(f){ return fileRow({ path: f, status: "?" }, "untracked"); }).join("");
      }
      el.innerHTML = html;
      wireGitRows(el);
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
        var all = (g.unstaged || []).map(function(f){ return f.path; }).concat(g.untracked || []);
        if (all.length) act("stage", { paths: all });
      };
      var ua = document.getElementById("unstageall");
      if (ua) ua.onclick = function(){
        var g = state.git || {};
        var all = (g.staged || []).map(function(f){ return f.path; });
        if (all.length) act("unstage", { paths: all });
      };
      var form = document.getElementById("gcommitform");
      if (form) form.onsubmit = function(ev){
        ev.preventDefault();
        var box = document.getElementById("gmsg");
        var msg = (box.value || "").trim();
        if (!msg) return toast("a commit needs a message");
        var btn = document.getElementById("gcommitbtn");
        if (btn) btn.disabled = true;
        api("/api/projects/" + pid + "/git/commit", { method: "POST", body: JSON.stringify({ message: msg }) })
          .then(function(r){
            box.value = "";
            toast("committed " + r.sha + " · " + r.files + " file" + (r.files === 1 ? "" : "s"));
            refreshGit();
            refreshTree(false);
          })
          .catch(function(e){ toast(e.message); })
          .then(function(){ if (btn) btn.disabled = false; });
      };
    }

    /** What git thinks, then redraw if that's what you're looking at. */
    function refreshGit(){
      return api("/api/projects/" + pid + "/git/status").then(function(g){
        state.git = g;
        if (state.railView === "scm") drawRail();
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
      var ws = new WebSocket(proto + location.host + "/ws?token=" + encodeURIComponent(state.token) + "&project=" + encodeURIComponent(pid));
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

    function send(){
      var box = document.getElementById("box");
      var text = (box.value || "").trim();
      if (!text) return;
      box.value = "";
      var p = state.project || {};

      // A bridge is driven, not handed a turn: Loom types into Antigravity's or
      // Kiro's own window and waits for the panel to settle. No handoff, because
      // it never takes the baton — whichever adapter holds it keeps it.
      var sel = (p.agents || []).filter(function(a){ return a.id === state.selected; })[0];
      if (sel && sel.tier === "bridge") {
        toast("typing into " + sel.id + "\\u2026");
        api("/api/projects/" + pid + "/bridge/" + encodeURIComponent(sel.id) + "/ask", {
          method: "POST", body: JSON.stringify({ text: text, chat: chatId }),
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
          body: JSON.stringify({ text: text, agentId: state.selected || undefined, chat: chatId }) });
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
  // ---- Console ------------------------------------------------------------
  // Everything that went wrong, in the drawer with the terminals.
  //
  // Errors used to have two fates: ~/.loom/daemon.log, which you have to know
  // exists and tail, or one of the many empty catch blocks, where they stopped
  // existing. Neither reaches the person looking at the window wondering why
  // nothing happened. Records arrive live over the same socket as events.
  var con = { logs: [], level: "all", open: false, seen: 0, expanded: {} };

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
    if (con.open) { drawConsole(); con.seen = r.id; }
    drawErrDot();
  }

  function openConsole(){
    con.open = true;
    var wrap = document.getElementById("conwrap");
    if (wrap) wrap.classList.add("on");
    // The dock has to be open for the Console to be visible in it. termOpen()
    // and toggleTerm() belong to renderProject's scope, not this one — calling
    // them from here throws a ReferenceError inside the click handler and the
    // button does nothing at all. state.toggleTerm is the hook renderProject
    // publishes for exactly this; the ctrl-backtick shortcut uses it too.
    // (And no, that shortcut cannot be written with the actual character here:
    // one raw backtick ends this whole template literal.)
    if (localStorage.getItem("loomTerm") !== "1" && state.toggleTerm) state.toggleTerm();
    // Mark what's on screen as seen — the dot is about news, not history.
    con.logs.forEach(function(r){ if (r.id > con.seen) con.seen = r.id; });
    drawConsole();
    drawErrDot();
  }

  function closeConsole(){
    con.open = false;
    var wrap = document.getElementById("conwrap");
    if (wrap) wrap.classList.remove("on");
    drawErrDot();
  }

  function bindConsole(){
    var btn = document.getElementById("consolebtn");
    if (btn) btn.onclick = function(){ con.open ? closeConsole() : openConsole(); };
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
   * Setup — what this machine still needs, answered by the daemon that can see
   * it.
   *
   * Everything is read from /api/setup rather than baked into the page: the
   * page cannot know whether you have codex installed, and the daemon can. A
   * checklist that says the same thing on every machine is a brochure, not a
   * setup screen.
   */
  function openSetupModal(){
    if (document.querySelector(".scrim")) return;
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal wide">' +
      '<div class="modalhead">Setup<button class="iconbtn" id="sclose" aria-label="close">' + ICONS.x + "</button></div>" +
      '<div class="modalbody setupbody" id="setupbody">' + LOADER + "</div>" +
      '<div class="modalfoot"><span class="hintx" id="setupfoot"></span><span class="spacer"></span>' +
      '<button class="btn ghost" id="srefresh">Re-check</button>' +
      '<button class="btn primary" id="sdone">Done</button></div>' +
    "</div>";
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("sclose").onclick = close;
    document.getElementById("sdone").onclick = close;
    document.getElementById("srefresh").onclick = function(){ load(); };

    function row(state, title, detail, cmd){
      return '<div class="srow2">' +
        '<span class="sdot ' + state + '"></span>' +
        '<div class="sbody"><div class="st">' + title + "</div>" +
        (detail ? '<div class="sd">' + detail + "</div>" : "") +
        (cmd ? '<code class="scmd">' + esc(cmd) + "</code>" : "") +
        "</div></div>";
    }

    function load(){
      var body = document.getElementById("setupbody");
      body.innerHTML = LOADER;
      api("/api/setup").then(function(s){
        var osname = s.platform === "darwin" ? "macOS" : s.platform === "win32" ? "Windows" : "Linux";
        var html = "";

        html += '<div class="sgrouph">Runtime</div>';
        html += row(s.node.ok ? "ok" : "bad", "Node " + esc(s.node.version),
          s.node.ok ? "new enough for the event log"
            : "Loom needs \\u2265" + esc(s.node.needed) + " \\u2014 on anything older your history is silently dropped",
          s.node.ok ? "" : (s.platform === "darwin" ? "brew install node"
            : s.platform === "win32" ? "winget install OpenJS.NodeJS" : "install node 22.5 or newer"));

        html += '<div class="sgrouph">Agents that can take a turn</div>';
        if (!s.ready) {
          html += '<div class="snote">Nothing here can hold the baton yet \\u2014 install one and Loom has something to drive.</div>';
        }
        s.agents.forEach(function(a){
          // Three states, not two. "Installed" was the lie that cost an
          // afternoon: claude answered --version happily while refusing every
          // turn with "Not logged in".
          var state = !a.found ? "warn" : a.authed === false ? "bad" : a.authed === true ? "ok" : "warn";
          var detail = !a.found ? "not installed"
            : a.authed === true ? "signed in \\u00b7 ready to take a turn"
            : a.authed === false ? (a.authDetail || "signed out") + " \\u2014 it will refuse every turn until you:"
            : "installed \\u2014 couldn\\u2019t confirm it\\u2019s signed in:";
          html += row(state, brandMark(a.kind) + " " + esc(a.label), esc(detail),
            !a.found ? a.install : a.authed === true ? "" : a.auth);
        });

        html += '<div class="sgrouph">Agents you drive in their own window</div>';
        s.bridges.forEach(function(b){
          html += row(b.driveable ? "ok" : b.reachable ? "warn" : "off",
            brandMark(b.kind) + " " + esc(b.label) + ' <span class="sport">:' + b.port + "</span>",
            b.driveable ? "ready to drive" : esc(b.reason || "not running"),
            b.driveable ? "" : b.launch);
        });

        html += '<div class="sgrouph">Permissions on ' + osname + "</div>";
        s.permissions.forEach(function(p){
          html += '<div class="srow2">' +
            '<span class="sdot ' + (p.refused ? "no" : "info") + '"></span>' +
            '<div class="sbody"><div class="st">' + esc(p.title) + (p.refused ? ' <span class="sport">not needed</span>' : "") + "</div>" +
            '<div class="sd">' + esc(p.why) + "</div>" +
            '<div class="sd how">' + esc(p.how) + "</div></div></div>";
        });

        html += '<div class="sgrouph">Your phone</div>';
        html += row("info", "Let it reach this machine",
          "Loom listens on localhost by default, which your phone can\\u2019t see.", "loom up --restart --tailnet");
        html += row("info", "Pair the device", "Prints a QR code. Single use.", "loom pair");

        body.innerHTML = html;
        document.getElementById("setupfoot").textContent =
          s.ready ? "This machine can run agents." : "No agents installed yet.";
      }).catch(function(err){
        body.innerHTML = '<div class="snote">Couldn\\u2019t read setup: ' + esc(err.message) + "</div>";
      });
    }
    load();
  }

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
        '<div class="snav">' + ICONS.search + '<input id="sfilter" placeholder="Search" autocomplete="off" spellcheck="false"></div>' +
        '<div class="stitle">projects<button id="addproj" class="iconbtn" title="new project" aria-label="new project">' + ICONS.plus + "</button></div>" +
        '<div class="slist" id="slist">' + LOADER + "</div>" +
        '<div class="sfoot">' +
        '<a class="iconbtn" title="Loom on GitHub" href="https://github.com/nickthelegend/loom" target="_blank" rel="noreferrer">' + ICONS.help + "</a>" +
        '<button id="setupbtn" class="iconbtn" title="Setup and permissions" aria-label="setup and permissions">' + ICONS.gear + "</button>" +
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
    document.getElementById("sfilter").oninput = function(){
      filter = (this.value || "").trim().toLowerCase();
      drawList();
    };
    document.getElementById("addproj").onclick = openProjectModal;
    document.getElementById("newproj").onclick = openProjectModal;
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
      Array.prototype.forEach.call(el.querySelectorAll(".srow"), function(row){
        row.onclick = function(){ select(row.getAttribute("data-id")); };
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
      var addRow = el.querySelector("[data-newchat]");
      if (addRow) addRow.onclick = function(){
        var pidN = addRow.getAttribute("data-newchat");
        api("/api/projects/" + pidN + "/chats", { method: "POST", body: "{}" })
          .then(function(j){ refresh(); setChat(pidN, j.chat.id); })
          .catch(function(err){ toast(err.message); });
      };
    }
    function select(pid){
      cur = pid;
      history.replaceState(null, "", "#p/" + pid);
      renderProject(pid, dmain, true);
      drawList();
    }
    state.selectProject = select;
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
  pairFromHash().then(function(paired){
    if (paired) toast("paired \\u2713");
    route();
  }).catch(function(err){ toast(err.message); route(); });
})();
</script>
</body>
</html>`;
