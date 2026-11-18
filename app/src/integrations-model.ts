export const INTAKE_SOURCES = ["github", "linear", "jira"] as const;
export function integrationPatch(values: Record<string, string>, numeric: string[] = [], secrets: string[] = []): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (secrets.includes(key) && !value) continue;
    if (numeric.includes(key)) {
      const n = Number(value);
      if (!value.trim() || !Number.isFinite(n)) throw new Error(`${key} must be a number`);
      out[key] = n;
    } else out[key] = value;
  }
  return out;
}
