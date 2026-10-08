/**
 * The chat's markdown renderer (src/web/format.js), on the shapes agents
 * actually print: code inside list steps, nested quotes, alerts, aligned
 * tables, snake_case that isn't italic, stars inside code that aren't bold.
 */

import { beforeAll, describe, expect, it } from "vitest";

let md: (s: string) => string;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const el = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : el()), apply: () => el() });
  g.document ??= el();
  g.window ??= el();
  g.location ??= { hash: "", pathname: "/", search: "" };
  md = ((await import("../src/web/format.js")) as { mdToHtml: (s: string) => string }).mdToHtml;
});

const strip = (h: string) => h.replace(/<button[\s\S]*?<\/button>/g, "").replace(/<span class="mdlang">\w+<\/span>/g, "");

describe("markdown for agent output", () => {
  it("keeps a code block inside the list step it belongs to", () => {
    const h = strip(md("1. Install:\n   ```bash\n   npm i\n   ```\n2. Run it"));
    expect(h).toMatch(/^<ol class="mdlist"><li>Install:<div class="mdcodewrap"><pre class="mdcode"><code>npm i<\/code><\/pre><\/div><\/li><li>Run it<\/li><\/ol>$/);
  });

  it("nests lists by indentation, keeps the start number, and draws task boxes", () => {
    expect(md("- a\n  - b\n- c")).toBe('<ul class="mdlist"><li>a<ul class="mdlist"><li>b</li></ul></li><li>c</li></ul>');
    expect(md("3. three\n4. four")).toContain('start="3"');
    expect(md("- [x] done\n- [ ] todo")).toContain('<input type="checkbox" class="mdcheck" disabled checked> done');
  });

  it("renders quotes as documents (nested, with lists) and GitHub alerts", () => {
    expect(md("> one **b**\n> - x\n>\n> > deeper")).toBe(
      '<blockquote class="mdq"><div class="mdp">one <strong>b</strong></div><ul class="mdlist"><li>x</li></ul><blockquote class="mdq"><div class="mdp">deeper</div></blockquote></blockquote>');
    expect(md("> [!WARNING]\n> careful")).toContain('<div class="mdalert warning"><div class="mdalerth">Warning</div>');
  });

  it("aligns table columns and keeps a pipe inside code in its cell", () => {
    const h = md("| a | b |\n|:--|--:|\n| `x|y` | 2 |");
    expect(h).toContain('<th style="text-align:right">b</th>');
    expect(h).toContain('<td style="text-align:left"><code class="mdi">x|y</code></td>');
  });

  it("leaves code spans, URLs and snake_case alone; honours escapes and both emphasis styles", () => {
    expect(md("`a**b**` and \\*literal\\*")).toBe('<div class="mdp"><code class="mdi">a**b**</code> and *literal*</div>');
    expect(md("snake_case_name, _it_, __b__, ***both***")).toBe(
      '<div class="mdp">snake_case_name, <em>it</em>, <strong>b</strong>, <strong><em>both</em></strong></div>');
    expect(md("see https://x.dev/a_b_c.")).toContain('href="https://x.dev/a_b_c"');
  });

  it("fences with tildes, headings with closing hashes, rules, images as links, nothing as markup", () => {
    expect(strip(md("~~~\nraw\n~~~"))).toContain("<code>raw</code>");
    expect(md("## Title ##")).toBe('<div class="mdh mdh2">Title</div>');
    expect(md("***")).toBe('<hr class="mdhr">');
    expect(md("![logo](https://x.dev/a.png)")).toContain('<a href="https://x.dev/a.png"');
    expect(md("<img src=x onerror=alert(1)>")).toBe('<div class="mdp">&lt;img src=x onerror=alert(1)&gt;</div>');
    expect(md("[x](javascript:alert(1))")).not.toContain("href=\"javascript");
  });
});
