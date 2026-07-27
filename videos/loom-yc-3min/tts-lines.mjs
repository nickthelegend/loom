/**
 * One WAV per subtitle line, not one per scene.
 *
 * The drift came from a single wav per scene: the visual ran 18.4s, the voice
 * ran 8.1s, and the captions were spread evenly across the visual — so by the
 * third line the words on screen had nothing to do with the words being said.
 * Rendering each line separately gives every caption its own measured duration,
 * and the builder can then pin caption i to the exact moment line i is spoken.
 *
 * Usage: node tts-lines.mjs            (writes assets/vo180/lines/<scene>-<i>.wav)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const D = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(D, "assets", "vo180", "lines");
fs.mkdirSync(OUT, { recursive: true });

// Only the scenes the recording drives. Everything else keeps the voice it has.
export const LINES = {
  uichat: [
    "One thread, and every agent you own is in it.",
    "The switcher lists all of them. Claude Code, Codex, OpenCode, Grok, Antigravity.",
    "Loom asks each CLI what models it can actually run, so the list is never stale.",
    "Skills and MCP servers sit right there in the composer.",
    "Pick an agent, send the task, and it goes.",
  ],
  uiboard: [
    "Work lives on a board.",
    "Every card carries the agent that owns it.",
    "Create a task, hand it to an agent, and watch it move across.",
  ],
  uibrain: [
    "This is the brain. Everything the project has learned.",
    "Decisions, conventions, constraints, failures.",
    "Codex wrote that one. Antigravity wrote that one.",
    "Four agents, one memory, all of them reading it.",
  ],
  mobile: [
    "The same brain is on your phone.",
    "The full thread, live, wherever you are.",
    "The board and the brain, in your pocket.",
    "Approve a plan, or start a route, from anywhere.",
    "Your fleet does not stop when you leave the desk.",
  ],
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dur = {};
  for (const [scene, lines] of Object.entries(LINES)) {
    dur[scene] = [];
    for (let i = 0; i < lines.length; i++) {
      const file = path.join(OUT, `${scene}-${i}.wav`);
      execFileSync("npx", ["hyperframes", "tts", lines[i],
        "--voice", "am_adam", "--speed", "1.2", "-o", file],
        { stdio: ["ignore", "pipe", "pipe"], cwd: D });
      const s = Number(execFileSync("ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
        { encoding: "utf8" }).trim());
      dur[scene].push(+s.toFixed(3));
      console.log(`  ${scene}[${i}] ${s.toFixed(2)}s  ${lines[i].slice(0, 54)}`);
    }
    const t = dur[scene].reduce((a, b) => a + b, 0);
    console.log(`${scene}: ${lines.length} lines, ${t.toFixed(2)}s of speech`);
  }
  fs.writeFileSync(path.join(OUT, "durations.json"), JSON.stringify(dur, null, 2));
  console.log("wrote", path.join(OUT, "durations.json"));
}
