import { labelOf } from '../agents.js';
import { drawApBadge,dropApproval,settleApprovalCards } from '../approvals.js';
import { api } from '../connection.js';
import { announce,toast } from '../notifications.js';
import { state } from '../state.js';

/** approval-events behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createApprovalEvents(view) {


    // ---- approvals: agents in "always ask" waiting on you --------------------
    // The daemon holds each request open until someone answers; the thread
    // shows it as a card (lineFor), the badge counts every one in the project.
    function loadApprovals(){
      api("/api/projects/" + view.pid + "/approvals").then(function(j){
        if (state.pid !== view.pid) return;
        state.approvals = { pid: view.pid, list: j.approvals || [] };
        drawApBadge();
      }).catch(function(){});
    }

    function onApprovalEvent(ev){
      if (!ev || ev.kind !== "approval") return;
      var p = ev.payload || {};
      if (!state.approvals || state.approvals.pid !== view.pid) state.approvals = { pid: view.pid, list: [] };
      if (p.phase === "requested") {
        var list = state.approvals.list;
        if (list.some(function(a){ return a.id === p.approvalId; })) return;
        list.push({ id: p.approvalId, projectId: view.pid, agent: ev.agentId, tool: p.tool, input: p.input, createdAt: ev.ts, expiresAt: p.expiresAt, sessionOption: p.sessionOption, chat: ev.chat || "main" });
        drawApBadge();
        // In this thread the card is right there; anywhere else, say so.
        var here = (ev.chat || "main") === view.chatId && (!view.desktop || state.tab === "thread");
        if (!here) toast("\u23f8 " + labelOf(ev.agentId) + " asks to use " + (p.tool || "a tool") + " \u2014 see the approvals badge");
        announce(labelOf(ev.agentId) + " is waiting for your approval to use " + (p.tool || "a tool"));
      } else if (p.phase === "decided") {
        dropApproval(p.approvalId);
        settleApprovalCards(p.approvalId, p.behavior, p.message);
      }
    }
return { loadApprovals, onApprovalEvent };
}
