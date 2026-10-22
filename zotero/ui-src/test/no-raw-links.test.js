// Spec 015 success check 1: no view opens a window or a new tab itself. Every web link goes through host.openLink
// (links.js); only the web host, which implements it, may call window.open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const ALLOWED = new Set(['web/host.js']);
const RAW = /\b(?:window|win|self|globalThis)\.open\(|\bopen\(\s*['"`]https?:|_blank|\.openUrl(?:\?\.)?\(|\bopenUrl\(/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'vendor') continue;
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|ts)$/.test(name)) yield path;
  }
}

test('no window.open, target=_blank or openUrl is left in ui-src outside the web host', () => {
  const offenders = [];
  for (const file of files(SRC)) {
    const rel = relative(SRC, file);
    if (ALLOWED.has(rel)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
      if (RAW.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${rel}:${n + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the web host is the only place that opens a window, and only for outside links', () => {
  const host = readFileSync(join(SRC, 'web/host.js'), 'utf8');
  assert.equal(host.match(/win\.open\(/g)?.length, 1);
});
