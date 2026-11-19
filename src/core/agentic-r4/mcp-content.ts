import type { DaemonClient } from "../../daemon/client.js";
import { fillTemplate } from "../chat-composer.js";

const enc = encodeURIComponent;
export async function listResources(client: DaemonClient) {
  const { projects } = await client.listProjects();
  const resources = (await Promise.all(projects.map(async p => {
    const base = `loom://projects/${enc(p.id)}`;
    const [{ chats }, { runs }] = await Promise.all([client.chats(p.id), client.orchestraRuns(p.id)]);
    return [
      { uri: `${base}/memories`, name: `${p.name} memories` },
      { uri: `${base}/board`, name: `${p.name} board` },
      ...chats.map(c => ({ uri: `${base}/chats/${enc(c.id)}`, name: `${p.name}: ${c.title}` })),
      ...runs.map(r => ({ uri: `${base}/runs/${enc(r.id)}`, name: `${p.name}: ${r.goal}` })),
    ].map(r => ({ ...r, mimeType: "application/json" }));
  }))).flat();
  return { resources };
}

export async function readResource(client: DaemonClient, uri: unknown) {
  if (typeof uri !== "string") throw new Error("uri is required");
  const match = /^loom:\/\/projects\/([^/?#]+)\/(memories|board|chats\/[^/?#]+|runs\/[^/?#]+)$/.exec(uri);
  if (!match) throw new Error("unknown Loom resource");
  const project = decodeURIComponent(match[1]!);
  const [kind, key] = match[2]!.split("/");
  const value = kind === "memories" ? await client.brain(project, { limit: 1000 })
    : kind === "board" ? await client.board(project)
    : kind === "chats" ? await client.chatMessages(project, decodeURIComponent(key!), 1000)
    : await client.orchestraRun(project, decodeURIComponent(key!));
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] };
}

export async function listPrompts(client: DaemonClient) {
  const { templates } = await client.templates();
  return { prompts: templates.map(t => ({ name: t.title, description: t.title,
    arguments: t.variables.map(name => ({ name, required: true })) })) };
}
export async function getPrompt(client: DaemonClient, name: unknown, args: unknown) {
  if (typeof name !== "string") throw new Error("name is required");
  if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args) || Object.values(args).some(v => typeof v !== "string")))
    throw new Error("arguments must be strings");
  const { templates } = await client.templates();
  const template = templates.find(t => t.title === name || t.id === name);
  if (!template) throw new Error("unknown prompt");
  const values = (args ?? {}) as Record<string, string>;
  if (Object.keys(values).some(k => !template.variables.includes(k))) throw new Error("unknown prompt argument");
  return { description: template.title, messages: [{ role: "user", content: { type: "text", text: fillTemplate(template.text, values) } }] };
}
