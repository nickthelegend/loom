import os from "node:os";
import { stripVTControlCharacters } from "node:util";

export function redactTriage(text: string, opts: { home?: string; secrets?: string[] } = {}): string {
  let clean = stripVTControlCharacters(text);
  for (const secret of opts.secrets ?? []) if (secret.length >= 4) {
    for (const spelling of [secret, JSON.stringify(secret).slice(1, -1)]) clean = clean.split(spelling).join("[REDACTED]");
  }
  const home = opts.home ?? os.homedir();
  for (const spelling of [home, home.replaceAll("\\", "\\\\")]) if (spelling.length > 1) clean = clean.split(spelling).join("~");
  return clean
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, "$1 [REDACTED]")
    .replace(/(["']?[\w.-]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|cookie)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi, "$1[REDACTED]")
    .replace(/(--(?:[\w-]*(?:token|key|secret|password))\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w_]+|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+|[a-f0-9]{48,})\b/gi, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/\/(?:Users|home)\/[^/\s"'\\]+/g, "~")
    .replace(/[A-Z]:\\+(?:Users|Documents and Settings)\\+[^\\\r\n"']+/gi, "~");
}

/** Remove credentials without removing the surrounding diagnostic context. */
export function redactText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:AKIA[0-9A-Z]{16}|(?:sk|rk|pk)_(?:live|test)_[0-9a-zA-Z]{16,}|sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED]")
    .replace(/(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\b["']?\s*[:=]\s*)(["'])([^\r\n]*?)\2/gi, "$1$2[REDACTED]$2")
    .replace(/(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\b["']?\s*[:=]\s*["'])[^"'\r\n]*$/gi, "$1[REDACTED]")
    .replace(/(\b(?:authorization\s*[:=]\s*)?Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\b\s*[:=]\s*)(?!["'\[])([^\s,;}]{6,})/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[REDACTED]@");
}
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map(redactValue) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
    /^(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization)$/i.test(key) && typeof v === "string" ? "[REDACTED]" : redactValue(v)])) as T;
  return value;
}

/** Stream ordinary prose immediately; hold credential prefixes until their line is complete. */
export class RedactedStream {
  private pending = "";
  private privateKey = false;
  private overflow = false;
  private readonly markers = ["akia", "sk-", "rk_live_", "rk_test_", "pk_live_", "pk_test_", "sk_live_", "sk_test_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-", "password", "passwd", "secret", "api_key", "api-key", "apikey", "token", "access_token", "access-token", "refresh_token", "refresh-token", "bearer", "http://", "https://", "-----begin", "eyj"];

  push(chunk: string): string {
    this.pending += chunk;
    let out = "";
    while (this.pending) {
      if (!this.privateKey && !this.overflow) {
        const lower = this.pending.toLowerCase();
        let first = -1;
        for (let i = 0; i < lower.length; i++) {
          if (i > 0 && /[a-z0-9_]/.test(lower[i - 1]!)) continue;
          const tail = lower.slice(i);
          if (this.markers.some(marker => tail.startsWith(marker) || marker.startsWith(tail))) { first = i; break; }
        }
        if (first < 0) { out += this.pending; this.pending = ""; break; }
        out += this.pending.slice(0, first); this.pending = this.pending.slice(first);
      }
      const end = this.pending.indexOf("\n");
      if (end < 0) break;
      const line = this.pending.slice(0, end + 1); this.pending = this.pending.slice(end + 1);
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) this.privateKey = true;
      if (this.privateKey) {
        if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) { this.privateKey = false; out += "[REDACTED PRIVATE KEY]\n"; }
      } else if (this.overflow) { out += "[REDACTED LONG LINE]\n"; this.overflow = false; }
      else out += redactText(line);
    }
    if (this.pending.length > 64_000) { this.pending = ""; this.overflow = true; }
    return out;
  }

  finish(): string {
    const out = this.privateKey || this.overflow ? "[REDACTED]" : redactText(this.pending);
    this.pending = ""; this.privateKey = false; this.overflow = false;
    return out;
  }
}
