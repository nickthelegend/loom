import { createApprovalEvents } from './project/approval-events.js';
import { createBoard } from './project/board.js';
import { createBrain } from './project/brain.js';
import { createChanges } from './project/changes.js';
import { createComposer } from './project/composer.js';
import { createExplorer } from './project/explorer.js';
import { createFleet } from './project/fleet.js';
import { createObservatory } from './project/observatory.js';
import { createOrchestra } from './project/orchestra.js';
import { createCrew } from './project/crew.js';
import { createQueue } from './project/queue.js';
import { createRoutes } from './project/routes.js';
import { createTerminal } from './project/terminal.js';
import { createThread } from './project/thread.js';
/** Browser project module. See README.md for ownership and startup. */
import { approvalClick,approvalKey,closeApprovalsPop,openApprovalsPop } from './approvals.js';
import { copyText } from './clipboard.js';
import { openConnectPhone } from './connect-phone.js';
import { openInvite } from './invite.js';
import { api,clearTimers } from './connection.js';
import { bindConsole } from './console.js';
import { renderDiffLines } from './diff.js';
import { maybeDigest } from './digest.js';
import { drawMermaid,esc,money,pageGone,rel } from './format.js';
import { ICONS,LOADER } from './icons.js';
import { applyRail,makeResizer,toggleRail } from './layout.js';
import { toast } from './notifications.js';
import { KMOD } from './permissions.js';
import { closeBrowser,openBrowser } from './preview.js';
import { root,state } from './state.js';
import { loadGitDelivery } from './statusbar.js';
import { loadTeam,loadTeamRunners,runnerHooks,teamEditing,teamHooks } from './team.js';
import { bindTheme } from './theme.js';
import { agentGlyph,agentLabel,labelOf } from './agents.js';
import { durfmt } from './transcript.js';
import { openBoardTaskModal } from './tasks.js';
import { openMenu } from './menus.js';


  // ---- project view (mobile: sheets · desktop: Orca workspace tabs) -------
  function renderProject(pid, mount, desktop){
    // Bind feature closures before any view setup invokes them. Accessors keep
    // asynchronous callbacks attached to this mount, never a later project.
    var { trunc, drawObservatory } = createObservatory({
      get obRefreshT() { return obRefreshT; }, set obRefreshT(value) { obRefreshT = value; },
      get ASK_SUGGESTIONS() { return ASK_SUGGESTIONS; },
      get OBPAL() { return OBPAL; },
      get obNodePos() { return obNodePos; },
    });
    var { closeDock, openChangesDock, openPatchDock, openFileDock, openArtifactDock, openCodePreview } = createChanges({
      get pid() { return pid; },
      get drawRail() { return drawRail; }
    });
    var { curTerm, termOpen, xtermTheme, applyTerm, toggleTerm, ensureTerm, focusTerm, fitActive, addTerm, drawTermTabs, showTermPane, showConsolePane, hideConsolePane, showBrowserPane, hideBrowserPane, runCmd, interruptTerm, onTermFrame } = createTerminal({
      get terms() { return terms; },
      get activeTerm() { return activeTerm; }, set activeTerm(value) { activeTerm = value; },
      get desktop() { return desktop; },
      get TERM_KEY() { return TERM_KEY; },
      get termSeq() { return termSeq; }, set termSeq(value) { termSeq = value; },
      get pid() { return pid; },
      get termMode() { return termMode; }, set termMode(value) { termMode = value; },
      get CONSOLE_TAB() { return CONSOLE_TAB; },
      get BROWSER_TAB() { return BROWSER_TAB; },
    });
    var { refreshBrain, refreshTeamBrain } = createBrain({
      get drawMemGraph() { return drawMemGraph; },
      get brainView() { return brainView; }, set brainView(value) { brainView = value; },
      get pid() { return pid; },
      get brainKind() { return brainKind; }, set brainKind(value) { brainKind = value; },
      get BRAIN_KINDS() { return BRAIN_KINDS; },
      get tbHistory() { return tbHistory; }, set tbHistory(value) { tbHistory = value; },
      get TB_TIERS() { return TB_TIERS; },
      get tbPr() { return tbPr; }, set tbPr(value) { tbPr = value; }
    });
    var { routeFormHtml, bindRouteForm } = createRoutes({
      get pid() { return pid; },
      get refresh() { return refresh; }
    });
    var { loadBoard, drawBoardPane } = createBoard({
      get board() { return board; },
      get PINKEY() { return PINKEY; },
      get pid() { return pid; },
      get BCOLS() { return BCOLS; },
      get BSTATES() { return BSTATES; },
      get OWN_STATE() { return OWN_STATE; },
    });
    var { openFileFromTree, drawRail, loadDir, drawExplorer } = createExplorer({
      get jumpToMessage() { return jumpToMessage; },
      get loadEarlier() { return loadEarlier; },
      get refresh() { return refresh; },
      get openChangesDock() { return openChangesDock; },
      get openFileDock() { return openFileDock; },
      get openArtifactDock() { return openArtifactDock; },
      get expl() { return expl; },
      get pid() { return pid; },
      get refreshTree() { return refreshTree; },
      get drawStatus() { return drawStatus; }
    });
    var { drawStatus, refresh, loadHistory, connect, drawEmpty, threadScroller, wantScroll, stickOrFlag, toBottom, liveFor, nearBottom, loadEarlier } = createThread({
      get loadQueue() { return loadQueue; },
      get autosizeBox() { return autosizeBox; },
      get jumpToMessage() { return jumpToMessage; },
      get markDays() { return markDays; },
      get syncStars() { return syncStars; },
      get orchRunForChat() { return orchRunForChat; },
      get planState() { return planState; },
      get orchTerminal() { return orchTerminal; },
      get desktop() { return desktop; }, set desktop(value) { desktop = value; },
      get drawOrchTabDot() { return drawOrchTabDot; },
      get updateModelLabel() { return updateModelLabel; },
      get pid() { return pid; },
      get drawRail() { return drawRail; },
      get historyLoaded() { return historyLoaded; }, set historyLoaded(value) { historyLoaded = value; },
      get pendingWs() { return pendingWs; }, set pendingWs(value) { pendingWs = value; },
      get chatId() { return chatId; },
      get loadApprovals() { return loadApprovals; },
      get onTermFrame() { return onTermFrame; },
      get onQueueFrame() { return onQueueFrame; },
      get onOrchEvent() { return onOrchEvent; },
      get onCrewEvent() { return onCrewEvent; },
      get onApprovalEvent() { return onApprovalEvent; },
      get onFleetEvent() { return onFleetEvent; }
    });
    var { autosizeBox, drawAttach, closeMenu, menuAway, openModelMenu, bindComposer, updateModelLabel, openPermMenu, composerPlaceholder, send } = createComposer({
      get historyLoaded() { return historyLoaded; },
      get clearDraft() { return clearDraft; },
      get drawEmpty() { return drawEmpty; },
      get drawLengthPill() { return drawLengthPill; },
      get exportThread() { return exportThread; },
      get holdForReconnect() { return holdForReconnect; },
      get liveFor() { return liveFor; },
      get myPrompts() { return myPrompts; },
      get openFind() { return openFind; },
      get recall() { return recall; },
      get replyLength() { return replyLength; },
      get restoreDraft() { return restoreDraft; },
      get saveDraft() { return saveDraft; },
      get setReplyLength() { return setReplyLength; },
      get stickOrFlag() { return stickOrFlag; },
      get wantScroll() { return wantScroll; },
      get sendOrchestra() { return sendOrchestra; },
      get attach() { return attach; }, set attach(value) { attach = value; },
      get planState() { return planState; }, set planState(value) { planState = value; },
      get orchRunForChat() { return orchRunForChat; },
      get pid() { return pid; },
      get mergeOrchRun() { return mergeOrchRun; },
      get refresh() { return refresh; },
      get chatId() { return chatId; },
      get wouldQueue() { return wouldQueue; },
      get queueFromComposer() { return queueFromComposer; },
      get menuState() { return menuState; }, set menuState(value) { menuState = value; },
      get refreshBrain() { return refreshBrain; },
      get drawStatus() { return drawStatus; },
      get setComposerMode() { return setComposerMode; },
      get drawOrchControls() { return drawOrchControls; },
      get openRewindMenu() { return openRewindMenu; },
      get PLAN_KEY() { return PLAN_KEY; },
      get prompts() { return prompts; },
      get desktop() { return desktop; },
      get showTab() { return showTab; },
      get trunc() { return trunc; },
      get MCPMARK() { return MCPMARK; },
      get _sugT() { return _sugT; }, set _sugT(value) { _sugT = value; }
    });
    var { loadQueue, onQueueFrame, wouldQueue, queueFromComposer } = createQueue({
      get pid() { return pid; },
      get queue() { return queue; },
      get orchCfg() { return orchCfg; },
      get orchRoster() { return orchRoster; },
      get planState() { return planState; }, set planState(value) { planState = value; },
      get orch() { return orch; },
      get chatId() { return chatId; },
    });
    var { orchRoster, orchCfg, orchTerminal, findOrchRun, orchRunForChat, mergeOrchRun, setComposerMode, drawOrchControls, sendOrchestra, needsInputClick, answerAgent, askRewind, openRewindMenu, openOrchChat, loadOrch, onOrchEvent, drawOrchTabDot, orchEl, openOrchSheet, closeOrchSheet, orchPill, drawOrch, redeliverOrch, applyOrch } = createOrchestra({
      get draftKey() { return draftKey; },
      get openPatchDock() { return openPatchDock; },
      get saveDraft() { return saveDraft; },
      get orch() { return orch; },
      get chatId() { return chatId; },
      get composerPlaceholder() { return composerPlaceholder; },
      get menuState() { return menuState; }, set menuState(value) { menuState = value; },
      get closeMenu() { return closeMenu; },
      get updateModelLabel() { return updateModelLabel; },
      get drawStatus() { return drawStatus; },
      get pid() { return pid; },
      get refresh() { return refresh; },
      get openModelMenu() { return openModelMenu; },
      get openPermMenu() { return openPermMenu; },
      get menuAway() { return menuAway; },
      get attach() { return attach; }, set attach(value) { attach = value; },
      get wouldQueue() { return wouldQueue; },
      get queueFromComposer() { return queueFromComposer; },
      get planState() { return planState; },
      get autosizeBox() { return autosizeBox; },
      get drawAttach() { return drawAttach; },
      get refreshTree() { return refreshTree; },
      get desktop() { return desktop; }, set desktop(value) { desktop = value; },
      get showTab() { return showTab; },
      get ORCH_TASK_KINDS() { return ORCH_TASK_KINDS; },
    });
    var { loadCrews, onCrewEvent, drawCrew, openCrewSheet, closeCrewSheet } = createCrew({
      get pid() { return pid; },
      get desktop() { return desktop; },
      get chatId() { return chatId; },
      get showTab() { return showTab; }
    });
    var { loadApprovals, onApprovalEvent } = createApprovalEvents({
      get pid() { return pid; },
      get chatId() { return chatId; },
      get desktop() { return desktop; }, set desktop(value) { desktop = value; }
    });
    var { loadFleet, fleetPoll, onFleetEvent, openFleetSheet, closeFleetSheet, drawFleet, drawTeamBlock } = createFleet({
      get desktop() { return desktop; },
      get pid() { return pid; },
      get fleet() { return fleet; },
      get FLEET_KINDS() { return FLEET_KINDS; },
      get orchTerminal() { return orchTerminal; },
      get orchPill() { return orchPill; },
      get mergeOrchRun() { return mergeOrchRun; }
    });

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
    // Orchestra runs for this project, and which one the view is showing. Up
    // here because the socket and the status poll both reach for it early.
    var orch = { runs: null, active: null, sel: state.pendingOrchRun || null, pinned: !!state.pendingOrchRun, t: null, files: {}, err: "" };
    state.pendingOrchRun = null;
    // Plan mode, remembered per project: the same send, but the agent writes a
    // plan under plans/ instead of code — or, orchestrating, PLAN.md plus a
    // spec per task. Storage can refuse (a private window); the switch still
    // works for this view, it just won't be there after a reload.
    var PLAN_KEY = "loomPlan:" + pid;
    var planState = (function(){ try { return localStorage.getItem(PLAN_KEY) === "1"; } catch (e) { return false; } })();
    // Approvals waiting in this project. Module-scoped (the badge and its list
    // live outside this view), but reset here so another project's never show.
    state.approvals = { pid: pid, list: [] };
    // The Fleet view's reading of /api/activity (declared up here: showTab
    // reaches for its poll during the first paint).
    var fleet = { data: null, err: "", poll: null, t: null };

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
        '<button id="routebtn" class="iconbtn" title="routes">' + ICONS.route + "</button>" +
        '<button id="orchbtn" class="iconbtn" title="orchestra">' + ICONS.orchestra + "</button>" +
        '<button id="crewbtn" class="iconbtn" title="crew \u00b7 agents with roles on one goal">' + ICONS.team + "</button>" +
        '<button id="fleetbtn" class="iconbtn" title="fleet \u00b7 what every agent is doing">' + ICONS.fleet + "</button>" +
        '<button class="apbadge" id="apbadge" type="button" style="display:none"></button>');

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
      '<div class="cqueue" id="cqueue" style="display:none"></div>' +
      '<textarea id="box" class="cinput" rows="2" aria-label="message" placeholder="Message&hellip;  @ for files, / for actions" autocomplete="off"></textarea>' +
      '<div class="cskillsug" id="cskillsug" style="display:none"></div>' +
      '<div class="cpanel" id="cpanel" style="display:none"></div>' +
      // Orchestrate mode's cast: who plans, who works, how many at once.
      // Drawn by drawOrchControls(); hidden in Chat mode.
      '<div class="corch" id="corch" style="display:none"></div>' +
      '<div class="crow">' +
      '<div class="cmode" id="cmode" role="tablist" aria-label="composer mode">' +
      '<button type="button" role="tab" data-cmode="chat" title="talk to one agent">' + ICONS.chat + "Chat</button>" +
      '<button type="button" role="tab" data-cmode="orch" title="one agent plans, many work in parallel">' + ICONS.orchestra + "Orchestrate</button></div>" +
      '<button class="ctool iconly" id="attach" type="button" title="attach an image or file" aria-label="attach a file">' + ICONS.plus + '</button>' +
      // Who and on what, as one joined control: the agent half opens the
      // agent picker, the model half the model picker. Two pills side by side
      // used to read as two unrelated settings.
      '<span class="cpick" id="cpick">' +
      '<button class="cagent" id="cagent" type="button" title="who runs this turn \u2014 AUTO routes it, or pick an agent" aria-label="who runs this turn"><span class="cadot" id="cadot"></span><span class="can">agent</span><span class="cchev">' + ICONS.chevron + "</span></button>" +
      '<button class="ctool" id="modelpick" type="button" title="pick a model" aria-label="pick a model">' + '<span class="cmodel" id="cmodellabel">model</span>' + '<span class="cchev">' + ICONS.updown + "</span></button>" +
      "</span>" +
      // What the chosen agent may do without asking. Drawn by drawPermChip().
      '<button class="cperm" id="cperm" type="button" aria-haspopup="menu" style="display:none"></button>' +
      // The chosen agent's context meter and usage limits (usage.js).
      '<span class="cctx" id="cctx" style="display:none"></span>' +
      // MCPs and Skills live behind this rather than beside it: they are
      // occasional settings, and the row they were on has to hold the model,
      // the agent, the permission chip, prompts and send — on a narrow window
      // it wrapped. The count badge stays on the outside, because "two skills
      // are on" is the part you need without opening anything.
      '<button class="cslot" id="morebtn" type="button" aria-haspopup="menu" aria-expanded="false" title="MCPs, skills and more"><span class="cslotico">' + ICONS.dots + '</span><span class="cslotlbl">More</span><span class="skcount" id="skcount" style="display:none">0</span></button>' +
      '<button class="cslot" id="micbtn" type="button" aria-label="hold to talk" title="hold to talk — transcribed by LOOM_STT_CMD on the daemon, or by this browser when that isn’t set"><span class="cslotico">' + ICONS.mic + "</span></button>" +
      // Saved and recent prompts, a clipboard manager's worth (⌘⇧V).
      '<button class="cprompt" id="promptbtn" type="button" aria-haspopup="dialog" title="prompts \u2014 saved and recent (' + KMOD + '\u21e7V)">' +
        ICONS.clipboard + '<span class="cslotlbl">Prompts</span><kbd>' + KMOD + "\u21e7V</kbd></button>" +
      '<span style="flex:1"></span>' +
      // Plan and send travel together: when a narrow row wraps, the switch that
      // changes what send does never ends up a line away from send.
      '<span class="ctok" id="ctok" aria-live="off"></span>' +
      '<span class="ckhint" aria-hidden="true"><kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> new line</span>' +
      '<span class="csend">' +
      // Plan: a switch, not a mode tab — it changes what either send does.
      '<button class="cplan" id="planbtn" type="button" role="switch" aria-checked="false" title="plan mode \u2014 write a plan, change no code">' +
        '<span class="ptrack"><i></i></span><span class="cplanlbl">Plan</span></button>' +
      '<button class="sendbtn" id="send" type="submit" title="send" aria-label="send">' + ICONS.up + "</button>" +
      '<button class="sendbtn orchsend" id="orchsend" type="button" title="plan this goal and run it in parallel" style="display:none">' + ICONS.orchestra + "Orchestrate</button>" +
      '<button class="sendbtn stopbtn" id="stop" type="button" title="interrupt" aria-label="interrupt" style="display:none">' +
      ICONS.stop + "</button></span>" +
      '</div>' +
      '<input type="file" id="cfile" multiple style="display:none">' +
      "</form>" +
      '<div class="hint" id="hint"></div></div>';

    if (desktop) {
      mount.innerHTML =
        '<div class="panel">' +
        // Orca chrome: the strip is the window top — context, tabs, actions.
          '<div class="tabstrip" id="tabstrip">' +
        // Only shown on a narrow window, where the sidebar slides in instead
        // of taking a third of the width.
        '<button id="sbbtn" class="iconbtn sbbtn" type="button" title="projects and threads" aria-label="show projects and threads">' + ICONS.panelRight + "</button>" +
        // No project title here. The sidebar already names every project and
        // highlights the open one, so this printed it a second time three
        // inches away — and for a project called "loom" that's the word "loom"
        // twice in one bar, under a window called Loom. Cost and needs-input
        // live on the sidebar row too, so nothing is lost with it.
        '<span id="tabsbox" style="display:contents"></span>' +
        '<span class="spacer"></span>' +
        // Tool calls waiting on you, from any thread of this project.
        '<button class="apbadge" id="apbadge" type="button" style="display:none"></button>' +
        // &#96; is a backtick — a literal one would close this template literal
        // One link brings a teammate in: the team, this repo, their agents, the crews.
        '<button id="invitebtn" class="btn outline sm invitebtn" type="button" title="invite a teammate \u2014 one link sets up the team, this repo and their agents">' + ICONS.team + "<span>Invite</span></button>" +
        '<button id="termbtn" class="iconbtn" title="toggle terminal (\u2303&#96;)">' + ICONS.terminal + "</button>" +
        // Connect a phone: a QR (or copy link) that pairs the native app over the
        // LAN or the tailnet. Sits by the terminal because both are "reach this
        // machine from somewhere else".
        '<button id="phonebtn" class="iconbtn" title="connect a phone" aria-label="connect a phone">' + ICONS.phone + "</button>" +
        // The Console shares the terminal's dock — both are "the drawer at the
        // bottom where output goes", and giving errors their own panel would
        // mean two drawers fighting for the same edge. The dot appears when
        // something has gone wrong since you last looked.
        '<button id="consolebtn" class="iconbtn" title="console \u00b7 errors and logs">' +
        ICONS.console + '<span class="errdot" id="errdot"></span></button>' +
        '<button id="browserbtn" class="iconbtn" title="browser \u00b7 live page and Playwright specs">' + ICONS.globe + "</button>" +
        '<button id="railbtn" class="iconbtn" title="toggle right panel">' + ICONS.panelRight + "</button>" +
        headerActions +
        "</div>" +
        '<div class="paneswrap">' +
        '<div class="mainpane" id="mainpane">' +
        '<div class="pane scroll" id="pane-thread"><div id="agenthead" class="agenthead" style="display:none"></div><div id="routebar"></div><div id="feed">' + LOADER + '</div><div id="feedlive" aria-live="polite"></div>' +
        '<button type="button" class="jumpnew" id="jumpnew">' + ICONS.arrowDown + "Latest</button></div>" +
        '<div class="pane scroll" id="pane-brain" style="display:none">' + LOADER + "</div>" +
        '<div class="pane scroll" id="pane-observatory" style="display:none">' + LOADER + "</div>" +
        '<div class="pane scroll" id="pane-board" style="display:none"></div>' +
        '<div class="pane scroll" id="pane-orchestra" style="display:none"></div>' +
        '<div class="pane scroll" id="pane-crew" style="display:none"></div>' +
        '<div class="pane scroll" id="pane-fleet" style="display:none"></div>' +
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
        '<span class="termfind" id="termfind" hidden><input id="termq" placeholder="Find in terminal" spellcheck="false" autocomplete="off" aria-label="find in terminal"><span id="termqn" class="termqn"></span></span>' +
        '<button id="termsearch" class="iconbtn" title="Find in this terminal">' + ICONS.search + "</button>" +
        '<button id="termclear" class="iconbtn" title="Clear this terminal">' + ICONS.trash + "</button>" +
        '<button id="termhide" class="iconbtn" title="hide terminal">' + ICONS.x + "</button></div>" +
        '<div class="termpanes" id="termpanes">' +
        '<div class="conwrap" id="conwrap">' +
        '<div class="conbar">' +
        '<span class="lvl on" data-lvl="all">all</span>' +
        '<span class="lvl" data-lvl="error">errors</span>' +
        '<span class="lvl" data-lvl="warn">warnings</span>' +
        '<select id="conscope" class="consel" title="filter by scope"><option value="">all scopes</option></select>' +
        '<input id="consearch" class="consearch" placeholder="search\u2026" autocomplete="off" spellcheck="false">' +
        '<span class="spacer" style="flex:1"></span>' +
        '<span id="concount"></span>' +
        '<button id="conclear" class="iconbtn" title="clear">' + ICONS.x + "</button>" +
        "</div>" +
        '<div class="conlist" id="conlist"></div>' +
        "</div>" +
        '<div class="browwrap" id="browwrap">' +
        '<div class="browrail">' +
        // The servers this project runs, above its tests: what's up, on which
        // port, and one click to start, stop or look at what it printed.
        '<div class="browbar"><span class="lbl">Dev servers</span><span class="spacer" style="flex:1"></span>' +
        '<button id="srvreload" class="iconbtn xs" title="refresh">' + ICONS.refresh + "</button></div>" +
        '<div class="srvlist" id="srvlist">' + LOADER + "</div>" +
        '<div class="browbar"><span class="lbl">Playwright specs</span><span class="spacer" style="flex:1"></span>' +
        '<button id="specreload" class="iconbtn xs" title="rescan">' + ICONS.refresh + "</button></div>" +
        '<div class="speclist" id="speclist">' + LOADER + "</div>" +
        '<div class="specout" id="specout" style="display:none"></div>' +
        "</div>" +
        '<div class="browmain">' +
        '<div class="browurl">' +
        '<input id="browurl" placeholder="http://localhost:3000 \u2014 preview a dev server" autocomplete="off" spellcheck="false">' +
        '<button id="browgo" class="iconbtn" title="open">' + ICONS.play + "</button>" +
        // The conditions a bug was seen under, and a way to carry the view
        // into the next prompt.
        '<span class="browsizes" id="browsizes">' +
        '<button data-w="0" class="on" title="fit the pane">Fit</button>' +
        '<button data-w="375" title="phone width">375</button>' +
        '<button data-w="768" title="tablet width">768</button>' +
        '<button data-w="1280" title="desktop width">1280</button>' +
        "</span>" +
        // The other half of "the conditions a bug was seen under": the page's
        // colour scheme, independent of Loom's own theme.
        '<span class="browsizes" id="browscheme">' +
        '<button data-s="" class="on" title="whatever your OS is set to">Auto</button>' +
        '<button data-s="light" title="preview the page in light mode">☀</button>' +
        '<button data-s="dark" title="preview the page in dark mode">☽</button>' +
        "</span>" +
        '<button id="browshot" class="iconbtn" title="screenshot into the composer">' + ICONS.camera + "</button>" +
        '<button id="browreload" class="iconbtn" title="reload">' + ICONS.refresh + "</button>" +
        '<label class="browauto" title="reload when an agent changes a file this server serves">' +
        '<input type="checkbox" id="browautorel" checked><span>auto</span></label>' +
        "</div>" +
        '<div class="browframe" id="browframe">' +
        '<div class="browhint">Point this at a running dev server to see the page beside its tests.<br>' +
        "Sites that forbid embedding (X-Frame-Options) won\u2019t render here \u2014 local ones do.</div>" +
        "</div>" +
        // A server's own output, under the page it serves: when the frame goes
        // blank, the reason is usually in here.
        '<div class="srvlog" id="srvlog" style="display:none"><div class="srvlogbar">' +
        '<span class="lbl" id="srvlogname"></span><span class="spacer" style="flex:1"></span>' +
        '<button id="srvlogclose" class="iconbtn xs" title="hide">' + ICONS.x + "</button></div>" +
        '<div class="srvloglines" id="srvloglines"></div></div>' +
        // What the previewed page itself said: its console and its requests,
        // each one a click away from being the next prompt's context.
        '<div class="pglog" id="pglog" style="display:none"><div class="srvlogbar">' +
        '<span class="lbl">Page</span>' +
        '<span class="pgtabs" id="pgtabs"><button data-pg="console" class="on">Console</button>' +
        '<button data-pg="network">Network</button></span>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<span class="pgcount" id="pgcount"></span>' +
        '<button id="pgpick" class="iconbtn xs" title="pick an element on the page">' + ICONS.target + "</button>" +
        '<button id="pgclear" class="iconbtn xs" title="clear">' + ICONS.x + "</button></div>" +
        '<div class="srvloglines" id="pglines"></div></div>' +
        "</div>" +
        "</div></div>" +
        '<form class="terminput" id="termform" style="display:none"><span class="pr">&#10095;</span>' +
        '<input id="terminput" placeholder="run a command\u2026" autocomplete="off" autocapitalize="off" spellcheck="false">' +
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
        '<div class="scroll" id="pane-thread"><div id="routesheet"></div><div id="routebar"></div><div id="feed">' + LOADER + '</div><div id="feedlive" aria-live="polite"></div>' +
        '<button type="button" class="jumpnew" id="jumpnew">' + ICONS.arrowDown + "Latest</button></div>" +
        composerHtml +
        "</div>";
    }
    bindTheme();
    var backBtn = document.getElementById("back");
    if (backBtn) backBtn.onclick = function(){ location.hash = ""; };
    document.getElementById("stop").onclick = function(){
      api("/api/projects/" + pid + "/interrupt", { method: "POST", body: JSON.stringify({ chat: chatId }) })
        .then(function(j){ toast(j.interrupted ? "interrupted " + j.interrupted : "nothing running"); })
        .catch(function(err){ toast(err.message); });
    };
    var apBadge = document.getElementById("apbadge");
    if (apBadge) apBadge.onclick = function(){ openApprovalsPop(apBadge); };
    closeApprovalsPop(); // a list of the last project's requests has no business here

    // ---- desktop tabs (Thread / Tasks / Brain / Routes) --------------------
    // mobile has no #tabsbox, so this is a no-op there by construction
    function drawTabs(){
      var box = document.getElementById("tabsbox"); if (!box) return;
      var tabs = ["thread", "board", "brain", "observatory"];
      // Orchestra sits beside Thread: a run is a conversation that fanned out,
      // and its tasks are threads of their own.
      tabs.splice(1, 0, "orchestra");
      // Crew sits beside Orchestra: agents with roles working one goal together.
      tabs.splice(2, 0, "crew");
      // Fleet sits beside them: the same question — who is doing what —
      // asked of every agent in every open project, not one run's workers.
      tabs.splice(3, 0, "fleet");
      if (tabs.indexOf(state.tab) < 0) state.tab = "thread";
      // Plain words, each with a line saying what's behind it: "Brain",
      // "Fleet" and "Observatory" were names you had to learn before you
      // could guess what they did.
      var LBL = { thread: [ICONS.thread, "Chat", "talk to an agent in this thread"],
                  orchestra: [ICONS.orchestra, "Orchestra", "one agent plans, a team builds in parallel"],
                  crew: [ICONS.team, "Crew", "agents with roles plan, build, review and test a goal"],
                  fleet: [ICONS.fleet, "Agents", "what every agent is doing right now"],
                  board: [ICONS.board, "Board", "issues, PRs and tasks"],
                  brain: [ICONS.memory, "Memory", "what every agent here remembers"],
                  observatory: [ICONS.telescope, "Insights", "time, tokens and cost"] };
      box.innerHTML = tabs.map(function(tb){
        return '<button class="tab' + (state.tab === tb ? " active" : "") + '" data-tab="' + tb + '" title="' + LBL[tb][1] + " — " + LBL[tb][2] + '">' +
          LBL[tb][0] + '<span class="tl">' + LBL[tb][1] + "</span>" + (tb === "orchestra" ? '<span class="tdot" id="orchtdot" style="display:none"></span>' : "") +
          (tb === "crew" ? '<span class="tdot" id="crewtdot" style="display:none"></span>' : "") + "</button>";
      }).join("");
      Array.prototype.forEach.call(box.querySelectorAll(".tab"), function(tb){
        tb.onclick = function(){ showTab(tb.getAttribute("data-tab")); };
      });
    }
    function showTab(name){
      // a quick crossfade between workspace tabs, where the browser can
      var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (document.startViewTransition && state.tab && state.tab !== name && !still && !showTab.inTransition) {
        showTab.inTransition = true;
        try {
          var vt = document.startViewTransition(function(){ showTabNow(name); });
          // A transition skipped (hidden tab, a second one on top) rejects
          // ready and updateCallbackDone too; the tab still switches, so
          // those are nothing to report.
          var quiet = function(){};
          if (vt.ready) vt.ready.catch(quiet);
          if (vt.updateCallbackDone) vt.updateCallbackDone.catch(quiet);
          vt.finished.then(function(){ showTab.inTransition = false; }, function(){ showTab.inTransition = false; });
          return;
        } catch (e) { showTab.inTransition = false; }
      }
      showTabNow(name);
    }
    function showTabNow(name){
      state.tab = name;
      (state.tabByProject || (state.tabByProject = {}))[pid] = name;
      ["thread", "orchestra", "crew", "fleet", "board", "brain", "observatory"].forEach(function(t){
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
      if (name === "orchestra") { drawOrch(); loadOrch(); }
      if (name === "crew") { drawCrew(); loadCrews(); }
      // Fleet polls only while you can see it.
      if (name === "fleet") { drawFleet(); loadFleet(); loadTeam(); }
      fleetPoll(name === "fleet");
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

    // ---- Dashboard charts ---------------------------------------------------
    // Donuts for composition ("what is the spend made of"), lines for behaviour
    // over time. Every value here comes from /metrics byAgent or the real event
    // log — there is no sample data path, so an empty fleet draws an empty state
    // rather than a decorative shape.
    var OBPAL = ["var(--ch1)", "var(--ch2)", "var(--ch3)", "var(--ch4)", "var(--ch5)", "var(--ch6)"];

    // ---- review comments: click a diff line, say what's wrong ---------------
    // Comments stage locally and leave as ONE message through the composer, so
    // the reply goes to whichever agent you pick there — same contract as
    // every other send, no parallel channel to a special endpoint.
    if (!state.review) state.review = [];
    if (desktop) {
      document.getElementById("dockclose").onclick = closeDock;
      document.getElementById("railbtn").onclick = toggleRail;
      // Narrow window: the sidebar slides in over the thread, and goes away
      // again on a pick (this view is re-rendered then) or a click outside it.
      var shellEl = document.querySelector(".dshell");
      if (shellEl) shellEl.classList.remove("sbopen");
      var sbb = document.getElementById("sbbtn");
      if (sbb) sbb.onclick = function(ev){ ev.stopPropagation(); var sh = document.querySelector(".dshell"); if (sh) sh.classList.toggle("sbopen"); };
      var dm = document.getElementById("dmain");
      if (dm && !dm._sbClose) {
        dm._sbClose = true;
        dm.addEventListener("mousedown", function(){ var sh = document.querySelector(".dshell"); if (sh) sh.classList.remove("sbopen"); });
      }
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
      var bwb = document.getElementById("browserbtn");
      if (bwb) bwb.onclick = function(){
        (state.browserActive && state.browserActive()) ? closeBrowser() : openBrowser();
      };
      var phb = document.getElementById("phonebtn");
      if (phb) phb.onclick = openConnectPhone;
      var ivb = document.getElementById("invitebtn");
      if (ivb) ivb.onclick = function(){ openInvite(pid); };
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
      // Back on a project (or the same one drawn again while it loads): the
      // tab you were on, not Chat — a click on Crew mid-load used to bounce.
      showTab((state.tabByProject && state.tabByProject[pid]) || "thread");
      // A just-launched orchestra lands on its own view, in its own chat.
      if (state.pendingTab) { var pt = state.pendingTab; state.pendingTab = null; showTab(pt); }
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
    var BROWSER_TAB = "__browser__";
    state.showConsole = showConsolePane;
    state.hideConsole = hideConsolePane;
    state.consoleActive = function(){ return activeTerm === CONSOLE_TAB; };
    state.redrawTermTabs = drawTermTabs;
    state.showBrowser = showBrowserPane;
    state.hideBrowser = hideBrowserPane;
    state.browserActive = function(){ return activeTerm === BROWSER_TAB; };
    if (desktop) {
      document.getElementById("termhide").onclick = function(){ localStorage.setItem(TERM_KEY, "0"); applyTerm(); };
      document.getElementById("termadd").onclick = function(){ addTerm(); };
      var tclr = document.getElementById("termclear");
      if (tclr) tclr.onclick = function(){ var t = curTerm(); if (t && t.xterm) { t.xterm.clear(); focusTerm(); } else toast("open a terminal first"); };
      var tsr = document.getElementById("termsearch"), tf = document.getElementById("termfind"), tq = document.getElementById("termq");
      if (tsr && tf && tq) {
        var tfind = { q: "", at: -1 };
        tsr.onclick = function(){ tf.hidden = !tf.hidden; if (!tf.hidden) { tq.focus(); tq.select(); } };
        // no search addon ships: read the buffer, newest match first, and select it
        var termFind = function(dir){
          var t = curTerm(), n = document.getElementById("termqn");
          if (!t || !t.xterm) { if (n) n.textContent = ""; return; }
          var q = tq.value.trim().toLowerCase(), buf = t.xterm.buffer.active;
          if (!q) { t.xterm.clearSelection(); if (n) n.textContent = ""; return; }
          var hits = [];
          for (var y = 0; y < buf.length; y++) {
            var line = buf.getLine(y); if (!line) continue;
            var s = line.translateToString(true).toLowerCase(), k = -1;
            while ((k = s.indexOf(q, k + 1)) >= 0) hits.push([y, k]);
          }
          if (!hits.length) { t.xterm.clearSelection(); if (n) n.textContent = "no match"; return; }
          if (q !== tfind.q) { tfind.q = q; tfind.at = hits.length; }
          tfind.at = (tfind.at + dir + hits.length) % hits.length;
          var h = hits[tfind.at];
          t.xterm.select(h[1], h[0], q.length);
          t.xterm.scrollToLine(Math.max(0, h[0] - Math.floor(t.xterm.rows / 2)));
          if (n) n.textContent = (tfind.at + 1) + "/" + hits.length;
        };
        tq.addEventListener("keydown", function(e){
          if (e.key === "Enter") { e.preventDefault(); termFind(e.shiftKey ? 1 : -1); }
          else if (e.key === "Escape") { e.preventDefault(); tf.hidden = true; var t = curTerm(); if (t && t.xterm) t.xterm.clearSelection(); focusTerm(); }
        });
        tq.addEventListener("input", function(){ tfind.q = ""; termFind(-1); });
      }
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
            // pty: type the line and press Enter (\r); the shell runs it
            api("/api/projects/" + pid + "/term/input",
                { method: "POST", body: JSON.stringify({ term: t.id, data: cmd + "\r" }) }).catch(function(){});
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
      // An agent's question, answered in place. First: the card lives inside
      // the feed, and its input must not read as a click on the card behind it.
      if (needsInputClick(ev)) return;
      // A code block's copy button, because it lives inside cards that claim
      // clicks of their own (a turn card opens its diff, a details folds).
      // Rewind, before the turn card's own click — the button sits inside the
      // card, and opening a diff dock instead of asking would be a surprise.
      var rw = ev.target.closest && ev.target.closest("[data-rewind]");
      if (rw) { ev.preventDefault(); ev.stopPropagation(); askRewind(rw.getAttribute("data-rewind"), rw); return; }
      var go = ev.target.closest && ev.target.closest("[data-gochat]");
      if (go) { ev.preventDefault(); openOrchChat(go.getAttribute("data-gochat")); return; }
      // A message's own actions: the ⋯ menu, your prompt's edit/copy/star,
      // and Continue on a reply you stopped.
      var rb = ev.target.closest && ev.target.closest(".msgrate");
      if (rb) {
        ev.preventDefault(); ev.stopPropagation();
        var rmsg = rb.closest(".msg"), rid = Number(rmsg.getAttribute("data-id")) || 0, ragent = rmsg.getAttribute("data-agent");
        var want = Number(rb.getAttribute("data-rate")), had = state.rateMap && state.rateMap[rid] ? state.rateMap[rid].v : 0;
        var val = had === want ? 0 : want;
        api("/api/projects/" + pid + "/chats/" + encodeURIComponent(chatId) + "/rate", { method: "POST", body: JSON.stringify({ eventId: rid, agentId: ragent, value: val }) })
          .then(function(j){
            state.rateMap = j.ratings || {};
            Array.prototype.forEach.call(rmsg.querySelectorAll(".msgrate"), function(x){
              var on = Number(x.getAttribute("data-rate")) === val;
              x.classList.toggle("on", on); x.classList.toggle("down", on && val === -1); x.setAttribute("aria-pressed", on ? "true" : "false");
            });
            toast(val === 1 ? "noted — a good one from " + labelOf(ragent) : val === -1 ? "noted — " + labelOf(ragent) + " missed on this one" : "rating cleared");
          })
          .catch(function(err){ toast(err.message); });
        return;
      }
      var mm = ev.target.closest && ev.target.closest(".msgmore");
      if (mm) { ev.preventDefault(); ev.stopPropagation(); msgMenu(mm.closest(".msg"), mm); return; }
      var ua = ev.target.closest && ev.target.closest(".uact");
      if (ua) {
        ev.preventDefault(); ev.stopPropagation();
        var um = ua.closest(".msg"), raw = decodeURIComponent((um && um.getAttribute("data-raw")) || "");
        if (ua.classList.contains("uedit")) composeFor(raw, null, false);
        else if (ua.classList.contains("ucopy")) copyText(raw);
        else if (ua.classList.contains("ustar")) toggleStar(Number(um.getAttribute("data-id")) || 0);
        return;
      }
      var eo = ev.target.closest && ev.target.closest("[data-errother]");
      if (eo) {
        ev.preventDefault(); ev.stopPropagation();
        var card = eo.closest(".errcard"), failed = eo.getAttribute("data-errother");
        var ask = promptFor(card);
        if (!ask) { toast("couldn’t find the prompt this error answered — scroll up and use Retry on it"); return; }
        var alts = ((state.project && state.project.agents) || []).filter(function(a){ return a.tier === "adapter" && a.enabled !== false && a.id !== failed; });
        if (!alts.length) { toast("no other agent is switched on in this project"); return; }
        var rr = eo.getBoundingClientRect();
        openMenu(Math.round(rr.left), Math.round(rr.bottom + 4), [{ head: "Send the same prompt to" }].concat(alts.map(function(a){
          return { label: agentLabel(a.kind, a.id), icon: agentGlyph(a.kind, a.id), hint: a.busy ? "busy" : "", run: function(){ composeFor(ask, a.id, true); } };
        })));
        return;
      }
      var ew = ev.target.closest && ev.target.closest("[data-errwait]");
      if (ew) {
        ev.preventDefault(); ev.stopPropagation();
        var wcard = ew.closest(".errcard"), wprompt = promptFor(wcard), wagent = ew.getAttribute("data-errwait");
        var wuntil = Number(ew.getAttribute("data-until")) || 0;
        if (!wprompt) { toast("couldn’t find the prompt this error answered"); return; }
        if (wuntil <= Date.now()) { composeFor(wprompt, wagent, true); return; }
        if (ew.getAttribute("data-armed")) { ew.removeAttribute("data-armed"); clearTimeout(ew._t); toast("won’t retry"); ew.classList.remove("armed"); return; }
        ew.setAttribute("data-armed", "1"); ew.classList.add("armed");
        toast("will retry when the limit lifts — click again to cancel");
        ew._t = setTimeout(function(){ if (!pageGone() && ew.getAttribute("data-armed")) composeFor(wprompt, wagent, true); }, wuntil - Date.now() + 500);
        return;
      }
      var ec = ev.target.closest && ev.target.closest("[data-errcopy]");
      if (ec) {
        ev.preventDefault(); ev.stopPropagation();
        var ecard = ec.closest(".errcard");
        var head = ecard.querySelector(".errh") ? ecard.querySelector(".errh").innerText.trim() : "";
        var det = ecard.querySelector(".errd pre") ? ecard.querySelector(".errd pre").textContent : "";
        var when = new Date(Number(ecard.getAttribute("data-ts")) || Date.now()).toISOString();
        copyText(["Loom error", "project: " + ((state.project && state.project.name) || pid), "chat: " + chatId,
          "agent: " + (ecard.getAttribute("data-agent") || "loom"), "at: " + when, "", head, det ? "\n" + det : ""].join("\n").trim());
        return;
      }
      // A proposed plan's buttons: leave plan mode and build it, or say what to change.
      var pi = ev.target.closest && ev.target.closest("[data-planimpl]");
      if (pi) {
        ev.preventDefault(); ev.stopPropagation();
        if (planState) { var pb = document.getElementById("planbtn"); if (pb) pb.click(); }
        composeFor("Implement the plan above.", pi.getAttribute("data-planimpl"), true);
        return;
      }
      var pr = ev.target.closest && ev.target.closest("[data-planrevise]");
      if (pr) { ev.preventDefault(); ev.stopPropagation(); composeFor("Change the plan: ", pr.getAttribute("data-planrevise"), false); return; }
      var cn = ev.target.closest && ev.target.closest("[data-continue]");
      if (cn) { ev.preventDefault(); ev.stopPropagation(); composeFor("Continue from exactly where you stopped.", cn.getAttribute("data-continue"), true); return; }
      // Copy a whole reply — the words, not the markup around them.
      var mc = ev.target.closest && ev.target.closest(".msgcopy");
      if (mc) {
        ev.preventDefault(); ev.stopPropagation();
        var mb = mc.closest(".msg"); var body = mb && mb.querySelector(".bubble");
        var txt = body ? body.innerText : "";
        if (txt) { copyText(txt); toast("copied"); }
        return;
      }
      // an artifact an agent made (a page, an image, a doc), shown as itself
      var art = ev.target.closest && ev.target.closest("[data-artifact]");
      if (art) { ev.preventDefault(); ev.stopPropagation(); openArtifactDock(art.getAttribute("data-artifact")); return; }
      // an html/svg code block, rendered
      var pv = ev.target.closest && ev.target.closest(".mdprev");
      if (pv) {
        ev.preventDefault(); ev.stopPropagation();
        var wrap = pv.closest(".mdcodewrap"), codeEl = wrap && wrap.querySelector("pre code");
        var lng = wrap && wrap.querySelector(".mdlang") ? wrap.querySelector(".mdlang").textContent : "html";
        if (codeEl) openCodePreview(codeEl.textContent, lng);
        return;
      }
      // a picture in a reply: open it at full size
      var mi = ev.target.closest && ev.target.closest("img.mdimg[data-projimg]");
      if (mi) { ev.preventDefault(); openArtifactDock(mi.getAttribute("data-projimg")); return; }
      var dr = ev.target.closest && ev.target.closest(".mddraw");
      if (dr) { ev.preventDefault(); ev.stopPropagation(); drawMermaid(dr.parentNode, dr); return; }
      var cp = ev.target.closest && ev.target.closest(".mdcopy");
      if (cp) {
        ev.preventDefault(); ev.stopPropagation();
        var box = cp.parentNode && cp.parentNode.querySelector("code");
        if (box) copyText(box.textContent || "");
        return;
      }
      var ap = ev.target.closest && ev.target.closest("[data-orch-apply]");
      if (ap) { applyOrch(ap.getAttribute("data-orch-apply"), ap); return; }
      var cmp = ev.target.closest && ev.target.closest("[data-orch-compare]");
      if (cmp) { ev.preventDefault(); orch.sel = cmp.getAttribute("data-orch-compare"); showTab("orchestra"); return; }
      var rsm = ev.target.closest && ev.target.closest("[data-orch-resume]");
      if (rsm) {
        rsm.disabled = true;
        api("/api/projects/" + pid + "/orchestra/" + encodeURIComponent(rsm.getAttribute("data-orch-resume")) + "/resume", { method: "POST", body: "{}" })
          .then(function(j){ if (j && j.run) mergeOrchRun(j.run); rsm.remove(); })
          .catch(function(err){ toast(err.message); rsm.disabled = false; });
        return;
      }
      var rd = ev.target.closest && ev.target.closest("[data-orch-deliver]");
      if (rd) { redeliverOrch(rd.getAttribute("data-orch-deliver"), rd); return; }
      if (approvalClick(ev)) return;
      if (ev.target.closest && ev.target.closest(".apcard")) return; // the card's own input, its details
      var t = ev.target;
      while (t && t !== this && !(t.classList && t.classList.contains("turncard"))) t = t.parentNode;
      if (!t || t === this) return;
      if (ev.target.closest && ev.target.closest(".tcdiff")) return; // let diff text select/scroll
      var enc = t.getAttribute("data-patch"); if (!enc) return;
      var patch = decodeURIComponent(enc);
      if (desktop) { var rwb = t.querySelector("[data-rewind]"); openPatchDock(patch, t.getAttribute("data-label") || "changes", rwb ? rwb.getAttribute("data-rewind") : null); return; }
      var d = t.querySelector(".tcdiff"); if (!d) return;
      var open = d.style.display !== "none" && d.innerHTML;
      if (open) { d.style.display = "none"; }
      else {
        if (!d.innerHTML) d.innerHTML = '<div class="dcode">' + renderDiffLines(patch.split("\n")) + "</div>";
        d.style.display = "";
      }
      var ch = t.querySelector(".tchev");
      if (ch) ch.textContent = open ? "\u25b8" : "\u25be";
    });
    // Right-click a message: its actions where you clicked. A text selection
    // inside it keeps the native menu (Copy, Look Up, spelling) — that's what
    // you right-clicked for.
    document.getElementById("feed").addEventListener("contextmenu", function(ev){
      var msgEl = ev.target && ev.target.closest ? ev.target.closest(".msg") : null;
      if (!msgEl || !msgEl.getAttribute("data-id")) return;
      var sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && msgEl.contains(sel.anchorNode)) return;
      if (ev.target.closest("a[href], input, textarea")) return;
      ev.preventDefault();
      msgMenu(msgEl, null, { x: ev.clientX, y: ev.clientY }, ev.target.closest("pre"));
    });
    document.getElementById("feed").addEventListener("keydown", approvalKey);
    // Enter in an answer box sends it, the way Enter sends anywhere else.
    document.getElementById("feed").addEventListener("keydown", function(ev){
      if (ev.key !== "Enter" || !ev.target.classList || !ev.target.classList.contains("nitext")) return;
      ev.preventDefault();
      answerAgent(ev.target.closest(".nicard"), ev.target.value);
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

    /**
     * What this project knows, as a map: each memory a dot (coloured by kind,
     * bigger the more it's been used), joined to the files and symbols it's
     * about. Only entities two or more memories share get a node — the rest
     * connect nothing. Laid out once with a small force simulation, seeded by
     * id so the same brain draws the same way every time.
     */
    function drawMemGraph(host, mems, usage){
      if (!host) return;
      mems = mems.slice(0, 150);
      var count = {};
      mems.forEach(function(m){ (m.entities || []).forEach(function(e){ count[e] = (count[e] || 0) + 1; }); });
      var ents = Object.keys(count).filter(function(e){ return count[e] > 1; })
        .sort(function(a, b){ return count[b] - count[a]; }).slice(0, 60);
      var eset = {}; ents.forEach(function(e){ eset[e] = 1; });
      var nodes = [], idx = {}, links = [];
      function seed(s){ var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
      function add(id, kind, data){
        var h = seed(id);
        idx[id] = nodes.length;
        nodes.push({ id: id, t: kind, d: data, x: (h % 400) / 2, y: ((h >> 9) % 400) / 2, vx: 0, vy: 0 });
      }
      mems.forEach(function(m){ add("m:" + m.id, "m", m); });
      ents.forEach(function(e){ add("e:" + e, "e", e); });
      mems.forEach(function(m){ (m.entities || []).forEach(function(e){ if (eset[e]) links.push([idx["m:" + m.id], idx["e:" + e]]); }); });
      var n = nodes.length;
      for (var it = 0; it < 260; it++) {
        var alpha = 1 - it / 260;
        for (var i = 0; i < n; i++) {
          var a = nodes[i];
          for (var j = i + 1; j < n; j++) {
            var b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01;
            if (d2 > 40000) continue;
            var f = 260 / d2;
            a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
          }
          a.vx -= a.x * 0.012; a.vy -= a.y * 0.012;
        }
        links.forEach(function(l){
          var a = nodes[l[0]], b = nodes[l[1]], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
          var f = (d - 46) * 0.05 / d;
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        });
        nodes.forEach(function(o){
          o.vx = Math.max(-12, Math.min(12, o.vx)); o.vy = Math.max(-12, Math.min(12, o.vy));
          o.x += o.vx * alpha; o.y += o.vy * alpha; o.vx *= 0.6; o.vy *= 0.6;
        });
      }
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      nodes.forEach(function(o){ x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x); y1 = Math.max(y1, o.y); });
      var pad = 40, w = Math.max(200, x1 - x0 + pad * 2), h = Math.max(160, y1 - y0 + pad * 2);
      var svg = '<svg class="bgsvg" viewBox="' + (x0 - pad) + " " + (y0 - pad) + " " + w + " " + h + '" role="img" aria-label="memory graph">' +
        links.map(function(l, k){
          var a = nodes[l[0]], b = nodes[l[1]];
          return '<line class="bgl" data-a="' + l[0] + '" data-b="' + l[1] + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"/>';
        }).join("") +
        nodes.map(function(o, i){
          if (o.t === "e") {
            var label = o.d.length > 22 ? "…" + o.d.slice(-21) : o.d;
            return '<g class="bge" data-i="' + i + '" tabindex="0"><title>' + esc(o.d) + " · " + count[o.d] + " memories</title>" +
              '<rect x="' + (o.x - 3).toFixed(1) + '" y="' + (o.y - 3).toFixed(1) + '" width="6" height="6" rx="1.5"/>' +
              '<text x="' + (o.x + 6).toFixed(1) + '" y="' + (o.y + 3).toFixed(1) + '">' + esc(label) + "</text></g>";
          }
          var used = (usage[o.d.id] || {}).n || 0;
          var r = 4.5 + Math.min(6, Math.sqrt(used) * 1.5);
          return '<g class="bgm bk-' + esc(o.d.kind) + '" data-i="' + i + '" tabindex="0"><title>' + esc(o.d.kind + ": " + o.d.text) + "</title>" +
            '<circle cx="' + o.x.toFixed(1) + '" cy="' + o.y.toFixed(1) + '" r="' + r.toFixed(1) + '"/></g>';
        }).join("") + "</svg>";
      var lonely = mems.filter(function(m){ return !(m.entities || []).some(function(e){ return eset[e]; }); }).length;
      host.innerHTML = '<div class="bgcap">' + mems.length + " memor" + (mems.length === 1 ? "y" : "ies") + " · " + ents.length + " shared file" + (ents.length === 1 ? "" : "s") + " or symbol" + (ents.length === 1 ? "" : "s") + " joining them" +
        (lonely ? " · " + lonely + " stand alone" : "") + '<span class="dim"> · click a dot or a name</span></div>' + svg + '<div class="bgpick" id="bgpick"></div>';
      var svgEl = host.querySelector("svg"), pick = host.querySelector("#bgpick");
      function focus(i){
        var near = {}; near[i] = 1;
        links.forEach(function(l){ if (l[0] === i) near[l[1]] = 1; if (l[1] === i) near[l[0]] = 1; });
        svgEl.classList.add("focus");
        Array.prototype.forEach.call(svgEl.querySelectorAll("[data-i]"), function(g){ g.classList.toggle("near", !!near[+g.getAttribute("data-i")]); });
        Array.prototype.forEach.call(svgEl.querySelectorAll(".bgl"), function(l){ l.classList.toggle("near", +l.getAttribute("data-a") === i || +l.getAttribute("data-b") === i); });
        var o = nodes[i];
        if (o.t === "m") {
          pick.innerHTML = '<span class="bbadge bk-' + esc(o.d.kind) + '">' + esc(o.d.kind) + "</span> " + esc(o.d.text) +
            ((o.d.entities || []).length ? '<div class="bents">' + o.d.entities.slice(0, 8).map(function(e){ return '<span class="bent">' + esc(e) + "</span>"; }).join("") + "</div>" : "");
        } else {
          var about = mems.filter(function(m){ return (m.entities || []).indexOf(o.d) >= 0; });
          pick.innerHTML = '<b class="mono">' + esc(o.d) + "</b> · " + about.length + " memor" + (about.length === 1 ? "y" : "ies") + "<ul>" +
            about.slice(0, 8).map(function(m){ return '<li><span class="bbadge bk-' + esc(m.kind) + '">' + esc(m.kind) + "</span> " + esc(m.text) + "</li>"; }).join("") + "</ul>";
        }
      }
      Array.prototype.forEach.call(svgEl.querySelectorAll("[data-i]"), function(g){
        g.onclick = function(ev){ ev.stopPropagation(); focus(+g.getAttribute("data-i")); };
        g.onkeydown = function(ev){ if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); focus(+g.getAttribute("data-i")); } };
      });
      svgEl.onclick = function(){ svgEl.classList.remove("focus"); pick.innerHTML = ""; };
    }

    // ---- brain pane · Team view (Phase 3: one brain) -------------------------
    // Mine is this machine's brain, above. Team is the team's: canon from
    // AGENTS.md, what teammates learned, by tier, and an inbox of what needs a
    // human first. Every action answers with the fresh view, so no re-read.
    var brainView = "mine", tbHistory = false, tbPr = null, tbPingT = null;
    var TB_TIERS = [["canon", "Canon"], ["confirmed", "Confirmed"], ["own", "Yours"], ["proposed", "Proposed"]];
    // A teammate's memory or a resolution landed: re-read, once per burst.
    state.teamBrainPing = function(){
      if (state.tab !== "brain" || brainView !== "team" || tbPingT) return;
      tbPingT = setTimeout(function(){ tbPingT = null; if (brainView === "team") refreshTeamBrain(); }, 600);
    };
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
            return '<div class="tool">' + esc(s.agentId) + " \u2190 " + esc(s.file) + "</div>";
          }).join("");
          var body = esc(m.document || "").split("\n").map(function(line){
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
          var patch = (t.patch || "").split("\n").map(function(line){
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
      // The phone has no tab strip, so the Orchestra view is a sheet — the
      // same drawing as the desktop tab, in the same slot as its siblings.
      document.getElementById("orchbtn").onclick = function(){
        if (document.getElementById("orchsheet")) { closeOrchSheet(); return; }
        openOrchSheet();
      };
      // Crew the same way.
      document.getElementById("crewbtn").onclick = function(){
        if (document.getElementById("crewsheet")) { closeCrewSheet(); return; }
        openCrewSheet();
      };
      // Fleet the same way: the desktop tab's drawing, in the sheet slot.
      document.getElementById("fleetbtn").onclick = function(){
        if (document.getElementById("fleetsheet")) { closeFleetSheet(); return; }
        openFleetSheet();
      };
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
    state.drawRail = drawRail;

    // Live frames that race the history fetch wait their turn, so an early
    // WS event can't outrun (and id-mask) the backlog.
    var historyLoaded = false, pendingWs = [];
    // The transcript-level menu lives in the shell's scope, and this doesn't.
    state.redrawFeed = loadHistory;
    loadHistory();
    if (chatId === "main") showRecap();

    /**
     * Back after a while (a new day, or eight hours on): what happened while
     * you were away, in one strip over Main — turns, who took them, what
     * failed, what it cost. From the log's own turn rows; shown once per
     * return, gone when you close it.
     */
    function showRecap(){
      var key = "loomLastVisit:" + pid, now = Date.now(), last = 0;
      try { last = Number(localStorage.getItem(key)) || 0; localStorage.setItem(key, String(now)); } catch (e) { return; }
      if (!last) return;
      var away = now - last, newDay = new Date(last).toDateString() !== new Date(now).toDateString();
      if (away < 8 * 3600 * 1000 && !newDay) return;
      if (away < 20 * 60 * 1000) return;
      api("/api/projects/" + pid + "/insights/turns?since=" + last).then(function(j){
        var rows = (j && j.leaderboard) || [];
        var turns = 0, errs = 0, cost = 0;
        rows.forEach(function(a){ turns += a.turns || 0; errs += a.errors || 0; cost += a.totalCostUsd || 0; });
        if (!turns || pageGone()) return;
        var host = document.getElementById("pane-thread"), feed = document.getElementById("feed");
        if (!host || !feed || document.getElementById("recap")) return;
        var who = rows.slice().sort(function(a, b){ return b.turns - a.turns; }).slice(0, 3).map(function(a){ return esc(labelOf(a.agentId)) + " " + a.turns; }).join(", ");
        var el = document.createElement("div");
        el.id = "recap";
        el.className = "recap";
        el.setAttribute("role", "status");
        el.innerHTML = '<span class="recapi">' + ICONS.clock + "</span>" +
          '<span class="recapt"><b>Since you were here</b> <span class="dim">' + esc(newDay ? relDay(last) : rel(last)) + "</span> · " +
          turns + " turn" + (turns === 1 ? "" : "s") + " (" + who + ")" +
          (errs ? ' · <span class="recaperr">' + errs + " failed</span>" : "") +
          (cost > 0 ? " · " + money(cost) : "") + "</span>" +
          '<button type="button" class="btn xs ghost" id="recapgo">Insights</button>' +
          '<button type="button" class="iconbtn xs" id="recapx" aria-label="dismiss" title="dismiss">' + ICONS.x + "</button>";
        host.insertBefore(el, feed);
        el.querySelector("#recapx").onclick = function(){ el.remove(); };
        el.querySelector("#recapgo").onclick = function(){ el.remove(); showTab("observatory"); };
      }).catch(function(){});
    }
    function relDay(ts){
      var d = new Date(ts), y = new Date(); y.setDate(y.getDate() - 1);
      var hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return (d.toDateString() === y.toDateString() ? "yesterday " : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + " ") + hm;
    }
    (function(){
      var j = document.getElementById("jumpnew"), sc = threadScroller();
      if (j) j.onclick = toBottom;
      if (sc) sc.addEventListener("scroll", function(){
        if (!nearBottom()) return;
        var jj = document.getElementById("jumpnew"); if (jj) jj.classList.remove("show");
      }, { passive: true });
    })();
    refresh();
    state.timers.push(setInterval(refresh, 4000));
    if (desktop) {
      refreshTree(false);
      state.timers.push(setInterval(function(){ refreshTree(false); }, 5000));
    }
    connect();

    // Attachments live here for the life of this project view. A pasted image
    // or dropped file is uploaded to .loom/attachments/ and referenced by path
    // in the outgoing message — the CLIs take text, not blobs, so the path IS
    // the attachment. Cleared after each send.
    var attach = [];
    /** Brief / Normal / Detailed — how long replies should be, per project, on this device. */
    function replyLength(){ try { var v = localStorage.getItem("loomLength:" + pid); return v === "brief" || v === "detailed" ? v : ""; } catch (e) { return ""; } }
    function setReplyLength(v){
      try { if (v) localStorage.setItem("loomLength:" + pid, v); else localStorage.removeItem("loomLength:" + pid); } catch (e) {}
      drawLengthPill();
      toast(v === "brief" ? "replies will be brief" : v === "detailed" ? "replies will be detailed" : "replies back to normal length");
    }
    function drawLengthPill(){
      var old = document.getElementById("lenpill"); if (old) old.remove();
      var v = replyLength(); if (!v) return;
      var plan = document.getElementById("planbtn"); if (!plan || !plan.parentNode) return;
      var b = document.createElement("button");
      b.type = "button"; b.id = "lenpill"; b.className = "lenpill";
      b.title = "reply length for this project — click for normal";
      b.textContent = v === "brief" ? "Brief" : "Detailed";
      b.onclick = function(){ setReplyLength(""); };
      plan.parentNode.insertBefore(b, plan);
    }
    /** A prompt waiting for the daemon to come back, shown above the composer. */
    function holdForReconnect(full){
      state.heldSend = { pid: pid, chat: chatId, text: full, agent: (!state.auto && state.selected) || null };
      saveDraft();
      var old = document.getElementById("heldnote"); if (old) old.remove();
      var form = document.getElementById("cform"); if (!form) return;
      var n = document.createElement("div");
      n.id = "heldnote"; n.className = "heldnote"; n.setAttribute("role", "status");
      n.innerHTML = '<span class="obspin"></span><span>Loom isn’t answering — this sends as soon as it’s back.</span><button type="button" class="linkbtn" id="heldcancel">Don’t send</button>';
      form.parentNode.insertBefore(n, form);
      document.getElementById("heldcancel").onclick = function(){ state.heldSend = null; n.remove(); toast("kept in the composer — it won’t send by itself"); };
    }
    state.onReconnect = function(){
      var h = state.heldSend; if (!h || h.pid !== pid || h.chat !== chatId) return;
      state.heldSend = null;
      var n = document.getElementById("heldnote"); if (n) n.remove();
      setTimeout(function(){ if (!pageGone()) { composeFor(h.text, h.agent, true); toast("sent — Loom is back"); } }, 700);
    };

    // ---- message actions ------------------------------------------------------
    /** The prompt behind an agent's reply: the nearest of your messages above it. */
    function promptFor(msgEl){
      for (var n = msgEl && msgEl.previousElementSibling; n; n = n.previousElementSibling) {
        if (n.classList && n.classList.contains("msg") && n.classList.contains("user")) return decodeURIComponent(n.getAttribute("data-raw") || "");
      }
      return "";
    }
    function bubbleText(msgEl){
      var b = msgEl && msgEl.querySelector(".bubble");
      return b ? (b.innerText || b.textContent || "").trim() : "";
    }
    /**
     * Put text in the composer, for an agent, and send it — or leave it there
     * to edit. The one path Retry, Edit, Continue and Quote all take, so a
     * resend follows every rule a typed prompt does (the queue, plan mode,
     * the handoff to a different agent).
     */
    function composeFor(text, agentId, go){
      var box = document.getElementById("box"); if (!box) return;
      if (state.cmode === "orch" && !orchRunForChat()) setComposerMode("chat");
      var roster = (state.project && state.project.agents) || [];
      if (agentId && roster.some(function(a){ return a.id === agentId; })) { state.auto = false; state.selected = agentId; drawStatus(); }
      box.value = text; autosizeBox(); saveDraft();
      var form = document.getElementById("cform"); if (form) form.classList.toggle("hastext", !!box.value.trim());
      if (go) { send(); return; }
      box.focus(); box.setSelectionRange(box.value.length, box.value.length);
    }
    function quoteIntoComposer(text){
      var box = document.getElementById("box"); if (!box || !text) return;
      var q = String(text).trim().split("\n").slice(0, 12).map(function(l){ return "> " + l; }).join("\n");
      var cur = box.value.replace(/\s+$/, "");
      box.value = (cur ? cur + "\n\n" : "") + q + "\n\n";
      autosizeBox(); saveDraft(); box.focus(); box.setSelectionRange(box.value.length, box.value.length);
      var form = document.getElementById("cform"); if (form) form.classList.add("hastext");
    }
    /**
     * A message's actions: from its ⋯ button, or a right-click anywhere on it
     * (`at` is the cursor; `code` the code block under it, if any).
     */
    function msgMenu(msgEl, anchor, at, code){
      if (!msgEl) return;
      var id = Number(msgEl.getAttribute("data-id")) || 0, agentId = msgEl.getAttribute("data-agent");
      var mine = msgEl.classList.contains("user");
      var prompt = promptFor(msgEl);
      var others = ((state.project && state.project.agents) || []).filter(function(a){
        return a.tier === "adapter" && a.enabled !== false && a.id !== agentId;
      });
      var starred = !!(state.starSet && state.starSet[id]);
      var r = anchor ? anchor.getBoundingClientRect() : { left: at.x, right: at.x + 220, bottom: at.y, top: at.y };
      var items = [{ head: agentId ? labelOf(agentId) : mine ? "Your message" : "Message" }];
      if (code) {
        items.push({ label: "Copy code", icon: ICONS.copy, run: function(){ copyText(code.innerText || code.textContent || ""); toast("code copied"); } });
        items.push({ label: "Code into the composer", icon: ICONS.quote, run: function(){ quoteIntoComposer("```\n" + (code.innerText || code.textContent || "").trim() + "\n```"); } });
        items.push({ sep: true });
      }
      items.push({ label: "Copy text", icon: ICONS.copy, run: function(){
        copyText(mine ? decodeURIComponent(msgEl.getAttribute("data-raw") || "") || bubbleText(msgEl) : bubbleText(msgEl)); toast("copied");
      } });
      if (mine) {
        var raw = decodeURIComponent(msgEl.getAttribute("data-raw") || "") || bubbleText(msgEl);
        items.push({ label: "Edit & resend", icon: ICONS.pencil, run: function(){ composeFor(raw, null, false); } });
        items.push({ label: "Send again", icon: ICONS.refresh, run: function(){ composeFor(raw, null, true); } });
        items.push({ label: "Save as a prompt", icon: ICONS.bookmark, run: function(){
          api("/api/prompts", { method: "POST", body: JSON.stringify({ text: raw, title: raw.split("\n")[0].slice(0, 60) }) })
            .then(function(){ toast("saved — it's in Prompts"); }).catch(function(err){ toast(err.message); });
        } });
        items.push({ sep: true });
      }
      if (prompt) {
        items.push({ label: "Retry", icon: ICONS.refresh, hint: "same prompt", run: function(){ composeFor(prompt, agentId, true); } });
        if (others.length) items.push({ label: "Retry with\u2026", icon: ICONS.agents, hint: others.length + " agents", run: function(){
          openMenu(Math.round(r.left), Math.round(r.bottom + 4), [{ head: "Send the same prompt to" }].concat(others.map(function(a){
            return { label: agentLabel(a.kind, a.id), icon: agentGlyph(a.kind, a.id), hint: a.busy ? "busy" : "", run: function(){ composeFor(prompt, a.id, true); } };
          })));
        } });
        items.push({ sep: true });
      }
      items.push({ label: starred ? "Unstar" : "Star", icon: ICONS.star, run: function(){ toggleStar(id); } });
      items.push({ label: "Quote in reply", icon: ICONS.quote, run: function(){ quoteIntoComposer(bubbleText(msgEl)); } });
      items.push({ label: "Make a card", icon: ICONS.board, hint: "on the board", run: function(){
        openBoardTaskModal(pid, "working", function(){ if (state.reloadBoard) state.reloadBoard(); }, bubbleText(msgEl).split("\n")[0].slice(0, 200));
      } });
      items.push({ label: "Copy link", icon: ICONS.link, run: function(){ copyText(messageLink(id)); } });
      if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
        var reading = window.speechSynthesis.speaking;
        items.push({ label: reading ? "Stop reading" : "Read aloud", icon: ICONS.play, run: function(){
          window.speechSynthesis.cancel();
          if (reading) return;
          var u = new SpeechSynthesisUtterance(bubbleText(msgEl).replace(/\s+/g, " ").slice(0, 8000));
          u.rate = 1.05;
          window.speechSynthesis.speak(u);
        } });
      }
      items.push({ label: "Branch from here", icon: ICONS.branch, hint: "new chat", run: function(){ branchFrom(msgEl); } });
      if (at) openMenu(at.x, at.y, items);
      else openMenu(Math.round(r.right - 220), Math.round(r.bottom + 4), items);
    }
    /** A link that opens this project, this chat, this message. */
    function messageLink(id){
      return location.origin + location.pathname + "#p/" + encodeURIComponent(pid) + "/c/" + encodeURIComponent(chatId) + "/m/" + id;
    }
    /** Stars live with the chat on the daemon, so every device sees them. */
    function syncStars(){
      var c = ((state.project && state.project.chats) || []).filter(function(q){ return q.id === chatId; })[0];
      var set = {};
      ((c && c.starred) || []).forEach(function(n){ set[n] = true; });
      state.starSet = set;
      state.rateMap = (c && c.ratings) || {};
    }
    function toggleStar(id){
      if (!id) return;
      var on = !(state.starSet && state.starSet[id]);
      api("/api/projects/" + pid + "/chats/" + encodeURIComponent(chatId) + "/star", { method: "POST", body: JSON.stringify({ eventId: id, on: on }) })
        .then(function(j){
          var set = {}; (j.starred || []).forEach(function(n){ set[n] = true; }); state.starSet = set;
          var el = document.querySelector('#feed .msg[data-id="' + id + '"]');
          if (el) {
            var old = el.querySelector(".wstar"); if (old) old.remove();
            if (on) {
              var host = el.querySelector(".who .msgcopy") || el.querySelector(".mt .ustar");
              if (host) host.insertAdjacentHTML("beforebegin", '<span class="wstar" title="starred">' + ICONS.star + "</span>");
              el.classList.add("flash"); setTimeout(function(){ el.classList.remove("flash"); }, 900);
            }
          }
          toast(on ? "starred · ⋯ beside the composer → Starred messages" : "unstarred");
          if (state.refreshShell) state.refreshShell();
        })
        .catch(function(err){ toast(err.message); });
    }
    state.showStarred = function(){
      var ids = Object.keys(state.starSet || {}).map(Number).sort(function(a, b){ return b - a; });
      if (!ids.length) { toast("nothing starred in this chat yet \u2014 \u22ef on a message \u2192 Star"); return; }
      var items = [{ head: "Starred in this chat" }].concat(ids.slice(0, 30).map(function(id){
        var el = document.querySelector('#feed .msg[data-id="' + id + '"]');
        var t = el ? bubbleText(el).split("\n")[0].slice(0, 70) : "message #" + id + " (earlier \u2014 load earlier messages)";
        return { label: t || "message #" + id, icon: ICONS.star, run: function(){ jumpToMessage(id); } };
      }));
      openMenu(Math.round(window.innerWidth / 2 - 180), 90, items);
    };
    /** Scroll to a message and flash it; page back for it when it's older than what's loaded. */
    function jumpToMessage(id, tries){
      var el = document.querySelector('#feed .msg[data-id="' + id + '"]');
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("flash"); setTimeout(function(){ el.classList.remove("flash"); }, 1600);
        return;
      }
      tries = tries || 0;
      if (tries < 8 && document.getElementById("loadearlier") && state.firstId && id < state.firstId) {
        loadEarlier().then(function(){ jumpToMessage(id, tries + 1); });
        return;
      }
      toast("that message isn\u2019t in this chat any more");
    }
    state.jumpToMessage = jumpToMessage;
    /**
     * Start a new chat that carries this one up to a message — for trying a
     * different direction without losing the one you're on.
     */
    function branchFrom(msgEl){
      var feed = document.getElementById("feed"); if (!feed || !msgEl) return;
      var lines = [], budget = 6000;
      var all = Array.prototype.slice.call(feed.querySelectorAll(":scope > .msg:not(.thinking)"));
      var upto = all.indexOf(msgEl);
      all.slice(0, upto + 1).reverse().some(function(n){
        var who = n.classList.contains("user") ? "Me" : labelOf(n.getAttribute("data-agent") || "agent");
        var t = n.classList.contains("user") ? decodeURIComponent(n.getAttribute("data-raw") || "") : bubbleText(n);
        var chunk = who + ": " + t.trim();
        if (chunk.length > budget) chunk = chunk.slice(0, budget) + "\u2026";
        lines.unshift(chunk); budget -= chunk.length;
        return budget <= 0;
      });
      var c = ((state.project && state.project.chats) || []).filter(function(q){ return q.id === chatId; })[0];
      var title = "Branch of " + ((c && c.title) || "Main");
      api("/api/projects/" + pid + "/chats", { method: "POST", body: JSON.stringify({ title: title.slice(0, 60) }) })
        .then(function(j){
          var draft = "Earlier, in \u201c" + ((c && c.title) || "Main") + "\u201d:\n\n" + lines.map(function(l){ return l.split("\n").map(function(x){ return "> " + x; }).join("\n"); }).join("\n>\n") + "\n\n";
          try { localStorage.setItem(draftKey(j.chat.id), draft); } catch (e) {}
          if (state.setChat) state.setChat(pid, j.chat.id);
          toast("branched \u2014 the conversation so far is in the composer; add where to go next");
        })
        .catch(function(err){ toast(err.message); });
    }

    // ---- drafts and recall ------------------------------------------------------
    function draftKey(cid){ return "loomDraft:" + pid + ":" + (cid || chatId); }
    var draftTimer = null;
    function saveDraft(){
      clearTimeout(draftTimer);
      draftTimer = setTimeout(function(){
        if (pageGone()) return;
        var box = document.getElementById("box"); if (!box) return;
        try {
          if (box.value.trim()) localStorage.setItem(draftKey(), box.value);
          else localStorage.removeItem(draftKey());
        } catch (e) {}
      }, 250);
    }
    function clearDraft(){ clearTimeout(draftTimer); try { localStorage.removeItem(draftKey()); } catch (e) {} }
    function restoreDraft(){
      var box = document.getElementById("box"); if (!box || box.value) return;
      var d = null;
      try { d = localStorage.getItem(draftKey()); } catch (e) {}
      if (!d) return;
      box.value = d; autosizeBox();
      var form = document.getElementById("cform"); if (form) form.classList.toggle("hastext", !!d.trim());
    }
    var recall = { i: -1, shown: "" };
    function myPrompts(){
      return Array.prototype.map.call(document.querySelectorAll("#feed .msg.user[data-raw]"), function(n){
        return decodeURIComponent(n.getAttribute("data-raw") || "");
      }).filter(function(t, i, all){ return t.trim() && t !== all[i + 1]; }).reverse();
    }

    // ---- find in thread --------------------------------------------------------
    var find = { hits: [], i: -1, q: "" };
    function clearFind(){
      Array.prototype.forEach.call(document.querySelectorAll("#feed mark.fhit"), function(m){
        var parent = m.parentNode; if (!parent) return;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
      });
      find.hits = []; find.i = -1;
    }
    function runFind(q){
      clearFind(); find.q = q;
      var feed = document.getElementById("feed");
      if (!q || !feed) return drawFindCount();
      var ql = q.toLowerCase(), nodes = [];
      Array.prototype.forEach.call(feed.querySelectorAll(".bubble, .sys, .tool .tx, .turncard .tcf, .plancard"), function(root){
        var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        for (var t = w.nextNode(); t; t = w.nextNode()) if (t.nodeValue && t.nodeValue.toLowerCase().indexOf(ql) >= 0) nodes.push(t);
      });
      var total = 0;
      nodes.forEach(function(t){
        if (total >= 500) return;
        var text = t.nodeValue.toLowerCase(), at = [], from = 0, k;
        while ((k = text.indexOf(ql, from)) >= 0 && total + at.length < 500) { at.push(k); from = k + ql.length; }
        for (var j = at.length - 1; j >= 0; j--) {
          var mid = t.splitText(at[j]); mid.splitText(q.length);
          var m = document.createElement("mark"); m.className = "fhit";
          mid.parentNode.replaceChild(m, mid); m.appendChild(mid);
        }
        total += at.length;
      });
      find.hits = Array.prototype.slice.call(feed.querySelectorAll("mark.fhit"));
      find.i = find.hits.length ? find.hits.length - 1 : -1; // newest first: you usually want the latest
      showFindHit();
    }
    function showFindHit(){
      find.hits.forEach(function(m, i){ m.classList.toggle("cur", i === find.i); });
      var m = find.hits[find.i];
      if (m) {
        for (var d = m.parentNode; d && d.id !== "feed"; d = d.parentNode) {
          if (d.tagName === "DETAILS") d.open = true;
          if (d.classList && d.classList.contains("clamped")) { d.classList.remove("clamped"); var sm = d.querySelector(".showmore"); if (sm) sm.textContent = "Show less"; }
        }
        m.scrollIntoView({ block: "center" });
      }
      drawFindCount();
    }
    function drawFindCount(){
      var c = document.getElementById("findcount"); if (!c) return;
      var more = document.getElementById("loadearlier");
      c.innerHTML = !find.q ? "" : find.hits.length
        ? (find.i + 1) + " of " + find.hits.length + (find.hits.length >= 500 ? "+" : "")
        : "No matches" + (more ? ' \u00b7 <button type="button" class="linkbtn" id="findearlier">search earlier</button>' : "");
      var fe = document.getElementById("findearlier");
      if (fe) fe.onclick = function(){ loadEarlier().then(function(){ runFind(find.q); }); };
    }
    function stepFind(dir){
      if (!find.hits.length) return;
      find.i = (find.i + dir + find.hits.length) % find.hits.length;
      showFindHit();
    }
    function closeFind(){
      clearFind(); find.q = "";
      var b = document.getElementById("findbar"); if (b) b.remove();
    }
    function openFind(){
      if (state.showTab) state.showTab("thread");
      var sc = threadScroller(); if (!sc || !sc.parentNode) return;
      var bar = document.getElementById("findbar");
      if (!bar) {
        var host = sc.parentNode;
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        bar = document.createElement("div");
        bar.id = "findbar"; bar.className = "findbar"; bar.setAttribute("role", "search");
        bar.innerHTML = ICONS.search + '<input id="findq" placeholder="Find in this chat" spellcheck="false" autocomplete="off" aria-label="find in this chat">' +
          '<span class="findcount" id="findcount" aria-live="polite"></span>' +
          '<button type="button" class="iconbtn" id="findprev" title="Previous (Enter)" aria-label="previous match">' + ICONS.up + "</button>" +
          '<button type="button" class="iconbtn" id="findnext" title="Next (\u21e7Enter)" aria-label="next match">' + ICONS.arrowDown + "</button>" +
          '<button type="button" class="iconbtn" id="findx" title="Close (Esc)" aria-label="close find">' + ICONS.x + "</button>";
        host.appendChild(bar);
        var qi = document.getElementById("findq"), t = null;
        qi.addEventListener("input", function(){ clearTimeout(t); var v = qi.value; t = setTimeout(function(){ runFind(v.trim()); }, 120); });
        qi.addEventListener("keydown", function(e){
          if (e.key === "Enter") { e.preventDefault(); stepFind(e.shiftKey ? 1 : -1); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); var bx = document.getElementById("box"); if (bx) bx.focus(); }
        });
        document.getElementById("findprev").onclick = function(){ stepFind(-1); };
        document.getElementById("findnext").onclick = function(){ stepFind(1); };
        document.getElementById("findx").onclick = closeFind;
      }
      var inp = document.getElementById("findq");
      var sel = String(window.getSelection ? window.getSelection() : "").trim();
      if (sel && sel.length < 80 && sel.indexOf("\n") < 0) { inp.value = sel; runFind(sel); }
      inp.focus(); inp.select();
    }
    state.openFind = openFind;
    /** [ and ]: to your previous or next prompt in this chat. */
    state.jumpPrompt = function(dir){
      var sc = threadScroller(); if (!sc) return;
      var top = sc.getBoundingClientRect().top;
      var mine = Array.prototype.slice.call(document.querySelectorAll("#feed > .msg.user"));
      if (!mine.length) return;
      var pick = null;
      if (dir < 0) { for (var i = mine.length - 1; i >= 0; i--) if (mine[i].getBoundingClientRect().top < top - 6) { pick = mine[i]; break; } }
      else { for (var j = 0; j < mine.length; j++) if (mine[j].getBoundingClientRect().top > top + 24) { pick = mine[j]; break; } }
      if (!pick) { toast(dir < 0 ? "that’s your first prompt here" : "that’s your last prompt here"); return; }
      sc.scrollTop += pick.getBoundingClientRect().top - top - 12;
      pick.classList.add("flash"); setTimeout(function(){ pick.classList.remove("flash"); }, 900);
    };

    // Select words in a reply → a small Quote button beside them.
    (function(){
      var feed = document.getElementById("feed"); if (!feed) return;
      function hide(){ var q = document.getElementById("quotebtn"); if (q) q.remove(); }
      feed.addEventListener("mouseup", function(){
        setTimeout(function(){
          if (pageGone()) return;
          hide();
          var sel = window.getSelection && window.getSelection();
          var text = sel ? String(sel).trim() : "";
          if (!text || !sel.rangeCount) return;
          var a = sel.anchorNode, host = a && (a.nodeType === 1 ? a : a.parentNode);
          if (!host || !host.closest || !host.closest("#feed .bubble")) return;
          var r = sel.getRangeAt(0).getBoundingClientRect();
          var b = document.createElement("button");
          b.type = "button"; b.id = "quotebtn"; b.className = "quotebtn";
          b.innerHTML = ICONS.quote + "Quote";
          b.style.left = Math.max(8, Math.min(window.innerWidth - 100, r.left + r.width / 2 - 38)) + "px";
          b.style.top = Math.max(8, r.top - 38) + "px";
          b.onmousedown = function(ev){ ev.preventDefault(); };
          b.onclick = function(){ quoteIntoComposer(text); hide(); if (sel.removeAllRanges) sel.removeAllRanges(); };
          document.body.appendChild(b);
        }, 0);
      });
      if (!state.quoteHideBound) {
        state.quoteHideBound = true;
        document.addEventListener("mousedown", function(ev){ if (!ev.target.closest || !ev.target.closest("#quotebtn")) { var q = document.getElementById("quotebtn"); if (q) q.remove(); } }, true);
      }
      var sc = threadScroller(); if (sc) sc.addEventListener("scroll", hide, { passive: true });
    })();

    // ---- day separators ----------------------------------------------------------
    function dayLabel(ts){
      var d = new Date(ts), t = new Date();
      var d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      var t0 = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
      var diff = Math.round((t0 - d0) / 86400000);
      if (diff === 0) return "Today";
      if (diff === 1) return "Yesterday";
      if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: "long" });
      var o = { weekday: "short", month: "short", day: "numeric" };
      if (d.getFullYear() !== t.getFullYear()) o.year = "numeric";
      return d.toLocaleDateString([], o);
    }
    var daysQueued = false;
    function markDays(){
      if (daysQueued) return;
      daysQueued = true;
      setTimeout(function(){
        daysQueued = false;
        if (pageGone()) return;
        var feed = document.getElementById("feed"); if (!feed) return;
        Array.prototype.forEach.call(feed.querySelectorAll(":scope > .daysep"), function(n){ n.remove(); });
        var last = "";
        Array.prototype.forEach.call(feed.querySelectorAll(":scope > .msg[data-ts]"), function(n){
          var ts = Number(n.getAttribute("data-ts")); if (!ts) return;
          var key = new Date(ts).toDateString();
          if (key === last) return;
          last = key;
          var sep = document.createElement("div");
          sep.className = "daysep"; sep.setAttribute("role", "separator");
          sep.innerHTML = "<span>" + esc(dayLabel(ts)) + "</span>";
          feed.insertBefore(sep, n);
          n.classList.remove("cont"); // a new day gets its byline back
        });
        clampLong(feed);
      }, 0);
    }
    /** A reply taller than a screen folds behind Show more. */
    function clampLong(feed){
      Array.prototype.forEach.call(feed.querySelectorAll(":scope > .msg.agent:not(.live):not([data-ck])"), function(m){
        m.setAttribute("data-ck", "1");
        var b = m.querySelector(".bubble");
        if (!b || b.scrollHeight < 760) return;
        m.classList.add("clamped");
        var btn = document.createElement("button");
        btn.type = "button"; btn.className = "showmore";
        btn.textContent = "Show more";
        btn.onclick = function(ev){
          ev.stopPropagation();
          var open = m.classList.toggle("clamped");
          btn.textContent = open ? "Show more" : "Show less";
          if (open) m.scrollIntoView({ block: "nearest" });
        };
        b.insertAdjacentElement("afterend", btn);
      });
    }

    // ---- export ----------------------------------------------------------------
    /** The whole chat as Markdown: prompts, replies, what was done, what changed. */
    function exportThread(){
      toast("gathering the whole chat\u2026");
      var all = [], pages = 0;
      function page(before){
        return api("/api/projects/" + pid + "/events?limit=500&chat=" + encodeURIComponent(chatId) + (before ? "&before=" + before : ""))
          .then(function(j){
            var evs = j.events || [];
            all = evs.concat(all); pages++;
            if (evs.length >= 500 && pages < 20) return page(evs[0].id);
          });
      }
      return page(0).then(function(){
        var c = ((state.project && state.project.chats) || []).filter(function(q){ return q.id === chatId; })[0];
        var title = ((state.project && state.project.name) || "Loom") + " \u2014 " + ((c && c.title) || "Main");
        var out = ["# " + title, "", "_Exported from Loom " + new Date().toLocaleString() + " \u00b7 " + all.length + " events_", ""];
        var day = "";
        all.forEach(function(e){
          var p = e.payload || {}, when = new Date(Number(e.ts) || 0);
          var d = when.toDateString(); if (d !== day) { day = d; out.push("", "---", "", "*" + dayLabel(Number(e.ts)) + "*", ""); }
          var hm = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          if (e.kind === "message" && !e.agentId && p.author !== "loom") out.push("", "### You \u00b7 " + hm, "", String(p.text || ""));
          else if (e.kind === "message" && e.agentId && !p.reasoning) out.push("", "### " + labelOf(e.agentId) + (p.model ? " (" + p.model + ")" : "") + " \u00b7 " + hm + (p.partial ? " \u00b7 stopped" : ""), "", String(p.text || ""));
          else if (e.kind === "tool_call") out.push("- \u2699 " + String(p.summary || p.tool || p.name || "tool").split("\n")[0]);
          else if (e.kind === "turn_diff") out.push("", "> Edited " + (p.files || []).length + " file(s) \u00b7 +" + Number(p.added || 0) + " \u2212" + Number(p.removed || 0) + ": " + (p.files || []).map(function(f){ return f.path; }).slice(0, 12).join(", "));
          else if (e.kind === "error") out.push("", "> **Error** (" + (e.agentId || "loom") + "): " + String(p.message || p.error || "").split("\n")[0]);
          else if (e.kind === "run_complete") out.push("", "_" + (e.agentId || "agent") + " finished" + (p.durationMs ? " in " + durfmt(p.durationMs) : "") + (p.costUsd ? " \u00b7 $" + Number(p.costUsd).toFixed(4) : "") + "_");
        });
        var blob = new Blob([out.join("\n") + "\n"], { type: "text/markdown" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = title.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() + ".md";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
        toast("exported " + a.download);
      }).catch(function(err){ toast(err.message); });
    }
    state.exportThread = exportThread;

    // ---- the prompt queue --------------------------------------------------
    // What you've lined up while something else is running. Yours until it's
    // sent: edit the text, change who takes it, reorder it, drop it. The
    // daemon sends the head as soon as nothing is in its way, one at a time.

    var queue = { items: [], paused: false, reason: "", waitingFor: "", editing: null, dragging: null };

    // The @ / popover. menuState remembers what kind of menu is open and where
    // in the text the trigger started, so accepting an item replaces exactly the
    // token you were typing.
    var menuState = null;

    // ---- prompt manager ------------------------------------------------------
    // A clipboard manager for prompts: what you saved (pinned first, then by
    // use) above everything you've actually sent (newest first). Daemon-wide —
    // a prompt you wrote in one project is there in the next. Opens from the
    // chip or ⌘⇧V / Ctrl+Shift+V; ↑↓ move, Enter inserts, ⌘Enter inserts and
    // sends — in Chat or Orchestrate, because send() already knows which.
    var prompts = { saved: [], recent: [], q: "", sel: 0, rows: [], loaded: false };
    var MCPMARK = {
      github: '<path d="M12 1.3a10.7 10.7 0 0 0-3.4 20.9c.5.1.7-.2.7-.5v-2c-3 .6-3.6-1.3-3.6-1.3-.5-1.2-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.6 1.1 1.6 1.1 1 1.7 2.6 1.2 3.2.9.1-.7.4-1.2.7-1.5-2.4-.3-4.9-1.2-4.9-5.4 0-1.2.4-2.1 1.1-2.9-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 3 1.1a10.3 10.3 0 0 1 5.5 0c2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.6.1 2.9.7.8 1.1 1.7 1.1 2.9 0 4.2-2.5 5.1-4.9 5.4.4.3.7 1 .7 2v3c0 .3.2.6.7.5A10.7 10.7 0 0 0 12 1.3Z"/>',
      linear: '<path d="M2.2 13.6 10.4 21.8a10 10 0 0 1-8.2-8.2Zm-.2-2.5 11 10.9c.7-.1 1.4-.3 2-.5L2.4 9.1c-.2.6-.3 1.3-.4 2Zm1.2-3.6 12.3 12.3c.5-.3 1-.6 1.4-.9L4.1 6.2c-.4.4-.6.9-.9 1.3Zm2-2.6L18.9 18.9A10 10 0 0 0 5.2 5Z"/>',
      slack: '<path d="M5.1 14.5a2.1 2.1 0 1 1-2.1-2.1h2.1v2.1Zm1 0a2.1 2.1 0 0 1 4.2 0v5.3a2.1 2.1 0 0 1-4.2 0v-5.3ZM8.2 5a2.1 2.1 0 1 1 2.1-2.1v2.1H8.2Zm0 1a2.1 2.1 0 0 1 0 4.2H2.9a2.1 2.1 0 0 1 0-4.2h5.3ZM17.7 8.2a2.1 2.1 0 1 1 2.1 2.1h-2.1V8.2Zm-1 0a2.1 2.1 0 1 1-4.2 0V2.9a2.1 2.1 0 0 1 4.2 0v5.3ZM14.5 17.7a2.1 2.1 0 1 1-2.1 2.1v-2.1h2.1Zm0-1a2.1 2.1 0 0 1 0-4.2h5.3a2.1 2.1 0 0 1 0 4.2h-5.3Z"/>',
      notion: '<path d="M4.4 3.3 15.9 2.4c1.4-.1 1.8-.1 2.7.6l3 2.1c.6.4.8.5.8 1v13.3c0 .9-.3 1.4-1.5 1.5l-13.3.8c-.8 0-1.2-.1-1.7-.7L3.1 18c-.5-.7-.7-1.2-.7-1.8V4.8c0-.7.3-1.3 2-1.5Zm11.9 1.4L5.2 5.5c-.6 0-.7.3-.5.5l1.9 1.4c.3.2.6.5 1.2.4l10.7-.6c.3 0 .1-.3-.1-.4l-1.6-1.2c-.2-.2-.5-.4-1-.4Zm-1.6 4.5-11 .6v10.9c0 .6.3.8 1 .8l10.5-.6c.6 0 .7-.4.7-.9V9.6c0-.5-.2-.7-.7-.7Z"/>',
      sentry: '<path d="M13.2 2.6a2.4 2.4 0 0 0-4.2 0L6.8 6.4a17 17 0 0 1 8.6 13.5h-2.5A14.5 14.5 0 0 0 5.6 8.5L3.4 12.3a10 10 0 0 1 4.8 7.6H3.5c-.4 0-.6-.4-.4-.7l1.3-2.2a6.7 6.7 0 0 0-1.4-.9l-1.3 2.2A2.4 2.4 0 0 0 3.5 22h6.8a12 12 0 0 0-4.9-10.4l1-1.7a14 14 0 0 1 5.6 12.1h5.5a2.4 2.4 0 0 0 2-3.6Z"/>',
      stripe: '<path d="M11.3 9.9c0-.8.7-1.1 1.7-1.1 1.5 0 3.4.5 4.9 1.3V5.5a13 13 0 0 0-4.9-.9c-4 0-6.7 2.1-6.7 5.6 0 5.4 7.5 4.6 7.5 6.9 0 .9-.8 1.2-1.9 1.2-1.6 0-3.8-.7-5.4-1.6v4.7c1.8.8 3.6 1.1 5.4 1.1 4.1 0 6.9-2 6.9-5.6 0-5.9-7.5-4.9-7.5-7.1Z"/>',
      supabase: '<path d="M13.8 22.3c-.6.8-1.9.4-1.9-.6l-.3-8.2h5.5c1 0 1.6 1.2 1 2l-4.3 6.8ZM10.2 1.7c.6-.8 1.9-.4 1.9.6l.3 8.2H6.9c-1 0-1.6-1.2-1-2l4.3-6.8Z"/>',
      figma: '<path d="M8.5 22a3.5 3.5 0 0 0 3.5-3.5V15H8.5a3.5 3.5 0 0 0 0 7Zm0-7.5H12V8H8.5a3.25 3.25 0 0 0 0 6.5ZM12 8h3.5a3.25 3.25 0 0 0 0-6.5H12V8Zm-3.5 0H12V1.5H8.5a3.25 3.25 0 0 0 0 6.5Zm7 6.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z"/>',
      cloudflare: '<path d="M16.5 16.3c.2-.6.1-1.1-.2-1.5-.3-.4-.8-.6-1.4-.6l-10.5-.1c-.1 0-.1 0-.2-.1v-.2c0-.1.1-.2.2-.2l10.6-.1c1.3 0 2.6-1 3.1-2.3l.6-1.5v-.2a5.9 5.9 0 0 0-11.3-.6 2.7 2.7 0 0 0-4.2 2.6A3.8 3.8 0 0 0 0 15.4c0 .2 0 .4.1.6 0 .1.1.2.2.2h15.6c.1 0 .2-.1.3-.2l.3.3Zm2.9-6.4h-.3c-.1 0-.1.1-.2.2l-.4 1.4c-.2.6-.1 1.1.2 1.5.3.4.8.6 1.4.6l2.2.1c.1 0 .1 0 .2.1v.2c0 .1-.1.2-.2.2l-2.3.1c-1.3 0-2.6 1-3.1 2.3l-.2.5c0 .1 0 .2.1.2h7.9c.1 0 .2-.1.2-.2.1-.5.2-1.1.2-1.6a5 5 0 0 0-5-5Z"/>',
      playwright: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-3.7 7.4c.9 0 1.6.7 1.6 1.6H6.7c0-.9.7-1.6 1.6-1.6Zm7.4 0c.9 0 1.6.7 1.6 1.6h-3.2c0-.9.7-1.6 1.6-1.6ZM12 18.2a5.6 5.6 0 0 1-5.3-3.7h10.6a5.6 5.6 0 0 1-5.3 3.7Z"/>',
      postgres: '<path d="M17.4 2.6c-1.6-.4-3.3-.5-4.9-.2-.6-.2-1.2-.3-1.8-.3-1.2 0-2.3.3-3.3.9-1-.4-3.6-1.2-5 .3C1.2 4.6 1.5 8 2.7 12.6c.6 2.3 1.4 4.3 2.2 5.6.4.6 1 1.4 1.9 1.5.6.1 1.2-.2 1.8-.8.6.2 1.3.3 2 .3h.1c.7 0 1.3-.1 1.9-.3.4.4.9.7 1.5.8h.4c1.1 0 1.9-.8 2.5-1.8 1.2-2 1.9-5.9 2-7.3.2-1.9 0-5.5-1.6-7.4-.2-.3-.6-.5-1-.6ZM8.4 7.6c-.1.9.1 1.7.4 2.4.3.9.5 1.6-.1 2.5-.6-1.4-.9-3.4-.6-4.9Zm7.3 8.7c-.5.9-.9 1.1-1.1 1.1-.4 0-.8-.5-1-.9.7-1.1.9-2.4.9-2.5v-.4c0-.2-.1-.3-.3-.4-.5-.2-1.2-.1-1.7.1.2-.9.7-1.6 1.5-2.1 1.3 1.2 2 2.8 2.2 3.9-.1.5-.3 1-.5 1.2Z"/>',
      signoz: '<path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3 6.8 3.8L12 11.9 5.2 8.1 12 4.3ZM5 9.8l6 3.4v6.8l-6-3.3V9.8Zm8 10.2v-6.8l6-3.4v6.9l-6 3.3Z"/>',
      filesystem: '<path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/>'
    };
    var _sugT = null;
    state.setComposerMode = setComposerMode;
    // Worker events that change what a card says; the rest (every tool call,
    // every streamed line) would only refetch an unchanged run.
    var ORCH_TASK_KINDS = { run_complete: 1, file_edit: 1, error: 1, needs_input: 1, turn_diff: 1 };
    // The team view landed or changed: goal titles on hold banners may have too.
    teamHooks().orch = function(){
      if (state.pid !== pid) return;
      var el = orchEl(), run = orch.runs && (findOrchRun(orch.sel) || orch.runs[0]);
      var names = run && (run.tasks || []).some(function(t){ return (t.hold && t.hold.runId) || /^wait:/.test(t.overlap || ""); });
      if (el && names && !teamEditing(el)) drawOrch();
    };
    loadOrch();
    // The Crew tab's dot says a crew is working (or waits on you) before you open it.
    if (desktop) loadCrews();
    loadApprovals();
    // Events that change a Fleet row; a burst (a plan spawning five tasks)
    // coalesces into one fetch.
    var FLEET_KINDS = { run_complete: 1, handoff: 1, status: 1, tool_call: 1, file_edit: 1, message: 1, orchestra: 1, approval: 1,
      needs_input: 1, error: 1, agent_join: 1, agent_leave: 1, subtask_started: 1, subtask_done: 1, subtask_failed: 1,
      route_started: 1, route_step: 1, route_completed: 1, route_failed: 1 };
    teamHooks().fleet = function(force){ if (state.pid === pid) drawTeamBlock(force); };
    // Phase 5: this project's runners, read once per view — they decide whether
    // the composer offers "Run on" and a run card offers "Continue on runner".
    runnerHooks.orch = function(p){
      if (p !== pid || state.pid !== pid) return;
      var el = orchEl();
      if (el && orch.runs && !teamEditing(el)) drawOrch();
      drawOrchControls();
    };
    loadTeamRunners(pid, true);

    // Git delivery lives in the status bar, which only the desktop shell has.
    if (desktop) loadGitDelivery(pid);

    // Explicit bridge for shell/preview actions into this mounted composer.
    // Identity is checked by asynchronous callers before delivering a result.
    state.composer = {
      projectId: pid,
      autosize: autosizeBox,
      refresh: refresh,
      addAttachment: function(item) { attach.push(item); drawAttach(); }
    };
    bindComposer();
    loadQueue();
    maybeDigest(pid);
  }
export { renderProject };
