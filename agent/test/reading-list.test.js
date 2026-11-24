// Spec 028 R8/R9: the Read later list. Pure helpers, the store at <dataDir>/reading-list.json, and the service through
// core, remote.js and the agentd routes. Invented papers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idOf, idsOf, addEntry, removeEntry, markEntry, normaliseList, createReadingListStore, READING_LIST_FILE, shownPaper, likedPapers, addLiked, removeLiked } from '../src/reading-list.js';
import { createLocalRuntime } from '../src/core.js';
import { createRemoteRuntime } from '../src/remote.js';
import { routes } from '../src/node/agentd.mjs';
import { memoryFs } from './support/memory-fs.mjs';

const t0 = '2026-11-01T00:00:00.000Z';
const t1 = '2026-11-02T00:00:00.000Z';
const paper = (over = {}) => ({ title: 'Invented spindles in voles', authors: ['A. Vole', 'B. Mole'], year: 2026, venue: 'J. Invented', doi: '10.9999/inv.1', abstract: 'We invent.', url: 'https://doi.org/10.9999/inv.1', source: 'radar', ...over });

test('idOf: doi first (lowercase, no resolver prefix), then arXiv without its version, then the address', () => {
  assert.equal(idOf(paper({ doi: 'https://doi.org/10.9999/INV.1' })), 'doi:10.9999/inv.1');
  assert.equal(idOf(paper({ doi: null, arxiv: '2611.20723v2' })), 'arxiv:2611.20723');
  assert.equal(idOf(paper({ doi: null, arxiv: '2611.20723v1.pdf' })), 'arxiv:2611.20723');
  assert.equal(idOf(paper({ doi: '', arxiv: null, url: ' https://example.org/p ' })), 'url:https://example.org/p');
  assert.equal(idOf({ title: 'nothing to find it by' }), null);
});

test('idOf: the arXiv DOI, arXiv addresses and doi.org addresses are the ids they stand for', () => {
  assert.equal(idOf(paper({ doi: '10.48550/arXiv.2611.20723' })), 'arxiv:2611.20723');
  assert.equal(idOf(paper({ doi: 'https://doi.org/10.48550/ARXIV.2611.20723v2' })), 'arxiv:2611.20723');
  assert.equal(idOf(paper({ doi: null, url: 'https://arxiv.org/abs/2611.20723v3' })), 'arxiv:2611.20723');
  assert.equal(idOf(paper({ doi: null, url: 'https://arxiv.org/pdf/2611.20723v1.pdf' })), 'arxiv:2611.20723');
  assert.equal(idOf(paper({ doi: null, url: 'http://export.arxiv.org/abs/cond-mat/0101001' })), 'arxiv:cond-mat/0101001');
  assert.equal(idOf(paper({ doi: null, url: 'https://doi.org/10.9999/INV.1' })), 'doi:10.9999/inv.1');
  assert.equal(idOf(paper({ doi: null, url: 'https://dx.doi.org/10.48550/arXiv.2611.20723' })), 'arxiv:2611.20723');
  // every id a paper can be found by, the listed one first
  assert.deepEqual(idsOf(paper({ arxiv: '2611.20723v2', url: 'https://example.org/p' })), ['doi:10.9999/inv.1', 'arxiv:2611.20723', 'url:https://example.org/p']);
  assert.deepEqual(idsOf(paper({ doi: '10.48550/arxiv.2611.20723', arxiv: '2611.20723', url: 'https://arxiv.org/abs/2611.20723' })), ['arxiv:2611.20723']);
  assert.deepEqual(idsOf({ title: 'nothing' }), []);
  // the same paper by its arXiv DOI and by its arXiv id is one entry
  const one = addEntry([], paper({ doi: '10.48550/arXiv.2611.20723' }), t0);
  assert.equal(one.entry.arxiv, '2611.20723');
  assert.equal(addEntry(one.list, paper({ doi: null, arxiv: '2611.20723v1' }), t1).changed, false);
});

