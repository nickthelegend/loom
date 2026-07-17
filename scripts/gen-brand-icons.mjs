/**
 * Regenerate src/daemon/brand-icons.ts from @lobehub/icons (MIT).
 *
 * Dev-time only — none of this ships. The web app has no build step and no CDN,
 * so it can't import React components; the marks are rendered once here and
 * frozen into an SVG sprite the page inlines.
 *
 * Run it (the deps are not in package.json on purpose — react-dom has no place
 * in a CLI's dependency tree for five glyphs):
 *
 *   npm i --no-save @lobehub/icons react react-dom esbuild
 *   npx esbuild scripts/gen-brand-icons.mjs --bundle --platform=node \
 *     --outfile=/tmp/gen-brand.cjs --format=cjs && node /tmp/gen-brand.cjs
 *
 * The esbuild step is not optional: @lobehub/icons ships bundler-targeted ESM
 * (extensionless relative imports, directory imports) that plain node won't
 * resolve. Import the leaf components, never the package barrel — that drags in
 * @lobehub/ui and antd for what is ultimately a handful of paths.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ClaudeCodeColor from "@lobehub/icons/es/ClaudeCode/components/Color.js";
import AntigravityColor from "@lobehub/icons/es/Antigravity/components/Color.js";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono.js";
import KiroColor from "@lobehub/icons/es/Kiro/components/Color.js";
import CodexColor from "@lobehub/icons/es/Codex/components/Color.js";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono.js";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.cwd(), "src/daemon/brand-icons.ts");

// The variants the ADEs are known by, matching upstream's own examples:
//   Codex → <Codex.Color> — the colour swirl, and the one that was rendering as
//     a blank white badge until the gradient fix below.
//   opencode / Grok → the mono mark IS the mark (neither ships a Color variant),
//     so <OpenCode size=…/> and <Grok size=…/> render Mono by default.
//   claude-code / Antigravity / Kiro → their Color marks. (Antigravity's Avatar
//     variant is a runtime CSS-in-JS badge that renders identically to Color
//     under renderToStaticMarkup — the badge styling doesn't survive SSR — so
//     the Color mark is what we can actually freeze.)
const brands = [
  ["claude-code", ClaudeCodeColor, "Claude Code"],
  ["antigravity", AntigravityColor, "Antigravity"],
  ["opencode", OpenCodeMono, "opencode"],
  ["kiro", KiroColor, "Kiro"],
  ["codex", CodexColor, "Codex"],
  ["grok-code", GrokMono, "Grok Code"],
];

/**
 * Rewrite userSpaceOnUse gradients to objectBoundingBox.
 *
 * A gradient with gradientUnits="userSpaceOnUse" resolves its coordinates in the
 * user space of wherever it's *painted*. In a sprite that's the wrong space: the
 * paint server lives in a hidden <svg>, the painted <use> instance lives in a
 * chip's <svg>, and the coordinates map to nothing — so the fill comes out
 * transparent and you see the badge background through it. That's exactly why
 * Codex rendered as a blank white square while Antigravity (whose gradients are
 * already objectBoundingBox) was fine.
 *
 * objectBoundingBox coordinates are 0..1 relative to the painted element's own
 * box, so they're portable across the <use> boundary. We only have the direction
 * to preserve, not the exact stops' positions, which is all a linear gradient's
 * look needs: map the vector to span the full box in the same direction.
 */
function portableGradients(svg) {
  return svg.replace(/<linearGradient\b[^>]*>/g, (tag) => {
    if (!/gradientUnits="userSpaceOnUse"/.test(tag)) return tag;
    const num = (name) => {
      const m = tag.match(new RegExp(name + '="([-\\d.]+)"'));
      return m ? parseFloat(m[1]) : 0;
    };
    const dx = num("x2") - num("x1");
    const dy = num("y2") - num("y1");
    const x1 = dx === 0 ? "0.5" : dx > 0 ? "0" : "1";
    const x2 = dx === 0 ? "0.5" : dx > 0 ? "1" : "0";
    const y1 = dy === 0 ? "0.5" : dy > 0 ? "0" : "1";
    const y2 = dy === 0 ? "0.5" : dy > 0 ? "1" : "0";
    return tag
      .replace(/\sgradientUnits="userSpaceOnUse"/, "")
      .replace(/\sx1="[-\d.]+"/, ` x1="${x1}"`)
      .replace(/\sx2="[-\d.]+"/, ` x2="${x2}"`)
      .replace(/\sy1="[-\d.]+"/, ` y1="${y1}"`)
      .replace(/\sy2="[-\d.]+"/, ` y2="${y2}"`);
  });
}

