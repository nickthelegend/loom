/**
 * The channel that knows "login" and "authentication" are the same subject.
 *
 * Retrieval has three channels — entities, BM25 and character trigrams — and
 * between them they cover exact strings, ordinary word overlap, morphology and
 * typos. What they cannot do, at all, is synonymy: `test/brain-recall.test.ts`
 * measures it, and the queries that miss share no word with the memory they
 * want. That gap is the whole and only reason for a model here.
 *
 * ## Why it is not installed by default
 *
 * The model is small — all-MiniLM-L6-v2, int8-quantised, 23 MB. The runtime
 * that executes it is not: `@huggingface/transformers` pulls ONNX Runtime with
 * every platform's binaries plus libvips, and lands at roughly 470 MB. Half a
 * gigabyte arriving unannounced on `npm i -g` is how a tool gets uninstalled,
 * and it would arrive for everyone to serve a channel some projects will never
 * turn on. So it is not a dependency at all: Loom asks for it at run time, and
 * says exactly what to install if it isn't there. Everything else keeps
 * working either way — a missing model degrades retrieval to the three
 * channels that have always been there, never to an error.
 *
 * ## What it does
 *
 * Embeds each memory once, keyed by the hash the memory already carries (edit
 * the text and the hash changes and it is re-embedded; nothing else is), keeps
 * the vectors beside the brain, and embeds the query per retrieval — 1-4ms
 * once the model is warm. Cosine similarity is a dot product, because the
 * vectors come out normalised.
 */

import fs from "node:fs";
import path from "node:path";

import type { Memory } from "./brain.js";
import { logbook } from "./logbook.js";
import { loomHome } from "./registry.js";

/** The package Loom will use if it's installed, and the words to install it. */
export const RUNTIME_PACKAGE = "@huggingface/transformers";
export const INSTALL_HINT = `semantic retrieval needs a local model runtime that Loom doesn't ship: npm i -g ${RUNTIME_PACKAGE} (about 470MB, one time). The model itself is 23MB and downloads on first use.`;

/**
 * int8, 23MB. The fp32 default is 90MB for no measurable gain on sentences
 * this short, and the q4 variants lose more than they save.
 */
export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const MODEL_DTYPE = "q8";
export const DIMS = 384;

/** Where the model file lives. Never inside node_modules, which upgrades away. */
export function modelDir(): string {
  return path.join(loomHome(), "models") + path.sep;
}

export interface SemanticModel {
  embed(texts: string[]): Promise<Float32Array[]>;
  /** True when the model was already on disk — i.e. nothing was downloaded. */
  cached: boolean;
}

/** Is the model already on disk? Decides whether this call needs the network. */
export function modelOnDisk(dir = modelDir()): boolean {
  const base = path.join(dir, ...MODEL_ID.split("/"));
  return fs.existsSync(path.join(base, "onnx", "model_quantized.onnx"));
}

let loading: Promise<SemanticModel | null> | null = null;

/**
 * Load the model, or return null with the reason logged.
 *
 * Null is a normal answer: the runtime isn't installed, or there's no network
 * for the first download. Retrieval carries on without the channel, which is
 * exactly what it did before this file existed.
 */
export async function loadModel(opts: { offline?: boolean; dir?: string } = {}): Promise<SemanticModel | null> {
  if (loading) return loading;
  loading = (async () => {
    const dir = opts.dir ?? modelDir();
    const cached = modelOnDisk(dir);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(/* @vite-ignore */ RUNTIME_PACKAGE)) as Record<string, unknown>;
    } catch {
      logbook.warn("brain", "semantic retrieval is on, but its runtime isn't installed", INSTALL_HINT);
      return null;
    }
    try {
      const env = mod.env as Record<string, unknown>;
      fs.mkdirSync(dir, { recursive: true });
      env.cacheDir = dir; // must end with a separator — modelDir() does
      env.allowLocalModels = true; // this is what gates reading the cache back
      // Offline once it's here: a retrieval should never wait on huggingface.co
      // to tell it something it already has on disk.
      env.allowRemoteModels = opts.offline ?? !cached;
      const pipeline = mod.pipeline as (
        task: string,
        model: string,
        o: Record<string, unknown>,
      ) => Promise<(texts: string[], o: Record<string, unknown>) => Promise<{ tolist(): number[][] }>>;
      const extract = await pipeline("feature-extraction", MODEL_ID, {
        dtype: MODEL_DTYPE,
        // A handful of short strings does not want four worker threads.
        session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
      });
      return {
        cached,
        async embed(texts: string[]): Promise<Float32Array[]> {
          if (!texts.length) return [];
          const out = await extract(texts, { pooling: "mean", normalize: true });
          return out.tolist().map((row) => Float32Array.from(row));
        },
      };
    } catch (err) {
      logbook.warn("brain", "the embedding model wouldn't load", String(err));
      return null;
    }
  })();
  return loading;
}

