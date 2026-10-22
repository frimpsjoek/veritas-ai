import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowOfItem, rowOfHit, sortRows, nextSort, visibleRange, treeRows, ancestorsOf, chipLabel, contextOf } from '../src/web/library-data.js';
import { parseRoute, formatRoute } from '../src/web/route.js';
import { protectMath, readerMarkdown, withoutFrontMatter, withoutComments, linkWikiTargets, noteFragment, authorLine, routeOfPath, openRefHandler } from '../src/web/view-kit.js';

const rows = [
  { key: 'A', title: 'beta', authors: ['Ann Chen'], year: 2020, venue: '', citekey: 'C20' },
  { key: 'B', title: 'Alpha', authors: [], year: null, venue: '', citekey: '' },
  { key: 'C', title: 'gamma', authors: ['A B', 'C D', 'E F'], year: 2023, venue: 'Nature', citekey: 'D23' },
];

test('rowOfItem drops the abstract and reads the year as a number', () => {
  const row = rowOfItem({ key: 'K', title: 'T', year: '2024', authors: ['X Y'], venue: 'V', citekey: 'XY24', abstract: 'long'.repeat(100) });
  assert.deepEqual(row, { key: 'K', title: 'T', authors: ['X Y'], year: 2024, venue: 'V', citekey: 'XY24' });
  assert.equal(rowOfItem({ key: 'K', title: '', year: '' }).year, null);
  assert.equal(rowOfItem({ key: 'K', title: '' }).title, 'Untitled');
});

test('rowOfHit keeps papers only', () => {
  assert.equal(rowOfHit({ path: 'notes/a.md', title: 'a' }), null);
  assert.equal(rowOfHit({ path: 'zotero/KEY1', title: 'P', zotero: { authors: ['A B'], year: '2021', venue: 'V', citekey: 'AB21' } })?.key, 'KEY1');
});

test('sortRows: year is newest first with undated last; title A to Z; dir flips; relevance keeps the server order', () => {
  assert.deepEqual(sortRows(rows, { by: 'year', dir: 1 }).map((r) => r.key), ['C', 'A', 'B']);
  assert.deepEqual(sortRows(rows, { by: 'year', dir: -1 }).map((r) => r.key), ['A', 'C', 'B']);
  assert.deepEqual(sortRows(rows, { by: 'title', dir: 1 }).map((r) => r.key), ['B', 'A', 'C']);
  assert.deepEqual(sortRows(rows, { by: 'title', dir: -1 }).map((r) => r.key), ['C', 'A', 'B']);
  assert.deepEqual(sortRows(rows, { by: 'relevance', dir: 1 }), rows);
});

test('nextSort: a new field starts in its natural direction, the same field flips', () => {
  assert.deepEqual(nextSort({ by: 'relevance', dir: 1 }, 'year'), { by: 'year', dir: 1 });
  assert.deepEqual(nextSort({ by: 'year', dir: 1 }, 'year'), { by: 'year', dir: -1 });
  assert.deepEqual(nextSort({ by: 'year', dir: -1 }, 'title'), { by: 'title', dir: 1 });
});

test('visibleRange: the rows in view plus a buffer, clamped to the table', () => {
  assert.deepEqual(visibleRange({ scrollTop: 0, viewport: 560, rowHeight: 56, total: 3500 }), { first: 0, last: 16 });
  assert.deepEqual(visibleRange({ scrollTop: 56 * 100, viewport: 560, rowHeight: 56, total: 3500 }), { first: 94, last: 116 });
  assert.deepEqual(visibleRange({ scrollTop: 56 * 3499, viewport: 560, rowHeight: 56, total: 3500 }), { first: 3493, last: 3500 });
  assert.deepEqual(visibleRange({ scrollTop: 0, viewport: 560, rowHeight: 56, total: 0 }), { first: 0, last: 0 });
});

const nodes = [
  { key: 'P', name: 'Physics', parent: null, count: 5 }, { key: 'C1', name: 'b child', parent: 'P', count: 2 },
  { key: 'C0', name: 'A child', parent: 'P', count: 1 }, { key: 'G', name: 'Grandchild', parent: 'C0', count: 1 },
  { key: 'Z', name: 'Alpha', parent: null, count: 9 }, { key: 'O', name: 'Orphan', parent: 'MISSING', count: 0 },
];

