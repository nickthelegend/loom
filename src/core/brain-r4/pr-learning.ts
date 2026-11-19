import type { Brain } from "../brain.js";
import type { EventJournal } from "../eventlog.js";
import type { LoomEvent } from "../../types.js";
import { execFile } from "../process.js";
import { prFromUrl } from "../pr-feedback.js";
import { logbook } from "../logbook.js";

export interface MergedPrKnowledge { title: string; body?: string; reviews?: Array<{ body?: string }>; comments?: Array<{ body?: string }> }
export type ReadPrKnowledge = (url: string) => Promise<MergedPrKnowledge>;

export function learnMergedPr(brain: Brain, event: LoomEvent, data: MergedPrKnowledge) {
  const url = String(event.payload.url);
  if (brain.knowledge.hasLearnedPr(url)) return { learned: 0 };
  const summary = [data.title, data.body].filter(s => s?.trim()).join("\n\n");
  const comments = [...(data.reviews ?? []), ...(data.comments ?? [])].map(c => c.body?.trim())
    .filter((s): s is string => Boolean(s && s.length >= 40));
  const parts = [...new Set([summary.trim(), ...[...new Set(comments)].slice(0, 10)].filter(Boolean).map(s => s.slice(0, 8000)))];
  let learned = 0;
  for (const text of parts) {
    const input = { kind: "decision" as const, text: `Merged PR ${url}: ${text}`,
      evidence: text, untrusted: true, scope: event.chat ? { chat: event.chat } : {}, tags: ["merged-pr"],
      provenance: { agentId: "brain:pr", eventId: event.id, ts: event.ts } };
    if (brain.knowledge.settings().reviewBeforeSaving) {
      const pending = new Set(brain.knowledge.inbox().map(p => p.id));
      if (!pending.has(brain.knowledge.propose(input).id)) learned++;
    } else if (brain.add(input).created) learned++;
  }
  brain.knowledge.record("pr_learned", { url, learned });
  return { learned };
}

function readPr(dir: string, url: string, signal: AbortSignal): Promise<MergedPrKnowledge> {
  const gh = (args: string[]) => new Promise<string>((resolve, reject) => {
    signal.throwIfAborted();
    execFile("gh", args, { cwd: dir, signal, timeout: 30_000, maxBuffer: 2_000_000 }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
  });
  return (async () => {
    const { repo, prNumber } = prFromUrl(url), parts = repo.split("/");
    const hostname = parts.length === 3 ? parts.shift()! : "github.com";
    const view = JSON.parse(await gh(["pr", "view", url, "--json", "title,body,reviews,comments"])) as MergedPrKnowledge;
    const pages = JSON.parse(await gh(["api", "--hostname", hostname, `repos/${parts.join("/")}/pulls/${prNumber}/comments?per_page=100`, "--paginate", "--slurp"])) as Array<Array<{ body?: string }>>;
    return { ...view, comments: [...(view.comments ?? []), ...pages.flat()] };
  })();
}

/** The existing PR poller emits the merge event. Subscribe without adding a second poller. */
export function watchMergedPrs(owner: Brain | (() => Brain), log: EventJournal, dir: string, read?: ReadPrKnowledge): () => void {
  // Closing a project must also stop reads and their follow-up gh commands.
  const lifetime = new AbortController();
  const readKnowledge = read ?? (url => readPr(dir, url, lifetime.signal));
  const currentBrain = () => typeof owner === "function" ? owner() : owner;
  let started: number | undefined;
  let closed = false;
  let pending = Promise.resolve();
  const receive = (event: LoomEvent) => {
    if (event.kind !== "status" || event.payload.state !== "pr_feedback" || !/^PR #\d+ merged$/.test(String(event.payload.text))) return;
    pending = pending.then(async () => {
      if (closed || started === undefined || event.id <= started) return;
      const brain = currentBrain(), url = String(event.payload.url);
      if (brain.knowledge.hasLearnedPr(url) || brain.knowledge.prFailures(url) >= 3) return;
      try {
        const data = await readKnowledge(url);
        if (!closed) learnMergedPr(brain, event, data);
      } catch (error) {
        if (closed) return;
        const count = brain.knowledge.prFailures(url) + 1;
        brain.knowledge.record("pr_learn_failed", { url, count });
        logbook.warn("brain", count >= 3 ? "PR knowledge stopped after three failures" : "PR knowledge will retry when the project reopens", String(error));
      }
    });
  };
  const unsubscribe = log.onEvent(receive);
  const start = () => {
    if (closed) return;
    const knowledge = currentBrain().knowledge;
    started = knowledge.startPrLearning(dir);
    for (const event of log.list({ kinds: ["status"], since: started })) receive(event);
  };
  // ProjectRuntime constructs briefings before assigning its Brain.
  if (typeof owner === "function") pending = pending.then(start);
  else start();
  return () => { closed = true; unsubscribe(); lifetime.abort(); };
}
