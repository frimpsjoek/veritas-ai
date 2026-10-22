// @ts-check
// Paths of listed folders (server spec 018) in the web app's helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderLabel, isDocumentPath, isListedPath, isNotePath, routeOfPath, titleFromPath } from '../src/web/view-kit.js';
import { folderDetail } from '../src/web/folders-view.js';

test('listed-folder paths are recognised, vault and Zotero paths are not', () => {
  assert.equal(isListedPath('papers:/review.md'), true);
  assert.equal(isListedPath('my-notes:/sub/x.txt'), true);
  assert.equal(isListedPath('Papers/review.md'), false);
  assert.equal(isListedPath('zotero/ABCD1234'), false);
});

test('notes, documents and folder labels', () => {
  assert.equal(isNotePath('papers:/plain.txt'), true);
  assert.equal(isNotePath('papers:/scan.pdf'), false);
  assert.equal(isDocumentPath('papers:/scan.PDF'), true);
  assert.equal(isDocumentPath('Notes/fig.png'), true);
  assert.equal(folderLabel('papers:/review.md'), 'papers');
  assert.equal(folderLabel('papers:/sub/deep/x.md'), 'papers/sub/deep');
  assert.equal(folderLabel('Voles/Seeds.md'), 'Voles');
  assert.equal(folderLabel('Seeds.md'), 'Vault');
  assert.equal(titleFromPath('papers:/sub/methods note.markdown'), 'methods note');
  assert.deepEqual(routeOfPath('papers:/review.md'), { view: 'note', path: 'papers:/review.md' });
});

test('a folder row says what it is', () => {
  assert.equal(folderDetail({ kind: 'plain', role: 'listed', documents: 1 }), 'Folder · 1 document');
  assert.equal(folderDetail({ kind: 'obsidian', role: 'off', documents: 9 }), 'Obsidian vault · switched off');
});

test('a source shows its logo when there is one, by label or id', async () => {
  const { logoFor, LOGOS } = await import('../src/logos.js');
  assert.equal(logoFor('arXiv')?.title, 'arXiv');
  assert.equal(logoFor('database:arxiv')?.title, 'arXiv');
  assert.equal(logoFor('Hugging Face papers')?.title, 'Hugging Face');
  assert.equal(logoFor('PubMed / Europe PMC')?.title, 'PubMed');
  assert.equal(logoFor('OpenAlex'), null, 'no logo: the monogram stays');
  assert.ok(Object.values(LOGOS).every((l) => /^[0-9A-F]{6}$/.test(l.hex) && l.path.startsWith('M')));
});

test('Pandoc superscript and subscript read as such, code and links untouched', async () => {
  const { pandocScripts } = await import('../src/web/view-kit.js');
  assert.equal(pandocScripts('FeO > CoO (d^6^ > d^7^)'), 'FeO > CoO (d<sup>6</sup> > d<sup>7</sup>)');
  assert.equal(pandocScripts('H~2~O and CO~2~'), 'H<sub>2</sub>O and CO<sub>2</sub>');
  assert.equal(pandocScripts('~~gone~~ and note[^1]'), '~~gone~~ and note[^1]');
  assert.equal(pandocScripts('see http://x.org/~a/~b and `a^b^`'), 'see http://x.org/~a/~b and `a^b^`');
});

test('a relative Markdown image loads from the server, beside its note', async () => {
  const { localImages, linkWikiTargets } = await import('../src/web/view-kit.js');
  const out = localImages('![Approach](data/2026-10-12/drawio_approach.png)', '2026/10-October/2026-10-12.md');
  assert.equal(out, '![Approach](/file?path=data%2F2026-10-12%2Fdrawio_approach.png&note=2026%2F10-October%2F2026-10-12.md)');
  assert.equal(localImages('![w](https://x.org/a.png) ![a](/abs.png)', 'n.md'), '![w](https://x.org/a.png) ![a](/abs.png)');
  assert.equal(localImages('![x](my%20fig.png)', 'papers:/r.md'), '![x](/file?path=my+fig.png&note=papers%3A%2Fr.md)');
  assert.match(linkWikiTargets('![A](fig.png)', [], 'n.md'), /\/file\?path=fig\.png/, 'the reader applies it');
});

test('a source with no bundled logo gets its site icon address: journal, feed, known database', async () => {
  const { siteIconUrl } = await import('../src/logos.js');
  assert.equal(siteIconUrl({ label: 'npj Computational Materials', openalexId: 'https://openalex.org/S2764667089' }), '/site-icon?openalex=S2764667089');
  assert.equal(siteIconUrl({ label: 'Journal feed', url: 'https://www.nature.com/npjcompumats.rss' }), '/site-icon?domain=nature.com');
  assert.equal(siteIconUrl({ label: 'OpenAlex' }), '/site-icon?domain=openalex.org');
  assert.equal(siteIconUrl({ label: 'database:crossref' }), '/site-icon?domain=crossref.org');
  assert.equal(siteIconUrl({ label: 'Something unknown' }), null);
});

test('who wrote a note: an agent folder is AI, any other note the person, a paper neither', async () => {
  const { authorOf } = await import('../src/avatars.js');
  assert.equal(authorOf('ai_notes/review-2026-10-21.md'), 'ai');
  assert.equal(authorOf('copilot/chat.md'), 'ai');
  assert.equal(authorOf('2026/10-October/2026-10-12.md'), 'human');
  assert.equal(authorOf('papers:/ai_notes/x.md'), 'ai', 'also in a listed folder');
  assert.equal(authorOf('zotero/ABCD1234'), null);
});