let symbols = "";
const titles = {};

for (const [kind, Comp, title] of brands) {
  const C = Comp?.default ?? Comp;
  let svg = renderToStaticMarkup(createElement(C, { size: 24 }));

  // Avatar variants wrap their <svg> in a <div>/<span> flex box. The sprite
  // needs the bare <svg>, so peel the outer element down to the first svg.
  if (!svg.startsWith("<svg")) {
    const m = svg.match(/<svg[\s\S]*<\/svg>/);
    if (m) svg = m[0];
  }

  // React names internal ids with useId (`_R_0_`), which is not a name to
  // freeze. Rewrite to deterministic, loom-namespaced ids so the output is
  // reproducible and can't collide with anything on the page.
  const ids = [...new Set([...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))];
  ids.forEach((id, i) => {
    const safe = `loom-${kind}-${i}`;
    svg = svg.split(`id="${id}"`).join(`id="${safe}"`);
    svg = svg.split(`url(#${id})`).join(`url(#${safe})`);
  });

  // Make gradients survive the sprite's <use> boundary (see portableGradients).
  svg = portableGradients(svg);

  const viewBox = (svg.match(/viewBox="([^"]+)"/) ?? [])[1] ?? "0 0 24 24";
  let inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  inner = inner.replace(/<title>[^<]*<\/title>/, ""); // the title belongs on the instance

  symbols += `  <symbol id="brand-${kind}" viewBox="${viewBox}">${inner}</symbol>\n`;
  titles[kind] = title;
  process.stderr.write(`${kind}: ids=${ids.length} bytes=${inner.length}\n`);
}

const file = `/**
 * ADE brand marks — Claude Code, Antigravity, opencode, Kiro, Codex.
 *
 * GENERATED by scripts/gen-brand-icons.mjs from @lobehub/icons (MIT,
 * github.com/lobehub/lobe-icons). Don't hand-edit; regenerate. The marks are
 * frozen here because the web app has no build step and no CDN — it can't
 * import React components and must work offline on a tailnet. Each logo is the
 * trademark of its owner, used only to identify that agent.
 *
 * It's a sprite, not inline strings: Antigravity and Codex carry internal ids
 * (masks, blur filters, a gradient), so repeating that markup per agent row
 * would duplicate those ids across the document and \`url(#id)\` would resolve
 * to whichever copy came first. <symbol> defines the art once; <use> draws it.
 */

/** Agent kinds that have a real mark. Anything else falls back to a monogram. */
export const BRAND_KINDS = ${JSON.stringify(Object.keys(titles))} as const;

/** Human-readable name per kind, for tooltips and accessible names. */
export const BRAND_TITLES: Record<string, string> = ${JSON.stringify(titles, null, 2)};

/**
 * Injected once per page; every mark is drawn with <use href="#brand-<kind>">.
 *
 * Hidden with position:absolute;width:0;height:0 — NOT display:none. A gradient
 * or filter is a paint server, and a paint server inside a display:none subtree
 * is inert: the browser never lays it out, so any <use> that references it (in
 * another SVG) paints nothing and you get a blank badge. That's exactly what
 * turned Codex's colour swirl into a white square. width:0/height:0 keeps the
 * sprite invisible and out of flow while leaving its paint servers live.
 */
export const BRAND_SPRITE = \`<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
${symbols}</svg>\`;
`;

fs.writeFileSync(OUT, file);
process.stderr.write(`\nwrote ${OUT} (${file.length} bytes)\n`);
