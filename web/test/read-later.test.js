// @ts-check
// Spec 028 R10-R12: the bookmark's state, the Read later view's sections and actions, and the rail badge, on a small
// fake DOM and an in-memory reading list. Invented papers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkButton, readingEntries, refreshReadingList, READING_LIST_CHANGED } from '../../ui/src/reading-list.js';
import { RadarDigest, likeMoved } from '../../ui/src/chat/radar-digest.js';
import { laterBadge, laterList, laterPane } from '../src/later-view.js';
import { addEntry, markEntry, removeEntry, newestFirst } from '../../agent/src/reading-list.js';
import { fakeDoc, fakeWin } from './support/fake-dom.js';

/** A host whose engine keeps the list in memory, as core.js does. */
function fakeHost(list = /** @type {any[]} */ ([])) {
  let now = 0;
  const at = () => `2026-11-1${now++}T00:00:00.000Z`;
  const calls = /** @type {string[]} */ ([]);
  const opened = /** @type {string[]} */ ([]);
  const readingList = {
    list: async () => newestFirst(list),
    add: async (/** @type {any} */ p) => { calls.push('add'); const out = addEntry(list, p, at()); list = out.list; return out.entry; },
    remove: async (/** @type {string} */ id) => { calls.push('remove'); const out = removeEntry(list, id); list = out.list; return { removed: out.changed }; },
    markRead: async (/** @type {string} */ id, read = true) => { calls.push(`read:${read}`); const out = markEntry(list, id, read, at()); list = out.list; return out.entry; },
  };
  return { calls, opened, ai: async () => ({ readingList }), logError() {}, notice() {}, openLink: (/** @type {string} */ url) => opened.push(url) };
}

const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };
const paper = (n) => ({ title: `Invented study ${n}`, authors: ['A. Vole'], year: 2026, venue: 'J. Invented', doi: `10.9999/inv.${n}`, abstract: '', url: `https://doi.org/10.9999/inv.${n}`, source: 'radar' });

test('the bookmark: hidden until the list is known, then "Read later"; pressed it says "Saved to read later"; again removes it', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const host = /** @type {any} */ (fakeHost());
  const b = /** @type {any} */ (bookmarkButton(doc, host, paper(1)));
  assert.equal(b.hidden, true);
  await flush();
  assert.equal(b.hidden, false);
  assert.equal(b.textContent, 'Read later');
  assert.equal(b.attrs['aria-pressed'], 'false');
  await b.click();
  await flush();
  assert.equal(b.textContent, 'Saved to read later');
  assert.equal(b.attrs['aria-pressed'], 'true');
  assert.equal(b.title, 'Remove from Read later');
  await b.click();
  await flush();
  assert.equal(b.textContent, 'Read later');
  assert.deepEqual(host.calls, ['add', 'remove']);
});

test('no reading list on this engine: no bookmark', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const host = /** @type {any} */ ({ ...fakeHost(), ai: async () => ({}) });
  const b = /** @type {any} */ (bookmarkButton(doc, host, paper(1)));
  await flush();
  assert.equal(b.hidden, true);
});

