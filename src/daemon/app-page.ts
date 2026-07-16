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
 * See docs/design-system.md.
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
    --agent-l:36%;--selvage-l:44%;
    --warp:rgba(0,0,0,.018);
    /* legacy aliases so older inline styles keep resolving */
    --accent-2:var(--thread);--mag:var(--shuttle);--bg:var(--background);
  }
  .dark{
    --background:#0a0a0a;--foreground:#fafafa;
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
  /* ── Agent chips ──────────────────────────────────────── */
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
  .routebar{position:sticky;top:calc(96px + env(safe-area-inset-top));z-index:3;
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
  .sheet select,.sheet input{height:36px;background:transparent;border:1px solid var(--input);
    border-radius:var(--radius-md);color:var(--foreground);padding:0 11px;font:inherit;font-size:14px;width:100%;
    transition:border-color .15s,box-shadow .15s;outline:none}
  .dark .sheet select,.dark .sheet input{background:color-mix(in srgb, var(--input) 30%, transparent)}
  .dark .sheet select option{background:var(--popover);color:var(--popover-foreground)}
  .sheet select:focus-visible,.sheet input:focus-visible{border-color:var(--ring);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--ring) 50%, transparent)}
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
  .scroll,.slist,.sheet .scrollable{scrollbar-width:thin;
    scrollbar-color:color-mix(in srgb, var(--muted-foreground) 34%, transparent) transparent}
  .scroll::-webkit-scrollbar,.slist::-webkit-scrollbar{width:12px;height:12px}
  .scroll::-webkit-scrollbar-track,.slist::-webkit-scrollbar-track{background:transparent}
  .scroll::-webkit-scrollbar-thumb,.slist::-webkit-scrollbar-thumb{
    background:color-mix(in srgb, var(--muted-foreground) 28%, transparent);
    border:3px solid transparent;border-radius:7px;background-clip:padding-box;min-height:28px}
  .scroll::-webkit-scrollbar-thumb:hover,.slist::-webkit-scrollbar-thumb:hover{
    background-color:color-mix(in srgb, var(--muted-foreground) 48%, transparent)}
  /* ── Desktop workspace shell: projects rail + thread ──── */
  .dshell{display:grid;grid-template-columns:280px 1fr;height:100dvh}
  .sidebar{border-right:1px solid var(--sidebar-border);display:flex;flex-direction:column;min-width:0;
    background:var(--sidebar);color:var(--sidebar-foreground)}
  .sidebar .shead{display:flex;align-items:center;gap:10px;height:48px;flex:none;padding:0 12px 0 16px;
    box-shadow:inset 0 -1px 0 var(--sidebar-border)}
  .sidebar .slist{flex:1;overflow-y:auto;padding:8px}
  .sidebar .stitle{font-size:11px;font-weight:600;color:var(--muted-foreground);
    letter-spacing:.05em;text-transform:uppercase;padding:8px 8px 6px;font-family:var(--font-mono)}
  .srow{padding:9px 10px;border-radius:var(--radius-md);border:1px solid transparent;cursor:pointer;
    margin-bottom:2px;transition:background .12s,border-color .12s}
  .srow:hover{background:var(--sidebar-accent)}
  .srow.sel{background:var(--sidebar-accent);border-color:var(--border)}
  .srow .n{font-weight:500;font-size:13px;display:flex;align-items:center;gap:8px;min-width:0}
  .srow .n .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .srow .m{color:var(--muted-foreground);font-family:var(--font-mono);font-size:11px;margin-top:3px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dmain{min-width:0;display:flex;flex-direction:column;position:relative;background:var(--background)}
  .dmain .panel{height:100%}
  .dmain .composer .inner,.dmain .hint{max-width:none}
  .dempty{flex:1;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;
    color:var(--muted-foreground);font-family:var(--font-mono);font-size:13px}
  .dempty .biglogo{font-size:36px;font-weight:650;letter-spacing:-.02em;color:var(--foreground)}
  .dempty .hair{width:48px;height:2px;border-radius:1px;
    background:linear-gradient(90deg,transparent,var(--thread),transparent)}
  /* ── Native desktop chrome (Electron shell) ───────────── */
  html[data-electron] .sidebar .shead,
  html[data-electron] .dmain > .panel > header,
  html[data-electron] #root > .panel > header,
  html[data-electron] header.appbar,
  html[data-electron] .dragstrip{-webkit-app-region:drag;user-select:none}
  html[data-electron] .sidebar .shead button,
  html[data-electron] .dmain > .panel > header button,
  html[data-electron] #root > .panel > header button,
  html[data-electron] header.appbar button,
  html[data-electron] .sidebar .shead .wordmark{-webkit-app-region:no-drag}
  .dragstrip{position:fixed;top:0;left:0;right:0;height:36px;z-index:50}
  html[data-electron="darwin"] .sidebar .shead{padding-left:84px}
  html[data-electron="darwin"] header.appbar{padding-left:88px}
  html[data-electron="darwin"] #root > .panel > header{padding-left:88px}
  /* on wide screens the app-shell fills the window and owns the height */
  @media (min-width:900px){
    #root{max-width:none;height:100dvh;display:block}
    /* readable, centered conversation column — messages never stretch full width */
    .dmain .scroll > #feed,.dmain .scroll > #routesheet,.dmain .scroll > #routebar{max-width:840px;margin-inline:auto}
    .dmain .composer .inner{max-width:840px}
    .dmain .msg .bubble{max-width:82%}
    .dmain > .panel > header{padding-left:18px;padding-right:14px}
    .srow .badge{font-size:10px;padding:0 7px}
  }
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
                project: null, selected: null, lastId: 0, ws: null, timers: [] };
  var root = document.getElementById("root");

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]; }); }
  function toast(msg){ var t = document.getElementById("toast"); t.textContent = msg;
    t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(function(){ t.classList.remove("show"); }, 2600); }
  function hue(id){ var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; }
  var LOADER = '<div class="loader"><i></i><i></i><i></i><i></i></div>';

  // Inline icon set — 24px grid, stroke 2, currentColor (no emoji, no CDN).
  function svg(inner){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>";
  }
  var ICONS = {
    back: svg('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
    up: svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
    memory: svg('<path d="m12 3 8.5 4.7L12 12.5 3.5 7.7 12 3Z"/><path d="m3.5 12.2 8.5 4.8 8.5-4.8"/><path d="m3.5 16.6 8.5 4.8 8.5-4.8"/>'),
    tree: svg('<path d="M12 4.5v6"/><path d="M9 7.5h6"/><path d="M9 17h6"/><path d="M4 12.5h16" opacity=".35"/>'),
    route: svg('<circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="5.5" r="2.5"/><path d="M8 18.5h5.5a4 4 0 0 0 4-4V8"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>'),
    moon: svg('<path d="M20 12.5A8.5 8.5 0 1 1 11.5 4a6.7 6.7 0 0 0 8.5 8.5Z"/>'),
    unpair: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>')
  };

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

  // ---- board ---------------------------------------------------------------
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
            (p.costUsd > 0 ? " &middot; $" + (p.costUsd >= 0.01 ? p.costUsd.toFixed(2) : p.costUsd.toFixed(4)) : "") +
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

  // ---- thread --------------------------------------------------------------
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
      return '<div class="sys">\\u270e changed ' + fl.length + " file" + (fl.length === 1 ? "" : "s") +
        " (+" + Number(p.added || 0) + " &minus;" + Number(p.removed || 0) + "): " +
        esc(fl.slice(0, 3).join(", ")) + (fl.length > 3 ? " &hellip;" : "") + "</div>";
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

  function renderThread(pid, mount){
    mount = mount || root;
    clearTimers();
    state.pid = pid; state.lastId = 0; state.selected = null;
    mount.innerHTML =
      '<div class="panel">' +
      "<header>" + (isDesktop() ? "" : '<button id="back" class="iconbtn" title="back">' + ICONS.back + "</button>") +
      '<div class="ptitle"><span class="nm" id="pname">&hellip;</span><span class="st" id="pstat"></span></div>' +
      '<span class="spacer"></span>' +
      (isDesktop() ? THEME_BTN : "") +
      '<button id="brainbtn" class="iconbtn" title="unified memory">' + ICONS.memory + "</button>" +
      '<button id="treebtn" class="iconbtn" title="working tree">' + ICONS.tree + "</button>" +
      '<button id="routebtn" class="iconbtn" title="routes">' + ICONS.route + "</button>" +
      '<button id="stop" class="iconbtn" title="interrupt">' + ICONS.stop + "</button></header>" +
      '<div class="chips" id="chips"></div>' +
      '<div class="scroll"><div id="routesheet"></div><div id="routebar"></div><div id="feed">' + LOADER + "</div></div>" +
      '<div class="composer"><form class="inner" id="cform">' +
      '<input id="box" placeholder="Message&hellip;" autocomplete="off">' +
      '<button class="sendbtn" id="send" type="submit" title="send">' + ICONS.up + "</button></form>" +
      '<div class="hint" id="hint"></div></div>' +
      "</div>";
    bindTheme();
    var backBtn = document.getElementById("back");
    if (backBtn) backBtn.onclick = function(){ location.hash = ""; };
    document.getElementById("stop").onclick = function(){
      api("/api/projects/" + pid + "/interrupt", { method: "POST", body: "{}" })
        .then(function(j){ toast(j.interrupted ? "interrupted " + j.interrupted : "nothing running"); })
        .catch(function(err){ toast(err.message); });
    };

    var brainOpen = false;
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
          var w = line.charAt(0) === "#" ? "600" : "400";
          return '<div style="color:' + c + ";font-weight:" + w + ';white-space:pre-wrap;word-break:break-word;font-size:12px;font-family:var(--font-mono)">' + (line || " ") + "</div>";
        }).join("");
        el.innerHTML = '<div class="sheet">' + head + src +
          '<div class="scrollable" style="max-height:46vh;overflow:auto;border-top:1px solid var(--border);padding-top:8px">' + body + "</div>" +
          '<button class="btn primary" id="reimport">re-import ADE memory</button></div>';
        document.getElementById("reimport").onclick = function(){
          api("/api/projects/" + pid + "/memory/import", { method: "POST", body: "{}" })
            .then(function(r){ toast(r.imported ? "imported " + r.imported + " source(s)" : "brain already current"); brainOpen=false; document.getElementById("brainbtn").click(); })
            .catch(function(err){ toast(err.message); });
        };
      }).catch(function(err){ toast(err.message); });
    };

    var treeOpen = false;
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
          var c = line.charAt(0) === "+" ? "var(--ok)" : line.charAt(0) === "-" ? "var(--err)" : "var(--muted-foreground)";
          return '<div style="color:' + c + ';white-space:pre-wrap;word-break:break-all">' + esc(line) + "</div>";
        }).join("");
        el.innerHTML = '<div class="sheet">' + head + list +
          '<div class="scrollable" style="font-family:var(--font-mono);font-size:11px;max-height:40vh;overflow:auto;border-top:1px solid var(--border);padding-top:8px">' +
          (patch || '<div class="sys">clean</div>') + "</div></div>";
      }).catch(function(err){ toast(err.message); });
    };

    var sheetOpen = false;
    document.getElementById("routebtn").onclick = function(){ sheetOpen = !sheetOpen; treeOpen = false; drawSheet(); };
    function drawSheet(){
      var el = document.getElementById("routesheet"); if (!el) return;
      if (!sheetOpen) { el.innerHTML = ""; return; }
      var names = (state.project && state.project.routeNames) || ["auto"];
      el.innerHTML = '<div class="sheet">' +
        "<label>pipeline</label>" +
        '<select id="rsel">' +
        names.map(function(n){
          return '<option value="' + esc(n) + '">' + esc(n === "auto" ? "auto \\u2014 LLM picks each hop" : n) + "</option>";
        }).join("") +
        '<option value="__custom">custom steps&hellip;</option></select>' +
        '<input id="rsteps" placeholder="steps e.g. planner,executor" style="display:none">' +
        '<input id="rtask" placeholder="what should they do?">' +
        '<div class="row"><button class="btn primary" id="rgo">Start route</button></div></div>';
      document.getElementById("rsel").onchange = function(){
        document.getElementById("rsteps").style.display = this.value === "__custom" ? "" : "none";
      };
      document.getElementById("rgo").onclick = function(){
        var sel = document.getElementById("rsel").value;
        var task = (document.getElementById("rtask").value || "").trim();
        if (!task) return toast("describe the task first");
        var spec = sel === "__custom" ? (document.getElementById("rsteps").value || "").trim() : sel;
        if (!spec) return toast("give steps like planner,executor");
        api("/api/projects/" + pid + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: spec }) })
          .then(function(){ sheetOpen = false; drawSheet(); refresh(); toast("route started"); })
          .catch(function(err){ toast(err.message); });
      };
    }

    function drawChips(){
      var p = state.project; if (!p) return;
      var chips = document.getElementById("chips"); if (!chips) return;
      var adapters = p.agents.filter(function(a){ return a.tier === "adapter"; });
      if (state.selected === null) state.selected = p.holder || (adapters[0] && adapters[0].id) || null;
      chips.innerHTML = adapters.map(function(a){
        var sel = a.id === state.selected;
        return '<button class="chip' + (sel ? " sel" : "") + '" data-id="' + esc(a.id) + '">' +
          esc(a.id) + ' <span class="role">' + esc(a.role) + (a.id === p.holder ? " \\u2190" : "") + "</span>" +
          (a.busy ? ' <span class="busy"></span>' : "") + "</button>";
      }).join("");
      Array.prototype.forEach.call(chips.querySelectorAll(".chip"), function(chip){
        chip.onclick = function(){ state.selected = chip.getAttribute("data-id"); drawChips(); };
      });
      var hint = document.getElementById("hint");
      hint.textContent = state.selected && state.selected !== p.holder
        ? "send will shift the baton to " + state.selected
        : "tap a chip to shift agents \\u00b7 baton: " + (p.holder || "\\u2014");
      var bar = document.getElementById("routebar");
      var r = p.route;
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
      var stat = document.getElementById("pstat");
      stat.textContent = p.needsInput
        ? "needs input"
        : p.costUsd > 0
          ? "$" + (p.costUsd >= 0.01 ? p.costUsd.toFixed(2) : p.costUsd.toFixed(4))
          : "";
    }

    function refresh(){
      api("/api/projects/" + pid).then(function(j){
        state.project = j.project;
        var nm = document.getElementById("pname"); if (nm) nm.textContent = j.project.name;
        drawChips();
      }).catch(function(err){ toast(err.message); });
    }

    function append(events){
      var feed = document.getElementById("feed"); if (!feed) return;
      // only the loading placeholder gets cleared — never real history
      if (feed.firstChild && feed.firstChild.className === "loader") feed.innerHTML = "";
      var html = "";
      events.forEach(function(e){
        if (e.id <= state.lastId) return;
        state.lastId = e.id;
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

    function connect(){
      var proto = location.protocol === "https:" ? "wss://" : "ws://";
      var ws = new WebSocket(proto + location.host + "/ws?token=" + encodeURIComponent(state.token) + "&project=" + encodeURIComponent(pid));
      state.ws = ws;
      ws.onmessage = function(ev){
        try {
          var frame = JSON.parse(ev.data);
          if (frame.type === "event" && frame.event) {
            if (historyLoaded) append([frame.event]);
            else pendingWs.push(frame.event);
          }
        } catch (e) {}
      };
      ws.onclose = function(){
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

  // ---- router ----------------------------------------------------------
  var mq = window.matchMedia("(min-width:900px)");
  function isDesktop(){ return mq.matches; }
  function clearShell(){ if (state.shellTimer) { clearInterval(state.shellTimer); state.shellTimer = null; } }

  // Desktop workspace: projects rail + live conversation, side by side.
  function renderShell(){
    clearTimers();
    clearShell();
    var m = location.hash.match(/^#p\\/(.+)$/);
    var cur = m ? m[1] : null;
    root.innerHTML =
      '<div class="dshell">' +
      '<aside class="sidebar">' +
        '<div class="shead"><span class="wordmark">lo<b>om</b></span><span class="spacer"></span>' +
        '<button id="unpair" class="iconbtn" title="unpair this device">' + ICONS.unpair + "</button></div>" +
        '<div class="stitle">projects</div>' +
        '<div class="slist" id="slist">' + LOADER + "</div>" +
      "</aside>" +
      '<section class="dmain" id="dmain"></section>' +
      "</div>";
    document.getElementById("unpair").onclick = logout;
    var dmain = document.getElementById("dmain");
    function drawEmpty(){
      dmain.innerHTML = '<div class="dempty"><div class="biglogo">loom</div><div class="hair"></div>' +
        "<div>select a project to open its thread</div></div>";
    }
    function markSel(){
      Array.prototype.forEach.call(document.querySelectorAll("#slist .srow"), function(row){
        var sel = row.getAttribute("data-id") === cur;
        row.className = "srow" + (sel ? " sel" : "");
        if (sel) row.setAttribute("data-current", "true"); else row.removeAttribute("data-current");
      });
    }
    function select(pid){
      cur = pid;
      history.replaceState(null, "", "#p/" + pid);
      renderThread(pid, dmain);
      markSel();
    }
    function refresh(){
      api("/api/projects").then(function(j){
        state.projects = j.projects || [];
        var el = document.getElementById("slist"); if (!el) return;
        if (!state.projects.length) {
          el.innerHTML = '<div class="sys" style="padding:24px 8px;line-height:1.7">no projects yet<br><span style="opacity:.75">run <b class="mono" style="font-weight:500">loom init</b></span></div>';
          drawEmpty(); return;
        }
        el.innerHTML = state.projects.map(function(p){
          var r = p.route, act = r && (r.status === "running" || r.status === "waiting_human");
          return '<div class="srow" data-id="' + esc(p.id) + '">' +
            '<div class="n"><span class="dot' + (p.needsInput ? " hot" : "") + '"></span><span class="nm">' + esc(p.name) + "</span>" +
            (act ? '<span class="badge live">' + (r.current + 1) + "/" + r.steps.length + "</span>" : "") + "</div>" +
            '<div class="m">baton ' + esc(p.holder || "\\u2014") +
            (p.costUsd > 0 ? " \\u00b7 $" + (p.costUsd >= 0.01 ? p.costUsd.toFixed(2) : p.costUsd.toFixed(4)) : "") + "</div></div>";
        }).join("");
        Array.prototype.forEach.call(el.querySelectorAll(".srow"), function(row){
          row.onclick = function(){ select(row.getAttribute("data-id")); };
        });
        var exists = state.projects.some(function(p){ return p.id === cur; });
        if (!document.getElementById("feed")) select(cur && exists ? cur : state.projects[0].id);
        else markSel();
      }).catch(function(err){ toast(err.message); });
    }
    if (!cur) drawEmpty();
    refresh();
    state.shellTimer = setInterval(refresh, 5000);
  }

  function route(){
    applyTheme();
    if (!state.token) return renderPair();
    if (isDesktop()) return renderShell();
    var m = location.hash.match(/^#p\\/(.+)$/);
    if (m) return renderThread(m[1]);
    renderBoard();
  }
  window.addEventListener("hashchange", function(){ if (!isDesktop()) route(); });
  mq.addEventListener("change", function(){ clearShell(); route(); });
  pairFromHash().then(function(paired){
    if (paired) toast("paired \\u2713");
    route();
  }).catch(function(err){ toast(err.message); route(); });
})();
</script>
</body>
</html>`;
