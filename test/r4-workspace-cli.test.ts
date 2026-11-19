import { execFile } from 'node:child_process';
import path from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { LoomDaemon } from '../src/daemon/server.js';
import { DaemonClient } from '../src/daemon/client.js';
import { readDaemonConfig } from '../src/core/registry.js';
import { tmpDir, makeProjectDir } from './helpers.js';
let daemon: LoomDaemon, dir: string;
const root = process.cwd();
function cli(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'src/cli/index.ts'), ...args], { cwd: dir, env: { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1' }, timeout: 60000 }, (err, out, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(out)));
}
beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir('r4-cli'); process.env.LOOM_NO_NOTIFY = '1';
  daemon = new LoomDaemon({ host: '127.0.0.1', port: 0 }); await daemon.listen();
  dir = makeProjectDir({ name: 'cli notes' }); await new DaemonClient(readDaemonConfig()!).addProject(dir);
}, 60000);
afterAll(async () => { await daemon?.close(); });
it('loom notes reads/writes Markdown and prints one JSON object', async () => {
  expect(JSON.parse(await cli('notes', '--set', '# CLI notes', '--json')).text).toBe('# CLI notes');
  expect(await cli('notes')).toBe('# CLI notes\n');
});
it('loom inbox, mission and chat-files are registered and return their JSON contracts', async () => {
  expect(JSON.parse(await cli('inbox', '--json'))).toMatchObject({ items: [], count: 0 });
  expect(JSON.parse(await cli('mission', '--json'))).toMatchObject({ chats: [], runningTurns: 0 });
  expect(JSON.parse(await cli('chat-files', '--json'))).toEqual({ files: [] });
});
it('existing send --wait --json still prints a single JSON value', async () => {
  const out = await cli('send', 'r4 contract', '--wait', '--json');
  expect(() => JSON.parse(out)).not.toThrow();
});
