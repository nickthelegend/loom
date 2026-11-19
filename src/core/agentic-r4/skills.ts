import fs from "node:fs";
import path from "node:path";
import { turnOutcome } from "../turn-wait.js";
import { parseSkillMd } from "../skills.js";
import { authorSkill } from "../skill-install.js";
import type { LoomEvent } from "../../types.js";

export function lintSkill(dir: string) {
  const errors: string[] = [];
  let text = "";
  try { text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"); }
  catch { return { valid: false, errors: ["SKILL.md is missing or unreadable"] }; }
  const parsed = parseSkillMd(text);
  if (!/^---\r?\n/.test(text)) errors.push("YAML front matter is required");
  if (!parsed.name) errors.push("front matter requires name");
  if (!parsed.description) errors.push("front matter requires description");
  if (parsed.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.name)) errors.push("name must be lowercase words separated by hyphens, at most 64 characters");
  if (parsed.description.length > 1024) errors.push("description must be at most 1024 characters");
  if (!parsed.body) errors.push("skill body is empty");
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
  for (const key of ["name", "description"]) if ((fm?.[1]?.match(new RegExp(`^${key}\\s*:`, "gm")) ?? []).length > 1) errors.push(`duplicate ${key}`);
  return { valid: !errors.length, errors };
}

export function draftChatSkill(dir: string, chat: string, name: string, events: LoomEvent[]) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error("name must be lowercase words separated by hyphens, at most 64 characters");
  const start = events.filter(e => e.kind === "status" && e.payload.state === "turn_started").at(-1);
  if (start?.agentId && turnOutcome(events, start.agentId, start.id, chat)?.status !== "ok") throw new Error("save a successfully finished chat as a skill");
  const last = events.filter(e => e.kind === "run_complete" || e.kind === "needs_input" || e.kind === "error" || (e.kind === "status" && e.payload.state === "turn_started")).at(-1);
  if (!last || last.kind !== "run_complete" || last.payload.error) throw new Error("save a successfully finished chat as a skill");
  const steps = events.filter(e => e.kind === "tool_call" || (e.kind === "message" && !e.payload.reasoning))
    .map(e => e.kind === "tool_call" ? `Tool: ${String(e.payload.tool ?? e.payload.name ?? "step")}\n${JSON.stringify(e.payload.input ?? {})}` : String(e.payload.text ?? ""))
    .filter(Boolean);
  if (!steps.length) throw new Error("chat has no steps to save");
  return { ...authorSkill(dir, { id: name, name, description: `Steps drafted from chat ${chat}. Edit before use.`,
    body: `# ${name}\n\nDraft from chat ${chat}. Review the steps, remove secrets and chat-specific details, and describe when to use this skill before enabling it.\n\n## Steps\n\n${steps.map((s, i) => `### ${i + 1}\n\n${s}`).join("\n\n")}` }), draft: true, enabled: false };
}
