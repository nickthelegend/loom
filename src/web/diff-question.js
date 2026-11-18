/** Stage a line question without submitting it or replacing the current draft. */
export function bindDiffQuestions(pane, close) {
  if (!pane || pane.dataset.questionsBound) return;
  pane.dataset.questionsBound = "1";
  var timer = null, start = null, held = false;
  function cancel(){ clearTimeout(timer); timer = null; }
  function ask(row){
    if (!pane.isConnected || !row.isConnected) return;
    var box = document.getElementById("box");
    if (!box) return;
    var question = "Explain this diff line in " + row.dataset.askFile + ":" + row.dataset.askLine + " (" + row.dataset.askSide + "):\n\n" + row.dataset.askText + "\n";
    box.value += (box.value ? "\n\n" : "") + question;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    if (close) close();
    box.focus();
  }
  pane.addEventListener("pointerdown", function(e){
    cancel(); held = false;
    var row = e.target.closest("[data-ask-file]");
    if (!row || (e.button !== undefined && e.button !== 0)) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(function(){ held = true; ask(row); }, 500);
  });
  pane.addEventListener("pointermove", function(e){ if (start && (Math.abs(e.clientX - start.x) > 8 || Math.abs(e.clientY - start.y) > 8)) cancel(); });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function(name){ pane.addEventListener(name, cancel); });
  pane.addEventListener("scroll", cancel, true);
  pane.addEventListener("click", function(e){ if (held) { e.preventDefault(); e.stopImmediatePropagation(); held = false; } }, true);
  pane.addEventListener("contextmenu", function(e){ var row = e.target.closest("[data-ask-file]"); if (row) { e.preventDefault(); cancel(); if (!held) ask(row); } });
  pane.addEventListener("keydown", function(e){ var row = e.target.closest("[data-ask-file]"); if (row && e.key === "Enter" && e.altKey) { e.preventDefault(); ask(row); } });
}
