import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl } from '../src/sources/view-kit.js';

test('script and odd schemes are refused, however they are disguised', () => {
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:x', 'jav\u0000ascript:x',
    'vbscript:x', 'data:text/html,<script>x</script>', 'file:///etc/passwd', 'blob:http://x/y', 'chrome://x']) {
    assert.equal(safeUrl(bad, 'href'), false, JSON.stringify(bad));
  }
});

test('web, mail, Zotero, Obsidian and relative links stay', () => {
  for (const ok of ['https://doi.org/10.1/x', 'http://example.org', 'mailto:a@b.org', 'zotero://select/library/items/ABC',
    'obsidian://open?vault=v', '#/paper/ABC', '/file?path=x.png', 'figure.png', '?q=1', '']) {
    assert.equal(safeUrl(ok, 'href'), true, ok);
  }
});

test('images may be data:image, links may not', () => {
  assert.equal(safeUrl('data:image/png;base64,AAAA', 'src'), true);
  assert.equal(safeUrl('data:image/png;base64,AAAA', 'href'), false);
  assert.equal(safeUrl('img1.png 1x, javascript:x 2x', 'srcset'), false);
  assert.equal(safeUrl('a.png 1x, https://x.org/b.png 2x', 'srcset'), true);
});