test('the view: Unread then Read; opening marks read; an entry in Zotero says so; the empty list has its line', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  let list = addEntry([], paper(1), '2026-11-01T00:00:00.000Z').list;
  list = addEntry(list, paper(2), '2026-11-02T00:00:00.000Z').list;
  list = addEntry(list, paper(3), '2026-11-03T00:00:00.000Z').list;
  list = markEntry(list, 'doi:10.9999/inv.2', true, '2026-11-04T00:00:00.000Z').list;
  const host = /** @type {any} */ (fakeHost(list));
  const root = /** @type {any} */ (laterList({ host, doc }, { inZotero: async () => new Map([['doi:10.9999/inv.3', 'AAAA1111']]) }));
  await flush();
  const sections = root.all().filter((/** @type {any} */ el) => el.dataset.section);
  assert.deepEqual(sections.map((/** @type {any} */ s) => s.dataset.section), ['Unread', 'Read']);
  const ids = (/** @type {any} */ s) => s.all().filter((/** @type {any} */ el) => el.dataset.id).map((/** @type {any} */ el) => el.dataset.id);
  assert.deepEqual(ids(sections[0]), ['doi:10.9999/inv.3', 'doi:10.9999/inv.1']);
  assert.deepEqual(ids(sections[1]), ['doi:10.9999/inv.2']);
  assert.match(sections[0].textContent, /In your Zotero library/);
  assert.match(sections[1].textContent, /Mark as unread/);
  const open = sections[0].all().find((/** @type {any} */ el) => el.tag === 'button' && el.textContent === 'Open');
  await open.click();
  await flush();
  assert.deepEqual(host.opened, ['https://doi.org/10.9999/inv.3']);
  assert.deepEqual(host.calls, ['read:true']);
  const after = root.all().filter((/** @type {any} */ el) => el.dataset.section);
  assert.deepEqual(ids(after[0]), ['doi:10.9999/inv.1']);

  const empty = /** @type {any} */ (laterList({ host: fakeHost(), doc: /** @type {any} */ (fakeDoc()) }));
  await flush();
  assert.equal(empty.textContent, 'Nothing saved to read later yet.');
});

test('the rail badge: unread entries, hidden at 0, and it follows every change', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const host = /** @type {any} */ (fakeHost(addEntry([], paper(1), '2026-11-01T00:00:00.000Z').list));
  const link = /** @type {any} */ (doc.createElementNS('', 'a'));
  const { badge } = /** @type {any} */ (laterBadge(doc, /** @type {any} */ (fakeWin()), host, link));
  await flush();
  assert.equal(badge.textContent, '1');
  assert.equal(badge.hidden, false);
  const b = /** @type {any} */ (bookmarkButton(doc, host, paper(2)));
  await flush();
  await b.click();
  await flush();
  assert.equal(badge.textContent, '2');
  const root = /** @type {any} */ (laterList({ host, doc }));
  await flush();
  for (const mark of root.all().filter((/** @type {any} */ el) => el.textContent === 'Mark as read')) { await mark.click(); await flush(); }
  assert.equal(badge.textContent, '0');
  assert.equal(badge.hidden, true);
});

test('the bookmark finds the paper by any of its ids: saved by its arXiv id, opened by its DOI', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const listed = addEntry([], { title: 'Invented GW', authors: [], year: 2026, venue: 'arXiv', doi: null, arxiv: '2611.00001', url: 'https://arxiv.org/abs/2611.00001', abstract: '', source: 'arxiv' }, '2026-11-01T00:00:00.000Z').list;
  const host = /** @type {any} */ (fakeHost(listed));
  const removed = /** @type {string[]} */ ([]);
  const ai = await host.ai();
  const remove = ai.readingList.remove;
  ai.readingList.remove = async (/** @type {string} */ id) => { removed.push(id); return remove(id); };
  host.ai = async () => ai;
  const b = /** @type {any} */ (bookmarkButton(doc, host, { ...paper(9), doi: '10.1103/inv.9', arxiv: '2611.00001v2', url: 'https://doi.org/10.1103/inv.9' }));
  await flush();
  assert.equal(b.textContent, 'Saved to read later');
  await b.click();
  await flush();
  assert.deepEqual(removed, ['arxiv:2611.00001']);
  assert.equal(b.textContent, 'Read later');
});

test('a button that left the page drops its listener on the next change, also when it was painted only once', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const host = /** @type {any} */ (fakeHost());
  const b = /** @type {any} */ (bookmarkButton(doc, host, paper(1)));
  await flush();
  assert.equal(doc.defaultView.count(READING_LIST_CHANGED), 1);
  b.isConnected = false;
  await refreshReadingList(host, doc);
  assert.equal(doc.defaultView.count(READING_LIST_CHANGED), 0);
});

