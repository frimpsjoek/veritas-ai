#!/usr/bin/env node
// tools/boundaries.mjs. Checks which part of the repo may import which. Apps (web, zotero, obsidian) may use ui and
// agent, ui may use agent, agent and server use nothing outside themselves. An app never imports another app, and no
// string may still name one of the old Second Brain repos.
//   node tools/boundaries.mjs [root]    prints `file:line: reason` per violation; exit 1 when there is any
//
// Read: JS/TS sources (imports, JSDoc import types, require/require.resolve, readFile/readFileSync, new URL), shell
// scripts (relative paths) and HTML pages (href/src). The server's Python is not read: it names other parts' build
// outputs (agent/dist, zotero/dist, obsidian/dist-versions) as files to serve, not as code it imports.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED = {
  agent: [],
  ui: ['agent'],
  web: ['ui', 'agent'],
  zotero: ['ui', 'agent'],
  obsidian: ['ui', 'agent'],
  server: [],
};
// Build and install scripts that drive another part on purpose: Obsidian's install also installs the web app, the
// Zotero build type-checks the Obsidian plugin (which compiles agent and ui strictly), the web install writes into
// the server's data folder.
export const SCRIPT_LINKS = {
  'obsidian/install.sh': ['web', 'server'],
  'zotero/build.sh': ['obsidian'],
  'web/install.sh': ['server'],
};
// A part's test/ and dev/ folders hold repo-wide checks (drift guards, the browser harness), so they may read any
// part. Shipped code may not.
const REPO_WIDE = new Set(['test', 'dev']);
const OLD_NAME = /(?:zotero-plugin|obsidian-kb|obsidian-plugin|agent-src|ui-src)(?:\/[\w.-]+)*/;
const SKIP = new Set(['node_modules', 'dist', 'dist-web', 'dist-versions', 'vendor', '.git', '.venv', '__pycache__']);
const CODE = /\.(js|mjs|cjs|ts|mts|jsx|tsx)$/;
const SCRIPT = /\.sh$/;
const PAGE = /\.html$/;
const READ = (/** @type {string} */ f) => CODE.test(f) || SCRIPT.test(f) || PAGE.test(f);
// import/export … from 'x', import 'x', import('x') (also JSDoc types), require('x'), require.resolve('x'),
// readFile('x'), readFileSync('x'), new URL('x', …)
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire(?:\.resolve)?\s*\(\s*|\breadFile(?:Sync)?\s*\(\s*|\bnew URL\s*\(\s*)(['"`])([^'"`\n]+)\1/g;
const STRING = /(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
const SCRIPT_PATH = /(?:^|[\s"'=(:])(\.\.?\/[^\s"'`;)&|]*)/g;
const PAGE_PATH = /\b(?:href|src)\s*=\s*["'](\.[^"']*)["']/g;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return READ(entry.name) ? [path] : [];
  });
}

/** The files git would commit (tracked or new, not ignored), or null outside a git repo. @param {string} root */
function gitFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter((f) => READ(f) && !f.split('/').some((d) => SKIP.has(d))).map((f) => join(root, f));
  } catch {
    return null;
  }
}

/** Relative paths a line refers to, by file type. @param {string} file @param {string} text @returns {string[]} */
function pathsOn(file, text) {
  if (SCRIPT.test(file)) return text.trimStart().startsWith('#') ? [] : [...text.matchAll(SCRIPT_PATH)].map((m) => m[1]);
  if (PAGE.test(file)) return [...text.matchAll(PAGE_PATH)].map((m) => m[1]);
  return [...text.matchAll(SPEC)].map((m) => m[2]).filter((spec) => spec.startsWith('.'));
}

/** The old repo name a line still uses, if any: in a string literal (code, pages) or anywhere (scripts).
 *  @param {string} file @param {string} text @returns {string | null} */
function oldNameOn(file, text) {
  if (/^\s*(\/\/|\/?\*)/.test(text)) return null; // a comment naming the old place is history, not a path
  if (SCRIPT.test(file)) return text.trimStart().startsWith('#') ? null : (OLD_NAME.exec(text)?.[0] ?? null);
  for (const m of text.matchAll(STRING)) {
    const hit = OLD_NAME.exec(m[2]);
    if (hit) return hit[0];
  }
  return null;
}

/** @param {string} root @returns {{ file: string, line: number, spec: string, reason: string }[]} */
export function checkBoundaries(root) {
  root = resolve(root);
  /** @type {{ file: string, line: number, spec: string, reason: string }[]} */
  const found = [];
  const tracked = gitFiles(root); // build output is git-ignored, so in a repo only real sources are read
  for (const from of /** @type {(keyof typeof ALLOWED)[]} */ (Object.keys(ALLOWED))) {
    let files;
    if (tracked) files = tracked.filter((f) => relative(root, f).split(sep)[0] === from);
    else try { files = walk(join(root, from)); } catch { continue; } // a part that does not exist yet
    for (const path of files) {
      const file = relative(root, path).split(sep).join('/');
      const allowed = new Set([from, ...ALLOWED[from], ...(SCRIPT_LINKS[/** @type {keyof typeof SCRIPT_LINKS} */ (file)] ?? [])]);
      readFileSync(path, 'utf8').split('\n').forEach((text, i) => {
        const report = (/** @type {string} */ spec, /** @type {string} */ reason) => found.push({ file, line: i + 1, spec, reason });
        const old = oldNameOn(file, text);
        if (old) { report(old, `old repo name ${old}`); return; }
        for (const spec of pathsOn(file, text)) {
          const target = relative(root, resolve(dirname(path), spec)).split(sep).join('/');
          if (target.startsWith('..')) { report(spec, `${spec} points outside the repo`); continue; }
          const to = target.split('/')[0];
          if (allowed.has(to) || REPO_WIDE.has(file.split('/')[1])) continue;
          if (!(to in ALLOWED)) continue; // a repo-level file (README, tools/), not another part
          report(spec, `${from} may not import ${to} (${spec})`);
        }
      });
    }
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = checkBoundaries(process.argv[2] ?? '.');
  for (const f of found) console.log(`${f.file}:${f.line}: ${f.reason}`);
  if (found.length) {
    console.error(`boundaries: ${found.length} violation(s)`);
    process.exit(1);
  }
  console.log('boundaries: ok');
}
