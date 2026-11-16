/**
 * Browser guest isolation. Approach credit: Nuphos's BrowserView / webview-guard
 * (Apache-2.0, © 2026 Zeabur Inc.), implemented for Loom's Electron shell.
 */
export const BROWSER_PARTITION = "persist:loom-browser";

export function allowWebviewUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function attachGuard(event, webPreferences, params) {
  // Renderer attributes must never supply native code or weaken guest isolation.
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  Object.assign(webPreferences, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
  });
  if (params.partition !== BROWSER_PARTITION || !allowWebviewUrl(params.src)) event.preventDefault();
}

export function guardBrowserSession(session) {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on("will-download", (event) => event.preventDefault());
}

export function guardWebview(contents) {
  // Popups never get a second guest or inherit the shell's preload.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  const navigate = (event, url) => {
    if (!allowWebviewUrl(url)) event.preventDefault();
  };
  contents.on("will-navigate", navigate);
  contents.on("will-redirect", navigate);
}