test('a list that failed to read is not kept: the next call asks the engine again', async () => {
  let calls = 0;
  const host = /** @type {any} */ ({ logError() {}, ai: async () => ({ readingList: { list: async () => { calls += 1; if (calls === 1) throw new Error('offline'); return []; } } }) });
  assert.equal(await readingEntries(host), undefined, 'a failed read is not "no list" (null)');
  assert.deepEqual(await readingEntries(host), []);
  assert.equal(calls, 2);
  assert.deepEqual(await readingEntries(host), []);
  assert.equal(calls, 2, 'a list that was read is kept');
});

test('refreshes that answer out of order: only the newest one tells the window', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  /** @type {((list: any[]) => void)[]} */ const answers = [];
  const host = /** @type {any} */ ({ logError() {}, ai: async () => ({ readingList: { list: () => new Promise((r) => answers.push(r)) } }) });
  const told = /** @type {any[]} */ ([]);
  doc.defaultView.addEventListener(READING_LIST_CHANGED, (/** @type {any} */ e) => told.push(e.detail));
  const first = refreshReadingList(host, doc);
  const second = refreshReadingList(host, doc);
  await flush();
  assert.equal(answers.length, 2);
  answers[1](['newer']);
  await second;
  answers[0](['older']);
  await first;
  assert.deepEqual(told, [['newer']]);
  assert.deepEqual(await readingEntries(host), ['newer']);
});

test('the radar\'s later verdict: Undo takes the paper off the list only when the verdict put it there', async () => {
  const row = (/** @type {number} */ n) => ({ id: `r${n}`, title: `Invented study ${n}`, authors: [], year: 2026, venue: 'J. Invented', doi: `10.9999/inv.${n}`, abstract: '', url: '', radar: { key: `k${n}` } });
  const host = /** @type {any} */ (fakeHost(addEntry([], paper(1), '2026-11-01T00:00:00.000Z').list));
  const digest = /** @type {any} */ (Object.assign(Object.create(RadarDigest.prototype), { host, doc: fakeDoc(), laterAdded: new Set() }));
  // already listed before the verdict: Undo leaves it
  await digest.keepLater(row(1), true);
  await digest.keepLater(row(1), false);
  // listed by the verdict: Undo takes it off
  await digest.keepLater(row(2), true);
  await digest.keepLater(row(2), false);
  assert.deepEqual(host.calls, ['add', 'add', 'remove']);
  assert.deepEqual((await (await host.ai()).readingList.list()).map((/** @type {any} */ e) => e.id), ['doi:10.9999/inv.1']);
});

test('the rail badge stops listening for focus once disposed', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const win = /** @type {any} */ (fakeWin());
  const later = /** @type {any} */ (laterBadge(doc, win, /** @type {any} */ (fakeHost()), doc.createElementNS('', 'a')));
  assert.equal(win.count('focus'), 1);
  later.dispose();
  assert.equal(win.count('focus'), 0);
});

/** A host whose list reads fail while `fail.on` is set (the engine still adds and removes). */
function flakyHost(list = /** @type {any[]} */ ([])) {
  const host = fakeHost(list);
  const fail = { on: false };
  const real = host.ai;
  host.ai = async () => {
    const ai = await real();
    const list = ai.readingList.list;
    return { readingList: { ...ai.readingList, list: async () => { if (fail.on) throw new Error('offline'); return list(); } } };
  };
  return { host, fail };
}

test('a fresh read that fails keeps the last good list: nothing is told, the bookmark and the badge stay', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const { host, fail } = /** @type {any} */ (flakyHost(addEntry([], paper(1), '2026-11-01T00:00:00.000Z').list));
  const b = /** @type {any} */ (bookmarkButton(doc, host, paper(1)));
  const { badge } = /** @type {any} */ (laterBadge(doc, /** @type {any} */ (fakeWin()), host, doc.createElementNS('', 'a')));
  await flush();
  assert.equal(b.textContent, 'Saved to read later');
  const told = /** @type {any[]} */ ([]);
  doc.defaultView.addEventListener(READING_LIST_CHANGED, (/** @type {any} */ e) => told.push(e.detail));
  fail.on = true;
  await refreshReadingList(host, doc);
  await flush();
  assert.deepEqual(told, [], 'a failed read tells nobody');
  assert.equal(b.hidden, false);
  assert.equal(b.textContent, 'Saved to read later');
  assert.equal(badge.textContent, '1');
  assert.deepEqual((await readingEntries(host)).map((/** @type {any} */ e) => e.id), ['doi:10.9999/inv.1'], 'the last good list');
});

