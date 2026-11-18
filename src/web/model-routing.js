import { esc } from './format.js';

/** Machine settings and project choices share a pane, but keep their own permissions. */
export async function renderModelRouting(pane, pid, api){
  pane.innerHTML = '<div class="setphead">Models and routing</div><div id="mrproject"></div><div id="mrmachine"></div>';
  var project = pane.querySelector('#mrproject'), machine = pane.querySelector('#mrmachine');
  function error(el, e){ el.textContent = e.message || String(e); }
  if (pid) api('/api/projects/' + encodeURIComponent(pid) + '/config').then(function(cfg){
    project.innerHTML = '<div class="sgrouph">Project reasoning effort</div><select id="mreffort" aria-label="Project reasoning effort">' + ['', 'low', 'medium', 'high'].map(function(v){ return '<option value="' + esc(v) + '"' + (v === cfg.defaultEffort ? ' selected' : '') + '>' + esc(v || 'Agent default') + '</option>'; }).join('') + '</select><div class="pd">Used when the agent and chat have no effort override.</div>' +
      '<div class="sgrouph">Agent options</div><select id="mragent" aria-label="Agent options">' + cfg.agents.map(function(a){ return '<option value="' + esc(a.id) + '">' + esc(a.id) + '</option>'; }).join('') + '</select>' +
      '<label class="mrlabel">Extra arguments (JSON array)<textarea id="mrargs" rows="3"></textarea></label><label class="mrlabel">Fallback models (JSON array; model agents)<textarea id="mrfallbacks" rows="3"></textarea></label><label class="mrlabel">Agent effort<input id="mragentEffort"></label><button class="btn" id="mrsaveagent">Save agent options</button><div class="snote" id="mrprojectstatus" role="status"></div>';
    var status = project.querySelector('#mrprojectstatus');
    project.querySelector('#mreffort').onchange = function(e){ api('/api/projects/' + pid + '/config', { method: 'PATCH', body: JSON.stringify({ defaultEffort: e.target.value }) }).then(function(){ status.textContent = 'Project effort saved'; }).catch(function(e){ error(status, e); }); };
    function agentPath(){ return '/api/projects/' + encodeURIComponent(pid) + '/agents/' + encodeURIComponent(project.querySelector('#mragent').value) + '/options'; }
    function loadAgent(){ api(agentPath()).then(function(o){ project.querySelector('#mrargs').value = JSON.stringify(o.extraArgs); project.querySelector('#mrfallbacks').value = JSON.stringify(o.fallbacks); project.querySelector('#mragentEffort').value = o.effort; }).catch(function(e){ error(status, e); }); }
    project.querySelector('#mragent').onchange = loadAgent;
    project.querySelector('#mrsaveagent').onclick = function(){
      try { api(agentPath(), { method: 'PUT', body: JSON.stringify({ extraArgs: JSON.parse(project.querySelector('#mrargs').value), fallbacks: JSON.parse(project.querySelector('#mrfallbacks').value), effort: project.querySelector('#mragentEffort').value }) }).then(function(){ status.textContent = 'Agent options saved'; }).catch(function(e){ error(status, e); }); }
      catch (e) { error(status, e); }
    };
    if (cfg.agents.length) loadAgent();
  }).catch(function(e){ error(project, e); });
  try {
    var settings = await api('/api/model-routing');
    machine.innerHTML = '<div class="sgrouph">Machine defaults · owner only</div><label class="mrlabel">Model aliases (JSON object)<textarea id="mraliases" rows="5">' + esc(JSON.stringify(settings.aliases, null, 2)) + '</textarea></label><div class="pd">Example: {"fast":"ollama/qwen3"}. Use alias names in any model field or fleet.</div>' +
      '<label class="mrlabel">Daily caps (JSON object)<textarea id="mrcaps" rows="5">' + esc(JSON.stringify(settings.caps, null, 2)) + '</textarea></label><div class="pd">Example: {"fast":{"usd":5,"tokens":100000}}. Resets at midnight UTC. Warning at 80%; turns stop at 100%.</div>' +
      '<label class="mrlabel"><input type="checkbox" id="mrmonday"' + (settings.mondayDigest ? ' checked' : '') + '> Monday scoreboard notification (UTC)</label><button class="btn" id="mrsave">Save model settings</button> <button class="btn" id="mrprobe">Probe model health</button><div class="snote" id="mrstatus" role="status"></div><div id="mrhealth"></div><div id="mrusages"></div>';
    machine.querySelector('#mrusages').innerHTML = (settings.usage || []).map(function(u){ return '<div class="snote">' + esc(u.model) + ': ' + esc(u.tokens) + ' tokens · $' + esc(u.usd.toFixed(4)) + (u.stopped ? ' · Daily cap reached' : u.warning ? ' · 80% of daily cap used' : '') + '</div>'; }).join('');
    var status = machine.querySelector('#mrstatus');
    machine.querySelector('#mrhealth').innerHTML = (settings.health || []).map(function(h){ return '<div class="snote">' + esc(h.model) + ' · ' + esc(h.latencyMs) + ' ms · ' + esc(h.lastError || 'Available') + '</div>'; }).join('');
    machine.querySelector('#mrsave').onclick = function(){
      try { api('/api/model-routing', { method: 'PUT', body: JSON.stringify({ aliases: JSON.parse(machine.querySelector('#mraliases').value), caps: JSON.parse(machine.querySelector('#mrcaps').value), mondayDigest: machine.querySelector('#mrmonday').checked }) }).then(function(){ status.textContent = 'Model settings saved'; }).catch(function(e){ error(status, e); }); }
      catch (e) { error(status, e); }
    };
    machine.querySelector('#mrprobe').onclick = function(){
      status.textContent = 'Sending a one-token health probe…';
      api('/api/model-routing/health', { method: 'POST' }).then(function(r){
        status.textContent = 'Model health probe complete';
        machine.querySelector('#mrhealth').innerHTML = r.health.map(function(h){ return '<div class="snote">' + esc(h.model) + ' · ' + esc(h.latencyMs) + ' ms · ' + esc(h.lastError || 'Available') + '</div>'; }).join('') || '<div class="snote">No configured models</div>';
      }).catch(function(e){ error(status, e); });
    };
  } catch (e) { error(machine, e); }
}
