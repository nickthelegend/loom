// Marks the page as running inside the Electron shell (with the platform), so
// the web app can adopt native desktop chrome — a draggable title strip and
// macOS traffic-light clearance. CommonJS so it loads in a sandboxed preload.
window.addEventListener("DOMContentLoaded", function () {
  try {
    document.documentElement.setAttribute("data-electron", process.platform);
  } catch (e) {
    /* non-fatal: the app works without native chrome hints */
  }
});
