import fs from "node:fs";
import path from "node:path";
import { loomHome } from "../registry.js";
import { lessons } from "./scenarios.js";
export interface TutorialProgress { project?: string; completed: string[] }
const file = () => path.join(loomHome(), "tutorial-progress.json");
export function tutorialProgress(): TutorialProgress {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
    return { project: typeof saved.project === "string" ? saved.project : undefined, completed: Array.isArray(saved.completed) ? saved.completed.filter((id: string) => lessons.some(l => l.id === id)) : [] };
  } catch { return { completed: [] }; }
}
export function saveTutorialProgress(progress: TutorialProgress) {
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(file() + ".tmp", JSON.stringify(progress), { mode: 0o600 }); fs.renameSync(file() + ".tmp", file());
}
