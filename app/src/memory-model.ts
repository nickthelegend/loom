export interface MemoryFilters { tag?: string; sort?: string; q?: string; kind?: string; agent?: string; since?: string; until?: string; chat?: string; includeArchived?: boolean }

export function memoryQuery(filters: MemoryFilters): string {
  const query = new URLSearchParams({ limit: "500" });
  for (const key of ["q", "kind", "agent", "since", "until", "chat", "tag", "sort"] as const) if (filters[key]?.trim()) query.set(key === "agent" ? "author" : key, filters[key]!.trim());
  if (filters.includeArchived) query.set("includeArchived", "1");
  return (filters.q?.trim() ? "/search?" : "?") + query;
}

export function memoryPriority(input: string): number {
  if (!/^-?\d+$/.test(input.trim()) || Math.abs(Number(input)) > 1000) throw new Error("Priority must be an integer from −1000 to 1000");
  return Number(input);
}

export interface KnowledgeMemory {
  tags?: string[];
  paths?: string[];
  pack?: string;
  timesBriefed?: number;
  lastUsedAt?: number;
  source?: { file: string; line: number };
}

export function memoryLabels(value: string): string[] {
  const labels = [...new Set(value.split(",").map(v => v.trim().toLowerCase()).filter(Boolean))];
  if (labels.length > 50 || labels.some(v => v.length > 100)) throw new Error("Use at most 50 tags of at most 100 characters");
  return labels;
}

export function memoryPaths(value: string): string[] {
  const paths = [...new Set(value.split(",").map(v => v.trim()).filter(Boolean))];
  if (paths.length > 50 || paths.some(v => v.length > 500 || v.startsWith("/") || v.includes("\\") || v.split("/").includes(".."))) throw new Error("Use relative project path globs");
  return paths;
}

export function interviewAnswers(tests: string, conventions: string, avoid: string): Record<string, string> {
  const answers = Object.fromEntries(Object.entries({ tests, conventions, avoid }).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
  if (!Object.keys(answers).length) throw new Error("Answer at least one question");
  return answers;
}

export function feedbackBody(value: "helpful" | "wrong", injection: number) {
  if (!Number.isSafeInteger(injection) || injection < 1) throw new Error("Choose a recorded turn");
  return { value, injection };
}
