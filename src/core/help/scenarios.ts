import fs from "node:fs";
import path from "node:path";
import type { ProjectRuntime } from "../../daemon/runtime.js";

export const scenarioNames = ["fleet", "review", "memory"] as const;
export const demoMemory = "Use copper lantern as the demo release codename.";
export function assertDemo(rt: ProjectRuntime) {
  if (!fs.existsSync(path.join(rt.info.dir, ".loom", "demo.json")) || rt.config.agents.length < 3 || rt.config.agents.some(a => a.kind !== "demo")) throw new Error("scenarios require a Loom demo project with at least three Demo agents");
}
export async function runScenario(rt: ProjectRuntime, scenario: string) {
  if (!scenarioNames.includes(scenario as typeof scenarioNames[number])) throw new Error("scenario must be fleet, review or memory");
  assertDemo(rt);
  if (rt.anyBusy()) throw new Error("wait for the current demo work to finish");
  const agents = rt.config.agents.map(a => a.id);
  if (scenario === "fleet") return { scenario, run: await rt.orchestra.start({ goal: "Add dark mode and write tests", orchestrator: agents[0]!, workers: agents.slice(1, 3), plan: true }) };
  if (scenario === "review") return { scenario, review: await rt.startReview({ agents: agents.slice(0, 2), text: "Offline demo example: function first(items) { return items[0].title; }", focus: "Check empty input. This is a scripted example." }) };
  const memory = rt.brain.list().find(m => m.text === demoMemory) ?? (() => {
    const event = rt.log.append({ kind: "decision", payload: { text: demoMemory, source: "demo-scenario" } });
    return rt.brain.add({ kind: "decision", text: demoMemory, provenance: { agentId: agents[0]!, eventId: event.id, ts: event.ts } });
  })();
  const chat = rt.createChat("Demo · memory learned and reused");
  await rt.handoff(agents[1]!, { chat: chat.id });
  const turn = await rt.sendMessage("What is our demo release codename? Explain which shared decision you reused.", agents[1]!, { chat: chat.id });
  return { scenario, memory, chat: chat.id, turn };
}

export const lessons = [
  { id: "send", title: "Send a request", instruction: 'Send "Add dark mode" to a Demo agent. Watch the real styles.css edit.' },
  { id: "steer", title: "Steer a running turn", instruction: 'Send "Write tests", then steer with "Also cover an empty list" before the turn finishes.' },
  { id: "fleet", title: "Run a fleet", instruction: "Run an Orchestra goal with one Demo orchestrator and two workers." },
  { id: "memory", title: "Teach a memory", instruction: "Save a release codename, then ask a different Demo agent to reuse it." },
];
