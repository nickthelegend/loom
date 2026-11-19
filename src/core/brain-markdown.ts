import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { editorPath } from "./editors.js";
import { MEMORY_KINDS, type BrainExport, type MemoryKind } from "./brain.js";

export const MAX_MARKDOWN_BYTES = 1_000_000;

export function brainMarkdown(doc: BrainExport): string {
  return `# ${doc.project.replace(/[\r\n]/g, " ")} — Loom brain\n\n` + doc.memories.map(m =>
    `<!-- loom-memory ${JSON.stringify(m).replace(/--/g, "\\u002d\\u002d")} -->\n## ${m.kind}\n\n${m.text.replace(/<!-- loom-memory /g, "&lt;!-- loom-memory ")}\n`).join("\n");
}

/** Plain Markdown paragraphs and list items are useful memories without a Loom export header. */
export function parseBrainMarkdown(markdown: string): BrainExport {
  if (typeof markdown !== "string" || Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) throw new Error("Markdown must be at most 1 MB");
  const memories: BrainExport["memories"] = [];
  if (markdown.includes("<!-- loom-memory ")) {
    for (const block of markdown.split("<!-- loom-memory ").slice(1)) {
      const end = block.indexOf(" -->");
      if (end < 0) throw new Error("invalid memory metadata");
      const meta = JSON.parse(block.slice(0, end)) as BrainExport["memories"][number];
      const text = typeof meta.text === "string" ? meta.text : block.slice(end + 4).replace(/^\s*## [^\n]+\n/, "").trim();
      memories.push({ ...meta, text });
    }
  } else {
    let kind: MemoryKind = "fact";
    for (const block of markdown.replace(/^(#{1,6} [^\n]*)\n/gm, "$1\n\n").split(/\n\s*\n|\n(?=\s*[-*+] )/)) {
      const text = block.trim();
      if (!text) continue;
      if (/^#{1,6} /.test(text)) {
        const heading = text.replace(/^#+\s*/, "").toLowerCase().replace(/s$/, "");
        if (MEMORY_KINDS.includes(heading as MemoryKind)) kind = heading as MemoryKind;
        continue;
      }
      memories.push({ kind, text: text.replace(/^[-*+]\s+/, "") });
    }
  }
  if (!memories.length || memories.length > 2000) throw new Error("Markdown must contain 1–2000 memories");
  return { format: "loom-brain", version: 1, project: "import", exportedAt: Date.now(), memories };
}

export function writeBrainMarkdown(dir: string, file: string, doc: BrainExport): string {
  if (!file.endsWith(".md")) throw new Error("choose a .md file inside the project");
  const target = editorPath(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, brainMarkdown(doc), { flag: "wx" });
  return file;
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a! > 0 && a! < 224 && a !== 10 && a !== 127 && !(a === 169 && b === 254) &&
      !(a === 192 && [0, 168].includes(b!)) && !(a === 172 && b! >= 16 && b! <= 31) &&
      !(a === 100 && b! >= 64 && b! <= 127) && !(a === 198 && [18, 19].includes(b!));
  }
  return isIP(address) === 6 && /^[23]/i.test(address);
}

/** Pin the checked address for the connection, including every redirect. */
export async function readMarkdownUrl(input: string, redirects = 0): Promise<string> {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || redirects > 3) throw new Error("expected a public HTTP(S) Markdown URL");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error("URL must resolve to a public address");
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(url, {
      signal: AbortSignal.timeout(10_000),
      lookup: (_host, opts, cb) => {
        if (opts.all) cb(null, [address]);
        else cb(null, address.address, address.family);
      },
      headers: { accept: "text/markdown, text/plain" },
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume();
        readMarkdownUrl(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200 || /text\/html/i.test(response.headers["content-type"] ?? "")) {
        response.resume(); reject(new Error("URL did not return Markdown or plain text")); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_MARKDOWN_BYTES) { request.destroy(new Error("Markdown must be at most 1 MB")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", reject);
  });
}
