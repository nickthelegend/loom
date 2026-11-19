import type { Command } from "commander";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { DaemonClient } from "../daemon/client.js";
import { helpGuides, whatsNew } from "../core/help/catalog.js";
import { applyExternalTemplate } from "../core/help/templates.js";
import { starterTemplates } from "../core/starter-templates.js";
import { lessons, scenarioNames } from "../core/help/scenarios.js";
import { saveTutorialProgress, tutorialProgress } from "../core/help/tutorial.js";

interface Dependencies { ensureDaemon: () => Promise<DaemonClient>; currentProject: (client: DaemonClient) => Promise<{ id: string }> }
export function registerR4Onboard(program: Command, deps: Dependencies) {
  program.command("guide [topic]").description("read or search the bundled offline help guides").action((topic?: string) => {
    const all = helpGuides();
    const exact = all.find(g => g.id === topic);
    if (exact) return void console.log(exact.body);
    const guides = topic ? helpGuides(topic) : all;
    if (!guides.length) throw new Error(`no guide matching ${topic}; run loom guide to list topics`);
    console.log(topic ? guides.map(g => g.body).join("\n") : guides.map(g => `${g.id} — ${g.title}`).join("\n"));
  });
  program.command("whatsnew").description("highlights for this Loom release").action(() => {
    const release = whatsNew(); console.log(`Loom ${release.version}\n` + release.highlights.map(h => `• ${h.text}\n  Show me: loom guide ${h.topic}`).join("\n"));
  });
  program.command("ready").description("check this project's readiness for agents").option("--fix", "draft missing instructions and ignore Loom metadata").option("--json", "print the readiness report as JSON").action(async opts => {
    const client = await deps.ensureDaemon(), project = await deps.currentProject(client);
    const r = await client.onboard.ready(project.id, Boolean(opts.fix));
    console.log(opts.json ? JSON.stringify(r) : `${r.score}/100 · ${r.stack}\n` + r.checks.map(c => `${c.ok ? "✓" : "○"} ${c.id}: ${c.detail}${c.fix && !c.ok ? ` (fix: ${c.fix})` : ""}`).concat(r.applied).join("\n"));
  });
  program.command("examples [action] [name]").description("list bundled examples, or install one").action(async (action?: string, name?: string) => {
    const client = await deps.ensureDaemon();
    const { examples } = await client.onboard.examples();
    if (!action) return void console.log(examples.map(e => `${e.name} (${e.kind}) — ${e.description}`).join("\n"));
    if (action !== "install" || !name) throw new Error("usage: loom examples [install <name>]");
    const example = examples.find(e => e.name === name); if (!example) throw new Error("unknown example");
    const result = await client.onboard.install(name, example.kind === "trigger" ? (await deps.currentProject(client)).id : undefined);
    console.log(`${result.installed ? "Installed" : "Already installed"}: ${name}${example.kind === "trigger" ? " (disabled; review before enabling)" : ""}`);
  });
  const init = program.commands.find(c => c.name() === "init");
  const templateOption = init?.options.find(o => o.long === "--template");
  if (templateOption) templateOption.description = "bundled starter name, Git URL or directory";
  init?.hook("preAction", async command => {
    const source = command.opts().template;
    if (!source || starterTemplates().some(t => t.name === source)) return;
    await applyExternalTemplate(process.cwd(), source);
    command.setOptionValue("template", undefined);
  });
  const scenarioOpen = new WeakMap<Command, boolean>();
  const demo = program.commands.find(c => c.name() === "try");
  demo?.option("--scenario <name>", "run fleet, review or memory with offline Demo agents").hook("preAction", command => {
    if (command.opts().scenario && !scenarioNames.includes(command.opts().scenario)) throw new Error("scenario must be fleet, review or memory");
    if (command.opts().scenario && Number(command.opts().agents) < 3) throw new Error("scenarios need at least three Demo agents");
    if (command.opts().scenario) { scenarioOpen.set(command, command.opts().open !== false); command.setOptionValue("open", false); }
  }).hook("postAction", async command => {
    const opts = command.opts(); if (!opts.scenario) return;
    const client = await deps.ensureDaemon();
    const { project } = await client.tryProject({ ...(opts.dir ? { dir: path.resolve(opts.dir) } : {}), agents: Number(opts.agents) });
    const result = await client.onboard.scenario(project.id, opts.scenario);
    console.log(JSON.stringify(result));
    if (scenarioOpen.get(command)) {
      const chat = result.chat ?? result.review?.chat ?? result.run?.chat;
      const { openInBrowser } = await import("../hub/supabase-client.js");
      openInBrowser(`${client.baseUrl}/app#p/${project.id}${chat ? `/c/${chat}` : ""}`);
    }
  });
  program.command("tutorial").description("four interactive lessons using offline Demo agents").option("--resume", "continue completed lessons on this device").action(async opts => {
    if (!process.stdin.isTTY) throw new Error("loom tutorial needs an interactive terminal");
    const client = await deps.ensureDaemon();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { await tutorialSession(client, Boolean(opts.resume), question => rl.question(question), text => console.log(text)); }
    finally { rl.close(); }
  });
  program.command("providers:guide").description("add a key, test it, pick a default model and add a model agent").action(async () => {
    if (!process.stdin.isTTY) throw new Error("loom providers:guide needs an interactive terminal");
    const client = await deps.ensureDaemon(), project = await deps.currentProject(client);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const provider = (await rl.question("1/4 Provider id (for example openrouter): ")).trim();
      const baseUrl = (await rl.question("Custom base URL (blank for built-in): ")).trim();
      // Do not echo provider credentials in terminal scrollback.
      rl.close();
      const key = await secretQuestion("API key: ");
      await client.onboard.provider("key", { provider, key, baseUrl });
      console.log("2/4 Testing credentials and fetching models…");
      const tested = await client.onboard.provider("test", { provider });
      const choose = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(tested.models!.join("\n"));
        const model = (await choose.question("3/4 Default model: ")).trim();
        await client.onboard.provider("default", { provider, model });
        const answer = await choose.question("4/4 Add a model agent to the current project? [Y/n] ");
        if (/^n/i.test(answer.trim())) return;
        const result = await client.onboard.provider("agent", { provider, project: project.id });
        console.log(`Ready: ${result.agent!.id}`);
      } finally { choose.close(); }
    } finally { rl.close(); }
  });
}
export async function tutorialSession(client: DaemonClient, resume: boolean, ask: (question: string) => Promise<string>, print: (text: string) => void) {
  const progress = resume ? tutorialProgress() : { completed: [] as string[], project: undefined as string | undefined };
  if (!progress.project) progress.project = (await client.tryProject()).project.id;
  saveTutorialProgress(progress);
  for (const lesson of lessons.filter(l => !progress.completed.includes(l.id))) {
    print(`\n${lesson.title}\n${lesson.instruction}`);
    const answer = await ask("Press Enter to try it, or q to save and quit: ");
    if (answer.trim().toLowerCase() === "q") return;
    const result = await client.onboard.lesson(progress.project, lesson.id);
    print(await waitForLesson(client, progress.project, result));
    print(`Completed. Inspect it at ${client.baseUrl}/app#p/${progress.project}${result.chat ? `/c/${result.chat}` : ""}`);
    progress.completed.push(lesson.id); saveTutorialProgress(progress);
  }
  print("Tutorial complete. Replay with loom tutorial, or explore loom guide.");
}
export async function waitForLesson(client: DaemonClient, project: string, result: { run?: { id: string }; chat?: string }) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (result.run) {
      const { run } = await client.orchestraRun(project, result.run.id);
      if (run.status === "completed") return run.tasks.map(t => `${t.title}: ${t.status}`).join("\n");
      if (["failed", "aborted", "waiting_human"].includes(run.status)) throw new Error(`demo fleet ${run.status}; inspect it and resume the tutorial`);
    } else {
      const { events } = await client.events(project, undefined, 200);
      const failed = events.find(e => e.chat === result.chat && e.kind === "error");
      if (failed) throw new Error(String(failed.payload.message ?? "demo turn failed"));
      if (events.some(e => e.chat === result.chat && e.kind === "run_complete")) return events.filter(e => e.chat === result.chat && e.kind === "message" && e.agentId).map(e => String(e.payload.text ?? "")).join("\n");
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("demo lesson timed out; inspect the project and run loom tutorial --resume");
}
function secretQuestion(prompt: string): Promise<string> {
  process.stdout.write(prompt); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (err?: Error) => { process.stdin.removeListener("data", input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); err ? reject(err) : resolve(value); };
    const input = (data: Buffer) => { for (const c of data.toString()) { if (c === "\u0003") return done(new Error("cancelled")); if (c === "\r" || c === "\n") return done(); if (c === "\u007f") value = value.slice(0, -1); else if (c >= " ") value += c; } };
    process.stdin.on("data", input);
  });
}
