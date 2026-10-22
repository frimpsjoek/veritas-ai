// Citations and links in answers must read as clickable in both hosts (user report 2026-09-29: in Obsidian they looked
// like plain text). The shared stylesheet colours resolved citations and links with the theme accent token, which each
// host's token map defines; unresolved ones stay red and pending ones muted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../styles/ui.css', import.meta.url), 'utf8');
const rule = (selector) => css.split('\n').find((line) => line.startsWith(selector));

test('resolved citations use the accent colour and a pointer cursor', () => {
  const r = rule('.sb-md .cite:not(.is-pending):not(.missing) {');
  assert.ok(r, 'the resolved-citation rule exists');
  assert.match(r, /color:\s*var\(--sb-ui-accent\)/);
  assert.match(r, /cursor:\s*pointer/);
});

test('links use the accent colour and are underlined', () => {
  const r = rule('.sb-md a {');
  assert.ok(r, 'the link rule exists');
  assert.match(r, /color:\s*var\(--sb-ui-accent\)/);
  assert.match(r, /text-decoration:\s*underline/);
});

test('both token maps define the accent token', () => {
  for (const file of ['tokens-zotero.css', 'tokens-obsidian.css']) {
    assert.match(readFileSync(new URL(`../styles/${file}`, import.meta.url), 'utf8'), /--sb-ui-accent:/, file);
  }
});
