/**
 * Just enough markdown for an agent's reply on a phone: paragraphs, headings,
 * lists, fenced code, and — Loom's own — the orchestrator's ```loom plan block,
 * which is JSON meant for the daemon and reads as noise to a person. Pure, so
 * it's testable in plain node; markdown.tsx draws it.
 */

export type Inline =
  | { t: "text"; s: string }
  | { t: "bold"; s: string }
  | { t: "italic"; s: string }
  | { t: "code"; s: string }
  | { t: "link"; s: string; href: string };

export type PlanAction = { type: string; text: string };

export type Block =
  | { t: "p"; inl: Inline[] }
  | { t: "h"; level: number; inl: Inline[] }
  | { t: "li"; ordered: boolean; n: number; depth: number; inl: Inline[] }
  | { t: "code"; lang: string; s: string }
  | { t: "plan"; actions: PlanAction[] }
  | { t: "quote"; inl: Inline[] }
  | { t: "hr" };

/** `**bold**`, `*italic*`, `code` and [links](url), in one left-to-right pass. */
export function inline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ t: "text", s: src.slice(last, m.index) });
    const tok = m[0];
    if (m[1]) out.push({ t: "code", s: tok.slice(1, -1) });
    else if (m[2]) out.push({ t: "bold", s: tok.slice(2, -2) });
    else if (m[3]) {
      // snake_case_words aren't emphasis: an underscore run inside a word stays text
      const before = src[m.index - 1] ?? " ";
      if (tok.startsWith("_") && /\w/.test(before)) out.push({ t: "text", s: tok });
      else out.push({ t: "italic", s: tok.slice(1, -1) });
    } else if (m[4]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      out.push({ t: "link", s: mm[1]!, href: mm[2]! });
    }
    last = m.index + tok.length;
  }
  if (last < src.length) out.push({ t: "text", s: src.slice(last) });
  return out;
}

/** A ```loom block's actions as a person would say them, or null if it isn't one. */
export function planActions(json: string): PlanAction[] | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  const acts = (v as { actions?: unknown })?.actions;
  if (!Array.isArray(acts)) return null;
  // the orchestrator's own verbs (see OrchestraAction in the daemon)
  return acts.map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    const s = (k: string) => (o[k] === undefined ? "" : String(o[k]));
    const type = s("type") || "step";
    if (type === "spawn") return { type, text: `${s("agent") || "an agent"}: ${s("title") || s("prompt")}` };
    if (type === "send") return { type, text: `to ${s("task")}: ${s("message")}` };
    if (type === "cancel") return { type, text: `stop ${s("task")}` };
    if (type === "ask") return { type, text: s("question") };
    if (type === "done") return { type, text: s("summary") };
    return { type, text: s("summary") || s("title") || s("text") };
  });
}

export function parse(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", inl: inline(para.join(" ").trim()) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const close = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(close)) body.push(lines[i++]!);
      const lang = fence[2] ?? "";
      const s = body.join("\n");
      const plan = lang === "loom" ? planActions(s) : null;
      out.push(plan ? { t: "plan", actions: plan } : { t: "code", lang, s });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ t: "h", level: h[1]!.length, inl: inline(h[2]!.replace(/\s#+\s*$/, "")) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ t: "hr" });
      continue;
    }
    const li = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      out.push({
        t: "li",
        ordered: li[3] !== undefined,
        n: li[3] ? Number(li[3]) : 0,
        depth: Math.min(3, Math.floor(li[1]!.replace(/\t/g, "  ").length / 2)),
        inl: inline(li[4]!),
      });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      out.push({ t: "quote", inl: inline(q[1]!) });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out;
}

/** One line of a reply for a preview row: marks dropped, a plan said in words. */
export function plainText(md: string): string {
  return parse(md)
    .map((b) => {
      if (b.t === "plan") return b.actions.map((a) => a.text).join("; ");
      if (b.t === "code") return b.s.split("\n")[0] ?? "";
      if (b.t === "hr") return "";
      return b.inl.map((x) => x.s).join("");
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
