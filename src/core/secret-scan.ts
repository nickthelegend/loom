/**
 * Secrets in a diff, before it's applied or pushed (#340). The same patterns review triage
 * scores a change by: a key or token pasted into code, a hard-coded credential, or a file
 * that is itself a secret (.env, a private key). Pure: reads a unified diff, returns findings.
 */

/** Text that looks like a secret, and how to say it. */
export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(sk|rk|pk)_(live|test)_[0-9a-zA-Z]{16,}|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[baprs]-[A-Za-z0-9-]{10,}/, "what looks like a secret key"],
  [/\b(password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["'][^"'\s]{6,}["']/i, "a hard-coded credential"],
];

/** Files that are secrets by name, whatever they hold. */
const SECRET_FILE = /(^|\/)(\.env(\.[\w-]+)?|id_(rsa|ed25519|ecdsa)|[^/]+\.(pem|p12|pfx|key))$/i;
/** …except the ones meant to be committed. */
const SAFE_FILE = /(^|\/)\.env\.(example|sample|template|defaults)$/i;

export interface SecretFinding {
  file: string;
  /** Line in the new file, when it's an added line. */
  line?: number;
  what: string;
}

export function findSecrets(diff: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "").trim();
      if (file !== "/dev/null" && SECRET_FILE.test(file) && !SAFE_FILE.test(file)) out.push({ file, what: "a file that holds secrets by its name" });
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      for (const [re, what] of SECRET_PATTERNS) if (re.test(raw.slice(1))) out.push({ file, line, what });
      line++;
    } else if (!raw.startsWith("-")) line++;
  }
  return out;
}
