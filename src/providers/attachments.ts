/**
 * Pictures attached to a prompt, for harnesses that can take them natively.
 *
 * Every client (desktop composer, phone) sends an attachment as a line
 * "[image] .loom/attachments/<hash>.<ext>" in the prompt text. A harness that
 * only sees that line has to decide to open the file itself — Claude often
 * doesn't, and an agent without a file tool can't. So each adapter also hands
 * the image over the way its harness takes one (Claude: a base64 image block;
 * Codex: a localImage input). The line stays in the text: it names the file.
 *
 * Only Loom's own attachments folder, inside the session's folder, and only
 * real images under 10MB — a prompt can't use this to read anything else.
 */

import fs from "node:fs";
import path from "node:path";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX = 10 * 1024 * 1024;

export interface AttachedImage {
  /** As written in the prompt: .loom/attachments/<hash>.<ext> */
  rel: string;
  abs: string;
  mime: string;
}

export function attachedImages(text: string, cwd: string | undefined): AttachedImage[] {
  if (!cwd) return [];
  let root: string;
  try { root = fs.realpathSync(path.join(cwd, ".loom", "attachments")); } catch { return []; }
  const out: AttachedImage[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/^\[image\] (\.loom\/attachments\/[\w.-]+)\s*$/gm)) {
    const rel = m[1]!;
    const mime = MIME[path.extname(rel).toLowerCase()];
    if (!mime || seen.has(rel)) continue;
    try {
      const abs = fs.realpathSync(path.join(cwd, rel));
      if (path.dirname(abs) !== root) continue;
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX) continue;
      seen.add(rel);
      out.push({ rel, abs, mime });
    } catch {
      /* gone, or never there — the text line still names it */
    }
  }
  return out;
}