test('a bookmark just pressed stays visible when the read after the add fails', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const { host, fail } = /** @type {any} */ (flakyHost());
  const b = /** @type {any} */ (bookmarkButton(doc, host, paper(1)));
  await flush();
  assert.equal(b.hidden, false);
  fail.on = true;
  await b.click();
  await flush();
  assert.deepEqual(host.calls, ['add']);
  assert.equal(b.hidden, false);
});

test('the first read failing is not "no list" and not "Loading…" for ever: it says so, and a later read paints over it', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const { host, fail } = /** @type {any} */ (flakyHost());
  fail.on = true;
  const root = /** @type {any} */ (laterList({ host, doc }));
  await flush();
  assert.match(root.textContent, /^Couldn't load your Read later list\./);
  fail.on = false;
  await refreshReadingList(host, doc);
  await flush();
  assert.equal(root.textContent, 'Nothing saved to read later yet.');
});

test('the radar\'s later verdict: when "was it listed before" could not be read, Undo leaves the paper on the list', async () => {
  const row = { id: 'r3', title: 'Invented study 3', authors: [], year: 2026, venue: 'J. Invented', doi: '10.9999/inv.3', abstract: '', url: '', radar: { key: 'k3' } };
  const { host, fail } = /** @type {any} */ (flakyHost());
  const digest = /** @type {any} */ (Object.assign(Object.create(RadarDigest.prototype), { host, doc: fakeDoc(), laterAdded: new Set() }));
  fail.on = true;
  const ai = await host.ai();
  const add = ai.readingList.add;
  ai.readingList.add = async (/** @type {any} */ p) => { fail.on = false; return add(p); }; // the engine answers again from the add on
  host.ai = async () => ai;
  await digest.keepLater(row, true);
  await digest.keepLater(row, false);
  assert.deepEqual(host.calls, ['add']);
  assert.equal(digest.laterAdded.size, 0);
});

test('Open comes back after the open, also when the paper was read already or marking it read failed', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  let list = addEntry([], paper(1), '2026-11-01T00:00:00.000Z').list;
  list = markEntry(list, 'doi:10.9999/inv.1', true, '2026-11-02T00:00:00.000Z').list;
  list = addEntry(list, paper(2), '2026-11-03T00:00:00.000Z').list;
  const host = /** @type {any} */ (fakeHost(list));
  const ai = await host.ai();
  ai.readingList.markRead = async () => { throw new Error('offline'); };
  host.ai = async () => ai;
  const root = /** @type {any} */ (laterList({ host, doc }));
  await flush();
  const opens = root.all().filter((/** @type {any} */ el) => el.tag === 'button' && el.textContent === 'Open');
  assert.equal(opens.length, 2);
  for (const open of opens) { await open.click(); await flush(); assert.equal(open.disabled, false); }
  assert.equal(host.opened.length, 2);
});

test('a bookmark built but never put on the page drops its listener after two changes', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const host = /** @type {any} */ (fakeHost());
  const b = /** @type {any} */ (bookmarkButton(doc, host, paper(1)));
  b.isConnected = false;
  await flush();
  assert.equal(doc.defaultView.count(READING_LIST_CHANGED), 1);
  await refreshReadingList(host, doc);
  assert.equal(doc.defaultView.count(READING_LIST_CHANGED), 1, 'one change of grace, for a button put on the page a moment later');
  await refreshReadingList(host, doc);
  assert.equal(doc.defaultView.count(READING_LIST_CHANGED), 0);
});

