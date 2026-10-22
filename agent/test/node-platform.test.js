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
  assert.ok(found && found.endsWith('node'));
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
