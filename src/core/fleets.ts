/** Named fleets belong to the user, so the same selection works in every project. */
import { resolveModel } from "./model-routing.js";
import fs from "node:fs";
import path from "node:path";
import { ensureLoomHome, loomHome } from "./registry.js";

/** Parse agent[@model][:effort][xN]. The team: and acp: prefixes belong to the agent name. */
export function parseAgentSpec(value: string, rosterIds: string[] = []): { agent: string; count: number; model?: string; effort?: string } {
  let spec = value.trim();
  if (rosterIds.some((id) => id.toLowerCase() === spec.toLowerCase())) return { agent: spec, count: 1 };
  const copies = /[x×](\d+)$/.exec(spec);
  const count = copies ? Number(copies[1]) : 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error("worker count must be an integer from 1 to 100");
  if (copies) spec = spec.slice(0, copies.index).trimEnd();
  const match = /^(team:|acp:)?([^@:#]+)(?:@([^@:#\s]+))?(?::([^@:#\s]+))?$/.exec(spec);
  if (!match) throw new Error(`invalid agent spec "${value}" — use agent[@model][:effort][xN]`);
  const agent = `${match[1] ?? ""}${match[2]!.trim()}`;
  if (!agent || agent === "team:") throw new Error(`invalid agent spec "${value}"`);
  return { agent, count, ...(match[3] ? { model: resolveModel(match[3]) } : {}), ...(match[4] ? { effort: match[4] } : {}) };
}

export interface SavedFleet { name: string; spec: string }

function fleetName(name: unknown): string {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error("fleet name must be 1–64 letters, digits, underscores or hyphens");
  }
  return name;
}

export function listFleets(): SavedFleet[] {
  const file = path.join(loomHome(), "fleets.json");
  if (!fs.existsSync(file)) return [];
  return (JSON.parse(fs.readFileSync(file, "utf8")) as SavedFleet[]).sort((a, b) => a.name.localeCompare(b.name));
}

function writeFleets(fleets: SavedFleet[]): void {
  const file = path.join(ensureLoomHome(), "fleets.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(fleets, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}

export function saveFleet(name: unknown, spec: unknown): SavedFleet {
  const key = fleetName(name);
  if (typeof spec !== "string" || !spec.trim()) throw new Error("fleet spec is required");
  const rows = spec.split(",").map(s => s.trim());
  // Store concrete specs: aliases cannot become recursive or change underneath another fleet.
  for (const row of rows) parseAgentSpec(row);
  const fleet = { name: key, spec: rows.join(",") };
  writeFleets([...listFleets().filter(f => f.name !== key), fleet]);
  return fleet;
}

export function removeFleet(name: unknown): boolean {
  const key = fleetName(name), fleets = listFleets();
  if (!fleets.some(f => f.name === key)) return false;
  writeFleets(fleets.filter(f => f.name !== key));
  return true;
}

export function expandSavedFleets(specs: string[]): string[] {
  return specs.flatMap(value => {
    const spec = value.trim();
    if (!spec.startsWith("@")) return [spec];
    const name = fleetName(spec.slice(1));
    const fleet = listFleets().find(f => f.name === name);
    if (!fleet) throw new Error(`unknown fleet "${name}"`);
    const rows = fleet.spec.split(",").map(s => s.trim());
    for (const row of rows) parseAgentSpec(row);
    return rows;
  });
}