test('a hidden Read later pane (Library\'s filter, not open) asks nothing of Zotero until it is shown', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const host = /** @type {any} */ (fakeHost(addEntry([], paper(1), '2026-11-01T00:00:00.000Z').list));
  let asked = 0;
  let open = false;
  const pane = laterPane({ host, doc }, { keep: true, hidden: () => !open, inZotero: async () => { asked += 1; return new Map(); } });
  await flush();
  await refreshReadingList(host, doc);
  await flush();
  assert.equal(asked, 0);
  open = true;
  pane.show();
  await flush();
  assert.equal(asked, 1);
  assert.match(/** @type {any} */ (pane.root).textContent, /Invented study 1/);
  await refreshReadingList(host, doc);
  await flush();
  assert.equal(asked, 2, 'shown, it repaints on every change');
});

test('the radar\'s later verdict: a paper saved in another window since the last read is not taken off by Undo', async () => {
  const row = { id: 'r4', title: 'Invented study 4', authors: [], year: 2026, venue: 'J. Invented', doi: '10.9999/inv.4', abstract: '', url: '', radar: { key: 'k4' } };
  const host = /** @type {any} */ (fakeHost([]));
  const digest = /** @type {any} */ (Object.assign(Object.create(RadarDigest.prototype), { host, doc: fakeDoc(), laterAdded: new Set() }));
  const ai = await host.ai();
  await readingEntries(host); // this window read the list while it was empty
  await ai.readingList.add({ title: row.title, authors: [], year: 2026, venue: row.venue, doi: row.doi, url: '', source: 'radar' }); // another window saves it
  await digest.keepLater(row, true);
  await digest.keepLater(row, false);
  assert.equal(digest.laterAdded.size, 0);
  assert.equal((await ai.readingList.list()).length, 1);
});

test('the radar\'s later verdict: a fresh read that fails gives an older list, and that is not taken as "not listed before"', async () => {
  const row = { id: 'r5', title: 'Invented study 5', authors: [], year: 2026, venue: 'J. Invented', doi: '10.9999/inv.5', abstract: '', url: '', radar: { key: 'k5' } };
  const { host, fail } = /** @type {any} */ (flakyHost());
  const digest = /** @type {any} */ (Object.assign(Object.create(RadarDigest.prototype), { host, doc: fakeDoc(), laterAdded: new Set() }));
  const ai = await host.ai();
  assert.deepEqual(await readingEntries(host), []); // a good read, while the list was empty
  await ai.readingList.add({ title: row.title, authors: [], year: 2026, venue: row.venue, doi: row.doi, url: '', source: 'radar' }); // another window saves it
  fail.on = true; // the fresh read fails and gives the empty list from before
  const add = ai.readingList.add;
  ai.readingList.add = async (/** @type {any} */ p) => { fail.on = false; return add(p); };
  host.ai = async () => ai;
  await digest.keepLater(row, true);
  await digest.keepLater(row, false);
  assert.equal(digest.laterAdded.size, 0);
  assert.equal((await ai.readingList.list()).length, 1);
});

test('spec 029 R9: likeMoved is true when a Like came or went, and only then', () => {
  assert.equal(likeMoved('shown', 'liked'), true);
  assert.equal(likeMoved('liked', 'shown'), true);
  assert.equal(likeMoved('liked', 'dismissed'), true);
  assert.equal(likeMoved(undefined, 'liked'), true);
  assert.equal(likeMoved('liked', 'liked'), false);
  assert.equal(likeMoved('shown', 'later'), false);
  assert.equal(likeMoved('dismissed', 'shown'), false);
});

test('spec 029 R9: a Like told from the reader reads the list again, so the badge and the bookmarks show the paper', async () => {
  const base = /** @type {any} */ (fakeHost());
  const ai = await base.ai();
  // the engine's Like puts the paper on the list (core.js likeToReading)
  ai.radar = { feedback: async () => { await ai.readingList.add(paper(7)); return { verdict: 'liked', changed: true }; } };
  const host = { ...base, ai: async () => ai };
  const doc = fakeDoc();
  const told = /** @type {any[]} */ ([]);
  /** @type {any} */ (doc.defaultView).addEventListener(READING_LIST_CHANGED, (/** @type {any} */ e) => told.push(e.detail));
  const digest = /** @type {any} */ (Object.assign(Object.create(RadarDigest.prototype), {
    host: { ...host, prefs: null }, doc, routine: 'r1', verdicts: new Map(), laterAdded: new Set(), waiting: new Set(), placed: new Map(), canAdd: false, paint() {}, say() {},
  }));
  const row = { id: 'r7', title: 'Invented study 7', authors: [], year: 2026, venue: 'J. Invented', doi: '10.9999/inv.7', abstract: '', url: '', radar: { key: 'doi:10.9999/inv.7' } };
  await digest.tell(row, 'liked');
  await flush();
  assert.equal(told.length, 1);
  assert.deepEqual(told[0].map((/** @type {any} */ e) => e.id), ['doi:10.9999/inv.7']);
});

