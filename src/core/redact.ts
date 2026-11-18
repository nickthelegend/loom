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

