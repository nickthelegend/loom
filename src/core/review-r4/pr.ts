import { execFile } from "../process.js";
import { resolveProvider } from "../providers.js";
import { integrationUrl } from "../jira.js";
import { git } from "./git.js";

export function prTarget(value: string, remote = "", gitlabHost?: string) {
  if (/^[1-9]\d*$/.test(value)) {
    if (!Number.isSafeInteger(Number(value))) throw new Error("invalid PR number");
    const lab = /(?:git@|https:\/\/)([^/:]+)[:/](.+?)(?:\.git)?$/.exec(remote);
    if (lab && (/gitlab/i.test(lab[1]!) || lab[1] === gitlabHost)) return { provider: "gitlab" as const, number: Number(value), host: lab[1]!, repo: lab[2]!.replace(/\.git$/, ""), url: `https://${lab[1]}/${lab[2]!.replace(/\.git$/, "")}/-/merge_requests/${value}` };
    return { provider: "github" as const, number: Number(value), url: lab?.[1] === "github.com" ? `https://github.com/${lab[2]!.replace(/\.git$/, "")}/pull/${value}` : value };
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) throw new Error("use an HTTPS pull request URL");
  const gh = /^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (gh && url.hostname === "github.com") return { provider: "github" as const, number: Number(gh[2]), url: value };
  const lab = /^\/(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (lab) return { provider: "gitlab" as const, number: Number(lab[2]), host: url.hostname, repo: lab[1]!, url: value };
  throw new Error("expected a GitHub PR or GitLab merge request URL");
}
/** Normalize both SSH and HTTPS origins without consulting machine credentials. */
function repository(remote: string): { host: string; repo: string } | null {
  try {
    const url = new URL(remote.includes("://") ? remote : remote.replace(/^(?:[^@]+@)?([^:]+):/, "ssh://$1/"));
    return { host: url.hostname.toLowerCase(), repo: decodeURIComponent(url.pathname).replace(/^\/|\/$/g, "").replace(/\.git$/, "") };
  } catch { return null; }
}
export function checkPrRepository(remote: string, value: string, owner = false): void {
  if (owner || /^[1-9]\d*$/.test(value)) return;
  const origin = repository(remote), target = repository(value.replace(/\/(?:pull\/\d+|-\/merge_requests\/\d+)\/?$/, ""));
  if (!origin || !target || origin.host !== target.host || origin.repo !== target.repo)
    throw new Error("that pull request is not in this project's repository");
}
export async function pullRequestDiff(dir: string, value: string, owner = false) {
  const remote = await git(dir, ["remote", "get-url", "origin"]).catch(() => "");
  const provider = resolveProvider("gitlab");
  const target = prTarget(value, remote.trim(), provider?.baseUrl ? new URL(provider.baseUrl).hostname : undefined);
  checkPrRepository(remote.trim(), value, owner);
  let patch = "";
  if (target.provider === "github") {
    patch = await new Promise<string>((resolve, reject) => execFile("gh", ["pr", "diff", target.url, "--color=never"], { cwd: dir, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (e, out, err) => e ? reject(new Error(String(err || e.message))) : resolve(String(out))));
  } else {
    const provider = resolveProvider("gitlab");
    if (!provider?.key) throw new Error("Configure the existing GitLab provider to review merge requests");
    const base = integrationUrl(provider.baseUrl);
    if (target.host !== base.hostname) throw new Error("MR host must match the configured GitLab host");
    for (let page = 1; page <= 100; page++) {
      const response = await fetch(`${base.href.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(target.repo)}/merge_requests/${target.number}/diffs?per_page=100&page=${page}`, { headers: { "PRIVATE-TOKEN": provider.key }, redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`GitLab diff request failed (${response.status})`);
      const files = await response.json() as { old_path: string; new_path: string; diff: string; collapsed?: boolean; too_large?: boolean }[];
      for (const file of files) {
        if (file.collapsed || file.too_large) throw new Error("GitLab omitted a diff; review it on GitLab before proceeding");
        patch += `diff --git a/${file.old_path} b/${file.new_path}\n--- a/${file.old_path}\n+++ b/${file.new_path}\n${file.diff}\n`;
      }
      if (!response.headers.get("x-next-page")) break;
      if (page === 100) throw new Error("PR exceeds the diff page limit");
    }
  }
  if (!patch.trim()) throw new Error("pull request has no reviewable diff");
  if (patch.length > 2_000_000) throw new Error("PR diff is too large; review smaller changes separately");
  return { target, patch };
}