test('normaliseList: entries saved under an alias id read under the id they stand for, and dedupe', () => {
  const kept = normaliseList({ entries: [
    { id: 'doi:10.48550/arxiv.2611.20723', title: 'A', added: t0 },
    { id: 'arxiv:2611.20723', title: 'A again', added: t1 },
    { id: 'url:https://doi.org/10.9999/inv.1', title: 'B', added: t0 },
    { id: 'url:https://arxiv.org/abs/2611.00001v2', title: 'C', added: t0 },
  ] });
  assert.deepEqual(kept.map((e) => [e.id, e.title]), [['arxiv:2611.20723', 'A'], ['doi:10.9999/inv.1', 'B'], ['arxiv:2611.00001', 'C']]);
  // an old client's id still finds its entry
  assert.equal(removeEntry(kept, 'doi:10.48550/arxiv.2611.20723').changed, true);
  assert.equal(markEntry(kept, 'url:https://doi.org/10.9999/inv.1', true, t1).entry.id, 'doi:10.9999/inv.1');
});

test('addEntry: a new paper goes in with `added`; the same id again is a no-op that keeps the first `added`', () => {
  const one = addEntry([], paper(), t0);
  assert.equal(one.changed, true);
  assert.deepEqual(one.entry, { id: 'doi:10.9999/inv.1', title: 'Invented spindles in voles', authors: ['A. Vole', 'B. Mole'], year: 2026, venue: 'J. Invented', doi: '10.9999/inv.1', url: 'https://doi.org/10.9999/inv.1', abstract: 'We invent.', source: 'radar', added: t0 });
  const again = addEntry(one.list, paper({ title: 'Other title', doi: '10.9999/INV.1' }), t1);
  assert.equal(again.changed, false);
  assert.equal(again.list.length, 1);
  assert.equal(again.entry.added, t0);
  assert.equal(again.entry.title, 'Invented spindles in voles');
  assert.throws(() => addEntry([], { title: 'x' }, t0), /no DOI, arXiv id or address/);
  assert.throws(() => addEntry([], paper({ title: '  ' }), t0), /no title/);
});

test('an arXiv paper keeps its arxiv id and the arXiv address', () => {
  const { entry } = addEntry([], { title: 'GW for invented molecules', authors: [], year: 2026, venue: 'arXiv', doi: null, arxiv: '2611.00001v3', url: 'https://arxiv.org/abs/2611.00001v3', abstract: '', source: 'arxiv' }, t0);
  assert.equal(entry.id, 'arxiv:2611.00001');
  assert.equal(entry.arxiv, '2611.00001');
  assert.equal('doi' in entry, false);
  assert.equal('abstract' in entry, false);
});

test('removeEntry and markEntry: by id; read stores when, unread drops it; an unknown id is refused for markEntry', () => {
  const { list } = addEntry([], paper(), t0);
  const read = markEntry(list, 'doi:10.9999/inv.1', true, t1);
  assert.equal(read.entry.read, t1);
  assert.equal(markEntry(read.list, 'doi:10.9999/inv.1', true, '2026-11-09T00:00:00.000Z').changed, false);
  const unread = markEntry(read.list, 'doi:10.9999/inv.1', false, t1);
  assert.equal('read' in unread.entry, false);
  assert.throws(() => markEntry(list, 'doi:nope', true, t1), /not on your Read later list/);
  assert.deepEqual(removeEntry(list, 'doi:nope'), { list, changed: false });
  assert.deepEqual(removeEntry(list, 'doi:10.9999/inv.1'), { list: [], changed: true });
});

test('normaliseList: a bad file, a wrong shape, broken and duplicate entries read as what can be kept', () => {
  assert.deepEqual(normaliseList(null), []);
  assert.deepEqual(normaliseList({ entries: 'no' }), []);
  const kept = normaliseList({ entries: [{ id: 'doi:x', title: 'X', added: t0, authors: 'not a list' }, { title: 'no id' }, { id: 'doi:x', title: 'dup', added: t1 }, 7] });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, 'X');
  assert.deepEqual(kept[0].authors, []);
});

