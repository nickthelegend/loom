import { createHash } from "node:crypto";
import { z } from "zod";

// Wire contracts contain only bounded JSON values. Refinements belong in the
// semantic validator, so the same shapes can be exported as JSON Schema.
export const Id = z.string().min(1).max(256);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Text = z.string().max(1_000_000);
export const SourceRefV1 = z.strictObject({ projectId: Id, eventId: Counter,
  hash: Hash, span: z.strictObject({ start: Counter, end: Counter }).optional() });
export const WorkspaceRefV1 = z.strictObject({ id: Hash, checkout: Text,
  head: z.string().max(256).nullable(), dirty: z.boolean().nullable(), revision: Hash });
export const ContextItemV1 = z.strictObject({ id: Id, revision: Counter,
  conversationId: Id, kind: z.enum(["instruction", "decision", "correction", "topic", "pending"]),
  text: Text, origin: z.enum(["user", "agent", "derived", "external"]),
  status: z.enum(["exploratory", "tentative", "accepted", "rejected", "deferred", "superseded"]),
  sources: z.array(SourceRefV1).min(1).max(1000),
  supersedes: z.strictObject({ id: Id, revision: Counter }).nullable() });
export const CoverageV1 = z.strictObject({ source: SourceRefV1,
  disposition: z.enum(["exact", "summarized", "referenced", "omitted"]), reason: z.string().min(1).max(1000) });
export const BindingV1 = z.strictObject({ id: Id, conversationId: Id,
  agentInstanceId: Id, harnessKind: z.enum(["codex", "claude-code", "opencode"]),
  workspaceId: Hash, compatibilityFingerprint: Hash, nativeSessionId: Id.nullable(),
  // "compacted": the harness reported native compaction; the next packet rebuilds state.
  sessionEpoch: Counter, retention: z.enum(["unknown", "observed", "compacted"]) });
export const ContextPacketV1 = z.strictObject({ version: z.literal(1), id: Id,
  conversationId: Id, requestId: Id, target: BindingV1,
  snapshot: z.strictObject({ throughEventId: Counter, conversationRevision: Counter,
    protectedStateRevision: Counter, workspace: WorkspaceRefV1, instructionFilesFingerprint: Hash }),
  mode: z.enum(["reconstruction", "delta"]), currentRequest: SourceRefV1,
  // The accepted packet a delta builds on; its native session already holds
  // everything that packet delivered.
  basis: z.strictObject({ packetId: Id, protectedStateRevision: Counter }).nullable().optional(),
  supplement: Text,
  retrieval: z.strictObject({ hash: Hash, relativePath: z.string().regex(/^\.loom\/brain\/artifacts\/[a-f0-9]{64}\.json$/),
    bytes: Counter }).nullable(),
  items: z.array(ContextItemV1).max(10_000),
  messages: z.array(z.strictObject({ source: SourceRefV1,
    origin: z.enum(["user", "agent", "external"]), text: Text })).max(10_000),
  // Older user messages sent as a one-line headline; full text is in the retrieval file.
  references: z.array(z.strictObject({ source: SourceRefV1, headline: z.string().max(1000) })).max(10_000).optional(),
  // Counts of sources that are covered but not listed individually in the rendered text.
  unlisted: z.strictObject({ references: Counter, observations: Counter }).optional(),
  evidence: z.array(z.strictObject({ source: SourceRefV1, text: Text,
    outcome: z.enum(["reported", "pending", "success", "failure", "cancelled", "unknown"]) })).max(1000),
  coverage: z.array(CoverageV1).max(20_000),
  budget: z.strictObject({ estimatedAddedTokens: Counter, estimation: z.literal("heuristic"),
    targetAddedTokens: Counter, overflow: z.enum(["none", "soft", "mandatory"]) }) });
export const RenderedBriefingV1 = z.strictObject({ version: z.literal(1), packetId: Id,
  text: Text, hash: Hash, channel: z.literal("turn-input"), renderer: z.literal("loom-context/1") });
export const DeliveryReceiptV1 = z.strictObject({ version: z.literal(1), id: Id,
  packetId: Id, requestId: Id, bindingId: Id, runId: Id,
  status: z.enum(["prepared", "submitting", "accepted", "failed", "outcome_unknown"]),
  execution: z.enum(["idle", "running", "complete", "failed", "interrupted", "unknown"]),
  evidence: z.string().max(2000).nullable(), updatedAt: Counter });
// Effort is optional so requests captured before per-chat effort keep their original hashes.
export const RequestV1 = z.strictObject({ id: Id, conversationId: Id, agentInstanceId: Id,
  text: Text.min(1), source: z.enum(["user", "route"]), model: Id.nullable(), effort: Id.nullable().optional(),
  plan: z.boolean(), targetAddedTokens: z.number().int().min(128).max(100_000) });
export type SourceRef = z.infer<typeof SourceRefV1>;
export type ContextItem = z.infer<typeof ContextItemV1>;
export type Binding = z.infer<typeof BindingV1>;
export type ContextPacket = z.infer<typeof ContextPacketV1>;
export type RenderedBriefing = z.infer<typeof RenderedBriefingV1>;
export type Receipt = z.infer<typeof DeliveryReceiptV1>;
export type ContinuityRequest = z.infer<typeof RequestV1>;
export type WorkspaceRef = z.infer<typeof WorkspaceRefV1>;
export const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export class ContinuityError extends Error {
  constructor(readonly code: "unsupported" | "conflict" | "overflow" | "recovery_required" | "stale" | "invalid", message: string) {
    super(message); this.name = "ContinuityError";
  }
}

/** Only adapters with evidence that no process was launched may use this. */
export class NativeDispatchRejected extends Error {
  constructor(message: string) { super(message); this.name = "NativeDispatchRejected"; }
}

/** The bound native session could not be resumed and no turn was started.
 * Safe to rebuild: the binding moves to a new epoch and reconstructs. */
export class NativeSessionMissing extends NativeDispatchRejected {
  constructor(message: string) { super(message); this.name = "NativeSessionMissing"; }
}

/** The native parent may have exited while a tool descendant still owns files. */
export class NativeQuiescenceUnknown extends Error {
  constructor(message: string) { super(message); this.name = "NativeQuiescenceUnknown"; }
}

export function parseBounded<T>(schema: z.ZodType<T>, value: unknown): T {
  // Reject oversize/deep/unserializable inputs before handing them to Zod.
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new ContinuityError("invalid", "invalid JSON"); }
  if (!encoded || Buffer.byteLength(encoded) > 4_000_000) throw new ContinuityError("invalid", "continuity input exceeds 4 MB");
  let depth = 0, inString = false, escaped = false;
  for (const c of encoded) {
    if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false; }
    else if (c === '"') inString = true;
    else if (c === "{" || c === "[") { if (++depth > 32) throw new ContinuityError("invalid", "continuity input is too deep"); }
    else if (c === "}" || c === "]") depth--;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ContinuityError("invalid", `invalid continuity contract: ${parsed.error.issues.slice(0, 8)
    .map(issue => `${issue.code} at ${issue.path.join(".").slice(0, 200) || "root"}`).join("; ")}`);
  return parsed.data;
}
