/**
 * A small, honest syntax colouring for the phone's file view (#380): comments, strings, numbers and
 * keywords for the languages a project mostly holds. Not a parser — it never hides text, it only
 * colours spans of it, and anything it doesn't recognise stays plain.
 */

export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword";
export interface Token { kind: TokenKind; text: string }

const KEYWORDS = new Set((
  "abstract as async await break case catch class const continue def default del do elif else enum export extends false final finally fn for from func function go if impl import in interface is let match mod module new nil none null package private protected pub public raise return self static struct super switch this throw true try type typeof undefined use var void while with yield"
).split(" "));

function commentStyle(ext: string): { line: string[]; block?: [string, string] } {
  if (["py", "rb", "sh", "bash", "zsh", "yml", "yaml", "toml", "r", "pl"].includes(ext)) return { line: ["#"] };
  if (["sql", "lua", "hs"].includes(ext)) return { line: ["--"] };
  if (["html", "xml", "svg", "vue", "md"].includes(ext)) return { line: [], block: ["<!--", "-->"] };
  if (["json"].includes(ext)) return { line: [] };
  return { line: ["//"], block: ["/*", "*/"] };
}

/** Tokenise one file. `state` carries an open block comment across lines when called per line. */
export function tokenizeLine(line: string, ext: string, inBlock = false): { tokens: Token[]; inBlock: boolean } {
  const { line: lineComments, block } = commentStyle(ext.toLowerCase());
  const tokens: Token[] = [];
  const push = (kind: TokenKind, text: string) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ kind, text });
  };
  let i = 0;
  if (inBlock && block) {
    const end = line.indexOf(block[1]);
    if (end < 0) return { tokens: [{ kind: "comment", text: line }], inBlock: true };
    push("comment", line.slice(0, end + block[1].length));
    i = end + block[1].length;
    inBlock = false;
  }
  while (i < line.length) {
    const rest = line.slice(i);
    if (block && rest.startsWith(block[0])) {
      const end = line.indexOf(block[1], i + block[0].length);
      if (end < 0) { push("comment", rest); return { tokens, inBlock: true }; }
      push("comment", line.slice(i, end + block[1].length));
      i = end + block[1].length;
      continue;
    }
    if (lineComments.some((c) => rest.startsWith(c))) { push("comment", rest); break; }
    const ch = line[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      push("string", line.slice(i, Math.min(j + 1, line.length)));
      i = j + 1;
      continue;
    }
    const num = /^\d[\d_]*(\.\d+)?/.exec(rest);
    if (num && !/[A-Za-z_$]/.test(line[i - 1] ?? "")) { push("number", num[0]); i += num[0].length; continue; }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) { push(KEYWORDS.has(word[0]) ? "keyword" : "plain", word[0]); i += word[0].length; continue; }
    push("plain", ch);
    i += 1;
  }
  return { tokens, inBlock };
}
