import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newForm, formFromRoutine, draftFromForm, learnedNote, learningText, learningOf } from '../src/chat/radar-data.js';
import { catalogOf, isLearned, dropLearned, isFollowed, setFollowed, followedCount, suggestionOf, addTyped, startEmpty, monogram, sourceLabels, whenText, journalRow } from '../src/web/sources-data.js';

const seed = {
  topics: [{ text: 'vole foraging', weight: 1, origin: 'seed' }, { text: 'Burrow Ecology', weight: 0.5, origin: 'seed' }],
  authors: [{ name: 'A. Bramblewood', weight: 1, origin: 'seed', openalexId: 'A1', match: 'A. Bramblewood, 120 works' }, { name: 'C. Quills', weight: 0.8, origin: 'seed', openalexId: null, match: null }],
  journals: [{ name: 'Annals of Burrowing', weight: 0.4, origin: 'seed', openalexId: 'S2', match: 'x' }, { name: 'Journal of Invented Zoology', weight: 1, origin: 'seed', openalexId: 'S1', match: 'y' }],
};
const fresh = () => startEmpty(newForm());
const every = (c) => Object.values(c).flat();

test('a new radar from the Sources page starts with nothing followed, so the ring counts what was picked', () => {
  const f = fresh();
  assert.equal(followedCount(f), 0);
  assert.equal(followedCount(newForm()), 3, 'the setup sheet keeps its three default databases');
});

test('the catalog lists the library\'s suggestions and every database', () => {
  const f = fresh();
  const c = catalogOf(f, seed);
  assert.deepEqual(c.topics.map((e) => e.label), ['vole foraging', 'Burrow Ecology']);
  assert.equal(c.databases.length, 7);
  assert.ok(every(c).every((e) => !isFollowed(f, e)));
  assert.deepEqual(c.journals.map((e) => e.key), ['S2', 'S1']);
});

test('following and unfollowing each kind of chip edits the form, and what is followed becomes the person\'s own', () => {
  const f = fresh();
  const c = catalogOf(f, seed);
  for (const e of [c.topics[0], c.authors[0], c.journals[1], c.databases.find((d) => d.key === 'arxiv')]) setFollowed(f, e, true);
  assert.equal(followedCount(f), 4);
  assert.deepEqual(f.profile.topics, [{ text: 'vole foraging', weight: 1, origin: 'user' }]);
  assert.equal(f.profile.authors[0].origin, 'user');
  assert.equal(f.profile.journals[0].openalexId, 'S1');
  assert.equal(f.databases.arxiv, true);
  setFollowed(f, c.topics[0], true);
  assert.equal(f.profile.topics.length, 1, 'following twice adds nothing');
  for (const e of [c.topics[0], c.authors[0], c.journals[1], c.databases.find((d) => d.key === 'arxiv')]) setFollowed(f, e, false);
  assert.equal(followedCount(f), 0);
  assert.deepEqual(f.profile, { topics: [], authors: [], journals: [] });
});

test('the topic key ignores case and spacing, so a typed repeat is the same topic', () => {
  const f = fresh();
  const c = catalogOf(f, seed);
  assert.equal(addTyped(f, c, 'topics', '  burrow   ecology ').label, 'Burrow Ecology'.toLowerCase().replace(/^./, 'b') && 'burrow ecology');
  assert.equal(followedCount(f), 1);
  assert.equal(c.topics.length, 2, 'the suggestion chip is the same chip');
  assert.equal(addTyped(f, c, 'topics', 'BURROW ECOLOGY'), null, 'already followed');
  assert.equal(addTyped(f, c, 'topics', '   '), null);
  const added = addTyped(f, c, 'topics', 'vole dispersal');
  assert.equal(c.topics.at(-1), added);
  assert.equal(addTyped(f, c, 'authors', 'Dana Typed').group, 'authors');
  assert.equal(f.profile.authors[0].openalexId, null);
});

test('the suggestion is the highest-weight journal or author not yet followed, one after another, and says which', () => {
  const f = fresh();
  const order = [];
  for (let next = suggestionOf(f, seed); next && order.length < 6; next = suggestionOf(f, seed)) { order.push(next.text); setFollowed(f, next.entry, true); }
  assert.deepEqual(order, ['Follow Journal of Invented Zoology, the journal your library cites most.', 'Follow A. Bramblewood, the author your library cites most.', 'Follow C. Quills, the author your library cites most.', 'Follow Annals of Burrowing, the journal your library cites most.']);
  assert.equal(suggestionOf(f, seed), null);
  assert.equal(suggestionOf(fresh(), null), null);
});

