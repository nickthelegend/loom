/** Only the Loom page may replace the shell's command accelerators. */
export function readShortcuts(bindings, frameUrl, appOrigin) {
  try {
    const source = new URL(frameUrl);
    if (source.origin !== appOrigin || source.pathname !== "/app") return null;
  } catch { return null; }
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return null;
  const entries = Object.entries(bindings);
  if (entries.length > 100) return null;
  if (entries.some(([key, value]) => !/^[a-z][a-z:-]{0,79}$/.test(key) || typeof value !== "string" ||
      (value !== "" && !/^(?:(?:CmdOrCtrl|Ctrl|Shift|Alt)\+)+(?:[a-z0-9,./;\[\]`-]|Up|Down)$/.test(value)))) return null;
  return Object.fromEntries(entries);
}
