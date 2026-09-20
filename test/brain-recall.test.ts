/**
 * How good is retrieval, in a number?
 *
 * #31 proposes a local embedding model and sets its own bar: it has to beat
 * what's here on a held-out set, "or it's dead weight". That bar can't be
 * applied without a measurement, so this is the measurement — a small corpus
 * of the kind of thing Loom actually learns, three query sets, and recall@5
 * for each.
 *
 * The three sets are chosen to separate what each channel can and can't do:
 *
 *   literal   — the query shares strings with the memory. Entities + BM25.
 *   fuzzy     — different word forms, and typos. The trigram channel (#4).
 *   synonymy  — the query and the memory share NO words at all. Nothing here
 *               can do this, and no amount of lexical tuning will: it is
 *               exactly and only what a dense model would buy.
 *
 * The first two assert floors, so a change that quietly makes retrieval worse
 * fails. The third asserts its own weakness, on purpose: it is the number a
 * dense channel has to beat to be worth a model download, and it should be
 * updated (not deleted) the day one lands.
 *
 * Where it stands today (recall@5):
 *
 *   literal   1.00
 *   fuzzy     0.80   miss: "migrating the database" → the drizzle-kit rule
 *   synonymy  0.50   misses: "how does login work" → the JWKS rule;
 *                    "colour theme switching" → the dark-mode decision;
 *                    "shipping a new version to users" → the release workflow
 *
 * Read the synonymy half honestly: half of those queries are found only
 * because a small corpus leaks some shared token. The three that miss share
 * no word with the memory at all, and no lexical tuning will reach them.
 */

import { describe, expect, it } from "vitest";

import { lemmatize, type Memory, type MemoryKind } from "../src/core/brain.js";
import { retrieveFrom } from "../src/core/brain-index.js";

const DAY = 24 * 60 * 60 * 1000;

function mem(id: string, kind: MemoryKind, text: string, entities: string[] = [], agedDays = 1): Memory {
  const at = Date.now() - agedDays * DAY;
  return {
    id,
    kind,
    text,
    entities,
    scope: {},
    confidence: 0.9,
    provenance: { agentId: "t", eventId: 1, ts: at },
    createdAt: at,
    updatedAt: at,
    lemmas: lemmatize(text),
    hash: id,
    version: 1,
  };
}

/** A project's worth of memories, in the register the extractor produces. */
const CORPUS: Memory[] = [
  mem("auth-1", "constraint", "Sessions are verified against Supabase JWKS on every request; there is no local session table.", ["Supabase", "JWKS"]),
  mem("auth-2", "decision", "We chose bearer tokens over cookies for the daemon API because the phone app has no cookie jar.", ["daemon"]),
  mem("db-1", "fact", "The pooler URL in SUPABASE_DB_URL is the only connection string that works from the runner.", ["SUPABASE_DB_URL"]),
  mem("db-2", "constraint", "Migrations run with drizzle-kit push, never by hand against production.", ["drizzle-kit"]),
  mem("deploy-1", "fact", "Deployment is a GitHub Actions workflow that builds on each native runner and publishes to Releases.", ["GitHub Actions"]),
  mem("deploy-2", "constraint", "The release job refuses to publish an empty artifact set — a silent empty release shipped once.", ["release"]),
  mem("ui-1", "fact", "The whole web app is one template literal in src/daemon/app-page.ts, so backticks must be escaped.", ["src/daemon/app-page.ts"]),
  mem("ui-2", "decision", "Dark mode is driven by CSS variables redefined under a prefers-color-scheme media query.", ["prefers-color-scheme"]),
  mem("test-1", "fact", "DOM tests run the real page inside jsdom against a real daemon, not a mock.", ["jsdom"]),
  mem("test-2", "constraint", "vitest testTimeout is 40s because an agent turn is real work, not a stub.", ["vitest"]),
  mem("git-1", "decision", "commitPerTurn stages exactly the files a turn touched, so a bystander's mess is never swallowed.", ["commitPerTurn"]),
  mem("git-2", "fact", "Agent worktrees live on branch agent/<id> beside the project directory.", ["worktree"]),
  mem("perf-1", "fact", "Retrieval is a linear scan over a few hundred units; an index would cost more than it saves.", ["retrieval"]),
  mem("err-1", "fact", "EADDRINUSE on start means a previous daemon is still holding the port.", ["EADDRINUSE"]),
  mem("err-2", "fact", "ENOSPC during npm install means the disk filled, not that the package is broken.", ["ENOSPC"]),
  mem("queue-1", "decision", "Stop pauses the prompt queue instead of emptying it; what you queued is still yours.", ["queue"]),
  mem("queue-2", "fact", "Queued prompts are kept in .loom/queue.json and survive a daemon restart.", [".loom/queue.json"]),
  mem("sqlite-1", "fact", "The event log uses node:sqlite when it exists and falls back to JSONL when it doesn't.", ["node:sqlite"]),
  mem("notify-1", "constraint", "No notification fires while you are looking at the conversation it would be about.", ["notification"]),
  mem("cost-1", "fact", "A goal's spend is capped by budgets.perGoalUsd; running work finishes, nothing new starts.", ["budgets.perGoalUsd"]),
];

