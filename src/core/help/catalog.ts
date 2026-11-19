import fs from "node:fs";
import { VERSION } from "../../version.js";

const guides = new URL("../../../docs/help/", import.meta.url);
export function helpGuides(query = "") {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return fs.readdirSync(guides).filter(f => /^[a-z0-9-]+\.md$/.test(f)).sort().map(file => {
    const body = fs.readFileSync(new URL(file, guides), "utf8");
    return { id: file.slice(0, -3), title: body.match(/^# (.+)/)?.[1] ?? file, body };
  }).filter(g => words.every(w => `${g.title}\n${g.body}`.toLowerCase().includes(w)));
}

export const featureTours = [
  { id: "orchestra", title: "Orchestra", steps: [
    { title: "Give a fleet a goal", body: "Open Orchestra. Choose an orchestrator and at least two workers, then describe a goal with independent tasks.", target: "orchestra" },
    { title: "Follow the plan", body: "Watch tasks and their worktrees. Reply when the orchestrator asks for help; inspect each diff before landing the work.", target: "orchestra" },
  ] },
  { id: "brain", title: "Brain", steps: [
    { title: "Teach a decision", body: "Open Memory and add a decision: Keep this project dependency-free. Decisions are shared by the project's agents.", target: "brain" },
    { title: "Use and maintain memory", body: "Send a related request to a different agent. Its briefing retrieves relevant memory. Review sources and retire stale entries in Memory.", target: "brain" },
  ] },
  { id: "triggers", title: "Triggers", steps: [
    { title: "Create a schedule", body: "Open Triggers. Give a schedule a prompt and an agent. Start with a disabled example so you can review it first.", target: "triggers" },
    { title: "Inspect a run", body: "Run now to test the prompt. Check the run history and resulting chat before enabling the schedule.", target: "triggers" },
  ] },
  { id: "review", title: "Review", steps: [
    { title: "Ask independent reviewers", body: "Open Review from Source Control. Select two agents and a diff or file. Reviewers inspect without editing.", target: "review" },
    { title: "Decide on findings", body: "Compare the findings and their evidence. Accept useful findings as shared decisions, or reject them with a reason.", target: "review" },
  ] },
];

/** Match the running release, never advertise Unreleased work as a shipped update. */
export function whatsNew(version = VERSION) {
  const changelog = fs.readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");
  const section = changelog.split(/^## /m).find(s => s.startsWith(`[${version}]`));
  const highlights = (section ?? "").split("\n").filter(l => l.startsWith("- ")).slice(0, 8).map(line => {
    const text = line.slice(2).replace(/\*\*/g, "");
    const topic = /orchestra|fleet/i.test(text) ? "orchestra" : /memory|brain/i.test(text) ? "brain" : /trigger/i.test(text) ? "triggers" : /review/i.test(text) ? "review" : "getting-started";
    return { text, topic };
  });
  return { version, highlights: highlights.length ? highlights : [{ text: `Loom ${version}. Explore the bundled guides and feature tours.`, topic: "getting-started" }] };
}
