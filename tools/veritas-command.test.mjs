// tools/veritas-command.test.mjs (spec 024 G2). bin/veritas (sh) and its Windows twin bin/veritas.cmd offer the same
// subcommands, the same defaults and the same model download; each is run for real on the system it is for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/', import.meta.url));
const sh = readFileSync(`${bin}veritas`, 'utf8');
const cmd = readFileSync(`${bin}veritas.cmd`, 'utf8');
const SUBCOMMANDS = ['serve', 'open', 'status', 'model'];

test('the Windows command has the same subcommands, port, model and data folder as bin/veritas', () => {
  for (const name of SUBCOMMANDS) {
    assert.match(sh, new RegExp(`^  ${name}\\)`, 'm'), `sh: ${name}`);
    assert.match(cmd, new RegExp(`^:${name}\\r?$`, 'm'), `cmd: ${name}`);
    assert.match(cmd, new RegExp(`^rem   veritas ${name}\\b`, 'm'), `cmd usage: ${name}`);
  }
  for (const shared of ['27182', 'snowflake-arctic-embed-s', 'https://huggingface.co/Snowflake/snowflake-arctic-embed-s/resolve/main/',
    'onnx/model.onnx', 'tokenizer.json', 'config.json', 'VERITAS_DATA', 'VERITAS_PYTHON', 'VERITAS_PORT', 'KB_BACKEND']) {
    assert.ok(sh.includes(shared) && cmd.includes(shared), shared);
  }
  assert.ok(cmd.includes('\\.venv\\Scripts\\python.exe'), "Windows venvs keep python in Scripts\\");
  assert.ok(cmd.includes('PYTHONUTF8=1'), 'notes are UTF-8 whatever the Windows code page');
});

test('veritas.cmd keeps CRLF line endings (cmd.exe misreads labels in LF files)', () => {
  assert.ok(!/[^\r]\n/.test(cmd), 'every line ends in CRLF');
});

test('with no subcommand each prints its usage and exits 2', { skip: process.platform === 'win32' ? false : 'veritas.cmd runs on Windows only; sh runs below' }, () => {
  const out = spawnSync('cmd.exe', ['/d', '/c', `${bin}veritas.cmd`], { encoding: 'utf8', env: { ...process.env, VERITAS_PORT: '1' } });
  assert.equal(out.status, 2);
  for (const name of SUBCOMMANDS) assert.ok(out.stdout.includes(`veritas ${name}`), out.stdout);
  const status = spawnSync('cmd.exe', ['/d', '/c', `${bin}veritas.cmd`, 'status'], { encoding: 'utf8', env: { ...process.env, VERITAS_PORT: '1' } });
  assert.equal(status.status, 1, 'nothing listens on port 1');
  assert.match(status.stdout, /not running/);
});

test('bin/veritas with no subcommand prints its usage and exits 2', { skip: process.platform === 'win32' ? 'sh is not on every Windows' : false }, () => {
  const out = spawnSync('sh', [`${bin}veritas`], { encoding: 'utf8' });
  assert.equal(out.status, 2);
  for (const name of SUBCOMMANDS) assert.ok(out.stdout.includes(`veritas ${name}`), out.stdout);
});
