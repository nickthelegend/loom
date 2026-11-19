import type { Command } from "commander";
import fs from "node:fs";
import { createInterface } from "node:readline/promises";
import type { DaemonClient } from "../daemon/client.js";
import { readDaemonConfig } from "../core/registry.js";
import { INTERVIEW } from "../core/brain-r4/knowledge.js";

type Connect = () => Promise<DaemonClient>;
type Project = (client: DaemonClient) => Promise<{ id: string }>;

export function registerR4Brain(program: Command, connect: Connect, project: Project): void {
  const request = async <T = unknown>(route: string, method = "GET", body?: unknown): Promise<T> => {
    const client = await connect(), current = await project(client);
    const response = await fetch(`${client.baseUrl}/api/projects/${encodeURIComponent(current.id)}/brain${route}`, {
      method, headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Brain request failed (${response.status})`);
    return result;
  };
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  program.command('brain:ask <question>').description('answer from cited project memories; offline by default')
    .option('--helper', 'opt in to the configured helper model').option('--chat <id>', 'include this chat').option('--tag <tag>', 'filter by tag')
    .action(async (question: string, opts) => print(await request('/ask', 'POST', { question, ...opts })));
  program.command('brain:tag <id> <tags...>').description('add tags to a memory')
    .action(async (id: string, tags: string[]) => print(await request(`/${encodeURIComponent(id)}/tags`, 'POST', { tags })));
  program.command('brain:inbox [action] [id]').description('list, approve, edit or reject project brain proposals')
    .option('--text <text>', 'edited wording (edit leaves the proposal pending)')
    .option('--review <on|off>', 'review extracted memories before saving')
    .action(async (action: string | undefined, id: string | undefined, opts) => {
      if (opts.review) {
        if (!['on', 'off'].includes(opts.review)) throw new Error('--review must be on or off');
        print(await request('/settings', 'PATCH', { reviewBeforeSaving: opts.review === 'on' })); return;
      }
      if (!action || action === 'list') { print(await request('/inbox')); return; }
      if (!id || !['approve', 'edit', 'reject'].includes(action)) throw new Error('use brain:inbox approve|edit|reject <id>');
      let text = opts.text;
      if (action === 'edit' && !text) {
        if (!process.stdin.isTTY) throw new Error('brain:inbox edit needs --text when not interactive');
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try { text = await input.question('Corrected memory: '); } finally { input.close(); }
      }
      print(await request(`/inbox/${encodeURIComponent(id)}`, 'POST', { action, ...(text ? { text } : {}) }));
    });
  const packs = program.command('brain:pack').description('save, install and remove portable memory packs');
  packs.command('save <name>').option('--tag <tag>', 'only memories with this tag').option('--file <file>', 'also write the pack to a new file')
    .action(async (name: string, opts) => {
      const doc = await request('/packs', 'POST', { name, ...(opts.tag ? { tag: opts.tag } : {}) });
      if (opts.file) fs.writeFileSync(opts.file, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
      print(doc);
    });
  packs.command('install <fileOrUrl>').action(async (file: string) => print(await request('/packs/install', 'POST', /^https?:\/\//i.test(file) ? { url: file } : { pack: JSON.parse(fs.readFileSync(file, 'utf8')) })));
  packs.command('list').action(async () => print(await request('/packs')));
  packs.command('rm <name>').action(async (name: string) => print(await request(`/packs/${encodeURIComponent(name)}`, 'DELETE')));
  program.command('brain:stats').description('usage counts, last used times, and review feedback').action(async () => print(await request('/stats')));
  program.command('brain:feedback <id> <helpfulOrWrong>').requiredOption('--injection <eventId>', 'event id from brain:why')
    .action(async (id: string, value: string, opts) => print(await request(`/${encodeURIComponent(id)}/feedback`, 'POST', { value, injection: Number(opts.injection) })));
  program.command('brain:sources <action> [pattern]').description('add, list, rm or refresh repository document globs')
    .action(async (action: string, pattern?: string) => {
      if (action === 'list') { print(await request('/sources')); return; }
      if (!pattern || !['add', 'rm', 'refresh'].includes(action)) throw new Error('use brain:sources add|rm|refresh "docs/**/*.md" or brain:sources list');
      print(await request('/sources', 'POST', { action, pattern }));
    });
  program.command('brain:diff').description('show what the brain learned or changed').option('--since <durationOrDate>', 'ISO date or duration', '7d')
    .action(async opts => print(await request('/changes?since=' + encodeURIComponent(opts.since))));
  program.command('brain:teach').description('interview: test command, conventions and areas to leave alone')
    .option('--tests <answer>').option('--conventions <answer>').option('--avoid <answer>').option('--chat <id>')
    .action(async opts => {
      const answers: Record<string, string> = { ...opts };
      if (!INTERVIEW.some(q => answers[q.key])) {
        if (!process.stdin.isTTY) throw new Error('provide --tests, --conventions or --avoid when not interactive');
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try { for (const q of INTERVIEW) { const answer = (await input.question(q.question + ' ')).trim(); if (answer) answers[q.key] = answer; } }
        finally { input.close(); }
      }
      print(await request('/teach', 'POST', answers));
    });

  // Original actions forward these options through DaemonClient.
  for (const command of program.commands) {
    if (['brain:search', 'brain:list', 'brain:export'].includes(command.name())) command.option('--tag <tag>', 'filter memories by tag');
    if (command.name() === 'brain:add') command.option('--paths <globs>', 'comma-separated project path globs');
    if (command.name() === 'brain:list') {
      command.option('--sort <order>', 'usage or newest');
      command.hook('preAction', (_this, action) => {
        if (action.opts().sort && !['usage', 'newest'].includes(action.opts().sort)) throw new Error('--sort must be usage or newest');
      });
    }
  }
}
