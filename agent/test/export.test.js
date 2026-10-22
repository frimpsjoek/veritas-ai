import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportReport } from '../src/export.js';
import { memoryFs } from './support/memory-fs.mjs';

function fakePlatform({ pandocPath = '/opt/homebrew/bin/pandoc', exitCode = 0, stderr = '' } = {}) {
  const fs = memoryFs();
  const spawnCalls = [];
  return {
    fs,
    spawnCalls,
    async which() { return pandocPath; },
    async spawn(spec) {
      spawnCalls.push(spec);
      return { lines() { return []; }, async write() {}, stderrTail: () => stderr, async kill() {}, exited: Promise.resolve(exitCode) };
    },
  };
}

test('md export writes the file directly, no pandoc lookup', async () => {
  const platform = fakePlatform();
  const result = await exportReport(platform, { markdown: '# Hi', format: 'md', path: 'reviews/r1/export.md', tmpDir: '/tmp' });
  assert.deepEqual(result, { path: 'reviews/r1/export.md' });
  assert.equal(await platform.fs.read('reviews/r1/export.md'), '# Hi\n');
  assert.equal(platform.spawnCalls.length, 0);
});

test('docx export spawns pandoc on a temp source file and cleans it up', async () => {
  const platform = fakePlatform();
  const result = await exportReport(platform, { markdown: '# Hi', format: 'docx', path: 'reviews/r1/export.docx', tmpDir: '/tmp' });
  assert.deepEqual(result, { path: 'reviews/r1/export.docx' });
  assert.equal(platform.spawnCalls.length, 1);
  const [call] = platform.spawnCalls;
  assert.equal(call.cmd, '/opt/homebrew/bin/pandoc');
  assert.deepEqual(call.args.slice(-2), ['-o', 'reviews/r1/export.docx']);
  const srcPath = call.args[0];
  assert.match(srcPath, /^\/tmp\/export-/);
  assert.equal(await platform.fs.read(srcPath), null, 'the temp .md source is removed after pandoc runs');
});

test('a nonzero pandoc exit throws export_failed with the stderr tail', async () => {
  const platform = fakePlatform({ exitCode: 1, stderr: 'unknown format' });
  await assert.rejects(
    () => exportReport(platform, { markdown: 'x', format: 'pdf', path: 'out.pdf', tmpDir: '/tmp' }),
    (error) => error.kind === 'export_failed' && /unknown format/.test(error.message),
  );
});

test('missing pandoc throws missing_pandoc without ever spawning', async () => {
  const platform = fakePlatform({ pandocPath: null });
  await assert.rejects(
    () => exportReport(platform, { markdown: 'x', format: 'pdf', path: 'out.pdf', tmpDir: '/tmp' }),
    (error) => error.kind === 'missing_pandoc',
  );
  assert.equal(platform.spawnCalls.length, 0);
});
