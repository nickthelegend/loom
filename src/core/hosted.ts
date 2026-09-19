/**
 * The hosted Loom Team Hub (Supabase) that ships in the build.
 *
 * The publishable key is public by design: it only identifies the project.
 * Every read is row-level-security checked against the signed-in user's JWT,
 * and every write goes through a rule function (supabase/migrations).
 * LOOM_SUPABASE_URL / LOOM_SUPABASE_PUBLISHABLE_KEY point a build elsewhere.
 */

export const HOSTED_SUPABASE_URL = "https://ufpkfpzspfzzxabklyec.supabase.co";
export const HOSTED_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_DBiS9r-XDdqlgjt_bdpC2w_JdXqEvb1";

/** How a hosted hub is written in team.json and invite links: `supabase:<project url>`. */
export const HOSTED_HUB_PREFIX = "supabase:";

export interface HostedTarget {
  supabaseUrl: string;
  publishableKey: string;
}

/** The hosted project in effect: env overrides first, then the built-in one. */
export function hostedTarget(env: NodeJS.ProcessEnv = process.env): HostedTarget {
  return {
    supabaseUrl: (env.LOOM_SUPABASE_URL || HOSTED_SUPABASE_URL).replace(/\/$/, ""),
    publishableKey: env.LOOM_SUPABASE_PUBLISHABLE_KEY || HOSTED_SUPABASE_PUBLISHABLE_KEY,
  };
}

/**
 * The Supabase project URL a hub string names, or null when it's a self-hosted
 * `loom hub`. Empty / "hosted" mean the hosted project in effect; so does its
 * bare URL; `supabase:<url>` names one explicitly.
 */
export function hostedSupabaseUrl(hub: string | undefined | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const h = (hub ?? "").trim().replace(/\/$/, "");
  const target = hostedTarget(env).supabaseUrl;
  if (!h || h.toLowerCase() === "hosted") return target;
  if (h.startsWith(HOSTED_HUB_PREFIX)) return h.slice(HOSTED_HUB_PREFIX.length).replace(/\/$/, "") || target;
  if (h.startsWith(target)) return target;
  if (h.startsWith(HOSTED_SUPABASE_URL)) return HOSTED_SUPABASE_URL;
  return null;
}

export function hostedHubUrl(supabaseUrl: string): string {
  return HOSTED_HUB_PREFIX + supabaseUrl.replace(/\/$/, "");
}

/** The publishable key for a Supabase project URL: the env/built-in one (a key is per project). */
export function publishableKeyFor(supabaseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const t = hostedTarget(env);
  if (supabaseUrl.replace(/\/$/, "") === t.supabaseUrl) return t.publishableKey;
  if (supabaseUrl.replace(/\/$/, "") === HOSTED_SUPABASE_URL) return HOSTED_SUPABASE_PUBLISHABLE_KEY;
  return t.publishableKey;
}
