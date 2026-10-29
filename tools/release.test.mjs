// tools/release.test.mjs. Each test builds a small fake repo in a temp folder (the version files of every part) and
// checks what tools/release.mjs would write, or what it did write and tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bumpChangelog, bumpFormula, bumpJson, newer, notesFor, planRelease, verify } from './release.mjs';

const json = (obj) => JSON.stringify(obj, null, 2) + '\n';
const FORMULA = `class Veritas < Formula
  url "https://github.com/frimpsjoek/veritas-ai/archive/refs/tags/v0.54.0.tar.gz"
  sha256 "${'b'.repeat(64)}"
  license "MIT"
  revision 2

  depends_on "uv"
end
`;
const README = `- **Zotero 7:** [veritas-zotero-0.53.0.xpi](https://github.com/frimpsjoek/veritas-ai/releases/latest/download/veritas-zotero-0.53.0.xpi).
- **Obsidian:** [veritas-obsidian-0.53.0.zip](https://github.com/frimpsjoek/veritas-ai/releases/latest/download/veritas-obsidian-0.53.0.zip).
`;

/** A repo shaped like veritas-ai: package.json without a version (agent), with one (obsidian), the manifests, a
 * package-lock, the formula and README. @param {Record<string, string>} [extra] */
function repo(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'veritas-release-'));
  const files = {
    'agent/package.json': json({ name: 'second-brain-agent-core', private: true, type: 'module' }),
    'agent/package-lock.json': json({ name: 'second-brain-agent-core', lockfileVersion: 3, packages: { '': { name: 'second-brain-agent-core' } } }),
    'obsidian/package.json': json({ name: 'obsidian-plugin', version: '1.0.0', main: 'index.js' }),
    'obsidian/manifest.json': json({ id: 'second-brain-search', name: 'Veritas', version: '0.53.0', minAppVersion: '1.5.0' }),
    'zotero/manifest.json': json({ manifest_version: 2, name: 'Veritas', version: '0.53.0' }),
    'packaging/homebrew/veritas.rb': FORMULA,
    'README.md': README,
    ...extra,
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const after = (edits, path) => edits.find((e) => e.path === path)?.after;

test('a package.json without a version gets one right after its name', () => {
  const out = JSON.parse(bumpJson('agent/package.json', json({ name: 'a', private: true }), '0.55.0'));
  assert.deepEqual(Object.keys(out), ['name', 'version', 'private']);
  assert.equal(out.version, '0.55.0');
});

test('a package-lock carries the version at the top and on its root package', () => {
  const lock = json({ name: 'o', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'o', version: '1.0.0' }, 'node_modules/x': { version: '2.0.0' } } });
  const out = JSON.parse(bumpJson('obsidian/package-lock.json', lock, '0.55.0'));
  assert.equal(out.version, '0.55.0');
  assert.equal(out.packages[''].version, '0.55.0');
  assert.equal(out.packages['node_modules/x'].version, '2.0.0');
});

test('the formula moves to the new tag, drops its revision and keeps sha256 until it is known', () => {
  const out = bumpFormula(FORMULA, '0.55.0');
  assert.match(out, /refs\/tags\/v0\.55\.0\.tar\.gz/);
  assert.doesNotMatch(out, /revision/);
  assert.match(out, new RegExp(`sha256 "${'b'.repeat(64)}"`));
  assert.match(out, /license "MIT"\n\n {2}depends_on/);
  const tap = bumpFormula(FORMULA, '0.55.0', 'c'.repeat(64));
  assert.match(tap, new RegExp(`sha256 "${'c'.repeat(64)}"`));
  assert.throws(() => bumpFormula(FORMULA, '0.55.0', 'not-a-hash'), /not a sha256/);
});

test('the changelog gets one section on top, and its notes read back', () => {
  const text = '# Changelog\n\n## 0.54.0 (2026-10-23)\n\n- Homebrew\n';
  const out = bumpChangelog(text, '0.55.0', '2026-10-28', ['Release workflow', 'Updating guide']);
  assert.equal(out, '# Changelog\n\n## 0.55.0 (2026-10-28)\n\n- Release workflow\n- Updating guide\n\n## 0.54.0 (2026-10-23)\n\n- Homebrew\n');
  assert.equal(bumpChangelog(out, '0.55.0', '2026-10-29', ['again']), out);
  assert.equal(notesFor(out, '0.55.0'), '- Release workflow\n- Updating guide');
  assert.equal(notesFor(out, '0.54.0'), '- Homebrew');
  assert.equal(notesFor(out, '0.9.0'), '');
});

test('newer compares versions as numbers', () => {
  assert.ok(newer('0.10.0', '0.9.9'));
  assert.ok(!newer('0.53.0', '0.53.0'));
  assert.ok(!newer('0.52.1', '0.53.0'));
  assert.ok(!newer('v1.0.0', '0.1.0'));
});

