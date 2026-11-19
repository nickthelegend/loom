import { getRecipe, saveRecipe } from "../recipes.js";
import { listFleets, saveFleet } from "../fleets.js";
import { listPrompts, savePrompt } from "../prompts.js";
import { readTriggers, writeTriggers, newTriggerId } from "../triggers.js";

export const examples = [
  { name: "small-change", kind: "recipe", title: "Plan, implement, verify", description: "Three editable queued prompts, resolved against the project's agent roles." },
  { name: "demo-team", kind: "fleet", title: "Offline demo fleet", description: "Two Demo workers. Use in a Loom demo project." },
  { name: "daily-review", kind: "trigger", title: "Daily repository review", description: "A disabled daily schedule. Review its prompt before enabling it." },
  { name: "explain-code", kind: "prompt", title: "Explain a component", description: "A prompt template with a component variable." },
] as const;
export function installExample(name: string, dir?: string) {
  const example = examples.find(e => e.name === name);
  if (!example) throw new Error("unknown example");
  if (example.kind === "recipe") {
    if (getRecipe(name)) return { example, installed: false };
    saveRecipe({ name, steps: [{ to: "auto", text: "Make a plan for one small, testable improvement.", plan: true }, { to: "auto", text: "Implement the agreed plan with focused changes." }, { to: "auto", text: "Run the relevant tests and summarize the diff and verification." }] });
  } else if (example.kind === "fleet") {
    if (listFleets().some(f => f.name === name)) return { example, installed: false };
    saveFleet(name, "demo-2,demo-3");
  } else if (example.kind === "prompt") {
    const text = "Explain {{component}}, its callers and its tests. Do not edit files.";
    if (listPrompts().saved.some(p => p.title === name || p.text === text)) return { example, installed: false };
    savePrompt({ title: name, text });
  } else {
    if (!dir) throw new Error("choose a project for the trigger example");
    const data = readTriggers(dir);
    if (data.triggers.some(t => t.name === name)) return { example, installed: false };
    data.triggers.push({ id: newTriggerId(), name, kind: "schedule", enabled: false, everyMin: 1440, prompt: "Review recent changes for bugs and missing tests. Do not edit files.", createdAt: Date.now() });
    writeTriggers(dir, data);
  }
  return { example, installed: true };
}
