import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/node/agentd.mjs', import.meta.url));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('agentd leaves when the server that started it dies, so no orphan keeps ticking routines', { timeout: 30000 }, async () => {
  const data = mkdtempSync(join(tmpdir(), 'sb-orphan-'));
  // the parent shell starts agentd in the background and lives a moment, then exits without stopping it, as a server killed with -9 would
  const parent = spawn('/bin/sh', ['-c', `"${process.execPath}" "${entry}" --port 0 --data "${data}" --kb http://127.0.0.1:9 >/dev/null 2>&1 & sleep 3`], {
    env: { ...process.env, SECOND_BRAIN_AGENTD_SECRET: 'test-secret' }, stdio: 'ignore',
  });
  await new Promise((resolve) => parent.on('exit', resolve));
  const status = join(data, 'agentd.json');
  for (let i = 0; i < 100 && !existsSync(status); i++) await pause(100);
  const { pid } = JSON.parse(readFileSync(status, 'utf8'));
  for (let i = 0; i < 120 && alive(pid); i++) await pause(100);
  const stillAlive = alive(pid);
  if (stillAlive) process.kill(pid, 'SIGKILL');
  assert.equal(stillAlive, false, `agentd ${pid} outlived its parent`);
});
