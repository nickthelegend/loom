/** Pure helpers for the Triggers tab (#361), kept apart from React Native so they can be tested. */

export interface ScheduleLike { kind: "schedule" | "webhook"; cron?: string; everyMin?: number }

/** "every 30 min", "every day at 09:00" for the common crons, the cron itself otherwise. */
export function scheduleText(t: ScheduleLike): string {
  if (t.kind === "webhook") return "on a webhook";
  if (t.everyMin) return t.everyMin % 60 === 0 ? `every ${t.everyMin / 60 === 1 ? "hour" : `${t.everyMin / 60} hours`}` : `every ${t.everyMin} min`;
  const c = (t.cron ?? "").trim();
  const named: Record<string, string> = { "@hourly": "every hour", "@daily": "every day at midnight", "@midnight": "every day at midnight", "@weekly": "every Sunday", "@monthly": "on the 1st of each month", "@weekdays": "weekdays at 09:00" };
  if (named[c]) return named[c]!;
  const m = /^(\d+) (\d+) \* \* (\*|1-5)$/.exec(c);
  if (m) return `${m[3] === "1-5" ? "weekdays" : "every day"} at ${m[2]!.padStart(2, "0")}:${m[1]!.padStart(2, "0")}`;
  return c ? `cron ${c}` : "on a schedule";
}

