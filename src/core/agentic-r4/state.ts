import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logbook } from "../logbook.js";
import { ensureLoomHome } from "../registry.js";

export interface AgenticSettings { disabledTools: string[]; hooks: boolean }
const file = (project: string) => path.join(ensureLoomHome(), `agentic-${encodeURIComponent(project)}.json`);
export function readSettings(project: string): AgenticSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(project), "utf8"));
    return {
      disabledTools: Array.isArray(parsed?.disabledTools) ? parsed.disabledTools.filter((name: unknown) => typeof name === "string") : [],
      hooks: typeof parsed?.hooks === "boolean" ? parsed.hooks : false,
    };
  } catch (error) {
    if (error instanceof SyntaxError) logbook.warn("agentic", "Invalid settings JSON; using defaults", String(error), project);
    else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { disabledTools: [], hooks: false };
  }
}
export function writeSettings(project: string, patch: Partial<AgenticSettings>) {
  const settings = { ...readSettings(project), ...patch }, target = file(project), tmp = `${target}.${randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(settings), { mode: 0o600 });
  fs.renameSync(tmp, target);
  return settings;
}
