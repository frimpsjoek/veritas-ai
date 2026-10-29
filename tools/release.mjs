#!/usr/bin/env node
// tools/release.mjs. Cuts a release: every part gets the same version, CHANGELOG.md gets a section for it, then one
// commit "Release <version>" and the tag v<version>. It never pushes: pushing the tag starts
// .github/workflows/release.yml, which builds the plugins, makes the GitHub Release and bumps the Homebrew tap.
//   node tools/release.mjs <version> [--dry-run]       bump, commit and tag; --dry-run prints the diff and writes nothing
//   node tools/release.mjs verify <version>             exit 1 unless every part already says <version> (release.yml)
//   node tools/release.mjs notes <version>              print that version's CHANGELOG section (the release notes)
//   node tools/release.mjs formula <version> <sha256>   print the tap's formula: packaging/homebrew/veritas.rb with the
//                                                       tag's url and sha256, revision back to 0 (release.yml)
//
// Versions live in: the package.json (and package-lock.json) of agent, ui, web, obsidian and zotero; the Zotero and
// Obsidian manifest.json (Zotero's dist/update.json is written from its manifest by zotero/build.sh); obsidian/
// versions.json and app/src-tauri/tauri.conf.json when they exist; the formula's url; the plugin file names in README.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PARTS = ['agent', 'ui', 'web', 'obsidian', 'zotero'];
export const JSON_FILES = [
  ...PARTS.flatMap((p) => [`${p}/package.json`, `${p}/package-lock.json`]),
  'obsidian/manifest.json',
  'zotero/manifest.json',
  'app/src-tauri/tauri.conf.json', // the desktop app (spec 024 G3), once it exists
];
export const FORMULA = 'packaging/homebrew/veritas.rb';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const TARBALL = /(\/archive\/refs\/tags\/v)(\d+\.\d+\.\d+)(\.tar\.gz)/;
const PLUGIN_FILE = /(veritas-(?:zotero|obsidian)-)\d+\.\d+\.\d+(\.(?:xpi|zip))/g;

