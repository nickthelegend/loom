/** Browser theme module. See README.md for ownership and startup. */
import { ICONS } from './icons.js';
import { THEME_KEY,state } from './state.js';


  /** What you picked: "light", "dark", or "system" (follow the OS, live). */
  function themePref(){
    var t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (e) {}
    return t === "light" || t === "system" ? t : "dark";
  }
  function systemLight(){ return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches); }
  /** The theme on screen right now. */
  function themeNow(){ var p = themePref(); return p === "system" ? (systemLight() ? "light" : "dark") : p; }
  function setThemePref(t){
    try { localStorage.setItem(THEME_KEY, t === "light" || t === "system" ? t : "dark"); } catch (e) {}
    applyTheme();
    if (state.retheme) state.retheme(); // live terminals repaint too
  }
  // "Match system" follows the OS as it changes (sunset, a Control Center flip).
  if (typeof window !== "undefined" && window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function(){
        if (themePref() === "system") { applyTheme(); if (state.retheme) state.retheme(); }
      });
    } catch (e) {}
  }

  /**
   * Text size, density and accent — this device's, remembered here. Zoom
   * scales the whole app (every size in it is in px); density tightens the
   * thread; the accent is the thread colour, a lighter tint for dark and a
   * deeper one for light so it keeps its contrast.
   */
  var ACCENTS = {
    cyan: ["#67e8f9", "#0e7490"], violet: ["#c4b5fd", "#6d28d9"], emerald: ["#6ee7b7", "#047857"],
    amber: ["#fcd34d", "#b45309"], rose: ["#fda4af", "#be123c"], blue: ["#93c5fd", "#1d4ed8"]
  };
  var TEXT_SIZES = { s: 0.92, m: 1, l: 1.08, xl: 1.16 };
  function appearancePref(name, fallback){ try { return localStorage.getItem("loomPref:" + name) || fallback; } catch (e) { return fallback; } }
  function applyAppearance(){
    var root = document.documentElement;
    // The workspace is scaled, not the page: menus and dialogs live on <body>
    // and place themselves from the workspace's on-screen boxes, which are
    // right only if <body> itself isn't zoomed.
    var z = TEXT_SIZES[appearancePref("textsize", "m")] || 1;
    if (z === 1) root.style.removeProperty("--tz"); else root.style.setProperty("--tz", String(z));
    root.classList.toggle("compact", appearancePref("density", "comfy") === "compact");
    var a = ACCENTS[appearancePref("accent", "cyan")] || ACCENTS.cyan;
    var dark = themeNow() !== "light";
    if (appearancePref("accent", "cyan") === "cyan") {
      root.style.removeProperty("--thread"); root.style.removeProperty("--thread-ink"); root.style.removeProperty("--accentBlue");
    } else {
      root.style.setProperty("--thread", a[0]);
      root.style.setProperty("--thread-ink", dark ? a[0] : a[1]);
      root.style.setProperty("--accentBlue", dark ? a[0] : a[1]);
    }
  }
  function applyTheme(){
    var t = themeNow();
    document.documentElement.classList.toggle("dark", t !== "light");
    applyAppearance();
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", t === "light" ? "#ffffff" : "#0a0a0a");
    var tb = document.getElementById("themebtn");
    if (tb) tb.innerHTML = t === "light" ? ICONS.moon : ICONS.sun;
  }

  function bindTheme(){
    var tb = document.getElementById("themebtn");
    if (!tb) return;
    tb.innerHTML = themeNow() === "light" ? ICONS.moon : ICONS.sun;
    tb.onclick = function(){ setThemePref(themeNow() === "light" ? "dark" : "light"); };
  }

  var THEME_BTN = '<button id="themebtn" class="iconbtn" title="toggle theme"></button>';

  function isElectron(){ return document.documentElement.hasAttribute("data-electron"); }
export { ACCENTS,appearancePref,applyAppearance,applyTheme,bindTheme,isElectron,setThemePref,THEME_BTN,themeNow,themePref };