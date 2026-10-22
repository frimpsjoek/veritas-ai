#!/usr/bin/env node
// tools/boundaries.mjs. Checks which part of the repo may import which. Apps (web, zotero, obsidian) may use ui and
// agent, ui may use agent, agent and server use nothing outside themselves. An app never imports another app, and no
// path may still name one of the old Second Brain repos.
//   node tools/boundaries.mjs [root]    prints `file:line: reason` per violation; exit 1 when there is any
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
const OLD_REPOS = /(^|\/)(zotero-plugin|obsidian-kb|obsidian-plugin|agent-src|ui-src)(\/|$)/;
const SKIP = new Set(['node_modules', 'dist', 'dist-web', 'dist-versions', 'vendor', '.git', '.venv', '__pycache__']);
const SOURCE = /\.(js|mjs|cjs|ts|mts)$/;
// import/export … from 'x', import 'x', import('x') (also JSDoc types), require('x'), readFileSync('x'), new URL('x', …)
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\breadFileSync\s*\(\s*|\bnew URL\s*\(\s*)(['"`])([^'"`\n]+)\1/g;

/** @param {string} dir @returns {string[]} */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

/** @param {string} root @returns {{ file: string, line: number, spec: string, reason: string }[]} */
export function checkBoundaries(root) {
  root = resolve(root);
  const found = [];
  for (const from of Object.keys(ALLOWED)) {
    let files;
    try { files = sources(join(root, from)); } catch { continue; } // a part that does not exist yet
    for (const path of files) {
      const file = relative(root, path).split(sep).join('/');
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((text, i) => {
        for (const match of text.matchAll(SPEC)) {
          const spec = match[2];
          if (!spec.startsWith('.')) continue; // a package or an absolute URL
          const report = (reason) => found.push({ file, line: i + 1, spec, reason });
          if (OLD_REPOS.test(spec)) { report(`old repo path ${spec}`); continue; }
          const target = relative(root, resolve(dirname(path), spec)).split(sep).join('/');
          if (target.startsWith('..')) { report(`${spec} points outside the repo`); continue; }
          const to = target.split('/')[0];
          if (to === from || ALLOWED[from].includes(to)) continue;
          report(`${from} may not import ${to} (${spec})`);
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