/** For tests: forget the loaded model so the next call loads again. */
export function resetModel(): void {
  loading = null;
}

interface StoredVectors {
  model: string;
  /** memory hash → base64 of the raw float32 bytes. */
  vectors: Record<string, string>;
}

const encode = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const decode = (s: string) => {
  const buf = Buffer.from(s, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};

/**
 * The vectors for one project's brain, kept next to it.
 *
 * Keyed by memory hash, not id: a memory whose text changed is a different
 * thing to embed, and one that was only re-scoped is not.
 */
export class SemanticIndex {
  private file: string;
  private model: SemanticModel | null = null;
  private byHash = new Map<string, Float32Array>();
  private queries = new Map<string, Float32Array>();

  constructor(loomDir: string) {
    this.file = path.join(loomDir, "vectors.json");
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredVectors;
      // A different model's vectors are not comparable with this one's.
      if (raw.model !== MODEL_ID) return;
      for (const [hash, b64] of Object.entries(raw.vectors ?? {})) this.byHash.set(hash, decode(b64));
    } catch {
      /* no vectors yet, or unreadable: we'll make them again */
    }
  }

  private save(): void {
    const vectors: Record<string, string> = {};
    for (const [hash, v] of this.byHash) vectors[hash] = encode(v);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ model: MODEL_ID, vectors } satisfies StoredVectors));
    } catch (err) {
      logbook.warn("brain", "couldn't save the embedding cache", String(err));
    }
  }

  /** True once a model is loaded — i.e. the channel can actually answer. */
  ready(): boolean {
    return Boolean(this.model);
  }

  async start(opts: { dir?: string } = {}): Promise<boolean> {
    this.model ??= await loadModel(opts);
    return Boolean(this.model);
  }

  /**
   * Embed what's new, forget what's gone. Returns how many were embedded.
   *
   * Batched: 256 at once takes about as long as 8 one at a time.
   */
  async sync(memories: Memory[]): Promise<number> {
    if (!this.model) return 0;
    const live = new Set(memories.map((m) => m.hash));
    const missing = memories.filter((m) => !this.byHash.has(m.hash));
    if (missing.length) {
      try {
        const vecs = await this.model.embed(missing.map((m) => m.text));
        missing.forEach((m, i) => this.byHash.set(m.hash, vecs[i]!));
      } catch (err) {
        logbook.warn("brain", "couldn't embed new memories", String(err));
        return 0;
      }
    }
    let dropped = 0;
    for (const hash of [...this.byHash.keys()]) {
      if (!live.has(hash)) {
        this.byHash.delete(hash);
        dropped++;
      }
    }
    if (missing.length || dropped) this.save();
    return missing.length;
  }

  /** The vectors for these memories, by memory id, for whatever is embedded. */
  byId(memories: Memory[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    for (const m of memories) {
      const v = this.byHash.get(m.hash);
      if (v) out.set(m.id, v);
    }
    return out;
  }

  /** Embed a query. Cached, because the same briefing asks more than once. */
  async query(text: string): Promise<Float32Array | null> {
    const key = text.trim().slice(0, 2000);
    if (!key || !this.model) return null;
    const hit = this.queries.get(key);
    if (hit) return hit;
    try {
      const [v] = await this.model.embed([key]);
      if (!v) return null;
      if (this.queries.size > 64) this.queries.clear(); // a cache, not a leak
      this.queries.set(key, v);
      return v;
    } catch (err) {
      logbook.warn("brain", "couldn't embed the query", String(err));
      return null;
    }
  }
}