/** @param {string} v */
const semver = (v) => SEMVER.exec(v)?.slice(1).map(Number) ?? null;
/** @param {string} a @param {string} b */
export function newer(a, b) {
  const [x, y] = [semver(a), semver(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The object with `version` set, put right after `name` when it was not there before (npm's own order).
 * @param {Record<string, any>} obj @param {string} version */
function withVersion(obj, version) {
  if ('version' in obj || !('name' in obj)) return { ...obj, version };
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v;
    if (k === 'name') out.version = version;
  }
  return out;
}

/** New text of one JSON file. package-lock.json carries the version twice: at the top and on packages[""].
 * @param {string} path @param {string} text @param {string} version */
export function bumpJson(path, text, version) {
  let obj = withVersion(JSON.parse(text), version);
  if (path.endsWith('package-lock.json') && obj.packages?.['']) {
    obj = { ...obj, packages: { ...obj.packages, '': withVersion(obj.packages[''], version) } };
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

/** Obsidian's versions.json maps each plugin version to the oldest Obsidian it runs on.
 * @param {string} text @param {string} version @param {string} minAppVersion */
export function bumpVersions(text, version, minAppVersion) {
  return JSON.stringify({ ...JSON.parse(text), [version]: minAppVersion }, null, 2) + '\n';
}

/** The formula at a new tag: url moved, revision dropped (a new version starts at revision 0), sha256 replaced when
 * known (only after the tag is pushed and GitHub serves its tarball).
 * @param {string} text @param {string} version @param {string} [sha256] */
export function bumpFormula(text, version, sha256) {
  if (!TARBALL.test(text)) throw new Error(`${FORMULA}: no tag tarball url to move`);
  let out = text.replace(TARBALL, `$1${version}$3`).replace(/^ *revision \d+\n/m, '');
  if (sha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
    out = out.replace(/^( *sha256 )"[0-9a-f]{64}"/m, `$1"${sha256}"`);
  }
  return out;
}

/** CHANGELOG.md with a section for `version` on top (once).
 * @param {string} text @param {string} version @param {string} date @param {string[]} changes */
export function bumpChangelog(text, version, date, changes) {
  if (new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm').test(text)) return text;
  const body = changes.length ? changes.map((c) => `- ${c}`).join('\n') : '- ';
  const section = `## ${version} (${date})\n\n${body}\n\n`;
  const first = text.search(/^## /m);
  return first < 0 ? `${text.trimEnd()}\n\n${section}` : text.slice(0, first) + section + text.slice(first);
}

/** The section of CHANGELOG.md for `version`, without its heading.
 * @param {string} text @param {string} version */
export function notesFor(text, version) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`);
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** Today's date where the release is cut (toISOString would give UTC's, a day ahead in the evening). */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Every file that changes for `version`: [{ path, before, after }], nothing written. A missing optional file is
 * skipped; CHANGELOG.md is created when the repo has none.
 * @param {string} root @param {string} version
 * @param {{ date?: string, changes?: string[] }} [opts] */
export function planRelease(root, version, { date = today(), changes = [] } = {}) {
  if (!semver(version)) throw new Error(`version must look like 1.2.3, not ${version}`);
  /** @type {{ path: string, before: string, after: string }[]} */
  const edits = [];
  const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null);
  const edit = (path, before, after) => { if (after !== before) edits.push({ path, before: before ?? '', after }); };
  for (const path of JSON_FILES) {
    const text = read(path);
    if (text !== null) edit(path, text, bumpJson(path, text, version));
  }
  const versions = read('obsidian/versions.json');
  const manifest = read('obsidian/manifest.json');
  if (versions !== null && manifest !== null) {
    edit('obsidian/versions.json', versions, bumpVersions(versions, version, JSON.parse(manifest).minAppVersion));
  }
  const formula = read(FORMULA);
  if (formula !== null) edit(FORMULA, formula, bumpFormula(formula, version));
  const readme = read('README.md');
  if (readme !== null) edit('README.md', readme, readme.replace(PLUGIN_FILE, `$1${version}$2`));
  const changelog = read('CHANGELOG.md') ?? '# Changelog\n';
  edit('CHANGELOG.md', read('CHANGELOG.md'), bumpChangelog(changelog, version, date, changes));
  return edits;
}

/** Files that do not yet say `version`: [`path: says X`].
 * @param {string} root @param {string} version */
export function verify(root, version) {
  const wrong = [];
  for (const path of JSON_FILES) {
    if (!existsSync(join(root, path))) continue;
    const said = JSON.parse(readFileSync(join(root, path), 'utf8')).version;
    if (said !== version) wrong.push(`${path}: says ${said ?? 'no version'}`);
  }
  if (existsSync(join(root, FORMULA))) {
    const said = TARBALL.exec(readFileSync(join(root, FORMULA), 'utf8'))?.[2];
    if (said !== version) wrong.push(`${FORMULA}: url names v${said}`);
  }
  return wrong;
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A unified diff of the planned edits, made with `diff -u` on temporary copies. */
function diffOf(edits) {
  const dir = mkdtempSync(join(tmpdir(), 'veritas-release-'));
  return edits.map(({ path, before, after }, i) => {
    const [a, b] = [join(dir, `${i}.a`), join(dir, `${i}.b`)];
    writeFileSync(a, before);
    writeFileSync(b, after);
    try {
      execFileSync('diff', ['-u', '--label', `a/${path}`, '--label', `b/${path}`, a, b], { encoding: 'utf8' });
      return '';
    } catch (e) {
      return /** @type {any} */ (e).stdout; // diff exits 1 when the files differ
    }
  }).join('');
}

function release(root, version, dryRun) {
  const current = JSON.parse(readFileSync(join(root, 'zotero/manifest.json'), 'utf8')).version;
  if (!newer(version, current)) throw new Error(`${version} is not newer than ${current} (zotero/manifest.json)`);
  if (git(root, ['tag', '--list', `v${version}`])) throw new Error(`tag v${version} already exists`);
  if (!dryRun && git(root, ['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('commit or stash your changes first: the release commit holds only the version bump');
  }
  let changes = [];
  try {
    const last = git(root, ['describe', '--tags', '--abbrev=0', '--match', 'v*']);
    changes = git(root, ['log', '--format=%s', '--no-merges', `${last}..HEAD`]).split('\n').filter(Boolean);
  } catch { /* no earlier tag: an empty stub */ }
  const edits = planRelease(root, version, { changes });
  if (dryRun) {
    process.stdout.write(diffOf(edits));
    console.log(`\nrelease: dry run, ${edits.length} files would change: ${edits.map((e) => e.path).join(', ')}`);
    return;
  }
  for (const { path, after } of edits) writeFileSync(join(root, path), after);
  git(root, ['add', '--', ...edits.map((e) => e.path)]);
  git(root, ['commit', '-q', '-m', `Release ${version}`]);
  git(root, ['tag', '-a', `v${version}`, '-m', `Veritas AI ${version}`]);
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  console.log(`release: committed "Release ${version}" and tagged v${version} (${edits.length} files).`);
  console.log('CHANGELOG.md lists the commit subjects since the last tag; to edit it before pushing:');
  console.log(`  git commit --amend --no-edit CHANGELOG.md && git tag -f -a v${version} -m "Veritas AI ${version}"`);
  console.log(`Then publish (starts .github/workflows/release.yml):\n  git push origin ${branch} v${version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'verify') {
      const wrong = verify(root, rest[0]);
      for (const w of wrong) console.log(w);
      if (wrong.length) throw new Error(`${wrong.length} file(s) do not say ${rest[0]}; run tools/release.mjs ${rest[0]}`);
      console.log(`release: every part says ${rest[0]}`);
    } else if (cmd === 'notes') {
      const path = join(root, 'CHANGELOG.md');
      console.log(existsSync(path) ? notesFor(readFileSync(path, 'utf8'), rest[0]) : '');
    } else if (cmd === 'formula') {
      process.stdout.write(bumpFormula(readFileSync(join(root, FORMULA), 'utf8'), rest[0], rest[1]));
    } else if (cmd && semver(cmd)) {
      release(root, cmd, rest.includes('--dry-run'));
    } else {
      console.error('usage: node tools/release.mjs <version> [--dry-run] | verify <version> | notes <version> | formula <version> <sha256>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`release: ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
}
