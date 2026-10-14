// The Loom pet: a little spool of thread that floats over your screen and
// shows what your agents are up to. The shell decides the mood (pet-model.js)
// and sends it here; this draws it, pixel by pixel, and passes clicks back.
(function () {
  "use strict";
  var api = window.loomPet;
  var canvas = document.getElementById("pet");
  var ctx = canvas.getContext("2d");
  var bubble = document.getElementById("bubble");
  var shadow = document.getElementById("shadow");

  // ---- the sprite ------------------------------------------------------------
  // 18 x 18 body on a 18 x 22 canvas (room above for "!" and "z"). Letters are
  // colours; L/R are the eyes, M/O the mouth, filled in per mood.
  var BODY = [
    "...kkkkkkkkkkkk...",
    "..kwwwwwwwwwwwwk..",
    "..kWWWWWWWWWWWWk..",
    "...kkkkkkkkkkkk...",
    "....kttttttttk....",
    "....khtTtttTtk....",
    "....ktLLttRRtk....",
    "....ktLLttRRtk....",
    "....kTttttttTk....",
    "....kcttMMttck....",
    "....kttTOOTttk....",
    "....kTTttttTTk....",
    "...kkkkkkkkkkkk...",
    "..kwwwwwwwwwwwwk..",
    "..kWWWWWWWWWWWWk..",
    "...kkkkkkkkkkkk...",
    ".....kf....fk.....",
    ".....kk....kk.....",
  ];
  var PAL = {
    k: "#18181b", w: "#d4a373", W: "#a26a3c", t: "#5eead4", T: "#14b8a6", h: "#ccfbf1",
    p: "#0f172a", e: "#ffffff", c: "#fda4af", r: "#e11d48", f: "#a26a3c",
    y: "#fbbf24", z: "#93c5fd", s: "#fde68a",
  };
  // eye: [top-left, top-right, bottom-left, bottom-right]
  var EYES = {
    open: ["p", "e", "p", "p"],
    shut: ["t", "t", "p", "p"],
    wide: ["e", "e", "p", "p"],
    down: ["t", "t", "p", "t"],
  };

  function px(x, y, c) { if (c && c !== "." && PAL[c]) { ctx.fillStyle = PAL[c]; ctx.fillRect(x, y, 1, 1); } }

  function draw(o) {
    ctx.clearRect(0, 0, 18, 22);
    var dy = o.dy, eye = EYES[o.eyes] || EYES.open;
    for (var r = 0; r < BODY.length; r++) {
      var row = BODY[r];
      for (var c = 0; c < row.length; c++) {
        var ch = row[c];
        if (ch === "L" || ch === "R") {
          var left = ch === "L" ? c === 6 : c === 10;
          ch = eye[(r === 6 ? 0 : 2) + (left ? 0 : 1)];
        } else if (ch === "M") ch = o.mouth === "flat" ? "p" : o.mouth === "frown" ? "t" : "p";
        else if (ch === "O") ch = o.mouth === "open" ? "r" : o.mouth === "frown" ? "p" : "t";
        else if (ch === "c" && !o.blush) ch = "t";
        px(c, r + dy, ch);
      }
    }
    (o.extra || []).forEach(function (p) { px(p[0], p[1], p[2]); });
  }

  // ---- moods -----------------------------------------------------------------
  var mood = "idle", tick = 0, hovering = false, target = null, title = "", sub = "";
  function frame() {
    tick++;
    var t = tick, o;
    if (mood === "work") {
      // weaving: a bob, and a strand of thread flicking off the side
      var a = t % 2 === 0;
      o = { dy: a ? 3 : 2, eyes: t % 14 === 0 ? "shut" : "open", mouth: "smile", blush: true,
        extra: a ? [[14, 12, "T"], [15, 13, "T"], [16, 13, "T"], [17, 14, "T"]] : [[14, 13, "T"], [15, 12, "T"], [16, 12, "T"], [17, 11, "T"]] };
    } else if (mood === "alert") {
      var up = t % 4 < 2;
      o = { dy: up ? 1 : 3, eyes: "wide", mouth: "open", blush: true,
        extra: [[16, 0, "y"], [16, 1, "y"], [16, 2, "y"], [16, 4, "y"], [17, 0, "y"], [17, 1, "y"], [17, 2, "y"], [17, 4, "y"]] };
    } else if (mood === "happy") {
      var b = t % 3 === 0;
      o = { dy: b ? 2 : 3, eyes: "shut", mouth: "open", blush: true,
        extra: t % 2 ? [[1, 2, "s"], [16, 1, "s"], [0, 9, "s"]] : [[2, 1, "s"], [17, 3, "s"], [1, 12, "s"]] };
    } else if (mood === "sad") {
      o = { dy: 4, eyes: "down", mouth: "frown", blush: false, extra: t % 6 < 3 ? [[5, 11, "z"]] : [[5, 12, "z"]] };
    } else if (mood === "sleep") {
      var zz = Math.floor(t / 4) % 3;
      o = { dy: 4, eyes: "shut", mouth: "flat", blush: false,
        extra: zz === 0 ? [[14, 2, "z"], [15, 2, "z"], [15, 1, "z"], [14, 0, "z"], [15, 0, "z"]]
          : zz === 1 ? [[15, 1, "z"], [16, 1, "z"], [16, 0, "z"]] : [] };
    } else {
      // idle: breathes, blinks, and looks pleased when you hover
      var breathe = Math.floor(t / 5) % 2;
      o = { dy: breathe ? 4 : 3, eyes: t % 17 === 0 || t % 17 === 1 ? "shut" : "open", mouth: hovering ? "open" : "smile", blush: hovering };
    }
    draw(o);
    shadow.style.transform = "scaleX(" + (o.dy < 3 ? 0.8 : 1) + ")";
  }
  setInterval(frame, 220);
  frame();

  // ---- the bubble ------------------------------------------------------------
  function showBubble() {
    var t = title, s = sub, cls = mood;
    if (!t && hovering) { t = "Loom"; s = mood === "sleep" ? "all quiet — click to open" : "click to open · drag me anywhere"; cls = "idle"; }
    bubble.className = t ? "show " + cls : "";
    bubble.querySelector(".t").textContent = t;
    bubble.querySelector(".s").textContent = s;
    bubble.querySelector(".s").style.display = s ? "" : "none";
  }
  api.onState(function (s) {
    var was = mood;
    mood = s.mood || "idle";
    title = s.title || "";
    sub = s.sub || "";
    target = s.project ? { project: s.project, chat: s.chat || null } : null;
    if (was !== mood) tick = 0;
    showBubble();
  });

  // ---- pointer: click-through except on the pet and its bubble ----------------
  var inside = false;
  function hit(x, y) {
    var el = document.elementFromPoint(x, y);
    return !!(el && (el === canvas || (bubble.classList.contains("show") && bubble.contains(el))));
  }
  var drag = null;
  window.addEventListener("mousemove", function (ev) {
    if (drag) {
      var dx = ev.screenX - drag.x, dy = ev.screenY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      if (drag.moved) { api.drag(dx, dy); drag.x = ev.screenX; drag.y = ev.screenY; }
      return;
    }
    var now = hit(ev.clientX, ev.clientY);
    if (now !== inside) { inside = now; api.setInside(now); }
    var over = document.elementFromPoint(ev.clientX, ev.clientY) === canvas;
    if (over !== hovering) { hovering = over; showBubble(); }
  });
  window.addEventListener("mouseleave", function () {
    if (drag) return;
    if (inside) { inside = false; api.setInside(false); }
    if (hovering) { hovering = false; showBubble(); }
  });
  canvas.addEventListener("mousedown", function (ev) {
    if (ev.button !== 0) return;
    drag = { x: ev.screenX, y: ev.screenY, moved: false };
  });
  window.addEventListener("mouseup", function () {
    if (!drag) return;
    var moved = drag.moved;
    drag = null;
    if (moved) api.dragEnd(); else api.open(target);
  });
  bubble.addEventListener("click", function () { api.open(target); });
  window.addEventListener("contextmenu", function (ev) { ev.preventDefault(); api.menu(); });
})();
