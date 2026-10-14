/**
 * Artifact previews: an HTML page, SVG, image or PDF an agent made, shown as
 * the thing itself in the dock rather than as source.
 *
 * An <iframe> can't send the app's bearer token, so a preview is reached
 * through a short-lived token: POST /api/projects/:id/preview (authed) mints
 * one for a project directory, and GET /preview/<token>/<path> serves files
 * from that directory — and only that directory — for half an hour. Relative
 * links in the page (its CSS, scripts, images) resolve under the same token.
 *
 * Every response carries `Content-Security-Policy: sandbox …` without
 * allow-same-origin: the page runs in an opaque origin even when opened on its
 * own, so its scripts can't read the app's storage or call the daemon as you.
 * The iframe adds the same sandbox; the header is what holds if it's opened
 * in a tab.
 */

import type { Express, Request, Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { findProject } from "../../core/registry.js";

const TTL_MS = 30 * 60_000;
const tokens = new Map<string, { dir: string; exp: number }>();

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp", ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".wasm": "application/wasm",
};
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** Inside `base` after resolving links, or null. */
function inside(base: string, rel: string): string | null {
  let root: string;
  try { root = fs.realpathSync(base); } catch { return null; }
  const target = path.resolve(root, rel.replace(/^\/+/, ""));
  const ok = (p: string) => p === root || p.startsWith(root + path.sep);
  if (!ok(target)) return null;
  try { if (!ok(fs.realpathSync(target))) return null; } catch { return null; }
  return target;
}

function sweep(): void {
  const now = Date.now();
  for (const [t, v] of tokens) if (v.exp < now) tokens.delete(t);
}

/** Before the auth wall: the token is the credential, scoped to one directory. */
export function registerPreviewPublic(app: Express): void {
  app.get("/preview/:tok/*rest", (req: Request, res: Response) => {
    const entry = tokens.get(String(req.params.tok));
    if (!entry || entry.exp < Date.now()) return void res.status(410).type("text/plain").send("this preview link has expired — open it again from Loom");
    const rest = (req.params as unknown as { rest: string[] | string }).rest;
    const rel = decodeURIComponent(Array.isArray(rest) ? rest.join("/") : String(rest ?? ""));
    let file = inside(entry.dir, rel);
    if (file && fs.statSync(file).isDirectory()) file = inside(entry.dir, path.join(rel, "index.html"));
    if (!file || !fs.statSync(file).isFile()) return void res.status(404).type("text/plain").send("not found");
    res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Security-Policy", SANDBOX);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    fs.createReadStream(file).on("error", () => res.status(500).end()).pipe(res);
  });
}

/** Behind the auth wall: mint a preview link, and serve a project's images to the thread. */
export function registerPreviewRoutes(app: Express): void {
  app.post("/api/projects/:id/preview", (req: Request, res: Response) => {
    const info = findProject(String(req.params.id));
    if (!info) return void res.status(404).json({ error: "not found" });
    const rel = String((req.body as { path?: unknown } | undefined)?.path ?? "").replace(/^\/+/, "");
    const file = inside(info.dir, rel);
    if (!rel || !file || !fs.existsSync(file)) return void res.status(404).json({ error: `no file ${rel || "(none)"} in this project` });
    sweep();
    // the token covers the file's own folder, so a page's relative assets load and nothing above it does
    const dir = fs.statSync(file).isDirectory() ? file : path.dirname(file);
    const tok = crypto.randomBytes(18).toString("base64url");
    tokens.set(tok, { dir, exp: Date.now() + TTL_MS });
    const name = fs.statSync(file).isDirectory() ? "" : path.basename(file);
    res.json({ url: `/preview/${tok}/${encodeURIComponent(name)}`, expiresAt: Date.now() + TTL_MS });
  });

  // An image in the project (a screenshot the agent saved, a chart it drew),
  // for markdown and artifact cards in the thread. Images only.
  app.get("/api/projects/:id/image", (req: Request, res: Response) => {
    const info = findProject(String(req.params.id));
    const rel = String(req.query.path ?? "");
    if (!info || !IMAGE_EXT.test(rel)) return void res.status(400).json({ error: "not an image" });
    const file = path.isAbsolute(rel) ? inside(info.dir, path.relative(info.dir, rel)) : inside(info.dir, rel);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return void res.status(404).json({ error: "not found" });
    res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Security-Policy", SANDBOX);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=60");
    fs.createReadStream(file).on("error", () => res.status(500).end()).pipe(res);
  });
}

/** Tests. */
export function clearPreviewTokens(): void {
  tokens.clear();
}