test('a release plan touches every version file in lockstep and skips the ones that do not exist', () => {
  const root = repo();
  const edits = planRelease(root, '0.55.0', { date: '2026-10-28', changes: ['Release workflow'] });
  assert.deepEqual(edits.map((e) => e.path).sort(), [
    'CHANGELOG.md', 'README.md', 'agent/package-lock.json', 'agent/package.json', 'obsidian/manifest.json',
    'obsidian/package.json', 'packaging/homebrew/veritas.rb', 'zotero/manifest.json',
  ]);
  assert.equal(JSON.parse(after(edits, 'zotero/manifest.json')).version, '0.55.0');
  assert.equal(JSON.parse(after(edits, 'obsidian/manifest.json')).version, '0.55.0');
  assert.match(after(edits, 'README.md'), /veritas-zotero-0\.55\.0\.xpi\]\(.*download\/veritas-zotero-0\.55\.0\.xpi\)/);
  assert.match(after(edits, 'README.md'), /veritas-obsidian-0\.55\.0\.zip/);
  assert.doesNotMatch(after(edits, 'README.md'), /0\.53\.0/);
  assert.equal(after(edits, 'CHANGELOG.md'), '# Changelog\n\n## 0.55.0 (2026-10-28)\n\n- Release workflow\n\n');
  assert.equal(readFileSync(join(root, 'zotero/manifest.json'), 'utf8').includes('0.53.0'), true, 'nothing written');
});

test('the desktop app and Obsidian versions.json are bumped when they exist', () => {
  const root = repo({
    'app/src-tauri/tauri.conf.json': json({ productName: 'Veritas', version: '0.54.0', identifier: 'ai.veritas' }),
    'obsidian/versions.json': json({ '0.53.0': '1.5.0' }),
  });
  const edits = planRelease(root, '0.55.0');
  assert.equal(JSON.parse(after(edits, 'app/src-tauri/tauri.conf.json')).version, '0.55.0');
  assert.deepEqual(JSON.parse(after(edits, 'obsidian/versions.json')), { '0.53.0': '1.5.0', '0.55.0': '1.5.0' });
});

test('verify names every file that does not say the version', () => {
  const root = repo();
  const wrong = verify(root, '0.55.0');
  assert.ok(wrong.includes('agent/package.json: says no version'));
  assert.ok(wrong.includes('zotero/manifest.json: says 0.53.0'));
  assert.ok(wrong.includes('packaging/homebrew/veritas.rb: url names v0.54.0'));
  for (const { path, after: text } of planRelease(root, '0.55.0')) writeFileSync(join(root, path), text);
  assert.deepEqual(verify(root, '0.55.0'), []);
});

test('rejects a version that is not x.y.z', () => {
  assert.throws(() => planRelease(repo(), 'v0.55'), /must look like 1\.2\.3/);
});

/** The real script, copied into a fake repo with git history, run as the user would. */
function gitRepo() {
  const root = repo({ 'CHANGELOG.md': '# Changelog\n\n## 0.54.0 (2026-10-23)\n\n- Homebrew\n' });
  mkdirSync(join(root, 'tools'));
  copyFileSync(fileURLToPath(new URL('./release.mjs', import.meta.url)), join(root, 'tools/release.mjs'));
  const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('add', '.');
  g('commit', '-q', '-m', 'Homebrew formula');
  g('tag', 'v0.54.0');
  writeFileSync(join(root, 'notes.txt'), 'x');
  g('add', '.');
  g('commit', '-q', '-m', 'Updating guide');
  const run = (...args) => spawnSync('node', ['tools/release.mjs', ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  return { root, g, run };
}

test('--dry-run prints the diff and changes nothing', () => {
  const { g, run } = gitRepo();
  const r = run('0.55.0', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^--- a\/zotero\/manifest\.json\n\+\+\+ b\/zotero\/manifest\.json/m);
  assert.match(r.stdout, /^-  "version": "0\.53\.0",\n\+  "version": "0\.55\.0",/m);
  assert.match(r.stdout, /^\+- Updating guide$/m);
  assert.match(r.stdout, /8 files would change/);
  assert.equal(g('status', '--porcelain'), '');
  assert.equal(g('tag', '--list', 'v0.55.0'), '');
});

test('a release commits, tags, prints the push command and never pushes', () => {
  const { root, g, run } = gitRepo();
  const r = run('0.55.0');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(g('log', '-1', '--format=%s').trim(), 'Release 0.55.0');
  assert.equal(g('tag', '--list', 'v0.55.0').trim(), 'v0.55.0');
  assert.equal(g('status', '--porcelain'), '');
  assert.match(r.stdout, /git push origin main v0\.55\.0/);
  assert.equal(g('remote').trim(), '', 'no remote to push to, and none was needed');
  assert.match(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), /## 0\.55\.0 \(\d{4}-\d\d-\d\d\)\n\n- Updating guide\n\n## 0\.54\.0/);
  assert.equal(run('verify', '0.55.0').status, 0);
  assert.equal(run('notes', '0.55.0').stdout.trim(), '- Updating guide');
});

test('refuses a dirty tree, an old version and an existing tag', () => {
  const { root, run } = gitRepo();
  assert.match(run('0.53.0', '--dry-run').stderr, /not newer than 0\.53\.0/);
  assert.match(run('0.54.0', '--dry-run').stderr, /tag v0\.54\.0 already exists/);
  writeFileSync(join(root, 'README.md'), 'edited\n');
  const r = run('0.55.0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commit or stash your changes first/);
});