interface Case {
  query: string;
  want: string;
}

const LITERAL: Case[] = [
  { query: "backticks in app-page.ts", want: "ui-1" },
  { query: "EADDRINUSE when starting the daemon", want: "err-1" },
  { query: "where are queued prompts stored", want: "queue-2" },
  { query: "drizzle-kit migrations", want: "db-2" },
  { query: "vitest timeout", want: "test-2" },
  { query: "budgets.perGoalUsd cap", want: "cost-1" },
  { query: "JWKS session verification", want: "auth-1" },
  { query: "agent worktree branch", want: "git-2" },
];

const FUZZY: Case[] = [
  { query: "deploying releases", want: "deploy-1" }, // deploying → deployment
  { query: "sqllite event log", want: "sqlite-1" }, // a typo
  { query: "migrating the database", want: "db-2" }, // migrating → migrations
  { query: "notifications while chatting", want: "notify-1" },
  { query: "committing each turn", want: "git-1" },
];

/**
 * No word in the query appears in the memory. This is the synonymy gap, and
 * it is the ONLY thing a dense channel is being proposed to buy.
 */
const SYNONYMY: Case[] = [
  { query: "how does login work", want: "auth-1" },
  { query: "sign-in tokens for the mobile client", want: "auth-2" },
  { query: "colour theme switching", want: "ui-2" },
  { query: "out of space while installing", want: "err-2" },
  { query: "shipping a new version to users", want: "deploy-1" },
  { query: "halting a run that costs too much", want: "cost-1" },
];

/** Recall@k: the share of cases whose wanted memory came back in the top k. */
function recallAt(cases: Case[], k = 5): number {
  let found = 0;
  for (const c of cases) {
    const ids = retrieveFrom(CORPUS, { query: c.query, limit: k }).map((h) => h.memory.id);
    if (ids.includes(c.want)) found++;
  }
  return found / cases.length;
}

/** Which cases missed — so a regression names the query, not just a number. */
function misses(cases: Case[], k = 5): string[] {
  return cases
    .filter((c) => !retrieveFrom(CORPUS, { query: c.query, limit: k }).some((h) => h.memory.id === c.want))
    .map((c) => `${c.query} → ${c.want}`);
}

describe("how much of what it should find, it finds", () => {
  it("finds what the query names, nearly always", () => {
    const r = recallAt(LITERAL);
    expect(misses(LITERAL), "literal misses").toEqual([]);
    expect(r).toBe(1);
  });

  it("survives different word forms and typos — what the trigram channel is for", () => {
    const r = recallAt(FUZZY);
    expect(r, `fuzzy recall@5 was ${r}; misses: ${misses(FUZZY).join(" | ")}`).toBeGreaterThanOrEqual(0.8);
  });

  /**
   * The bar #31 has to clear. This asserts the WEAKNESS: lexical retrieval
   * cannot match "login" to "Supabase JWKS", and pretending it might is how a
   * model gets added for nothing. When a dense channel lands, this number
   * moves up and this test changes with it — it is the evidence, not decoration.
   */
  it("cannot follow a synonym, and says so with a number", () => {
    const r = recallAt(SYNONYMY);
    expect(r).toBeLessThan(0.7); // the gap a dense channel would have to close
    expect(misses(SYNONYMY).length).toBeGreaterThan(0);
  });

  it("a query about nothing in the corpus returns nothing loudly relevant", () => {
    const hits = retrieveFrom(CORPUS, { query: "the migratory patterns of arctic terns", limit: 5 });
    expect(hits.every((h) => h.score < 0.5)).toBe(true);
  });
});
