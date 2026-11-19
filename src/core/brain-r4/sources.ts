import fs from "node:fs";
import path from "node:path";
import { memoryHash, type Brain, type Memory } from "../brain.js";
import { matchesPath, paths } from "./fields.js";

export function sourcePatterns(brain: Brain): string[] {
  return brain.knowledge.sourcePatterns();
}

export function configureSource(brain: Brain, pattern: string, dir: string, remove = false) {
  pattern = paths([pattern])[0]!;
  if (!/\.(md|markdown|txt)$/i.test(pattern)) throw new Error("choose Markdown or text documents inside the repo");
  // Validate without mutating either configuration or indexed memories.
  if (!remove) scanSources(dir, [pattern], true);
  brain.knowledge.record(remove ? "source_remove" : "source_add", { pattern });
  if (remove) for (const m of brain.all()) if (m.source?.pattern === pattern) brain.forget(m.id, "source removed", "brain:sources");
}

type Chunk = { text: string; source: NonNullable<Memory["source"]> };
function scanSources(dir: string, patterns: string[], strict = false) {
  const root = fs.realpathSync(dir), files: string[] = [], skippedFiles = new Set<string>();
  const skip = (file: string, reason: string) => {
    if (strict) throw new Error(reason);
    skippedFiles.add(file);
  };
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ["node_modules", "vendor", "dist", "build"].includes(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.posix.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && patterns.some(p => matchesPath(file, p))) {
        if (files.length >= 500) skip(file, "document sources match more than 500 files; narrow the pattern");
        else files.push(file);
      }
    }
  };
  walk("");
  const wanted: Chunk[] = [];
  let bytes = 0, capped = false, scanned = 0;
  for (const file of files) {
    if (capped) { skippedFiles.add(file); continue; }
    const target = fs.realpathSync(path.join(root, file));
    if (!target.startsWith(root + path.sep)) throw new Error("document source escaped the project");
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let text: string;
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 1_000_000) { skip(file, "document sources exceed the 1 MB/file limit"); continue; }
      if (bytes + size > 10_000_000) { skip(file, "document sources exceed the 10 MB total limit"); capped = true; continue; }
      bytes += size;
      text = fs.readFileSync(fd, "utf8");
    } finally { fs.closeSync(fd); }
    scanned++;
    const lines = text.split("\n");
    let chunk = "", line = 1;
    const emit = () => {
      if (chunk.trim()) for (const pattern of patterns.filter(p => matchesPath(file, p))) wanted.push({ text: chunk.trim(), source: { pattern, file, line, hash: memoryHash(chunk) } });
      chunk = "";
    };
    lines.forEach((value, index) => {
      if (chunk.length + value.length > 2000 || (!value.trim() && chunk.length > 600)) { emit(); line = index + 1; }
      if (!chunk) line = index + 1;
      chunk += value.slice(0, 10_000) + "\n";
    });
    emit();
  }
  return { wanted, skippedFiles, files: scanned };
}

/** Refresh before retrieval; unchanged chunks keep their ids and usage history. Never follow symlinks. */
export function refreshSources(brain: Brain, dir: string, only?: string) {
  const patterns = sourcePatterns(brain).filter(p => !only || p === only);
  if (only && !patterns.length) throw new Error("no such document source");
  if (!patterns.length) return { added: 0, removed: 0, files: 0, skipped: 0 };
  // Finish the scan before changing the index: I/O failures leave the prior snapshot intact.
  const { wanted, skippedFiles, files } = scanSources(dir, patterns);
  const key = (s: Chunk["source"]) => JSON.stringify([s.pattern, s.file, s.hash]);
  const old = brain.all().filter(m => m.source && patterns.includes(m.source.pattern)).sort((a, b) => a.source!.line - b.source!.line);
  const available = new Map<string, Memory[]>();
  const occurrences = new Map<string, number>();
  for (const memory of old) {
    const k = key(memory.source!);
    occurrences.set(k, Math.max(occurrences.get(k) ?? 0, memory.source!.occurrence ?? 0));
    const rows = available.get(k) ?? []; rows.push(memory); available.set(k, rows);
  }
  let added = 0, removed = 0;
  for (const item of wanted) {
    // Pair repeated chunks in occurrence order. Keep the recorded line until text changes.
    if (available.get(key(item.source))?.shift()) continue;
    // A new repeat can occupy a retained chunk's old line. Give it a distinct
    // occurrence so Brain.add cannot mistake it for that preserved memory.
    const occurrence = (occurrences.get(key(item.source)) ?? 0) + 1;
    occurrences.set(key(item.source), occurrence);
    brain.add({ ...item, source: { ...item.source, occurrence }, kind: "fact", private: true, untrusted: true, entities: [item.source.file],
      provenance: { agentId: "brain:sources", eventId: brain.knowledge.log.lastId(), ts: Date.now() } });
    added++;
  }
  for (const rows of available.values()) for (const memory of rows) {
    if (skippedFiles.has(memory.source!.file)) continue;
    brain.forget(memory.id, "source changed or deleted", "brain:sources"); removed++;
  }
  return { added, removed, files, skipped: skippedFiles.size };
}
