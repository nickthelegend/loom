/** Browser sign-in module: Loom Desktop's first screen — your GitHub account, for Loom Teams. See README.md for ownership and startup. */
import { api } from './connection.js';
import { esc } from './format.js';
import { ICONS, LOADER } from './icons.js';
import { toast } from './notifications.js';
import { root, state } from './state.js';
import { githubSignIn } from './team.js';
import { isElectron } from './theme.js';

  var SKIP_KEY = "loomSignInSkipped";

  /**
   * Should the desktop open on the sign-in screen? Only in Loom Desktop, only
   * once per launch, and never again after "Continue without an account" —
   * Loom works alone; the account is for Teams. Resolves true when it showed
   * the screen (the caller stops routing), false to carry on.
   */
  function signInGate(next){
    if (!isElectron() || state.signInChecked) return false;
    try { if (localStorage.getItem(SKIP_KEY) === "1") { state.signInChecked = true; return false; } } catch (e) {}
    state.signInChecked = true;
    root.innerHTML = '<div class="dragstrip"></div><div class="signwrap">' + LOADER + "</div>";
    api("/api/team").then(function(t){
      state.team = t;
      if (t && t.signedIn) return next();
      renderSignIn(next);
    }).catch(function(){ next(); }); // a daemon that can't say isn't a reason to block the app
    return true;
  }

  function renderSignIn(next){
    root.innerHTML = '<div class="dragstrip"></div><div class="signwrap"><div class="signcard">' +
      '<div class="biglogo">loom</div>' +
      '<div class="signt">Sign in to Loom</div>' +
      '<div class="signd">Use your GitHub account. It’s how your teammates see your agents and goals, and how invites find you. Loom asks GitHub for your name and email — never your code.</div>' +
      '<button class="btn primary signgh" id="signgh">' + ICONS.github + "Continue with GitHub</button>" +
      '<div class="signst" id="signst"></div>' +
      '<button class="signskip" id="signskip">Continue without an account</button>' +
      '<div class="signfoot">Working alone? You don’t need one — sign in any time from the Team tab.</div>' +
      "</div></div>";
    var gh = document.getElementById("signgh"), st = document.getElementById("signst");
    gh.onclick = function(){
      gh.disabled = true;
      gh.innerHTML = '<span class="obspin"></span>Finish signing in in your browser…';
      githubSignIn(function(url){
        st.innerHTML = 'A GitHub page opened in your browser. <a href="' + esc(url) + '" target="_blank" rel="noopener">Open it again</a>';
      }).then(function(t){
        toast("signed in as @" + t.github);
        next();
      }).catch(function(err){
        gh.disabled = false;
        gh.innerHTML = ICONS.github + "Continue with GitHub";
        st.innerHTML = '<span class="signerr">' + esc(err.message) + "</span>";
      });
    };
    document.getElementById("signskip").onclick = function(){
      try { localStorage.setItem(SKIP_KEY, "1"); } catch (e) {}
      next();
    };
  }

export { signInGate };
