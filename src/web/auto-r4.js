import { api } from "./connection.js";
import { esc } from "./format.js";
import { toast } from "./notifications.js";

const kinds = { schedule: "Plain-language schedule", file: "File changes", event: "Project event", branch: "Branch commits", url: "URL changes", webhook: "Incoming webhook" };
const events = ["turn_failed", "pr_merged", "ci_failed", "run_completed", "approval_expired"];
const field = (id, label, value) => '<div class="field"><label for="a4-' + esc(id) + '">' + esc(label) + '</label><input id="a4-' + esc(id) + '" value="' + esc(value || "") + '"></div>';

export function mountAutomation(body, pid, reload) {
  const root = document.createElement("section"); root.className = "tradd"; root.setAttribute("aria-label", "Automation");
  body.prepend(root);
  const base = "/api/projects/" + encodeURIComponent(pid) + "/automation";
  let data, editing = null, preview = "";
  const request = (route, method, value) => api(route, { method, ...(value ? { body: JSON.stringify(value) } : {}) });
  function load() { return api(base).then(function(value){ data = value; draw(); }).catch(function(e){ root.textContent = e.message; }); }
  function draw() {
    if (!root.isConnected) return;
    const control = data.control || {}, activePause = control.paused && (!control.resumeAt || control.resumeAt > Date.now());
    root.innerHTML = '<div class="trrow"><b>Automation</b><p id="a4-status" aria-live="polite">' + esc(data.hold || "Active") + " · " + esc(data.held) + ' held</p>' +
      (data.owner ? '<div class="cloudin">' + field("quiet", "Quiet hours (local time)", control.quiet && control.quiet.range || "22:00-07:00") + field("days", "Days quiet hours start", control.quiet ? control.quiet.days.map(d => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][d]).join(",") : "mon-fri") +
      '<div class="pillrow"><button class="btn ghost sm" id="a4-quiet-save">Set quiet hours</button><button class="btn ghost sm" id="a4-quiet-off">Quiet hours off</button></div>' + field("duration", "Pause for (blank means until resumed)", "2h") +
      '<button class="btn ghost sm" id="a4-pause">' + (activePause ? "Resume all automation" : "Pause all automation") + '</button></div>' : '<p class="hintx">The owner controls quiet hours and the global pause.</p>') + '</div>' +
      '<details id="a4-form"><summary>Create or edit automation</summary><div class="cloudin"><div class="field"><label for="a4-edit">Trigger</label><select id="a4-edit"><option value="">New trigger</option>' + data.triggers.filter(t => t.kind !== "intake").map(t => '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>').join("") + '</select></div>' +
      field("name", "Name") + '<div class="field"><label for="a4-kind">Start when</label><select id="a4-kind">' + Object.keys(kinds).filter(k => data.owner || k !== "file").map(k => '<option value="' + esc(k) + '">' + esc(kinds[k]) + '</option>').join("") + '</select></div>' +
      field("when", "When", "every weekday at 9am") + '<p class="hintx" id="a4-help"></p>' + field("every", "URL polling interval", "15m") + field("select", "JSON path (optional)") +
      '<button class="btn ghost sm" id="a4-preview">Preview next five runs</button><pre id="a4-next" class="trprompt" aria-live="polite"></pre>' +
      '<div class="field"><label for="a4-prompt">Prompt</label><textarea id="a4-prompt" rows="3"></textarea></div>' +
      field("condition", "Condition: clean, dirty, file:glob, hours:9-18" + (data.owner ? ", cmd:command" : "")) +
      '<div class="field"><label for="a4-action">Start</label><select id="a4-action"><option value="prompt">Prompt</option><option value="recipe">Orchestra recipe</option><option value="orchestrate">Orchestra goal</option><option value="route">Saved route</option></select></div>' +
      field("target", "Recipe or route name") + field("failures", "Pause after consecutive failures", "3") +
      '<div class="pillrow"><button class="btn primary sm" id="a4-save">Save automation</button><button class="btn ghost sm" id="a4-delete" hidden>Remove automation</button></div><pre id="a4-result" class="trprompt" aria-live="polite"></pre></div></details>' +
      '<details><summary>Outgoing webhooks and deliveries</summary><p class="hintx">Signed using the project webhook secret. Failed deliveries retry up to five times.</p><div class="cloudin">' + field("url", "Destination URL") + field("events", "Events (comma-separated)", "turn_finished,needs_you,pr_opened") + '<button class="btn primary sm" id="a4-hook-add">Add outgoing webhook</button></div>' +
      data.webhooks.map(w => '<div class="trrow">' + esc(w.url) + '<span class="hintx">' + esc(w.events.join(", ")) + '</span><button class="btn ghost sm" data-hook-remove="' + esc(w.id) + '">Remove webhook</button></div>').join("") +
      data.deliveries.slice(-30).reverse().map(d => '<div class="trrow">' + esc(d.event) + " · " + esc(d.status) + " · attempts " + esc(d.attempts) + '<span class="hintx">' + esc(d.error || "") + '</span><button class="btn ghost sm" data-resend="' + esc(d.id) + '">Send again</button></div>').join("") + '</details>';
    const el = id => root.querySelector("#a4-" + id), val = id => el(id).value.trim();
    const act = promise => promise.then(reload).catch(e => toast(e.message));
    if (data.owner) {
      el("quiet-save").onclick = () => act(request("/api/automation", "PUT", { quiet: val("quiet"), days: val("days") }));
      el("quiet-off").onclick = () => act(request("/api/automation", "PUT", { quiet: "off" }));
      el("pause").onclick = () => {
        const c = data.control || {}, paused = c.paused && (!c.resumeAt || c.resumeAt > Date.now());
        act(request("/api/automation", "PUT", { paused: !paused, ...(val("duration") ? { for: val("duration") } : {}) }));
      };
    }
    function kindChanged(reset) {
      const kind = val("kind"); preview = ""; el("next").textContent = "";
      el("preview").hidden = kind !== "schedule";
      el("every").parentElement.hidden = el("select").parentElement.hidden = kind !== "url";
      el("when").parentElement.hidden = kind === "webhook";
      el("help").textContent = { schedule: "Local time. Preview the next five runs before saving.", file: "Project-relative glob, e.g. docs/**. Use {{files}} in the prompt.", event: events.join(" | ") + ". Use {{event.type}} and payload fields.", branch: "Branch name, including remote-tracking refs. Use {{commits}} and {{range}}.", url: "Public HTTP(S) only. Use {{old}} and {{new}}.", webhook: "The URL and secret appear once after saving." }[kind];
      if (reset) el("when").value = { schedule: "every weekday at 9am", file: "docs/**", event: "turn_failed", branch: "main", url: "https://example.com", webhook: "" }[kind];
    }
    el("kind").onchange = () => kindChanged(true);
    el("when").oninput = () => { preview = ""; el("next").textContent = "Preview again after changing the schedule."; };
    el("preview").onclick = () => {
      const when = val("when");
      request(base + "/preview", "POST", { when }).then(p => { if (val("when") !== when) return; preview = when; el("next").textContent = p.cron + "\n" + p.next.map(at => new Date(at).toLocaleString()).join("\n"); }).catch(e => { el("next").textContent = e.message; });
    };
    el("edit").onchange = () => {
      editing = data.triggers.find(t => t.id === val("edit")) || null;
      el("kind").disabled = Boolean(editing); el("delete").hidden = !editing;
      if (!editing) { el("kind").value = "schedule"; kindChanged(true); return; }
      el("kind").value = editing.kind; kindChanged(false);
      el("when").value = editing.when || editing.onChange || editing.on || editing.onCommit || editing.watchUrl || "";
      if (editing.kind === "schedule" && !editing.when) el("help").textContent = "Existing schedule: " + (editing.cron || "every " + editing.everyMin + " minutes") + ". Leave When blank to keep it.";
      ["name", "prompt", "condition", "select"].forEach(k => { el(k).value = editing[k] || ""; });
      el("action").value = editing.recipe ? "recipe" : editing.route ? "route" : editing.orchestrate ? "orchestrate" : "prompt";
      el("target").value = editing.recipe || editing.route || ""; el("failures").value = editing.failureLimit || 3;
      el("every").value = (editing.everyMin || 15) + "m";
    };
    el("save").onclick = () => {
      const kind = val("kind");
      const keepSchedule = editing && kind === "schedule" && !editing.when && !val("when");
      if (kind === "schedule" && !keepSchedule && preview !== val("when")) { el("next").textContent = "Preview the next five runs before saving."; return; }
      const input = { kind, name: val("name") || kind, prompt: val("prompt"), condition: val("condition"), failureLimit: Number(val("failures")), recipe: "", route: "", orchestrate: false };
      const key = { schedule: "when", file: "onChange", event: "on", branch: "onCommit", url: "watchUrl" }[kind];
      if (key && !keepSchedule) input[key] = val("when");
      if (kind === "url") { input.every = val("every"); input.select = val("select"); }
      const action = val("action"); if (action === "orchestrate") input.orchestrate = true; else if (action !== "prompt") input[action] = val("target");
      request(base + "/triggers" + (editing ? "/" + encodeURIComponent(editing.id) : ""), editing ? "PATCH" : "POST", input).then(r => {
        if (r.secret) { el("result").textContent = "URL: " + location.origin + r.path + "\nSecret (shown once): " + r.secret; el("save").disabled = true; }
        else reload();
      }).catch(e => { el("result").textContent = e.message; });
    };
    el("delete").onclick = () => editing && act(request(base + "/triggers/" + encodeURIComponent(editing.id), "DELETE"));
    el("hook-add").onclick = () => act(request(base + "/webhooks", "POST", { url: val("url"), events: val("events").split(",").map(e => e.trim()) }));
    root.querySelectorAll("[data-hook-remove]").forEach(button => { button.onclick = () => act(request(base + "/webhooks/" + encodeURIComponent(button.dataset.hookRemove), "DELETE")); });
    root.querySelectorAll("[data-resend]").forEach(button => { button.onclick = () => act(request(base + "/deliveries/" + encodeURIComponent(button.dataset.resend) + "/resend", "POST", {})); });
    el("save").disabled = el("delete").disabled = !data.canEditTriggers;
    el("hook-add").disabled = !data.owner;
    root.querySelectorAll("[data-hook-remove], [data-resend]").forEach(button => { button.disabled = !data.owner; });
    kindChanged(false);
  }
  load();
  const timer = setInterval(function(){
    if (!root.isConnected) { clearInterval(timer); return; }
    api(base).then(function(value){
      if (!root.isConnected) return;
      data.control = value.control;
      const button = root.querySelector("#a4-pause"), c = value.control || {};
      if (button) button.textContent = c.paused && (!c.resumeAt || c.resumeAt > Date.now()) ? "Resume all automation" : "Pause all automation";
      const status = root.querySelector("#a4-status");
      if (status) status.textContent = (value.hold || "Active") + " · " + value.held + " held";
    }).catch(function(){});
  }, 15000);
}
