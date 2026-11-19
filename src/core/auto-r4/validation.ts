import { newSecret, newTriggerId, parseCron, parseEvery, type Trigger } from "../triggers.js";
import { schedulePreview, triggerEvents, validateCondition } from "./model.js";
import { publicUrl } from "./watch.js";

export function automationTrigger(body: Record<string, unknown>, prior?: Trigger): Trigger {
  const kind = body.kind ?? prior?.kind ?? (body.onChange ? "file" : body.on ? "event" : body.onCommit ? "branch" : body.watchUrl ? "url" : "schedule");
  if (!["schedule", "webhook", "file", "event", "branch", "url"].includes(String(kind))) throw new Error("unknown automation trigger kind");
  if (prior && kind !== prior.kind) throw new Error("create a new trigger to change its kind");
  const t: Trigger = prior ? { ...prior } : { id: newTriggerId(), kind: kind as Trigger["kind"], name: String(kind), prompt: "", enabled: true, createdAt: Date.now() };
  for (const key of ["name", "prompt", "agent", "onChange", "on", "onCommit", "watchUrl", "select", "when", "condition", "recipe", "route"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") throw new Error(`${key} must be text`);
    const value = body[key].trim();
    if (value.length > (key === "prompt" ? 20_000 : 2000)) throw new Error(`${key} is too long`);
    t[key] = value;
  }
  for (const key of ["enabled", "orchestrate", "githubCommand"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") throw new Error(`${key} must be a boolean`);
      t[key] = body[key];
    }
  }
  if (body.failureLimit !== undefined) {
    if (!Number.isInteger(body.failureLimit) || Number(body.failureLimit) < 1 || Number(body.failureLimit) > 100) throw new Error("failureLimit must be an integer from 1 to 100");
    t.failureLimit = Number(body.failureLimit);
  }
  if (body.minIntervalSec !== undefined) {
    if (typeof body.minIntervalSec !== "number" || !Number.isFinite(body.minIntervalSec) || body.minIntervalSec < 0) throw new Error("minIntervalSec must be nonnegative seconds");
    t.minIntervalSec = body.minIntervalSec;
  }
  if ([t.recipe, t.route, t.orchestrate].filter(Boolean).length > 1) throw new Error("choose one of recipe, orchestrate or route");
  if (!t.prompt && !t.recipe) throw new Error("a trigger needs a prompt or an Orchestra recipe");
  if (t.condition) validateCondition(t.condition);
  if (body.cron !== undefined) { parseCron(String(body.cron)); t.cron = String(body.cron); delete t.everyMin; delete t.when; }
  if (body.every !== undefined) { t.everyMin = parseEvery(String(body.every)); delete t.cron; delete t.when; }
  if (body.when) { t.cron = schedulePreview(String(body.when)).cron; delete t.everyMin; }
  if (kind === "schedule" && !t.cron && !t.everyMin) throw new Error("a schedule needs when, cron or every");
  if (kind === "file" && (!t.onChange || t.onChange.startsWith("/") || t.onChange.split("/").includes(".."))) throw new Error("onChange must be a project-relative glob");
  if (kind === "event" && !triggerEvents.includes(t.on ?? "")) throw new Error(`on must be ${triggerEvents.join(" | ")}`);
  if (kind === "branch" && (!t.onCommit || !/^[\w][\w./-]*$/.test(t.onCommit) || t.onCommit.includes(".."))) throw new Error("onCommit must be a branch name");
  if (kind === "url") { publicUrl(t.watchUrl ?? ""); t.everyMin ??= 15; if (t.select && !/^[\w-]+(?:\.[\w-]+)*$/.test(t.select)) throw new Error("select must be a JSON dot path"); }
  if (kind === "webhook") t.secret ??= newSecret();
  if (body.enabled === true) t.failures = 0;
  return t;
}

export function ownerOnlyTrigger(t: Trigger): boolean { return t.kind === "file" || Boolean(t.condition?.startsWith("cmd:")); }
