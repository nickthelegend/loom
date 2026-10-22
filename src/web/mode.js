/** Browser mode module: Simple (the default) or Developer. See README.md for ownership and startup. */

  /**
   * Loom has two faces. Simple — the default — is chat, your team, your agents,
   * the board and memory: what you need to get work done with agents, and
   * nothing that needs explaining first. Developer mode (Settings → Preferences)
   * turns on everything else Loom has grown: Orchestra and Crew, Insights and
   * its metrics, the terminal, the console, the browser pane, the right-hand
   * panel, MCPs and skills, the cost meter, and the full transcript.
   * Per device; nothing is removed — only out of the way.
   */
  var KEY = "loomDevMode";

  function devMode(){
    try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
  }

  /** Put the mode on the document: `html.simple` hides every `.devonly`. (Not `html.dev`: `.dev` is a Devices row.) */
  function applyMode(){
    var dev = devMode();
    document.documentElement.classList.toggle("simple", !dev);
    document.documentElement.classList.toggle("devmode", dev);
  }

  function setDevMode(on){
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) {}
    applyMode();
  }

  /** The workspace tabs a mode shows, in order. */
  var SIMPLE_TABS = ["thread", "team", "fleet", "board", "brain"];

export { applyMode, devMode, setDevMode, SIMPLE_TABS };