test('treeRows: name sorted, children only under open nodes, orphans at the top', () => {
  assert.deepEqual(treeRows(nodes, new Set()).map((r) => r.node.key), ['Z', 'O', 'P']);
  const open = treeRows(nodes, new Set(['P', 'C0']));
  assert.deepEqual(open.map((r) => [r.node.key, r.depth]), [['Z', 0], ['O', 0], ['P', 0], ['C0', 1], ['G', 2], ['C1', 1]]);
  assert.equal(open.find((r) => r.node.key === 'P')?.hasChildren, true);
  assert.equal(open.find((r) => r.node.key === 'Z')?.hasChildren, false);
});

test('ancestorsOf lists the chain to the root', () => {
  assert.deepEqual(ancestorsOf(nodes, 'G'), ['C0', 'P']);
  assert.deepEqual(ancestorsOf(nodes, 'P'), []);
});

test('ticked rows become chat context chips', () => {
  assert.equal(chipLabel(rows[2]), 'B et al. 2023');
  assert.equal(chipLabel(rows[0]), 'Chen 2020');
  assert.equal(chipLabel(rows[1]), 'Alpha');
  assert.deepEqual(contextOf([rows[0], rows[1]]).map((c) => [c.attachment.citekey, c.why]), [['C20', 'selected'], ['B', 'selected']]);
});

test('routes for the readers round-trip with spaces and slashes in note paths', () => {
  const route = { view: 'note', path: 'ai notes/mnemo/Idea (draft).md' };
  assert.deepEqual(parseRoute(formatRoute(route)), route);
  assert.deepEqual(parseRoute(formatRoute({ view: 'library', collection: 'ABCD1234' })), { view: 'library', collection: 'ABCD1234' });
  assert.deepEqual(routeOfPath('zotero/KEY1'), { view: 'paper', key: 'KEY1' });
  assert.deepEqual(routeOfPath('a/b.md'), { view: 'note', path: 'a/b.md' });
});

test('linkWikiTargets points known wiki links at the in-app note and keeps the label', () => {
  const known = ['ai_notes/mnemo/Lexi.md', 'People/Ann Chen.md'];
  const out = linkWikiTargets('See [[Lexi|the lexi]], [[ai_notes/mnemo/Lexi]], [[Ann Chen#Work]] and [[Nobody]] ![[pic.png]]', known);
  assert.equal(out, 'See [the lexi](#/note/ai_notes/mnemo/Lexi.md), [Lexi](#/note/ai_notes/mnemo/Lexi.md), [Ann Chen](#/note/People/Ann%20Chen.md) and [[Nobody]] ![pic.png](/file?name=pic.png)');
});

test('an image embed becomes a vault image found beside the note; other embeds stay as they are', () => {
  assert.equal(linkWikiTargets('![[attachments/fig 1.jpeg|300]] ![[Other note]] ![[deck.pdf]]', [], 'Papers/AB99 PBE.md'),
    '![fig 1.jpeg](/file?name=attachments%2Ffig+1.jpeg&note=Papers%2FAB99+PBE.md) ![[Other note]] ![[deck.pdf]]');
});

test('authorLine', () => {
  assert.equal(authorLine([]), '');
  assert.equal(authorLine(['A B']), 'A B');
  assert.equal(authorLine(['A', 'B']), 'A and B');
  assert.equal(authorLine(['A', 'B', 'C', 'D', 'E']), 'A, B, C and 2 more');
});

test('noteFragment is exercised in the browser checks (needs a DOM)', () => { assert.equal(typeof noteFragment, 'function'); });

test('openRefHandler: papers and notes open in the app, a PDF in any folder opens from the server', () => {
  const routes = [];
  const loaded = [];
  const open = openRefHandler({ location: { assign: (url) => loaded.push(url) } }, (route) => routes.push(route));
  open({ path: 'zotero/KEY1' });
  open({ path: 'a/b.md' });
  open({ path: 'Papers/Scan one.pdf' });
  assert.deepEqual(routes, [{ view: 'paper', key: 'KEY1' }, { view: 'note', path: 'a/b.md' }]);
  open({ path: 'papers:/scan.pdf' });
  open({ path: 'papers:/review.md' });
  assert.deepEqual(routes.slice(2), [{ view: 'note', path: 'papers:/review.md' }]);
  assert.deepEqual(loaded, ['/folder-file?path=Papers%2FScan+one.pdf', '/folder-file?path=papers%3A%2Fscan.pdf']);
});

