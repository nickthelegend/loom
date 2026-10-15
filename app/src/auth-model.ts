/** Hosted Loom identities use the same GitHub provider as the Team Hub. */
export const OAUTH_PROVIDER = "github" as const;
export const OAUTH_LABEL = "Continue with GitHub";
export const oauthOptions = (redirectTo: string) => ({ provider: OAUTH_PROVIDER, options: { redirectTo, skipBrowserRedirect: true } });

/** Accept only the callback requested by this browser session. Never logs tokens. */
export function redirectParams(url: string, expected: string): Record<string, string> {
  if (url.split(/[?#]/, 1)[0] !== expected.split(/[?#]/, 1)[0]) throw new Error("Sign-in returned to an unexpected callback.");
  const out: Record<string, string> = {};
  const q = url.indexOf("?"), h = url.indexOf("#");
  const query = q >= 0 ? url.slice(q + 1, h > q ? h : undefined) : "";
  const frag = h >= 0 ? url.slice(h + 1) : "";
  for (const part of `${query}&${frag}`.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("="), decode = (value: string) => decodeURIComponent(value.replace(/\+/g, " "));
    const key = decode(eq < 0 ? part : part.slice(0, eq));
    if (Object.hasOwn(out, key)) throw new Error("Sign-in returned duplicate callback parameters.");
    out[key] = eq < 0 ? "" : decode(part.slice(eq + 1));
  }
  return out;
}
