import { esc } from "./format.js";
import { toast } from "./notifications.js";

export function renderIntegrationSettings(pane, api) {
  pane.textContent = "Loading integrations…";
  Promise.all([api("/api/providers"), api("/api/integrations/email")]).then(function(data){
    var email = data[1];
    var fields = [["host", "SMTP host"], ["port", "Port"], ["username", "Username"], ["password", "Password (blank keeps saved)"], ["from", "Sender email"], ["to", "Recipient email"], ["everyHours", "Every (hours, 1–168)"]];
    var h = '<div class="setphead">Integrations &amp; email</div><p class="setpsub">Credentials stay on this computer. Jira intake appears in My issues. GitLab feedback attaches to a chat. Linked Linear issues move to Done after their PR merges.</p>';
    ["jira", "linear", "gitlab"].forEach(function(id){
      var p = data[0].providers.find(function(p){ return p.id === id; }) || {};
      h += '<div class="sgrouph">' + esc(p.label || id) + '</div><p class="hintx">' + esc(p.note || "") + '</p><div class="cloudin">' +
        '<div class="field"><label>Base URL</label><input data-provider-url="' + esc(id) + '" value="' + esc(p.baseUrl || "") + '"></div>' +
        '<div class="field"><label>Key (blank keeps saved) ' + esc(p.hint || "") + '</label><input type="password" autocomplete="off" data-provider-key="' + esc(id) + '"></div></div><button class="btn sm" data-provider-save="' + esc(id) + '">Save ' + esc(p.label || id) + '</button>';
    });
    h += '<div class="sgrouph">Email digest</div><label class="trsw"><input type="checkbox" id="email-enabled"' + (email.enabled ? ' checked' : '') + '> Send a digest on a schedule</label><div class="cloudin">';
    fields.forEach(function(f){ h += '<div class="field"><label>' + esc(f[1]) + '</label><input id="email-' + esc(f[0]) + '" type="' + (f[0] === "password" ? "password" : "text") + '" value="' + esc(email[f[0]] == null ? "" : String(email[f[0]])) + '"></div>'; });
    h += '<div class="field"><label>Security</label><select id="email-security"><option value="tls">TLS (usually 465)</option><option value="starttls">STARTTLS (usually 587)</option></select></div></div><div class="pillrow"><button class="btn primary sm" id="email-save">Save SMTP</button><button class="btn sm" id="email-preview">Preview digest</button><button class="btn sm" id="email-send">Send digest now</button></div><pre class="trprompt" id="email-output" aria-live="polite"></pre>';
    pane.innerHTML = h;
    pane.querySelector("#email-security").value = email.security;
    pane.querySelectorAll("[data-provider-save]").forEach(function(btn){ btn.onclick = function(){
      var id = btn.getAttribute("data-provider-save"), body = { baseUrl: pane.querySelector('[data-provider-url="' + id + '"]').value.trim() }, key = pane.querySelector('[data-provider-key="' + id + '"]').value;
      if (key) body.key = key;
      api("/api/providers/" + id, { method: "POST", body: JSON.stringify(body) }).then(function(){ pane.querySelector('[data-provider-key="' + id + '"]').value = ""; toast("Provider saved"); }).catch(function(e){ toast(e.message); });
    }; });
    pane.querySelector("#email-save").onclick = function(){
      var body = { enabled: pane.querySelector("#email-enabled").checked, security: pane.querySelector("#email-security").value };
      fields.forEach(function(f){ var value = pane.querySelector("#email-" + f[0]).value; if (f[0] !== "password" || value) body[f[0]] = value; });
      api("/api/integrations/email", { method: "PUT", body: JSON.stringify(body) }).then(function(){ pane.querySelector("#email-password").value = ""; toast("SMTP settings saved"); }).catch(function(e){ toast(e.message); });
    };
    ["preview", "send"].forEach(function(action){ pane.querySelector("#email-" + action).onclick = function(){
      var btn = this; btn.disabled = true;
      api("/api/integrations/email/" + action, action === "send" ? { method: "POST", body: "{}" } : undefined)
        .then(function(r){ pane.querySelector("#email-output").textContent = r.text || "Digest sent."; })
        .catch(function(e){ pane.querySelector("#email-output").textContent = e.message; }).finally(function(){ btn.disabled = false; });
    }; });
  }).catch(function(e){ pane.textContent = e.message; });
}
