import type { Command } from "commander";
import { ensureDaemon } from "../daemon/client.js";
import { resolveCurrentProject } from "./common.js";

export function registerR4Review(program: Command): void {
  const project = async () => { const client = await ensureDaemon(); const p = await resolveCurrentProject(client); return { client, root: `/api/projects/${encodeURIComponent(p.id)}` }; };
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  program.command("review:inbox").description("Unreviewed changes across your projects").action(async () => print(await (await ensureDaemon()).reviewR4("/api/review/inbox")));
  program.command("review:summary").option("--chat <chat>", "summarize a chat's recorded changes").option("--run <run>", "summarize a run")
    .action(async (opts: { chat?: string; run?: string }) => { const { client, root } = await project(); print(await client.reviewR4(root + "/review/summary?" + new URLSearchParams(opts))); });
  program.command("blame <file>").description("Find the chat, turn, agent and prompt behind file[:line]")
    .action(async (file: string) => { const { client, root } = await project(); const m = /^(.*):(\d+)$/.exec(file); print(await client.reviewR4(root + "/review/blame?" + new URLSearchParams({ path: m?.[1] ?? file, line: m?.[2] ?? "1" }))); });
  program.command("git:resolve").option("--agent <agent>", "agent to resolve conflicts").option("--run <run>", "prepare a run Apply conflict").option("--branch <branch>", "prepare a branch or landing conflict").action(async (opts: { agent?: string; run?: string; branch?: string }) => { const { client, root } = await project(); print(await client.reviewR4(root + "/git/resolve", opts)); });
  program.command("git:verify").description("Configure or run pre-commit verification").option("--command <command>", "set command; empty disables").option("--run", "run verification now").option("--send-to-agent", "send the last failure to an agent").option("--agent <agent>", "agent for the failure")
    .action(async (opts: { command?: string; run?: boolean; sendToAgent?: boolean; agent?: string }) => {
      const { client, root } = await project();
      if (opts.command !== undefined) print(await client.reviewR4(root + "/git/verify", { command: opts.command }, "PUT"));
      else if (opts.sendToAgent) print(await client.reviewR4(root + "/git/verify/agent", { agent: opts.agent }));
      else if (opts.run) {
        const settings = await client.reviewR4<{ verifyTimeoutMs?: number }>(root + "/git/verify");
        print(await client.reviewR4(root + "/git/verify", {}, "POST", Math.min(2_147_483_647, (settings.verifyTimeoutMs ?? 600_000) + 10_000)));
      } else print(await client.reviewR4(root + "/git/verify"));
    });
  program.command("git:split").option("--apply", "commit the proposed groups").option("--model <model>", "optional model for grouping; falls back offline").action(async (opts: { apply?: boolean; model?: string }) => {
    const { client, root } = await project(); const proposal = await client.reviewR4<{ version: string; groups: { subject: string; files: string[] }[] }>(root + "/git/split" + (opts.model ? "?model=" + encodeURIComponent(opts.model) : ""));
    if (opts.apply) {
      const settings = await client.reviewR4<{ verifyTimeoutMs?: number }>(root + "/git/verify");
      print(await client.reviewR4(root + "/git/split", proposal, "POST", Math.min(2_147_483_647, ((settings.verifyTimeoutMs ?? 600_000) + 60_000) * Math.max(1, proposal.groups.length))));
    } else print(proposal);
  });
  program.command("review:pr <pr> [agents...]").description("Review a GitHub PR or GitLab MR; comments remain drafts").option("--no-wait", "return the review id immediately")
    .action(async (pr: string, agents: string[], opts: { wait: boolean }) => {
      const { client, root } = await project(); const started = await client.reviewR4<{ review: { reviewId: string } }>(root + "/review/pr", { pr, agents });
      if (!opts.wait) return print(started);
      const deadline = Date.now() + 20 * 60_000;
      while (Date.now() < deadline) {
        const result = await client.reviewR4<{ review: { status: string }; draft: string }>(root + "/review/pr/" + started.review.reviewId);
        if (result.review.status === "done") return print(result);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error(`Review is still running: ${started.review.reviewId}`);
    });
}
