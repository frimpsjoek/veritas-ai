// Spec 005 success check 11 (after stage D): every older panel uses the shared components, so none of the old design's
// leftovers may come back -- no `--sb-*` colour variables in second-brain.js, no `sbs-` / `sbc-` rule in Obsidian's CSS, and
// no host stylesheet redefining a shared panel class (.sb-p-*): a host may only scope under its own selector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const zotero = (f) => readFileSync(fileURLToPath(new URL(`../../zotero/content/${f}`, import.meta.url)), 'utf8');
const obsidian = (f) => readFileSync(fileURLToPath(new URL(`../../obsidian/${f}`, import.meta.url)), 'utf8');

test('second-brain.js defines and reads no --sb-* colour variable (the note editor keeps its own, in note-frame.css and editor.js)', () => {
  const css = zotero('second-brain.js');
  assert.deepEqual(css.match(/--sb-[\w-]+\s*:/g) ?? [], [], 'a --sb-* custom property is defined');
  assert.deepEqual(css.match(/var\(--sb-[\w-]+/g) ?? [], [], 'a --sb-* custom property is read');
});

// `sbs-` is the shared Settings view's prefix since spec 016 (ui.css, which styles.css carries); Obsidian's own sheets and
// views must not define or use one, and `sbc-` (the old chat CSS) stays gone everywhere.
test('Obsidian: no sbc- class anywhere, and no sbs- / sbc- class in the panel CSS or any view source', () => {
  assert.deepEqual(obsidian('styles.css').match(/\.sbc-[\w-]+/g) ?? [], [], 'styles.css');
  assert.deepEqual(obsidian('styles-panels.css').match(/\.(?:sbs|sbc)-[\w-]+/g) ?? [], [], 'styles-panels.css');
  for (const file of ['search', 'related', 'zotero', 'duplicates', 'status', 'links', 'main', 'chat', 'ui-host'].map((n) => `src/${n}.ts`)) {
    assert.deepEqual(obsidian(file).match(/["'`](?:sbs|sbc)-[\w-]+/g) ?? [], [], file);
  }
});

test('host stylesheets never define a rule whose selector starts with a shared panel class (.sb-p-*)', () => {
  const OWN = /(^|\n)\s*\.sb-p-[\w-]+[^{]*\{/;
  assert.doesNotMatch(zotero('search.css'), OWN, 'search.css');
  assert.doesNotMatch(obsidian('styles-panels.css'), OWN, 'styles-panels.css');
  assert.match('x\n.sb-p-row { color: red; }', OWN, 'sanity: the pattern catches a redefinition');
  assert.doesNotMatch('x\n.view-content:has(> .sb-p-search) { padding: 0; }', OWN, 'sanity: scoping under a host selector stays legal');
});
