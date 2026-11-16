/**
 * Terminal output for a phone screen (#380): a pty speaks ANSI — colours, cursor moves, carriage
 * returns that redraw a line (progress bars), backspaces. A native Text can't render that, so this
 * turns the stream into plain lines the way a terminal would leave them on screen, closely enough
 * to read a build or a test run.
 */

const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;          // colour, cursor, erase…
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;    // window title, hyperlinks
const OTHER = /\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g; // charset and single-char escapes

/** Apply one chunk to the screen lines so far; returns the new lines (capped to `max`). */
export function applyTermChunk(lines: string[], chunk: string, max = 2000): string[] {
  const out = lines.length ? lines.slice() : [""];
  const text = chunk.replace(OSC, "").replace(CSI, "").replace(OTHER, "");
  let cur = out.pop() ?? "";
  let col = cur.length;
  for (const ch of text) {
    if (ch === "\n") { out.push(cur); cur = ""; col = 0; }
    else if (ch === "\r") { col = 0; }
    else if (ch === "\b") { col = Math.max(0, col - 1); }
    else if (ch === "\x07" || ch < " " && ch !== "\t") { /* bell and other controls: nothing to show */ }
    else {
      cur = cur.slice(0, col) + ch + cur.slice(col + 1);
      col += 1;
    }
  }
  out.push(cur);
  return out.length > max ? out.slice(out.length - max) : out;
}

/** What an on-screen key sends to the shell. */
export const TERM_KEYS: Record<string, string> = {
  "Ctrl-C": "\x03",
  "Ctrl-D": "\x04",
  "Ctrl-Z": "\x1a",
  "Ctrl-L": "\x0c",
  Tab: "\t",
  Esc: "\x1b",
  "↑": "\x1b[A",
  "↓": "\x1b[B",
  "←": "\x1b[D",
  "→": "\x1b[C",
};
