import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { loomHome, projectLoomDir } from "../registry.js";

export class WorkspaceConflict extends Error {}
const name = z.string().trim().min(1).max(80);
const id = z.string().min(1).max(160).regex(/^[\w-]+$/);
export type Layout = { id: string } | { direction: "row" | "column"; children: Layout[] };
const layout: z.ZodType<Layout> = z.lazy(() => z.union([
  z.strictObject({ id }), z.strictObject({ direction: z.enum(["row", "column"]), children: z.array(layout).min(2).max(16) }),
]));
export const workspaceSchema = z.strictObject({
  layout, panes: z.record(id, z.strictObject({ hash: z.string().max(1000).regex(/^(|#home|#p\/[^/]+(\/c\/[^/]+)?)$/, "Choose Home, a project, or a chat for each pane"), title: z.string().max(200).optional() })), focus: id,
}).superRefine((w, ctx) => {
  const ids: string[] = [];
  const walk = (n: Layout, depth: number) => {
    if (depth > 8) { ctx.addIssue({ code: "custom", message: "layout too deep" }); return; }
    if ("id" in n) ids.push(n.id); else n.children.forEach(c => walk(c, depth + 1));
  };
  walk(w.layout, 0);
  if (ids.length > 16 || new Set(ids).size !== ids.length || ids.some(k => !w.panes[k]) || Object.keys(w.panes).length !== ids.length || !ids.includes(w.focus))
    ctx.addIssue({ code: "custom", message: "layout panes and focus must match the tree" });
});
export const sidebarSchema = z.strictObject({
  sections: z.array(z.strictObject({ id, name, collapsed: z.boolean() })).max(100),
  projects: z.array(z.strictObject({ id, pinned: z.boolean(), section: id.nullable() })).max(1000),
}).superRefine((s, ctx) => {
  if (new Set(s.sections.map(x => x.id)).size !== s.sections.length || new Set(s.projects.map(x => x.id)).size !== s.projects.length || s.projects.some(p => p.section && !s.sections.some(g => g.id === p.section)))
    ctx.addIssue({ code: "custom", message: "duplicate ids or unknown section" });
});
export type Sidebar = z.infer<typeof sidebarSchema>;
export type SavedLayout = { name: string; workspace: z.infer<typeof workspaceSchema> };
type Preferences = { revision: number; layouts: SavedLayout[]; sidebar: Sidebar };
function read<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}
function write(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try { fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
const prefsFile = () => path.join(loomHome(), "workspace-r4.json");
export function preferences(): Preferences { return read(prefsFile(), { revision: 0, layouts: [], sidebar: { sections: [], projects: [] } }); }
export function changePreferences(input: unknown): Preferences {
  // Bound nesting before the recursive schema walks a client-supplied split tree.
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > 24) throw new Error("workspace data is too deeply nested");
    if (value && typeof value === "object") for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
  }
  const b = z.strictObject({ revision: z.number().int().nonnegative(), sidebar: sidebarSchema.optional(),
    save: z.strictObject({ name, workspace: workspaceSchema }).optional(), remove: name.optional() }).parse(input);
  const p = preferences();
  if (p.revision !== b.revision) throw new WorkspaceConflict("Workspace changed in another window. Reload and try again.");
  if (b.sidebar) p.sidebar = b.sidebar;
  if (b.remove) p.layouts = p.layouts.filter(l => l.name !== b.remove);
  if (b.save) { p.layouts = p.layouts.filter(l => l.name !== b.save!.name); p.layouts.push(b.save); }
  if (p.layouts.length > 100) throw new Error("at most 100 saved layouts");
  p.revision++; write(prefsFile(), p); return p;
}
const notesFile = (dir: string) => path.join(projectLoomDir(dir), "workspace-r4-notes.json");
export function notes(dir: string): { text: string; revision: string } {
  const text = read(notesFile(dir), { text: "" }).text;
  return { text, revision: createHash("sha256").update(text).digest("hex") };
}
export function saveNotes(dir: string, input: unknown) {
  const b = z.strictObject({ text: z.string().max(500_000), revision: z.string().optional() }).parse(input);
  if (b.revision !== undefined && b.revision !== notes(dir).revision) throw new WorkspaceConflict("Notes changed in another window. Reload before saving.");
  write(notesFile(dir), { text: b.text }); return notes(dir);
}
export function dismissed(dir: string): number[] { return read(path.join(projectLoomDir(dir), "workspace-r4-dismissed.json"), []); }
export function dismiss(dir: string, event: number) {
  write(path.join(projectLoomDir(dir), "workspace-r4-dismissed.json"), [...new Set([...dismissed(dir), event])].slice(-5000));
}
