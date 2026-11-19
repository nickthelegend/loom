// Startup suggestions yield to an explicit project-settings request, including
// when a timer or release response arrives after that request.
var dismissed = false, closeActive = null;

export function openStartupDialog(open) {
  // A cancelled suggestion is handled; only an occupied screen needs a retry.
  if (dismissed) return true;
  if (document.querySelector('.scrim,#tourcard')) return false;
  closeActive = open();
  return true;
}

export function dismissStartupDialogs() {
  dismissed = true;
  if (closeActive) { closeActive(); closeActive = null; }
}