test('the store: one JSON file written atomically; a file that does not parse reads as an empty list', async () => {
  const fs = memoryFs();
  const store = createReadingListStore(fs, 'data');
  assert.equal(READING_LIST_FILE, 'reading-list.json');
  assert.deepEqual(await store.read(), []);
  const { list } = addEntry([], paper(), t0);
  await store.write(list);
  assert.deepEqual(JSON.parse(fs.files.get('data/reading-list.json')).entries.map((e) => e.id), ['doi:10.9999/inv.1']);
  fs.files.set('data/reading-list.json', '{ half written');
  assert.deepEqual(await store.read(), []);
});

const noopLibrary = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
const provider = {
  id: 'fake', caps: {},
  async status() { return { provider: 'fake', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
  async models() { return []; }, async signIn() { throw new Error('n/a'); }, async signOut() {},
  async *turn() { yield { type: 'final', text: 'ok', json: null, usage: {} }; },
  async dispose() {},
};
const gateway = {
  open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
  mcpServers: { async reports() { return []; }, async save(config) { return { config, state: 'connected', error: null, tools: [] }; }, async remove() {}, rows: () => [] },
  async dispose() {},
};

async function runtime(fs = memoryFs(), clock = { t: Date.parse(t0) }) {
  const ai = await createLocalRuntime({
    platform: { fs }, library: noopLibrary, notes: {}, dataDir: 'data', providers: new Map([['fake', provider]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }), clock: () => clock.t,
  });
  return { ai, fs, clock };
}

test('the store: a file that does not parse is kept aside as reading-list.json.bad-<time> before it is written over', async () => {
  const fs = memoryFs();
  const store = createReadingListStore(fs, 'data', () => Date.parse(t1));
  fs.files.set('data/reading-list.json', '{ half written');
  assert.deepEqual(await store.read(), []);
  const { list } = addEntry([], paper(), t0);
  await store.write(list);
  assert.equal(fs.files.get('data/reading-list.json.bad-2026-11-02T00-00-00-000Z'), '{ half written');
  assert.deepEqual(JSON.parse(fs.files.get('data/reading-list.json')).entries.map((e) => e.id), ['doi:10.9999/inv.1']);
  // once kept aside, later writes do not copy it again
  await store.read();
  await store.write([]);
  assert.equal([...fs.files.keys()].filter((k) => k.includes('.bad-')).length, 1);
});

test('ai.readingList: an add over a file that does not parse keeps the old file aside', async () => {
  const fs = memoryFs();
  fs.files.set('data/reading-list.json', 'not json');
  const { ai } = await runtime(fs);
  assert.deepEqual(await ai.readingList.list(), []);
  await ai.readingList.add(paper());
  assert.equal(fs.files.get('data/reading-list.json.bad-2026-11-01T00-00-00-000Z'), 'not json');
  assert.equal((await ai.readingList.list()).length, 1);
  await ai.dispose();
});

test('ai.readingList: add, dedupe, list newest first, markRead, remove; it persists across a restart', async () => {
  const { ai, fs, clock } = await runtime();
  await ai.readingList.add(paper());
  clock.t = Date.parse(t1);
  await ai.readingList.add(paper({ doi: '10.9999/inv.2', title: 'Second', url: 'https://doi.org/10.9999/inv.2' }));
  await ai.readingList.add(paper()); // already listed
  assert.deepEqual((await ai.readingList.list()).map((e) => e.id), ['doi:10.9999/inv.2', 'doi:10.9999/inv.1']);
  const read = await ai.readingList.markRead('doi:10.9999/inv.1');
  assert.equal(read.read, t1);
  await ai.dispose();
  const again = await runtime(fs);
  const list = await again.ai.readingList.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((e) => e.id === 'doi:10.9999/inv.1').added, t0);
  assert.equal((await again.ai.readingList.markRead('doi:10.9999/inv.1', false)).read, undefined);
  assert.deepEqual(await again.ai.readingList.remove('doi:10.9999/inv.2'), { removed: true });
  assert.deepEqual(await again.ai.readingList.remove('doi:10.9999/inv.2'), { removed: false });
  assert.deepEqual((await again.ai.readingList.list()).map((e) => e.id), ['doi:10.9999/inv.1']);
  await again.ai.dispose();
});

test('two adds at once both land (writes are serialised)', async () => {
  const { ai } = await runtime();
  await Promise.all([1, 2, 3].map((n) => ai.readingList.add(paper({ doi: `10.9999/inv.${n}` }))));
  assert.equal((await ai.readingList.list()).length, 3);
  await ai.dispose();
});

test('the agentd routes and remote.js reach the same service', async () => {
  const { ai } = await runtime();
  const table = routes();
  const transport = {
    async request(method, path, body) {
      const [bare, query] = path.split('?');
      const row = table.find((x) => x.method === method && x.path === bare);
      assert.ok(row, `${method} ${bare} has a route`);
      const out = await row.call(ai, body ?? Object.fromEntries(new URLSearchParams(query ?? '')), { signal: new AbortController().signal });
      return out === undefined ? null : JSON.parse(JSON.stringify(out));
    },
    async *stream() {},
  };
  const remote = createRemoteRuntime(transport);
  const entry = await remote.readingList.add(paper());
  assert.equal(entry.id, 'doi:10.9999/inv.1');
  assert.equal((await remote.readingList.markRead(entry.id, true)).read, t0);
  assert.deepEqual((await remote.readingList.list()).map((e) => e.id), [entry.id]);
  assert.deepEqual(await remote.readingList.remove(entry.id), { removed: true });
  assert.deepEqual(await ai.readingList.list(), []);
  await ai.dispose();
});

const shown = (n, over = {}) => ({ keys: [`doi:10.9999/like.${n}`, `title:liked paper ${n}`], title: `Liked paper ${n}`, text: `Liked paper ${n}. What it found, in full.`, authors: ['A. Vole'], venue: 'J. Invented', sources: ['feed'], ...over });

test('spec 029: shownPaper keeps the title, authors, venue, DOI and the abstract after the title', () => {
  assert.deepEqual(shownPaper(shown(1)), { title: 'Liked paper 1', authors: ['A. Vole'], venue: 'J. Invented', doi: '10.9999/like.1', abstract: 'What it found, in full.', source: 'radar' });
  assert.equal(shownPaper(shown(2, { keys: ['arxiv:2611.20723'], text: 'Liked paper 2' })).arxiv, '2611.20723');
  assert.equal(shownPaper(shown(2, { text: 'Liked paper 2' })).abstract, undefined, 'a text that is only the title has no abstract');
});

test('spec 029: likedPapers lists only liked papers, found by any of their keys, oldest Like first', () => {
  const state = {
    shown: { a: shown(1), b: shown(2), c: shown(3) },
    seen: { 'doi:10.9999/like.1': { verdict: 'liked', at: t1 }, 'title:liked paper 2': { verdict: 'liked', at: t0 }, 'doi:10.9999/like.3': { verdict: 'dismissed', at: t0 } },
  };
  assert.deepEqual(likedPapers(/** @type {any} */ (state)).map((l) => [l.paper.title, l.at]), [['Liked paper 2', t0], ['Liked paper 1', t1]]);
});

test('spec 029: addLiked adds what is not listed, at the Like time, via like; removeLiked takes off only those', () => {
  const hand = addEntry([], paper({ doi: '10.9999/like.1' }), t0).list;
  const out = addLiked(hand, [{ paper: shownPaper(shown(1)), at: t1 }, { paper: shownPaper(shown(2)), at: t1 }, { paper: { title: '' }, at: t1 }]);
  assert.equal(out.added, 1);
  assert.deepEqual(out.list.map((e) => [e.id, e.via ?? null, e.added]), [['doi:10.9999/like.1', null, t0], ['doi:10.9999/like.2', 'like', t1]]);
  assert.equal(removeLiked(out.list, shownPaper(shown(1))).changed, false, 'saved by hand: stays');
  assert.deepEqual(removeLiked(out.list, shownPaper(shown(2))).list.map((e) => e.id), ['doi:10.9999/like.1']);
});
