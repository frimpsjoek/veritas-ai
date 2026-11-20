// Spec 031 R5/R6: the pure part of Get PDF, and getPapers against a fake host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outsidePaper, gotState, keptState, readLink, batchLine, stateWords } from '../src/get-paper-data.js';
import { getPapers } from '../src/get-paper.js';

const open = { access: 'open', pdfUrl: 'https://repo.example/a.pdf', via: 'OpenAlex' };
const pub = { access: 'publisher', page: 'https://doi.org/10.1/b' };
const none = { access: 'none' };

test('outsidePaper: a free copy goes along as the pdf; the DOI becomes the link', () => {
  const p = outsidePaper({ title: 'A', doi: 'https://doi.org/10.1/A', year: 1999 }, open);
  assert.deepEqual([p.pdf, p.url, p.doi, p.year], ['https://repo.example/a.pdf', 'https://doi.org/10.1/A', 'https://doi.org/10.1/A', 1999]);
  assert.equal(outsidePaper({ title: 'B', doi: null, url: 'https://x' }, pub).pdf, null);
});

test('gotState, readLink, batchLine, stateWords', () => {
  assert.deepEqual([gotState(open, true), gotState(pub, true), gotState(none, true), gotState(open, false)], ['pdf', 'publisher', 'searching', 'failed']);
  assert.deepEqual([readLink(open), readLink(pub), readLink(none)], ['https://repo.example/a.pdf', 'https://doi.org/10.1/b', null]);
  assert.equal(batchLine(['pdf', 'pdf', 'pdf', 'publisher', 'publisher', 'searching']), '3 with a free PDF · 2 need the publisher’s page · 1 not found yet (Zotero keeps looking)');
  assert.equal(batchLine(['publisher']), '1 needs the publisher’s page');
  assert.equal(stateWords('pdf'), 'Saved to Zotero with its PDF');
  assert.equal(stateWords('folder'), 'Saved to Veritas › Papers');
});

function fakeHost({ library = true, access = [open, pub, none], kind = 'zotero', keep = null } = {}) {
  const added = [];
  const opened = [];
  const kept = [];
  return {
    added, opened, kept, kind,
    can: { addToLibrary: library },
    ai: async () => ({ papers: { access: async (papers) => access.slice(0, papers.length), keep: async (p) => { kept.push(p); return keep(p, kept.length - 1); } } }),
    addToLibrary: library ? async (papers) => { added.push(...papers); return { items: papers.map(() => ({ key: 'K', citekey: '' })) }; } : undefined,
    openLink: (url) => opened.push(url),
    logError() {},
  };
}

test('getPapers with a library: each paper added, the free PDF attached; a single publisher-only paper opens its page', async () => {
  const host = fakeHost();
  const got = await getPapers(host, [{ title: 'A', doi: '10.1/a' }, { title: 'B', doi: '10.1/b' }, { title: 'C', doi: null }]);
  assert.deepEqual(got.states, ['pdf', 'publisher', 'searching']);
  assert.deepEqual(host.added.map((p) => p.pdf), ['https://repo.example/a.pdf', null, null]);
  assert.deepEqual(host.opened, []);
  const one = fakeHost({ access: [pub] });
  await getPapers(one, [{ title: 'B', doi: '10.1/b' }], { openOne: true });
  assert.deepEqual(one.opened, ['https://doi.org/10.1/b']);
});

test('spec 032 keptState: Zotero (now or when it opens), the Papers folder, the publisher, nothing', () => {
  assert.deepEqual([
    keptState({ status: 'added', where: 'zotero', downloaded: true }),
    keptState({ status: 'queued', where: 'zotero', downloaded: true }),
    keptState({ status: 'queued', where: 'zotero', downloaded: false, access: pub }),
    keptState({ status: 'queued', where: 'zotero', downloaded: false, access: none }),
    keptState({ status: 'kept', where: 'folder', downloaded: true }),
    keptState({ status: 'failed', where: 'folder', downloaded: false, access: pub }),
    keptState({ status: 'failed', where: 'folder', downloaded: false, access: none }),
    keptState({ status: 'failed', where: 'folder', downloaded: false, access: open }),
  ], ['pdf', 'waiting', 'publisher', 'searching', 'folder', 'publisher', 'nocopy', 'failed']);
});

test('spec 032 getPapers outside the Zotero pane: the engine keeps each paper; the publisher page is offered when no copy could be kept', async () => {
  const results = [
    { status: 'kept', where: 'folder', path: 'Papers/A.pdf', downloaded: true, access: open },
    { status: 'failed', where: 'folder', downloaded: false, access: pub },
  ];
  const host = fakeHost({ kind: 'web', library: false, keep: (_p, i) => results[i] });
  const got = await getPapers(host, [{ title: 'A', doi: '10.1/a', year: 2020 }, { title: 'B', doi: '10.1/b' }]);
  assert.deepEqual(got.states, ['folder', 'publisher']);
  assert.deepEqual(got.paths, ['Papers/A.pdf', null]);
  assert.deepEqual(got.links, [null, 'https://doi.org/10.1/b']);
  assert.deepEqual(host.kept.map((p) => [p.title, p.doi, p.year]), [['A', '10.1/a', 2020], ['B', '10.1/b', null]]);
  assert.deepEqual(host.added, []);
  const one = fakeHost({ kind: 'web', keep: () => results[1] });
  await getPapers(one, [{ title: 'B', doi: '10.1/b' }], { openOne: true });
  assert.deepEqual(one.opened, ['https://doi.org/10.1/b']);
});

test('getPapers: an engine that cannot look still adds the papers (no PDF)', async () => {
  const host = { ...fakeHost(), ai: async () => ({ papers: { access: async () => { throw new Error('down'); } } }) };
  const got = await getPapers(host, [{ title: 'A', doi: '10.1/a' }]);
  assert.deepEqual(got.states, ['searching']);
});