test('spec 029 R1: a row shows two lines of the abstract (TeX drawn) and when it was saved; no abstract, no line', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  const added = new Date(Date.now() - 3 * 86_400_000).toISOString();
  let list = addEntry([], { ...paper(1), abstract: 'We find \\ce{C2H4O} opens its ring.' }, added).list;
  list = addEntry(list, paper(2), added).list;
  const root = /** @type {any} */ (laterList({ host: fakeHost(list), doc }));
  await flush();
  const rows = root.all().filter((/** @type {any} */ el) => el.dataset.id);
  const abstracts = rows.map((/** @type {any} */ r) => r.all().find((/** @type {any} */ el) => el.className === 'sbw-later-abstract')?.textContent ?? null);
  assert.deepEqual(abstracts, ['We find C2H4O opens its ring.', null]);
  assert.ok(rows.every((/** @type {any} */ r) => /Saved 3 days ago/.test(r.textContent)));
});

test('spec 029 R2: Mark as read and Remove are icon buttons whose words are the tooltip and the accessible name', async () => {
  const doc = /** @type {any} */ (fakeDoc());
  let list = addEntry([], paper(1), '2026-11-01T00:00:00.000Z').list;
  list = markEntry(addEntry(list, paper(2), '2026-11-02T00:00:00.000Z').list, 'doi:10.9999/inv.2', true, '2026-11-03T00:00:00.000Z').list;
  const root = /** @type {any} */ (laterList({ host: fakeHost(list), doc }));
  await flush();
  const buttons = root.all().filter((/** @type {any} */ el) => el.tag === 'button');
  const icons = buttons.filter((/** @type {any} */ b) => b.classList.contains('sbw-later-icon'));
  // spec 031 R5, spec 032: a paper not in the library also has Get PDF, before Mark as read
  assert.deepEqual(icons.map((/** @type {any} */ b) => [b.attrs['aria-label'], b.title]), [['Get PDF', 'Get PDF'], ['Mark as read', 'Mark as read'], ['Remove from Read later', 'Remove from Read later'], ['Get PDF', 'Get PDF'], ['Mark as unread', 'Mark as unread'], ['Remove from Read later', 'Remove from Read later']]);
  assert.ok(icons.every((/** @type {any} */ b) => b.kids.some((/** @type {any} */ k) => k.tag === 'svg')));
  assert.deepEqual(buttons.filter((/** @type {any} */ b) => !b.classList.contains('sbw-later-icon')).map((/** @type {any} */ b) => b.textContent), ['Open', 'Open']);
});

test('spec 029 R3: Read is folded at first; opened, it stays open on the next visit; nothing unread says so', async () => {
  let list = addEntry([], paper(1), '2026-11-01T00:00:00.000Z').list;
  list = markEntry(list, 'doi:10.9999/inv.1', true, '2026-11-02T00:00:00.000Z').list;
  const view = async () => { const root = /** @type {any} */ (laterList({ host: fakeHost(list), doc: /** @type {any} */ (fakeDoc()) })); await flush(); return root; };
  const first = await view();
  const fold = first.all().find((/** @type {any} */ el) => el.dataset.section === 'Read');
  assert.equal(fold.tag, 'details');
  assert.equal(fold.open, false);
  assert.match(fold.kids[0].textContent, /^Read · 1$/);
  assert.equal(first.all().find((/** @type {any} */ el) => el.classList.contains('sbw-later-none'))?.textContent, 'Nothing unread. What you have read is below.');
  fold.open = true;
  await fold.dispatch('toggle');
  const again = await view();
  assert.equal(again.all().find((/** @type {any} */ el) => el.dataset.section === 'Read').open, true, 'kept for the window');
  assert.equal(again.all().some((/** @type {any} */ el) => el.dataset.section === 'Unread'), false, 'Unread is never shown empty');
});