test('a journal found by name is a source row; unfollowing it removes it, following it again puts it back', () => {
  const f = fresh();
  const c = catalogOf(f, seed);
  const row = journalRow({ openalexId: 'S9', name: 'Invented Letters', issn: '1111-2222' });
  setFollowed(f, row, true);
  assert.deepEqual(f.journals.map((j) => [j.openalexId, j.on]), [['S9', true]]);
  assert.ok(isFollowed(f, row));
  setFollowed(f, row, false);
  assert.equal(f.journals.length, 0);
  assert.equal(followedCount(f), 0);
  void c;
});

test('a saved radar comes back with the same things followed, feeds included, and the draft round-trips', () => {
  const f = fresh();
  const c = catalogOf(f, seed);
  setFollowed(f, c.topics[0], true);
  setFollowed(f, c.journals[1], true);
  f.feeds.push({ url: 'https://good.example/rss', title: 'Good feed', on: true });
  const draft = draftFromForm(f);
  const back = formFromRoutine({ ...draft, id: 'r1' });
  assert.equal(followedCount(back), 3);
  const again = catalogOf(back, null);
  assert.deepEqual(every(again).filter((e) => isFollowed(back, e)).map((e) => e.label).sort(), ['Good feed', 'Journal of Invented Zoology', 'vole foraging']);
  setFollowed(back, again.feeds[0], false);
  assert.equal(followedCount(back), 2);
  assert.equal(back.feeds.length, 1, 'an unfollowed feed stays listed, switched off');
  setFollowed(back, again.feeds[0], true);
  assert.equal(followedCount(back), 3);
});

test('the explainer names the schedule and draws up to six followed sources, databases first', () => {
  const f = fresh();
  assert.equal(whenText(f), 'Every day, at 07:00. Change it any time in Routines.');
  const c = catalogOf(f, seed);
  setFollowed(f, c.journals[1], true);
  setFollowed(f, c.databases[0], true);
  f.feeds.push({ url: 'https://good.example/rss', title: 'Good feed', on: true });
  assert.deepEqual(sourceLabels(f), ['arXiv', 'Good feed', 'Journal of Invented Zoology']);
  assert.equal(monogram('Journal of Invented Zoology'), 'JI');
  assert.equal(monogram('arXiv'), 'Ar');
  assert.equal(monogram('  '), '?');
});

test('a followed author matched on OpenAlex and the same name suggested by the library make one chip', async () => {
  const { catalogOf } = await import('../src/web/sources-data.js');
  const form = { profile: { topics: [], authors: [{ name: 'Giulia Galli', openalexId: 'A5058293814', weight: 1, origin: 'seed' }], journals: [{ name: 'Physical Review B', openalexId: 'S1', weight: 1, origin: 'seed' }] }, journals: [], feeds: [], databases: {}, mcp: [] };
  const out = catalogOf(form, { authors: [{ name: 'giulia  galli', count: 9 }, { name: 'Marco Govoni', count: 5 }], journals: [{ name: 'Physical Review B', count: 40 }] });
  assert.deepEqual(out.authors.map((e) => e.label), ['Giulia Galli', 'Marco Govoni']);
  assert.deepEqual(out.journals.map((e) => e.label), ['Physical Review B']);
});

test('a learned topic is a Learned chip: not a toggle, with the papers it came from, and removing it clears form and catalog (spec 017)', () => {
  const f = formFromRoutine({ name: 'r', schedule: { days: { kind: 'daily' }, times: { kind: 'at', times: ['07:00'] } }, radar: { scope: { kind: 'library' }, profile: { topics: [{ text: 'vole foraging', weight: 1, origin: 'user' }, { text: 'moiré excitons', weight: 0.6, origin: 'learned', papers: 3 }], authors: [], journals: [] }, sources: [], size: { fresh: 8, older: 1 }, note: true } });
  const c = catalogOf(f, seed);
  const learned = c.topics.find((e) => e.label === 'moiré excitons');
  assert.equal(isLearned(learned), true);
  assert.equal(isLearned(c.topics.find((e) => e.label === 'vole foraging')), false);
  assert.equal(isFollowed(f, learned), true);
  assert.equal(learnedNote(learned.value), 'from 3 papers you kept');
  assert.equal(learnedNote({ text: 'x', weight: 1, origin: 'learned', papers: 1 }), 'from 1 paper you kept');
  dropLearned(f, c, learned);
  assert.deepEqual(f.profile.topics.map((t) => t.text), ['vole foraging']);
  assert.ok(!c.topics.some((e) => e.label === 'moiré excitons'));
});

test('"Learning…" lists phrases still short of three papers, as "2 of 3"', () => {
  const routine = { radarLearning: [{ text: 'spin liquids', count: 2 }, { text: 'odd', count: 3 }, { text: 'moiré excitons', count: 2 }] };
  assert.deepEqual(learningOf(routine).map(learningText), ['spin liquids, 2 of 3', 'moiré excitons, 2 of 3']);
  assert.deepEqual(learningOf({}), []);
  assert.deepEqual(learningOf(null), []);
});
