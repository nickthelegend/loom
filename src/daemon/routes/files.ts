import type { Express } from 'express';
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { capture } from "../../core/preview-shot.js";
import { findProject } from "../../core/registry.js";
import { MIME_EXT } from '../system.js';
/** Register files routes in the order established by LoomDaemon.routes(). */
export function registerFilesRoutes(app: Express): void {

  // Explorer: list a directory, read a file, search filenames. All strictly
  // sandboxed to the project directory (no traversal outside it).
  const contains = (base: string, target: string) =>
    target === base || target.startsWith(base + path.sep);

  /**
   * Resolve a project-relative path, or null if it escapes the project.
   * Two checks, because they catch different attacks: the lexical one stops
   * `../` traversal (and works for paths that don't exist yet), and the
   * realpath one stops a symlink *inside* the project from pointing out of
   * it — path.resolve happily resolves through links.
   */
  const projectPath = (id: string, rel: string | undefined): string | null => {
    const info = findProject(id);
    if (!info) return null;
    let base: string;
    try {
      base = fs.realpathSync(path.resolve(info.dir));
    } catch {
      return null;
    }
    const target = path.resolve(base, rel ?? ".");
    if (!contains(base, target)) return null;
    try {
      if (!contains(base, fs.realpathSync(target))) return null;
    } catch {
      // doesn't exist — the lexical check above is the whole answer
    }
    return target;
  };

  const HIDE_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "coverage"]);

  app.get("/api/projects/:id/files", (req, res) => {
    const dir = projectPath(String(req.params.id), req.query.dir ? String(req.query.dir) : ".");
    if (!dir) return void res.status(404).json({ error: "not found" });
    const base = projectPath(String(req.params.id), ".")!;
    fs.readdir(dir, { withFileTypes: true }, (err, ents) => {
      if (err) return void res.status(400).json({ error: err.message });
      const entries = ents
        .filter((e) => e.name !== ".git")
        .map((e) => ({
          name: e.name,
          path: path.relative(base, path.join(dir, e.name)),
          dir: e.isDirectory(),
        }))
        .sort((a, b) =>
          a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
        )
        .slice(0, 500);
      res.json({ dir: path.relative(base, dir), entries });
    });
  });

  app.get("/api/projects/:id/file", (req, res) => {
    const file = projectPath(String(req.params.id), req.query.path ? String(req.query.path) : "");
    if (!file) return void res.status(404).json({ error: "not found" });
    fs.stat(file, (err, st) => {
      if (err) return void res.status(400).json({ error: err.message });
      if (st.isDirectory()) return void res.status(400).json({ error: "is a directory" });
      const MAX = 400_000;
      const truncated = st.size > MAX;
      const stream = fs.createReadStream(file, { start: 0, end: Math.min(st.size, MAX) - 1, encoding: "utf8" });
      let content = "";
      stream.on("data", (c) => (content += c));
      stream.on("error", (e) => res.status(400).json({ error: e.message }));
      stream.on("end", () => {
        const base = projectPath(String(req.params.id), ".")!;
        res.json({ path: path.relative(base, file), content, truncated, size: st.size });
      });
    });
  });

  app.get("/api/projects/:id/find", (req, res) => {
    const base = projectPath(String(req.params.id), ".");
    if (!base) return void res.status(404).json({ error: "not found" });
    const q = String(req.query.q ?? "").trim().toLowerCase();
    // A bare "@": the files touched most recently, which is usually what you mean.
    if (!q) return void res.json({ matches: recentFiles(base, 20), recent: true });
    const matches: string[] = [];
    let visited = 0;
    const walk = (dir: string) => {
      if (matches.length >= 200 || visited >= 20_000) return;
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (matches.length >= 200 || visited >= 20_000) return;
        visited++;
        if (e.isDirectory()) {
          if (HIDE_DIRS.has(e.name)) continue;
          walk(path.join(dir, e.name));
        } else if (e.name.toLowerCase().includes(q)) {
          matches.push(path.relative(base, path.join(dir, e.name)));
        }
      }
    };
    walk(base);
    res.json({ matches });
  });

  /** The project's most recently modified files (bounded walk, hidden dirs skipped). */
  function recentFiles(base: string, n: number): string[] {
    const found: Array<{ p: string; t: number }> = [];
    let visited = 0;
    const walk = (dir: string, depth: number) => {
      if (visited >= 5_000 || depth > 8) return;
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (visited++ >= 5_000) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!HIDE_DIRS.has(e.name) && !e.name.startsWith(".")) walk(full, depth + 1);
        } else if (e.isFile() && !e.name.startsWith(".")) {
          try {
            found.push({ p: path.relative(base, full), t: fs.statSync(full).mtimeMs });
          } catch {}
        }
      }
    };
    walk(base, 0);
    return found.sort((a, b) => b.t - a.t).slice(0, n).map((f) => f.p);
  }

  /**
   * Stash a pasted image or dropped file, and hand back its path.
   *
   * The CLIs Loom drives take text and nothing else — SendInput is { text,
   * briefing }, no image channel. So the only honest way to "attach" an image
   * is to write it somewhere the agent can read and reference the path in the
   * message. Claude Code and Codex both read image files by path; for the
   * others it's at least a real artifact on disk rather than a lie in the UI.
   *
   * Under .loom/attachments/ so it's inside the project (the agent's cwd) but
   * out of the way. Name is derived from a content hash, never from the
   * client's — a caller doesn't get to choose where in the tree this lands.
   */
  /**
   * A picture of what the preview is showing, as an attachment.
   *
   * The frame is someone else's origin, so the page can't photograph it —
   * the daemon does, with the project's own Playwright (core/preview-shot.ts),
   * and the file lands beside pasted images so the composer carries it the
   * same way.
   */
  app.post("/api/projects/:id/preview/screenshot", (req, res) => {
    void (async () => {
      const dir = projectPath(String(req.params.id), ".");
      if (!dir) return void res.status(404).json({ error: "not found" });
      const b = (req.body ?? {}) as { url?: string; width?: number; height?: number; colorScheme?: string; fullPage?: boolean };
      try {
        const shot = await capture(dir, {
          url: String(b.url ?? ""),
          ...(b.width ? { width: Number(b.width) } : {}),
          ...(b.height ? { height: Number(b.height) } : {}),
          colorScheme: b.colorScheme === "dark" ? "dark" : "light",
          fullPage: Boolean(b.fullPage),
        });
        const buf = fs.readFileSync(shot.file);
        fs.rmSync(path.dirname(shot.file), { recursive: true, force: true });
        const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
        const rel = path.join(".loom", "attachments", `preview-${hash}.png`);
        const abs = projectPath(String(req.params.id), rel);
        if (!abs) return void res.status(400).json({ error: "bad attachment path" });
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
        res.json({ path: rel, bytes: buf.length, width: shot.width, height: shot.height, colorScheme: shot.colorScheme, fullPage: shot.fullPage });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  app.post("/api/projects/:id/attachments", (req, res) => {
    const base = projectPath(String(req.params.id), ".");
    if (!base) return void res.status(404).json({ error: "not found" });
    const { name, dataUrl } = (req.body ?? {}) as { name?: string; dataUrl?: string };
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl ?? "");
    if (!m) return void res.status(400).json({ error: "expected a base64 data URL" });
    const mime = m[1] ?? "application/octet-stream";
    const buf = Buffer.from(m[2] ?? "", "base64");
    const MAX = 12 * 1024 * 1024;
    if (buf.length > MAX) return void res.status(413).json({ error: "attachment over 12MB" });

    // Extension from the declared type or the client's name, whichever we
    // trust more — but only ever the extension, never the path.
    const extFromName = typeof name === "string" ? path.extname(name).replace(/[^.\w]/g, "").slice(0, 8) : "";
    const ext = extFromName || "." + (MIME_EXT[mime] ?? "bin");
    const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
    const rel = path.join(".loom", "attachments", hash + ext);
    const abs = projectPath(String(req.params.id), rel);
    if (!abs) return void res.status(400).json({ error: "bad attachment path" });
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
    } catch (err) {
      return void res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
    res.json({ path: rel, bytes: buf.length, mime });
  });

  /** An attached image, back as an image: the thread's thumbnails. Images under .loom/attachments only. */
  const IMG_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  app.get("/api/projects/:id/attachment", (req, res) => {
    const rel = path.normalize(String(req.query.path ?? ""));
    const type = IMG_TYPES[path.extname(rel).toLowerCase()];
    if (!type || !rel.startsWith(path.join(".loom", "attachments") + path.sep)) return void res.status(400).json({ error: "not an attached image" });
    const abs = projectPath(String(req.params.id), rel);
    if (!abs) return void res.status(404).json({ error: "not found" });
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "private, max-age=86400"); // content-addressed: the name is its hash
    fs.createReadStream(abs).on("error", () => res.status(404).end()).pipe(res);
  });
}
