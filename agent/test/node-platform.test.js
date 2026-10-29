import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createNodePlatform } from '../src/node/platform.mjs';

function tmpDir() {
  return path.join(os.tmpdir(), `second-brain-platform-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

test('fs.writeAtomic then read round-trips, creating parent directories', async () => {
  const platform = createNodePlatform();
  const file = path.join(tmpDir(), 'nested', 'note.md');
  await platform.fs.writeAtomic(file, 'hello');
  assert.equal(await platform.fs.read(file), 'hello');
});

test('fs.read on a missing file returns null, not a thrown error', async () => {
  const platform = createNodePlatform();
  assert.equal(await platform.fs.read(path.join(tmpDir(), 'missing.txt')), null);
});

test('fs.append adds newline-terminated lines; list finds them by directory', async () => {
  const platform = createNodePlatform();
  const dir = tmpDir();
  const file = path.join(dir, 'a.jsonl');
  await platform.fs.append(file, '{"a":1}');
  await platform.fs.append(file, '{"a":2}');
  assert.equal(await platform.fs.read(file), '{"a":1}\n{"a":2}\n');
  assert.deepEqual(await platform.fs.list(dir), ['a.jsonl']);
});

test('fs.symlink is idempotent: a second call does not throw when the link already exists', async () => {
  const platform = createNodePlatform();
  const dir = tmpDir();
  const target = path.join(dir, 'target.txt');
  await platform.fs.writeAtomic(target, 'x');
  const link = path.join(dir, 'link.txt');
  await platform.fs.symlink(target, link);
  await platform.fs.symlink(target, link); // must not throw EEXIST
  assert.equal(await platform.fs.read(link), 'x');
});

test('which() finds node itself on PATH', async () => {
  const platform = createNodePlatform();
  const found = await platform.which(['definitely-not-a-real-binary', 'node']);
  assert.ok(found && /node(\.exe)?$/i.test(found));
});

// spec 024 G2: the same platform on Windows and Linux.
test('the platform says which system it runs on, and the home folder comes from the OS (Windows has no $HOME)', () => {
  const platform = createNodePlatform();
  assert.equal(platform.os, process.platform);
  assert.equal(platform.homeDir, os.homedir());
});

test('which() on Windows tries the PATHEXT extensions (claude.cmd, node.exe) for a bare name', async () => {
  const dir = tmpDir();
  const platform = createNodePlatform({ system: 'win32', env: { PATH: dir, PATHEXT: '.COM;.EXE;.CMD' } });
  await platform.fs.writeAtomic(path.join(dir, 'claude.cmd'), '@echo off');
  assert.equal(await platform.which(['claude']), path.join(dir, 'claude.cmd'));
  assert.equal(await platform.which(['claude.cmd']), path.join(dir, 'claude.cmd'));
  assert.equal(await createNodePlatform({ system: 'linux', env: { PATH: dir } }).which(['claude']), null, 'not elsewhere');
});

test('which() returns null when nothing matches', async () => {
  const platform = createNodePlatform();
  assert.equal(await platform.which(['definitely-not-a-real-binary']), null);
});

test('spawn(): stdout lines are readable and write() reaches the child\'s stdin', async () => {
  const platform = createNodePlatform();
  const child = await platform.spawn({ cmd: process.execPath, args: ['-e', 'process.stdin.on("data", d => process.stdout.write("echo:" + d))'], env: {}, cwd: process.cwd() });
  await child.write('ping');
  for await (const line of child.lines()) {
    assert.match(line, /^echo:ping$/);
    break;
  }
  await child.kill();
});

test('serve(): mounts a route reachable over real HTTP, and unmount() 404s it', async () => {
  const platform = createNodePlatform();
  const mount = await platform.serve('/hello', async (req) => ({ status: 200, body: JSON.stringify({ got: req.body }) }));
  const res = await fetch(mount.url, { method: 'POST', body: 'hi' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { got: 'hi' });
  mount.unmount();
  const after = await fetch(mount.url, { method: 'POST', body: 'hi' });
  assert.equal(after.status, 404);
});

// Spec 007 follow-up: deleting a chat must delete its result versions too (chats/<id>.d/), not leak them.
test('conversationStore.remove deletes the log and the session\'s results folder', async () => {
  const { conversationStore } = await import('../src/store.js');
  const fsp = await import('node:fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-store-'));
  try {
    const store = conversationStore(createNodePlatform().fs, dir);
    await store.append('C1', { type: 'meta', id: 'C1' });
    await store.writeResult('C1', 'R1', 1, { ref: { id: 'R1', version: 1 } });
    await store.append('C2', { type: 'meta', id: 'C2' });
    await store.writeResult('C2', 'R1', 1, { ref: { id: 'R1', version: 1 } });
    await store.remove('C1');
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['C2.d', 'C2.jsonl'], 'only the other chat is left');
    await store.remove('C1'); // absent is fine
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('spawn(): a command that does not exist settles exited instead of crashing the process', async () => {
  const platform = createNodePlatform();
  const child = await platform.spawn({ cmd: 'sb-no-such-command-xyz', args: [], env: {}, cwd: process.cwd() });
  const code = await Promise.race([child.exited, new Promise((resolve) => setTimeout(() => resolve('hung'), 3000))]);
  assert.notEqual(code, 'hung');
  assert.notEqual(code, 0);
  assert.match(child.stderrTail(), /ENOENT|not found/i);
});

// spec 024 TG5: Node will not start a .cmd or .bat without a shell (EINVAL, CVE-2024-27980), and a shell would put
// prompts through cmd.exe's quoting. So on Windows a shim is resolved to what it runs.
const { resolveWindowsCommand } = await import('../src/node/windows-command.mjs');

// The shim npm (cmd-shim) writes for a global package's bin, byte for byte apart from the package path.
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  '',
].join('\r\n');

// The npx.cmd that ships beside node.exe: the script is in a variable, set first to a default and then, through a
// FOR loop we cannot run, to the npm prefix's copy.
const NPX_SHIM = [
  ':: Created by npm, please don\'t edit manually.',
  '@ECHO OFF',
  '',
  'SETLOCAL',
  '',
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ')',
  '',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
  '  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"',
  ')',
  'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (',
  '  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"',
  ')',
  '',
  '"%NODE_EXE%" "%NPX_CLI_JS%" %*',
  '',
].join('\r\n');

async function shimDir(files) {
  const fsp = await import('node:fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-shim-'));
  for (const [name, text] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), text);
  }
  return dir;
}

test('Windows: an npm shim runs as node <its script>, the arguments passed through untouched', async () => {
  const script = path.join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const dir = await shimDir({ 'claude.cmd': NPM_SHIM, [script]: '' });
  const which = async (names) => (names[0] === 'node' ? process.execPath : null);
  const prompt = 'say "hi" & del %USERPROFILE% | more';
  const launch = await resolveWindowsCommand({ cmd: path.join(dir, 'claude.cmd'), args: ['-p', prompt], env: {}, cwd: dir }, { which });
  assert.deepEqual(launch, { cmd: process.execPath, args: [path.join(dir, script), '-p', prompt] });
  // a node.exe beside the shim is the one the shim itself would use
  await (await import('node:fs/promises')).writeFile(path.join(dir, 'node.exe'), '');
  const local = await resolveWindowsCommand({ cmd: path.join(dir, 'claude.cmd'), args: [], env: {}, cwd: dir }, { which });
  assert.equal(local.cmd, path.join(dir, 'node.exe'));
});

test('Windows: npx.cmd, whose script is in a variable, and a bare name found through PATH', async () => {
  const script = path.join('node_modules', 'npm', 'bin', 'npx-cli.js');
  const dir = await shimDir({ 'npx.cmd': NPX_SHIM, [script]: '', [path.join('node_modules', 'npm', 'bin', 'npm-prefix.js')]: '' });
  const which = async (names) => (names[0] === 'node' ? process.execPath : names[0] === 'npx' ? path.join(dir, 'npx.cmd') : null);
  const launch = await resolveWindowsCommand({ cmd: 'npx', args: ['-y', 'tavily-mcp'], env: {}, cwd: '' }, { which });
  assert.deepEqual(launch, { cmd: process.execPath, args: [path.join(dir, script), '-y', 'tavily-mcp'] });
});

test('Windows: a shim that is not npm\'s gives way to the .exe beside it', async () => {
  const dir = await shimDir({ 'claude.cmd': '@echo off\r\n"%~dp0\\claude.exe" %*\r\n', 'claude.exe': '' });
  const launch = await resolveWindowsCommand({ cmd: path.join(dir, 'claude.cmd'), args: ['-p', 'a "quoted" prompt'], env: {}, cwd: dir }, { which: async () => null });
  assert.deepEqual(launch, { cmd: path.join(dir, 'claude.exe'), args: ['-p', 'a "quoted" prompt'] });
});

test('Windows: an unknown shim goes through cmd.exe only when every argument is plain, else it is refused', async () => {
  const dir = await shimDir({ 'tool.bat': '@echo off\r\npowershell -File "%~dp0\\tool.ps1" %*\r\n' });
  const cmd = path.join(dir, 'tool.bat');
  const plain = await resolveWindowsCommand({ cmd, args: ['auth', 'login', '--with-api-key'], env: {}, cwd: dir }, { which: async () => null });
  assert.deepEqual(plain, { cmd: `"${cmd}"`, args: ['auth', 'login', '--with-api-key'], shell: true });
  for (const unsafe of ['two words', 'a&b', '%PATH%', 'x|y', '"q"', '^', '']) {
    const refused = await resolveWindowsCommand({ cmd, args: ['-p', unsafe], env: {}, cwd: dir }, { which: async () => null });
    assert.ok('refused' in refused, `refuses ${JSON.stringify(unsafe)}`);
    assert.match(refused.refused, /tool\.bat/);
  }
});

test('Windows: an .exe and a missing command pass through as they are', async () => {
  const which = async () => null;
  assert.deepEqual(await resolveWindowsCommand({ cmd: 'C:\\Tools\\pandoc.exe', args: ['a.md'], env: {}, cwd: '' }, { which }), { cmd: 'C:\\Tools\\pandoc.exe', args: ['a.md'] });
  assert.deepEqual(await resolveWindowsCommand({ cmd: 'no-such-tool', args: [], env: {}, cwd: '' }, { which }), { cmd: 'no-such-tool', args: [] });
});

test('spawn() on Windows starts an npm shim\'s script with node, and a refused one exits with the reason', async () => {
  const script = path.join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const dir = await shimDir({ 'claude.cmd': NPM_SHIM, [script]: 'console.log("ran:" + process.argv.slice(2).join(","))' });
  const platform = createNodePlatform({ system: 'win32', env: { PATH: [dir, path.dirname(process.execPath)].join(';'), PATHEXT: '.EXE;.CMD' } });
  const child = await platform.spawn({ cmd: 'claude', args: ['-p', 'a & b'], env: {}, cwd: dir });
  for await (const line of child.lines()) { assert.equal(line, 'ran:-p,a & b'); break; }
  assert.equal(await child.exited, 0);
  const odd = await shimDir({ 'odd.cmd': '@echo off\r\nsomething-else %*\r\n' });
  const refused = await platform.spawn({ cmd: path.join(odd, 'odd.cmd'), args: ['a & b'], env: {}, cwd: odd });
  assert.equal(await refused.exited, 127);
  assert.match(refused.stderrTail(), /odd\.cmd/);
});
