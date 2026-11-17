/**
 * Get started, derived from durable work rather than button clicks (#403).
 * Approach credit: Agent Orchestrator's SystemRequirementsChecklist.tsx and
 * InstallDependencyDialog.tsx, and T3 Code's WelcomeWizard.tsx.
 */
import fs from "node:fs";
import path from "node:path";
import { agentSkillsStatus } from "./agent-skills.js";
import { EventLog } from "./eventlog.js";
import { listProjects, readDaemonConfig, readProjectConfig, writeDaemonConfig } from "./registry.js";
import { hasConfiguredProvider } from "./providers.js";
import { listShares } from "./shares.js";
import { setupAgents, type AgentStatus } from "./setup.js";
import type { OrchestraRun } from "./orchestra.js";

export type OnboardingAction = "try" | "install-agent" | "open-project" | "send-message" | "run-fleet" | "pair-phone" | "skills" | "share";
export interface OnboardingStep {
  id: "demo" | "agent" | "project" | "message" | "fleet" | "phone" | "skills" | "share";
  title: string;
  done: boolean;
  detail: string;
  /** Stable button key for web and phone clients; never a command to execute. */
  action: OnboardingAction;
  optional?: boolean;
}
export interface OnboardingReport { steps: OnboardingStep[]; dismissed: boolean }
export interface OnboardingOptions {
  /** Machine probes can be supplied by an embedding host or isolated tests. */
  agents?: () => Promise<Pick<AgentStatus, "kind" | "found" | "authed">[]>;
  hasTeamInvite?: () => boolean;
}

export async function onboardingReport(opts: OnboardingOptions = {}): Promise<OnboardingReport> {
  const projects = listProjects();
  const demo = projects.some(p => fs.existsSync(path.join(p.dir, ".loom", "demo.json")));
  const tried = demo || projects.some(p => readProjectConfig(p.dir)?.agents.some(a => a.kind === "demo"));
  const agents = await (opts.agents ?? setupAgents)();
  const agent = hasConfiguredProvider() || agents.some(a => !["demo", "model", "echo"].includes(a.kind) && a.found && a.authed === true);
  let message = false, fleet = false;
  for (const project of projects) {
    const dir = path.join(project.dir, ".loom");
    // Opening a checklist must not open a runtime or start any agents. A stale
    // registry entry also must not recreate a deleted project's directory.
    if (!message && ["log.db", "log.jsonl"].some(f => fs.existsSync(path.join(dir, f)))) {
      const log = await EventLog.open(dir);
      try { message = log.count({ kinds: ["run_complete"] }) > 0; }
      finally { log.close(); }
    }
    const runs = path.join(dir, "orchestra");
    if (!fleet && fs.existsSync(runs)) {
      fleet = fs.readdirSync(runs).filter(f => f.endsWith(".json")).some(file => {
        try {
          const run = JSON.parse(fs.readFileSync(path.join(runs, file), "utf8")) as OrchestraRun;
          return run.workers.length >= 2 && new Set(run.tasks.filter(t => t.startedAt !== undefined && run.workers.includes(t.agent)).map(t => t.agent)).size >= 2;
        } catch { return false; } // A torn run file is not evidence of progress.
      });
    }
  }
  const clients = readDaemonConfig()?.clients ?? [];
  const phone = clients.some(c => !c.owner && !c.guest);
  const skills = agentSkillsStatus().agents.some(a => a.skills.length > 0 && a.skills.every(s => s.current));
  const share = listShares().length > 0 || Boolean(opts.hasTeamInvite?.())
    || clients.some(c => c.guest && c.guest.expiresAt > Date.now());
  return { dismissed: readDaemonConfig()?.onboarding?.dismissed ?? false, steps: [
    { id: "demo", title: "Try the demo", done: demo, detail: demo ? "Demo project created" : "Try Loom with free, offline agents", action: "try" },
    { id: "agent", title: "Connect an agent", done: agent, detail: agent ? "An agent is signed in or a provider is configured" : tried ? "Demo tried; connect a real agent to do your own work" : "Install and sign in to an agent, or configure a model provider", action: "install-agent" },
    { id: "project", title: "Open a project", done: projects.length > 0, detail: `${projects.length} project(s) registered`, action: "open-project" },
    { id: "message", title: "Finish a chat turn", done: message, detail: message ? "A chat has a finished turn" : "Send a message and let an agent finish", action: "send-message" },
    { id: "fleet", title: "Run a fleet", done: fleet, detail: fleet ? "A run has started at least two workers" : "Run Orchestra, compare or race with two or more workers", action: "run-fleet" },
    { id: "phone", title: "Pair your phone", done: phone, detail: phone ? "A device is paired" : "Pair a device to take Loom with you", action: "pair-phone" },
    { id: "skills", title: "Install Loom skills", done: skills, detail: skills ? "Bundled Loom skills are current in an agent directory" : "Install or update Loom skills for an agent", action: "skills" },
    { id: "share", title: "Share with someone", done: share, detail: share ? "A share link or team invite exists" : "Optionally share a chat or invite a teammate", action: "share", optional: true },
  ] };
}

export function dismissOnboarding(dismissed: boolean): { dismissed: boolean } {
  const config = readDaemonConfig();
  if (!config) throw new Error("daemon is not configured");
  config.onboarding = { dismissed };
  writeDaemonConfig(config);
  return { dismissed };
}

export const onboardingCommands: Record<OnboardingAction, string> = {
  try: "loom try",
  "install-agent": "loom setup install codex (then codex login), or loom providers:set <provider> --key <key>",
  "open-project": "loom init",
  "send-message": 'loom send "Hello" --wait',
  "run-fleet": 'loom compare "Review this project" --workers <agent1>,<agent2>',
  "pair-phone": "loom pair",
  skills: "loom skills install loom",
  share: "loom share",
};

export function formatOnboarding(report: OnboardingReport): string {
  return ["Get started" + (report.dismissed ? " (dismissed)" : ""), ...report.steps.map(s =>
    `${s.done ? "✓" : "○"} ${s.title}${s.optional ? " (optional)" : ""} — ${s.detail}${s.done ? "" : `\n  ${onboardingCommands[s.action]}`}`)].join("\n");
}
