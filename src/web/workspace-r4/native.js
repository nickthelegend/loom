/** Split panes share the trusted Loom origin; the native bridge belongs to their top window. */
export function workspaceNative(){
  if (window.loomNative) return window.loomNative;
  try { if (window.parent !== window && window.parent.location.origin === location.origin) return window.parent.loomNative || null; } catch (e) {}
  return null;
}
