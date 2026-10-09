/** Browser invite module: one link brings a teammate in. See README.md for ownership and startup. */
import { copyText } from './clipboard.js';
import { api } from './connection.js';
import { esc } from './format.js';
import { ICONS,LOADER } from './icons.js';
import { toast } from './notifications.js';


  // ---- invite a teammate ----------------------------------------------------
  /**
   * One link (daemon/onboard.ts): whoever opens it signs in with GitHub, joins
   * the team, gets this repo cloned and opened with their own agents, and
   * this project's crews set up. Loom makes the team and shares the repo
   * first if you haven't, and — when your `gh` can — gives them push access
   * the moment they join. Not signed in to a hub yet? GitHub first, here.
   */
  function openInvite(pid){
    if (document.querySelector(".scrim")) return;
    var scrim = document.createElement("div"); scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal invmodal" role="dialog" aria-modal="true" aria-label="Invite a teammate">' +
      '<div class="modalhead">Invite a teammate<button class="iconbtn" id="ivx" aria-label="close">' + ICONS.x + "</button></div>" +
      '<div class="modalbody" id="ivbody">' + LOADER + "</div>" +
      '<div class="modalfoot" id="ivfoot" style="display:none"><span class="ivexp" id="ivexp"></span><span class="spacer"></span>' +
        '<label class="ivgrant" id="ivgrantl" style="display:none"><input type="checkbox" id="ivgrant" checked> give them push access</label>' +
        '<button class="btn ghost" id="ivnew" style="display:none">New link</button></div>' +
    "</div>";
    document.body.appendChild(scrim);
    var poll = null;
    function close(){ if (poll) clearInterval(poll); scrim.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    function q(id){ return document.getElementById(id); }
    q("ivx").onclick = close;

    function body(html){ q("ivbody").innerHTML = html; }

    function signIn(){
      body('<div class="ivstate">' + LOADER + "<p>Opening GitHub sign-in…</p></div>");
      api("/api/team/hosted-signin", { method: "POST", body: "{}" }).then(function(r){
        if (r && r.url) window.open(r.url, "_blank", "noopener");
        body('<div class="ivstate">' + LOADER + "<p>Finish signing in with GitHub in the tab that opened. This updates on its own.</p>" +
          (r && r.url ? '<p class="ivsub"><a href="' + esc(r.url) + '" target="_blank" rel="noopener">Open the sign-in page again</a></p>' : "") + "</div>");
        if (poll) clearInterval(poll);
        poll = setInterval(function(){
          api("/api/team").then(function(t){
            if (t && t.signedIn) { clearInterval(poll); poll = null; mint(); }
          }).catch(function(){});
          api("/api/team/hosted-signin").then(function(s){
            if (s && s.error) { clearInterval(poll); poll = null; showError(s.error); }
          }).catch(function(){});
        }, 1500);
      }).catch(function(err){ showError(err.message); });
    }

    function showError(msg){
      var html = esc(msg).replace(/`([^`]+)`/g, "<code>$1</code>");
      body('<div class="ivstate"><div class="ivbad">' + ICONS.alert + '</div><p class="ivwarn">' + html + '</p><button class="btn outline sm" id="ivretry">Try again</button></div>');
      q("ivretry").onclick = mint;
    }

    function mint(){
      body('<div class="ivstate">' + LOADER + "<p>Making your link…</p></div>");
      q("ivfoot").style.display = "none";
      q("ivnew").style.display = "none";
      var grant = q("ivgrant");
      api("/api/projects/" + pid + "/team/invite", { method: "POST", body: JSON.stringify({ grant: grant ? grant.checked : true }) }).then(function(r){
        q("ivfoot").style.display = "";
        q("ivnew").style.display = "";
        q("ivgrantl").style.display = "";
        q("ivexp").textContent = r.expiresAt ? "works once · until " + new Date(r.expiresAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
        body(
          '<div class="ivhead"><div class="ivwho">' + ICONS.team + "<b>" + esc(r.team.name) + "</b><code>" + esc(r.repo) + "</code></div>" +
            '<div class="ivsub">Send this to one teammate. One click and they’re in: GitHub sign-in, the team, this repo cloned and opened with <i>their</i> agents' +
            (r.grant ? ", push access to the repo" : "") + ", and this project’s crews.</div></div>" +
          (r.qrSvg ? '<div class="ivqr">' + r.qrSvg + "</div>" : "") +
          '<div class="phlinkrow ivrow"><input id="ivlink" readonly spellcheck="false" aria-label="invite link" value="' + esc(r.link) + '">' +
            '<button class="btn primary sm" id="ivcopy">' + ICONS.copy + "Copy link</button></div>" +
          '<div class="ivacts"><button class="btn outline sm" id="ivmsg">Copy as a message</button>' +
            (navigator.share ? '<button class="btn outline sm" id="ivshare">Share…</button>' : "") + "</div>" +
          (r.grantNote ? '<div class="ivnote">' + esc(r.grantNote) + "</div>" : "") +
          '<div class="tinvw ivwarnrow">' + ICONS.shield + "<span><b>Treat it like a password.</b> It carries the team key — send it to one person, privately. No Loom on their side yet? The page it opens shows the one command that installs Loom and joins.</span></div>"
        );
        q("ivcopy").onclick = function(){ q("ivlink").select(); copyText(r.link); };
        q("ivmsg").onclick = function(){ copyText(r.message); };
        var sh = q("ivshare");
        if (sh) sh.onclick = function(){
          navigator.share({ title: "Join " + r.team.name + " in Loom", text: r.message }).catch(function(){});
        };
      }).catch(function(err){
        if (err && (err.code === "signin" || /sign in to a team hub/.test(err.message))) {
          body('<div class="ivstate"><p>Loom teams use your GitHub account. Sign in once, and your link is ready.</p>' +
            '<button class="btn primary" id="ivsign">' + ICONS.github + "Sign in with GitHub</button></div>");
          q("ivsign").onclick = signIn;
          return;
        }
        showError(err.message);
      });
    }

    q("ivnew").onclick = mint;
    q("ivgrant").onchange = mint;
    mint();
  }

export { openInvite };
