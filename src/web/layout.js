/** Browser layout module. See README.md for ownership and startup. */



  var RAIL_KEY = "loomRail";

  // Open by default only where there's room for it beside a readable thread;
  // on a laptop the chat is the point, and the panel is one click away.
  function railOpen(){
    // Simple mode has no right-hand panel: the conversation is the point
    if (document.documentElement.classList.contains("simple")) return false;
    var v = localStorage.getItem(RAIL_KEY); return v === null ? (window.innerWidth || 0) >= 1440 : v === "1";
  }

  function applyRail(){
    var shell = document.querySelector(".dshell");
    if (shell) shell.classList.toggle("railopen", railOpen());
    var rb = document.getElementById("railbtn");
    if (rb) rb.classList.toggle("active", railOpen());
  }

  function toggleRail(){
    localStorage.setItem(RAIL_KEY, railOpen() ? "0" : "1");
    applyRail();
  }


  // ---- column resizing -----------------------------------------------------
  function shellEl(){ return document.querySelector(".dshell"); }

  function cssPx(el, name, fallback){
    if (!el) return fallback;
    var n = parseInt(getComputedStyle(el).getPropertyValue(name), 10);
    return isNaN(n) ? fallback : n;
  }

  /**
   * Drag a handle to resize a column: clamped, persisted, double-click resets.
   * opts.invert is for handles on a panel's left edge, where dragging left widens.
   */
  function makeResizer(handleId, opts){
    var h = document.getElementById(handleId); if (!h) return;
    h.addEventListener("mousedown", function(ev){
      if (ev.button !== 0) return;
      ev.preventDefault();
      var startX = ev.clientX, startW = opts.get();
      h.classList.add("dragging");
      document.body.classList.add("resizing-x");
      function mv(e){
        var dx = (e.clientX - startX) * (opts.invert ? -1 : 1);
        opts.set(Math.max(opts.min, Math.min(opts.max(), startW + dx)));
      }
      function up(){
        h.classList.remove("dragging");
        document.body.classList.remove("resizing-x");
        document.removeEventListener("mousemove", mv);
        document.removeEventListener("mouseup", up);
        if (opts.key) localStorage.setItem(opts.key, String(opts.get()));
      }
      document.addEventListener("mousemove", mv);
      document.addEventListener("mouseup", up);
    });
    h.addEventListener("dblclick", function(){
      opts.set(opts.def);
      if (opts.key) localStorage.setItem(opts.key, String(opts.def));
    });
  }

  function applyWidths(){
    var s = shellEl(); if (!s) return;
    var sb = Number(localStorage.getItem("loomSbW")) || 264;
    var rw = Number(localStorage.getItem("loomRailW")) || 304;
    s.style.setProperty("--sbw", sb + "px");
    s.style.setProperty("--railw", rw + "px");
  }
export { applyRail,applyWidths,cssPx,makeResizer,RAIL_KEY,railOpen,shellEl,toggleRail };