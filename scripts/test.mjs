// Keep shell quoting and glob expansion out of the Windows test command.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const dom = fs.readdirSync(new URL('../test/', import.meta.url)).filter(name => /^app-.*dom\.test\.ts$/.test(name)).sort().map(name => `test/${name}`);
for (const args of [['--exclude', 'test/app-*dom.test.ts'], ['--no-file-parallelism', ...dom]]) {
  const result = spawnSync(process.execPath, [vitest, 'run', ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
