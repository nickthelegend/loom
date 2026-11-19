import fs from "node:fs";
import path from "node:path";
import { listProjects, loomHome } from "./registry.js";
import { readModelRouting } from "./model-routing.js";
import { readScoreboard, scoreboardDigest } from "./scoreboard.js";
import { notify, type Notification } from "./notify.js";

/** Monday is UTC, as are daily model caps; a persisted marker survives daemon restarts. */
export async function mondayScoreboard(now = Date.now(), send: (n: Notification) => void = notify): Promise<boolean> {
  if (!readModelRouting().mondayDigest || new Date(now).getUTCDay() !== 1) return false;
  const day = new Date(now).toISOString().slice(0, 10);
  const file = path.join(loomHome(), "scoreboard-monday");
  try { if (fs.readFileSync(file, "utf8") === day) return false; } catch { /* first digest */ }
  const board = await readScoreboard(listProjects(), "7d", "all", now);
  try { if (fs.readFileSync(file, "utf8") === day) return false; } catch { /* another check may have finished while reading the board */ }
  send({ title: "Loom weekly scoreboard", body: scoreboardDigest(board) });
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(file, day);
  return true;
}
