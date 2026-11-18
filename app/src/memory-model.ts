export interface MemoryFilters { q?: string; kind?: string; agent?: string; since?: string; until?: string; chat?: string; includeArchived?: boolean }

export function memoryQuery(filters: MemoryFilters): string {
  const query = new URLSearchParams({ limit: "500" });
  for (const key of ["q", "kind", "agent", "since", "until", "chat"] as const) if (filters[key]?.trim()) query.set(key, filters[key]!.trim());
  if (filters.includeArchived) query.set("includeArchived", "1");
  return (filters.q?.trim() ? "/search?" : "?") + query;
}

export function memoryPriority(input: string): number {
  if (!/^-?\d+$/.test(input.trim()) || Math.abs(Number(input)) > 1000) throw new Error("Priority must be an integer from −1000 to 1000");
  return Number(input);
}