test('withoutComments hides Obsidian %% comments, inline and across lines', () => {
  assert.equal(withoutComments('a %% hidden %% b\n%% zotero:start\nsynced %%\nc'), 'a  b\n\nc');
});

test('readerMarkdown: numbered sources become a list with the title linked and the address under it', () => {
  assert.equal(readerMarkdown('[1] https://doi.org/10.1103/PRB.98.1 — Large gaps in In2Se3\n[2] https://doi.org/10.1/x — Two'),
    '- **1.** [Large gaps in In2Se3](https://doi.org/10.1103/PRB.98.1)  \n  [doi.org/10.1103/PRB.98.1](https://doi.org/10.1103/PRB.98.1)\n- **2.** [Two](https://doi.org/10.1/x)  \n  [doi.org/10.1/x](https://doi.org/10.1/x)');
});

test('readerMarkdown: single line breaks stay breaks and bare addresses become links, as in Obsidian; code, lists and tables are left alone', () => {
  assert.equal(readerMarkdown('One\ntwo see https://example.org/a.\n\n- a\n- b\n| x |\n| - |'), 'One  \ntwo see <https://example.org/a>.\n\n- a\n- b\n| x |\n| - |');
  assert.equal(readerMarkdown('```\nhttps://code.x\nb\n```'), '```\nhttps://code.x\nb\n```');
  assert.equal(readerMarkdown('[link](https://a.org) and https://b.org'), '[link](https://a.org) and <https://b.org>');
});

test('withoutFrontMatter removes two properties blocks in a row', () => {
  assert.equal(withoutFrontMatter('---\na: 1\n---\n---\nb: 2\n---\nBody'), 'Body');
  assert.equal(withoutFrontMatter('Body\n---\nnot: front\n---'), 'Body\n---\nnot: front\n---');
});

test('readerMarkdown: a YouTube embed becomes its thumbnail linked to the video; an empty image is dropped', () => {
  assert.equal(readerMarkdown('![YouTube video](https://youtu.be/UngVdAsQEiU)'), '[![YouTube video](https://i.ytimg.com/vi/UngVdAsQEiU/hqdefault.jpg)](https://youtu.be/UngVdAsQEiU)');
  assert.equal(readerMarkdown('![](https://www.youtube.com/watch?v=cVSTxB_gJY8)'), '[![YouTube video](https://i.ytimg.com/vi/cVSTxB_gJY8/hqdefault.jpg)](https://www.youtube.com/watch?v=cVSTxB_gJY8)');
  assert.equal(readerMarkdown('a ![]() b'), 'a  b');
});

test('protectMath takes TeX out before rendering (so a_i b_i never becomes emphasis) and leaves code and money alone', () => {
  const out = protectMath('Sum $a_i b_i$ and \\(x^2\\), costs $5 and $10.\n\n$$\\hat H\\psi = E\\psi$$\n\n`$not math$`');
  assert.equal(out.markdown, 'Sum SBMATH1X and SBMATH2X, costs $5 and $10.\n\n\n\nSBMATH0X\n\n\n\n`$not math$`');
  assert.deepEqual(out.formulas, [{ tex: '\\hat H\\psi = E\\psi', display: true }, { tex: 'a_i b_i', display: false }, { tex: 'x^2', display: false }]);
});

test('protectMath: $$…$$ inside a sentence stays inline; on its own line it is a display equation', () => {
  const out = protectMath('variations $$|\\psi^1\\rangle$$ under a perturbation\n$$E = mc^2$$\nend');
  assert.deepEqual(out.formulas.map((f) => [f.tex, f.display]), [['|\\psi^1\\rangle', false], ['E = mc^2', true]]);
  assert.match(out.markdown, /^variations SBMATH0X under a perturbation\n\n\nSBMATH1X\n\n\nend$/);
});
