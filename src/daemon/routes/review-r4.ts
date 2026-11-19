import fs from "node:fs";
import path from "node:path";
import type { Express, Request } from "express";
import type { RouteContext, WithRuntime } from "./context.js";
import type { LoomEvent } from "../../types.js";
import type { ProjectRuntime } from "../runtime.js";
import { listProjects } from "../../core/registry.js";
import { applySplit, changeHunk, conflictPrompt, digest, fileVersion, git, hunks, patchFiles, projectFile, prepareConflict, proposeSplit, workingPatch } from "../../core/review-r4/git.js";
import { blameLine, chatChanges, summarize } from "../../core/review-r4/records.js";
import { afterHumanReview, reviewSettings, runVerify, saveReviewSettings, VerifyError } from "../../core/review-r4/verify.js";
import { pullRequestDiff } from "../../core/review-r4/pr.js";

function context(req: Request) {
  const query = req.method === "GET" ? req.query : req.body;
  return { chat: String(query?.chat ?? "main"), run: query?.run ? String(query.run) : undefined };
}
async function changes(rt: ProjectRuntime, scope: { chat: string; run?: string }, events?: LoomEvent[], versions = new Map<string, string>()) {
  if (scope.run) {
    const run = rt.orchestra.list().find(r => r.id === scope.run);
    if (!run) throw new Error("no such run");
    const files = new Map<string, Set<string>>();
    for (const branch of [...new Set([run.branch, ...run.tasks.map(t => t.branch).filter((b): b is string => !!b)])]) {
      const patch = await git(rt.info.dir, ["diff", "--relative", "--no-ext-diff", "--no-textconv", "--no-renames", `${run.baseCommit}...${branch}`, "--", "."]);
      for (const f of patchFiles(patch)) {
        const versions = files.get(f.path) ?? new Set<string>(); versions.add(f.patch); files.set(f.path, versions);
      }
    }
    return [...files].map(([path, patches]) => { const patch = [...patches].join("\n"); return { path, patch, version: digest(patch) }; });
  }
  if (!events && !rt.chats().some(c => c.id === scope.chat)) throw new Error("no such chat");
  return chatChanges(events ?? rt.log.list({ activeLineages: true }), scope.chat).map(f => {
    // Manual edits after a turn invalidate the viewed marker as well.
    let current = versions.get(f.path);
    if (current === undefined) {
      try { current = fileVersion(rt.info.dir, f.path); } catch { current = "unavailable"; }
      versions.set(f.path, current);
    }
    return { ...f, version: digest(f.version + current) };
  });
}
async function reviewView(rt: ProjectRuntime, scope: { chat: string; run?: string }, events?: LoomEvent[], marks?: Map<string, Map<string, string>>, versions?: Map<string, string>) {
  const key = scope.run ? `run:${scope.run}` : `chat:${scope.chat}`;
  const marked = (marks ?? viewedMap(rt.log.list({ kinds: ["status"] }))).get(key) ?? new Map<string, string>();
  const files = (await changes(rt, scope, events, versions)).map(f => ({ ...f, viewed: marked.get(f.path) === f.version }));
  return { context: key, files, viewed: files.filter(f => f.viewed).length, total: files.length };
}
function viewedMap(events: LoomEvent[]) {
  const marks = new Map<string, Map<string, string>>();
  for (const event of events) if (event.payload.state === "r4_viewed") {
    const key = String(event.payload.context), files = marks.get(key) ?? new Map<string, string>();
    files.set(String(event.payload.path), String(event.payload.version)); marks.set(key, files);
  }
  return marks;
}
type InboxRow = Awaited<ReturnType<typeof reviewView>> & { chat: string; run?: string; title: string };
const inboxCache = new WeakMap<ProjectRuntime, { id: number; at: number; stamps: Map<string, string>; pending: Promise<InboxRow[]> }>();
function stamp(dir: string, file: string) {
  try { const s = fs.lstatSync(path.join(dir, projectFile(dir, file))); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch { return "missing"; }
}
/** One projection per loaded project/event position, shared by simultaneous clients. */
export async function projectInbox(rt: ProjectRuntime): Promise<InboxRow[]> {
  const id = rt.log.lastId(), cached = inboxCache.get(rt);
  if (cached && cached.id === id && Date.now() - cached.at < 60_000 && [...cached.stamps].every(([file, value]) => stamp(rt.info.dir, file) === value)) return cached.pending;
  const entry = { id, at: Date.now(), stamps: new Map<string, string>(), pending: Promise.resolve([] as InboxRow[]) };
  entry.pending = (async () => {
    const events = rt.log.list({ activeLineages: true, kinds: ["turn_diff"] });
    const marks = viewedMap(rt.log.list({ kinds: ["status"] })), versions = new Map<string, string>();
    const chats = new Map<string, LoomEvent[]>();
    for (const event of events) { const key = event.chat ?? "main", list = chats.get(key) ?? []; list.push(event); chats.set(key, list); }
    const items: InboxRow[] = [];
    for (const chat of rt.chats()) {
      if (!chats.has(chat.id)) continue;
      const view = await reviewView(rt, { chat: chat.id }, chats.get(chat.id), marks, versions);
      if (view.viewed < view.total) items.push({ chat: chat.id, title: chat.title, ...view });
    }
    for (const run of rt.orchestra.list()) {
      if (run.applied || ["failed", "aborted", "moved"].includes(run.status)) continue;
      const view = await reviewView(rt, { chat: run.chat, run: run.id }, [], marks, versions);
      if (view.viewed < view.total) items.push({ chat: run.chat, run: run.id, title: run.goal, ...view });
    }
    for (const file of versions.keys()) entry.stamps.set(file, stamp(rt.info.dir, file));
    return items;
  })();
  inboxCache.set(rt, entry);
  try { return await entry.pending; } catch (e) { if (inboxCache.get(rt) === entry) inboxCache.delete(rt); throw e; }
}
function owner(req: Request): boolean {
  const who = req as Request & { isAdmin?: boolean; projectScope?: string[] | null; guest?: unknown };
  return !!(who.isAdmin || (!who.projectScope && !who.guest));
}
export async function handConflictToAgent(rt: ProjectRuntime, agent?: string, branch?: string) {
  const id = agent || rt.config.defaultAgent || rt.config.agents.find(a => a.enabled !== false)?.id;
  if (!id || !rt.config.agents.some(a => a.id === id && a.enabled !== false)) throw new Error("choose an enabled project agent");
  rt.reviews.check([id]);
  const existing = (await git(rt.info.dir, ["diff", "--name-only", "--diff-filter=U", "--", "."])).trim();
  const prepared = !!branch && !existing;
  let chat: ReturnType<ProjectRuntime["createChat"]> | undefined, setHold = false;
  const previousHold = !!reviewSettings(rt.info.dir).hold;
  if (prepared) await prepareConflict(rt.info.dir, branch!);
  try {
    const conflict = await conflictPrompt(rt.info.dir);
    if ((await rt.status()).holder !== id) await rt.handoff(id);
    chat = rt.createChat("Resolve merge conflicts", { agentId: id });
    await rt.sendMessage(`Resolve files in ${rt.info.dir}.\n\n${conflict.prompt}`, id, { chat: chat.id });
    saveReviewSettings(rt.info.dir, { hold: true }); setHold = !previousHold;
    return { chat: chat.id, files: conflict.files, waitingForReview: true };
  } catch (error) {
    if (prepared) await git(rt.info.dir, ["merge", "--abort"]).catch(() => {});
    if (setHold) saveReviewSettings(rt.info.dir, { hold: false });
    if (chat) { try { rt.deleteChat(chat.id); } catch { /* Preserve the original hand-off error. */ } }
    throw error;
  }
}

export function registerReviewR4Routes(app: Express, withRuntime: WithRuntime, ctx: Pick<RouteContext, "runtimes">): void {
  const route = (method: "get" | "post" | "put" | "delete", suffix: string, fn: (rt: ProjectRuntime, req: Request) => Promise<unknown>) => {
    app[method]("/api/projects/:id/" + suffix, withRuntime(async (rt, req, res) => {
      if (method === "put" && suffix === "git/verify" && !owner(req)) return void res.status(403).json({ error: "only this machine's owner can set verification" });
      try { res.json(await fn(rt, req)); }
      catch (e) { res.status(e instanceof VerifyError ? 409 : 400).json({ error: e instanceof Error ? e.message : String(e), ...(e instanceof VerifyError ? { code: "verify_failed", verify: e.result } : {}) }); }
    }));
  };
  app.get("/api/review/inbox", async (req, res) => {
    const scope = (req as Request & { projectScope?: string[] | null }).projectScope;
    const items = [], errors = [];
    for (const project of listProjects().filter(p => !scope || scope.includes(p.id))) {
      try {
        const rt = ctx.runtimes.get(project.id);
        if (!rt) { errors.push({ project: project.id, error: "not open" }); continue; }
        for (const item of await projectInbox(rt)) items.push({ project: project.id, projectName: project.name, ...item });
      } catch (error) { errors.push({ project: project.id, error: String(error) }); }
    }
    res.json({ items, errors });
  });
  route("get", "review/viewed", async (rt, req) => reviewView(rt, context(req)));
  route("post", "review/viewed", async (rt, req) => {
    const view = await reviewView(rt, context(req)), file = view.files.find(f => f.path === req.body?.path);
    if (!file || req.body?.version !== file.version) throw new Error("file changed; refresh before marking viewed");
    if (typeof req.body?.viewed !== "boolean") throw new Error("viewed must be boolean");
    rt.log.append({ kind: "status", chat: context(req).chat, payload: { state: "r4_viewed", context: view.context, path: file.path, version: req.body.viewed ? file.version : "" } });
    return reviewView(rt, context(req));
  });
  route("get", "review/summary", async (rt, req) => {
    const files = req.query.chat || req.query.run ? await changes(rt, context(req)) : patchFiles(await workingPatch(rt.info.dir));
    return { files: summarize(files.map(f => f.patch).join("\n"), files).map(file => {
      try { if (fs.statSync(path.join(rt.info.dir, projectFile(rt.info.dir, file.path))).size > 512_000 && !file.flags.includes("very large file change")) file.flags.push("very large file"); } catch { /* Deleted files still have their patch summary. */ }
      return file;
    }) };
  });
  route("get", "review/blame", async (rt, req) => {
    const file = projectFile(rt.info.dir, String(req.query.path ?? "")), line = Number(req.query.line ?? 1);
    const result = blameLine(rt.log.list({ activeLineages: true }), file, line);
    if (result.agent && fs.readFileSync(path.join(rt.info.dir, file), "utf8").split("\n")[line - 1] !== result.text) return { path: file, line, chat: null, turn: null, agent: null, prompt: null, reason: "This line differs from the recorded turn; attribution is unavailable" };
    return result;
  });
  route("get", "git/hunks", async (rt, req) => hunks(rt.info.dir, String(req.query.path ?? "")));
  route("post", "git/hunks", async (rt, req) => changeHunk(rt.info.dir, req.body ?? {}));
  route("get", "git/conflicts", async rt => ({ files: (await git(rt.info.dir, ["diff", "--name-only", "--diff-filter=U", "-z", "--", "."])).split("\0").filter(Boolean), waitingForReview: !!reviewSettings(rt.info.dir).hold }));
  route("post", "git/resolve", async (rt, req) => {
    const run = req.body?.run ? rt.orchestra.get(String(req.body.run)) : undefined;
    if (req.body?.run && !run) throw new Error("no such run");
    return handConflictToAgent(rt, req.body?.agent, req.body?.branch || run?.branch);
  });
  route("delete", "git/resolve", async rt => { saveReviewSettings(rt.info.dir, { hold: false }); return { waitingForReview: false }; });
  route("get", "git/verify", async rt => reviewSettings(rt.info.dir));
  route("put", "git/verify", async (rt, req) => {
    if (typeof req.body?.command !== "string" || req.body.command.length > 4000) throw new Error("command must be a string under 4000 characters");
    const timeout = req.body.verifyTimeoutMs;
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)) throw new Error("verifyTimeoutMs must be a positive integer up to 2147483647");
    return saveReviewSettings(rt.info.dir, { verify: req.body.command.trim(), ...(timeout === undefined ? {} : { verifyTimeoutMs: timeout }) });
  });
  route("post", "git/verify", async rt => ({ result: await runVerify(rt.info.dir) }));
  route("post", "git/verify/agent", async (rt, req) => {
    const last = reviewSettings(rt.info.dir).last;
    if (!last || last.ok) throw new Error("no failed verification to send");
    const agent = req.body?.agent || rt.config.defaultAgent || (await rt.status()).holder;
    if (agent && (await rt.status()).holder !== agent) await rt.handoff(agent);
    const chat = rt.createChat("Fix verification");
    await rt.sendMessage(`Fix this failing pre-commit verification. Leave changes for review.\nCommand: ${last.command}\nOutput:\n${last.output}`, agent, { chat: chat.id });
    return { chat: chat.id };
  });
  route("get", "git/split", async (rt, req) => proposeSplit(rt.info.dir, typeof req.query.model === "string" ? req.query.model : undefined));
  route("post", "git/split", async (rt, req) => afterHumanReview(() => applySplit(rt.info.dir, req.body?.groups, req.body?.version)));
  route("get", "review/pr", async rt => ({ reviews: rt.log.list({ kinds: ["status"] }).filter(e => e.payload.state === "r4_pr").map(e => ({ reviewId: String(e.payload.reviewId), target: e.payload.target, status: rt.reviews.status(String(e.payload.reviewId))?.status ?? "done" })) }));
  route("post", "review/pr", async (rt, req) => {
    const agents = Array.isArray(req.body?.agents) && req.body.agents.length ? req.body.agents : [rt.config.defaultAgent || rt.config.agents.find(a => a.enabled !== false)?.id];
    rt.reviews.check(agents);
    const { target, patch } = await pullRequestDiff(rt.info.dir, String(req.body?.pr ?? ""), owner(req));
    const savedPatch = path.join(rt.info.dir, ".loom", "review-r4", digest(patch) + ".diff");
    fs.mkdirSync(path.dirname(savedPatch), { recursive: true }); fs.writeFileSync(savedPatch, patch);
    const review = await rt.startReview({ agents, text: `Review the complete pull request diff stored at ${savedPatch}. Read the whole file. Pull request: ${target.url}`, focus: "Draft actionable PR comments. Include file and line. Do not post comments or edit files." });
    rt.log.append({ kind: "status", chat: review.chat, payload: { state: "r4_pr", reviewId: review.reviewId, target } });
    return { review, target };
  });
  route("get", "review/pr/:reviewId", async (rt, req) => {
    const review = rt.reviews.status(String(req.params.reviewId));
    if (!review) throw new Error("no such review");
    const saved = rt.log.list({ chat: review.chat, kinds: ["status"] }).filter(e => e.payload.state === "r4_pr_draft").at(-1);
    const target = rt.log.list({ chat: review.chat, kinds: ["status"] }).find(e => e.payload.state === "r4_pr")?.payload.target;
    return { review, target, draft: saved ? String(saved.payload.text) : (review.findings ?? []).map(f => `${f.file ?? "General"}${f.line ? ":" + f.line : ""}: ${f.text}`).join("\n\n") || (review.results ?? []).map(r => r.reply).join("\n\n") };
  });
  route("put", "review/pr/:reviewId", async (rt, req) => {
    const review = rt.reviews.status(String(req.params.reviewId));
    if (!review || typeof req.body?.text !== "string" || req.body.text.length > 200_000) throw new Error("provide a review and comment text");
    rt.log.append({ kind: "status", chat: review.chat, payload: { state: "r4_pr_draft", text: req.body.text } });
    return { saved: true };
  });
}