test('spec 029 R4: from ten papers a filter box and a sort switch; fewer, neither', async () => {
  const build = (/** @type {number} */ n) => {
    let list = /** @type {any[]} */ ([]);
    for (let i = 1; i <= n; i += 1) list = addEntry(list, { ...paper(i), title: i === 3 ? 'Møller–Plesset gaps in voles' : `Invented study ${i}`, authors: i === 4 ? ['K. Ohno'] : ['A. Vole'] }, `2026-11-${String(i).padStart(2, '0')}T00:00:00.000Z`).list;
    return list;
  };
  const view = async (/** @type {number} */ n) => { const root = /** @type {any} */ (laterList({ host: fakeHost(build(n)), doc: /** @type {any} */ (fakeDoc()) })); await flush(); return root; };
  const ids = (/** @type {any} */ root) => root.all().filter((/** @type {any} */ el) => el.dataset.id).map((/** @type {any} */ el) => el.dataset.id);
  const few = await view(9);
  assert.equal(few.all().some((/** @type {any} */ el) => el.classList.contains('sbw-later-bar')), false);
  const many = await view(12);
  const input = many.all().find((/** @type {any} */ el) => el.classList.contains('sbw-later-filter'));
  const sort = many.all().find((/** @type {any} */ el) => el.classList.contains('sbw-later-sort'));
  assert.ok(input && sort);
  assert.equal(ids(many)[0], 'doi:10.9999/inv.12', 'newest saved first');
  input.value = 'moller';
  await input.dispatch('input');
  await flush();
  assert.deepEqual(ids(many), ['doi:10.9999/inv.3'], 'accents and case off');
  input.value = 'ohno';
  await input.dispatch('input');
  await flush();
  assert.deepEqual(ids(many), ['doi:10.9999/inv.4'], 'authors are searched');
  input.value = 'zzz';
  await input.dispatch('input');
  await flush();
  assert.equal(many.textContent.includes('No papers match “zzz”.'), true);
  input.value = '';
  await input.dispatch('input');
  sort.value = 'oldest';
  await sort.dispatch('change');
  await flush();
  assert.equal(ids(many)[0], 'doi:10.9999/inv.1', 'oldest saved first');
  assert.equal(many.all().filter((/** @type {any} */ el) => el.classList.contains('sbw-later-bar')).length, 1, 'one bar, kept while typing');
});

test('spec 029 R11: a row asks the figure finder by DOI or arXiv id, and draws nothing until a picture loads', async () => {
  const asked = /** @type {string[]} */ ([]);
  let list = addEntry([], { ...paper(1), doi: undefined, arxiv: '2611.20723', url: 'https://arxiv.org/abs/2611.20723' }, '2026-11-01T00:00:00.000Z').list;
  list = addEntry(list, { ...paper(2), doi: undefined, url: 'https://example.org/only-a-page' }, '2026-11-02T00:00:00.000Z').list;
  const host = { ...fakeHost(list), json: async (/** @type {string} */ path) => { asked.push(path); return { image: 'https://example.org/toc.png' }; } };
  const root = /** @type {any} */ (laterList({ host, doc: /** @type {any} */ (fakeDoc()) }));
  await flush();
  assert.deepEqual(asked, ['/paper-figure?doi=&arxiv=2611.20723'], 'the page-only paper is not asked about');
  const boxes = root.all().filter((/** @type {any} */ el) => el.classList.contains('sbw-later-figure'));
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].hidden, true, 'hidden until the image has loaded');
  assert.equal(boxes[0].kids[0]?.src, 'https://example.org/toc.png');
});
