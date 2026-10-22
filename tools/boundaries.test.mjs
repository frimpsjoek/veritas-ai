// tools/boundaries.test.mjs. Each test builds a tiny fake repo in a temp folder and checks what checkBoundaries reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkBoundaries } from './boundaries.mjs';

/** @param {Record<string, string>} files repo-relative path → contents */
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'veritas-bounds-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

test('allows app → ui', () => {
  const root = repo({ 'web/src/a.js': "import { h } from '../../ui/src/dom.js';\n", 'ui/src/dom.js': '' });
  assert.deepEqual(checkBoundaries(root), []);
});

test('allows ui → agent', () => {
  const root = repo({ 'ui/src/chat/x.js': "import { a } from '../../../agent/src/activity.js';\n", 'agent/src/activity.js': '' });
  assert.deepEqual(checkBoundaries(root), []);
});

test('allows imports inside one part and bare packages', () => {
  const root = repo({ 'web/src/a.js': "import { b } from './b.js';\nimport { build } from 'esbuild';\n" });
  assert.deepEqual(checkBoundaries(root), []);
});

test('rejects app → app', () => {
  const root = repo({ 'obsidian/src/x.ts': "import { y } from '../../zotero/content/y.js';\n" });
  const found = checkBoundaries(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'obsidian/src/x.ts');
  assert.equal(found[0].line, 1);
  assert.match(found[0].reason, /obsidian may not import zotero/);
});

test('rejects agent → ui', () => {
  const root = repo({ 'agent/src/a.js': "\n\nimport { h } from '../../ui/src/dom.js';\n" });
  const found = checkBoundaries(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
  assert.match(found[0].reason, /agent may not import ui/);
});

test('rejects old repo names', () => {
  const root = repo({ 'obsidian/src/s.ts': "import { SearchPanel } from '../../zotero-plugin/ui-src/src/index.js';\n" });
  const found = checkBoundaries(root);
  assert.equal(found.length, 1);
  assert.match(found[0].reason, /old repo path/);
});

test('sees JSDoc import types', () => {
  const root = repo({ 'ui/src/a.js': '/** @type {import("../../web/src/x").T} */\nexport const t = 1;\n' });
  const found = checkBoundaries(root);
  assert.equal(found.length, 1);
  assert.match(found[0].reason, /ui may not import web/);
});

test('sees readFileSync paths in build scripts', () => {
  const root = repo({ 'obsidian/esbuild.config.mjs': 'const css = readFileSync("../zotero/content/x.css", "utf8");\n' });
  const found = checkBoundaries(root);
  assert.equal(found.length, 1);
  assert.match(found[0].reason, /obsidian may not import zotero/);
});

test('rejects escaping the repo', () => {
  const root = repo({ 'web/src/a.js': "import x from '../../../outside.js';\n" });
  const found = checkBoundaries(root);
  assert.equal(found.length, 1);
  assert.match(found[0].reason, /outside the repo/);
});

test('skips node_modules and build output', () => {
  const root = repo({
    'web/node_modules/p/i.js': "import x from '../../../zotero/a.js';\n",
    'web/dist-web/app.js': "import x from '../../zotero/a.js';\n",
  });
  assert.deepEqual(checkBoundaries(root), []);
});

test('lets test and dev folders read any part, but not old repo paths', () => {
  const root = repo({
    'ui/test/guard.test.js': "const dir = new URL('../../zotero/content', import.meta.url);\n",
    'ui/dev/checks.mjs': "const dist = new URL('../../web/dist-web', import.meta.url);\n",
    'web/test/x.test.js': "import { a } from '../../zotero-plugin/ui-src/a.js';\n",
  });
  const found = checkBoundaries(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'web/test/x.test.js');
  assert.match(found[0].reason, /old repo path/);
});

test('in a git repo, skips files git ignores (build output)', () => {
  const root = repo({
    '.gitignore': 'zotero/content/bundle.js\n',
    'zotero/content/bundle.js': "import x from '../../web/src/a.js';\n",
    'zotero/content/hand.js': "import x from '../../web/src/a.js';\n",
  });
  execFileSync('git', ['init', '-q', root]);
  const found = checkBoundaries(root);
  assert.deepEqual(found.map((f) => f.file), ['zotero/content/hand.js']);
});
