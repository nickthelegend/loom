import path from "node:path";

export interface KnowledgeFields {
  tags?: string[];
  paths?: string[];
  pack?: string;
  source?: { pattern: string; file: string; line: number; hash: string; occurrence?: number };
}

export function labels(values: string[] = []): string[] {
  if (!Array.isArray(values) || values.some(v => typeof v !== "string" || !v.trim() || v.trim().length > 100)) throw new Error("tags must be nonempty and at most 100 characters");
  const normalized = [...new Set(values.map(v => v.trim().toLowerCase()))];
  if (normalized.length > 50) throw new Error("use at most 50 tags");
  return normalized;
}

export function paths(values: string[] = []): string[] {
  if (!Array.isArray(values) || values.some(v => typeof v !== "string")) throw new Error("paths must be relative project globs");
  const normalized = [...new Set(values.map(v => v.trim().replace(/^\.\//, "")))];
  if (normalized.length > 50 || normalized.some(v => !v || v.length > 500 || path.posix.isAbsolute(v) || /^[a-z]:/i.test(v) || v.includes("\\") || v.split("/").includes(".."))) throw new Error("paths must be relative project globs");
  return normalized;
}

/** A glob's ** spans directories; * and ? stay inside one path segment. */
export function matchesPath(file: string, pattern: string): boolean {
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") { i++; expression += "(?:.*/)?"; }
      else expression += ".*";
    } else if (ch === "*") expression += "[^/]*";
    else if (ch === "?") expression += "[^/]";
    else expression += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`).test(file.replace(/^\.\//, ""));
}

export function pathMatches(patterns: string[] | undefined, query = "", files: string[] = []): string[] {
  const mentioned = query.match(/[\w@.-]+(?:\/[\w@.*?-]+)+|[\w-]+\.[a-zA-Z0-9]+/g) ?? [];
  return [...new Set([...files, ...mentioned])].filter(file => patterns?.some(pattern => matchesPath(file, pattern)));
}
