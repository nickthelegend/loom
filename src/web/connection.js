/** Browser connection module. See README.md for ownership and startup. */
import { bootstrapAdmin,route } from './navigation.js';
import { toast } from './notifications.js';
import { clearShell } from './shell.js';
import { CLIENT_ID_KEY,TOKEN_KEY,root,state } from './state.js';
import { drawStatusbar } from './statusbar.js';
import { isElectron } from './theme.js';
import { pageGone } from './format.js';


  /**
   * This page is baked at one build; the daemon under it can restart onto a
   * newer one while the window stays open. Every socket (re)connect compares —
   * a mismatch gets a one-line banner with a Reload button rather than the
   * slow weirdness of an old client talking to a new API.
   */
  function checkBuild(){
    fetch("/api/health").then(function(r){ return r.json(); }).then(function(h){
      if (h && typeof h.stt === "boolean") state.stt = h.stt;
      if (!h.rev || h.rev === window.__loomPageRev) return;
      if (document.getElementById("revbanner")) return;
      var b = document.createElement("div");
      b.id = "revbanner";
      b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;display:flex;align-items:center;justify-content:center;gap:12px;padding:7px;background:var(--warn, #7a5b00);color:#fff;font-size:12.5px";
      b.innerHTML = 'the daemon restarted on a newer build — this window is stale <button style="border:1px solid #fff5;background:transparent;color:#fff;border-radius:6px;padding:2px 10px;cursor:pointer">Reload</button>';
      b.querySelector("button").onclick = function(){ location.reload(); };
      document.body.appendChild(b);
    }).catch(function(){});
  }


  function clearTimers(){ state.timers.forEach(clearInterval); state.timers = [];
    if (state.disposeView) { var d = state.disposeView; state.disposeView = null; try { d(); } catch (e) {} }
    if (state.ws) {
      // Closing a socket that is still CONNECTING doesn't throw — it emits an
      // async error event ("closed before the connection was established"), so
      // the try/catch around close() never sees it and it surfaces as an
      // unhandled error. Happens on every logout that races the socket's own
      // connect. Swallow it by handler, not by catch.
      try { state.ws.onerror = function(){}; state.ws.onclose = function(){}; state.ws.close(); } catch (e) {}
      state.ws = null;
    } }


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
    return fetch(path, opts).catch(function(err){
      daemonReached(false);
      // "Failed to fetch" is the browser's words, not ours: say what happened.
      var e = new Error("Can’t reach Loom — is the daemon running? (loom up)");
      e.offline = true; e.cause = err;
      throw e;
    }).then(function(r){
      daemonReached(true);
      noteBoot(r.headers && r.headers.get ? r.headers.get("X-Loom-Boot") : null);
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

  /**
   * The daemon restarted under this window — fast enough that no request
   * failed in between, so nothing noticed, and Insights and the rest went on
   * showing a daemon that's gone until you reloaded (#307). Reload once:
   * drafts are kept in localStorage, so nothing typed is lost.
   */
  function noteBoot(boot){
    if (!boot) return;
    if (!state.daemonBoot) { state.daemonBoot = boot; return; }
    if (boot === state.daemonBoot || state.reloadingForBoot) return;
    state.reloadingForBoot = true;
    setTimeout(function(){ location.reload(); }, 300);
  }

  /** Whether the daemon answered the last request — the status bar's "live" when no project socket is open. */
  function daemonReached(up){
    if (state.daemonUp === up) return;
    var wasDown = state.daemonUp === false;
    state.daemonUp = up;
    if (typeof drawStatusbar === "function") drawStatusbar();
    offlineBanner(!up);
    // Back after an outage: re-read what the view missed while it was gone,
    // and send whatever was typed while it was down.
    if (up && wasDown) {
      if (state.refreshShell) state.refreshShell();
      if (state.redrawFeed) state.redrawFeed();
      if (state.onReconnect) state.onReconnect();
    }
  }
  /**
   * One calm line when the daemon stops answering, instead of a toast per
   * failed poll ("Failed to fetch", every few seconds, for as long as it's
   * down). It goes away on its own when the daemon is back.
   */
  function offlineBanner(show){
    if (pageGone()) return;
    var b = document.getElementById("offbanner");
    if (!show) { if (b) b.remove(); return; }
    if (b) return;
    b = document.createElement("div");
    b.id = "offbanner"; b.setAttribute("role", "status");
    b.innerHTML = '<span class="obspin"></span><span><b>Loom isn’t answering</b> — reconnecting… If it doesn’t come back, run <code>loom up</code>.</span>';
    document.body.appendChild(b);
  }

  function logout(){ state.token = ""; state.clientId = ""; localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(CLIENT_ID_KEY); route(); }


  // ---- pairing -------------------------------------------------------------
  function pairFromHash(){
    var m = location.hash.match(/pair=([A-Za-z0-9]+)/);
    if (!m) return Promise.resolve(false);
    // a Share-live link lets this browser into one chat (share-live.js); any other pairing is a device of yours
    try { if (/[#&]guest=1(&|$)/.test(location.hash)) localStorage.setItem("loomGuest", "1"); else localStorage.removeItem("loomGuest"); } catch (e) {}
    history.replaceState(null, "", location.pathname);
    return claim(m[1]);
  }

  function claim(tok){
    return fetch("/api/pair/claim", { method: "POST",
      headers: { "Content-Type": "application/json" },
      // the desktop window is "Loom Desktop", not one more "phone" (49 of those piled up)
      body: JSON.stringify({ token: tok, name: isElectron() ? "Loom Desktop" : /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "phone" : "browser" }) })
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
export { api,checkBuild,claim,clearTimers,daemonReached,logout,pairFromHash,reauth,reauthing,renderPair };
