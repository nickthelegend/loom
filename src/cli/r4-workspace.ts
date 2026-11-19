import fs from "node:fs";
import type { Command } from "commander";
import { ensureDaemon } from "../daemon/client.js";
import { resolveCurrentProject } from "./common.js";

export function registerWorkspaceCommands(program: Command): void {
  program.command('inbox').description('Needs-you inbox across projects').option('--json', 'print JSON').action(async (opts: { json?: boolean }) => {
    const result = await (await ensureDaemon()).workspace.inbox();
    if (opts.json) console.log(JSON.stringify(result));
    else console.log(result.items.length ? result.items.map(i => `${i.kind}\t${i.projectName}/${i.chat}\t${i.title}`).join('\n') : 'Nothing needs you.');
  });
  program.command('mission').description('Every running chat across projects').option('--json', 'print JSON').action(async (opts: { json?: boolean }) => {
    const result = await (await ensureDaemon()).workspace.mission();
    if (opts.json) console.log(JSON.stringify(result));
    else console.log(result.chats.length ? result.chats.map(c => `${c.projectName}/${c.title}\t${Math.floor(c.elapsedMs / 1000)}s\t${c.costUsd == null ? 'cost unknown' : '$' + c.costUsd.toFixed(4)}\t${c.lastLine}`).join('\n') : 'No chats running.');
  });
  program.command('notes').description('Read or replace project Markdown notes').option('-p, --project <id>', 'project id or name').option('--set <text>', 'replace the notes').option('--file <path>', 'read notes from a file; - for stdin').option('--json', 'print JSON').action(async (opts: { project?: string; set?: string; file?: string; json?: boolean }) => {
    if (opts.set !== undefined && opts.file !== undefined) throw new Error('Use either --set or --file');
    const client = await ensureDaemon();
    const project = opts.project ? (await client.project(opts.project)).project : await resolveCurrentProject(client);
    const current = await client.workspace.notes(project.id);
    const text = opts.file !== undefined ? fs.readFileSync(opts.file === '-' ? 0 : opts.file, 'utf8') : opts.set;
    const result = text === undefined ? current : await client.workspace.saveNotes(project.id, text, current.revision);
    if (opts.json) console.log(JSON.stringify(result)); else process.stdout.write(result.text + (result.text.endsWith('\n') ? '' : '\n'));
  });
  program.command('chat-files').description('List files produced or received in a chat').option('-p, --project <id>', 'project id or name').option('--chat <id>', 'chat id', 'main').option('--json', 'print JSON').action(async (opts: { project?: string; chat: string; json?: boolean }) => {
    const client = await ensureDaemon(), project = opts.project ? (await client.project(opts.project)).project : await resolveCurrentProject(client);
    const result = await client.workspace.files(project.id, opts.chat);
    console.log(opts.json ? JSON.stringify(result) : result.files.map(f => `${f.path}\t${f.direction}\tmessage ${f.eventId}`).join('\n'));
  });
}
