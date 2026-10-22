import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newForm, formFromRoutine, mergeSeed, addEntry, removeAt, matchLine, statusLine, checkNotice, addFeed, addJournal, mcpChoices, mergeMcp,
  radarProblem, sourcesOf, draftFromForm, sizeDefaults, SIZE_DEFAULTS, BLOCKED_OFFER, RADAR_CARD, radarAvailable, DATABASES,
} from '../src/chat/radar-data.js';
import { validateDraft } from '../../agent-src/src/routines.js';
import { scheduleText } from '../src/chat/routines-data.js';

process.env.TZ = 'America/New_York';
const topic = (text, origin = 'user') => ({ text, weight: 1, origin });
const person = (name, openalexId = null, origin = 'user', match = null) => ({ name, openalexId, weight: 1, origin, match });
const ready = () => { const f = newForm(); f.profile.topics.push(topic('phonon transport')); return f; };

test('a new radar is named, daily at 07:00, with arXiv, chemRxiv and OpenAlex on and 8 new + 1 older', () => {
  const f = newForm();
  assert.equal(f.name, 'Reading radar');
  assert.equal(scheduleText(draftFromForm(f).schedule), 'Every day at 07:00');
  assert.deepEqual(Object.entries(f.databases).filter(([, on]) => on).map(([id]) => id), ['arxiv', 'chemrxiv', 'openalex']);
  assert.equal(DATABASES.length, 7);
  assert.deepEqual(f.size, { fresh: 8, older: 1, discover: 3 });
  assert.equal(f.sizeTouched, false);
  assert.deepEqual(f.scope, { kind: 'library' });
});

test('the weekly size is 15 + 5 for a radar that runs once a week or less, 8 + 1 otherwise', () => {
  const days = (d) => ({ days: d, times: { kind: 'at', times: ['07:00'] } });
  assert.deepEqual(SIZE_DEFAULTS.weekly, { fresh: 15, older: 5, discover: 3 });
  assert.equal(sizeDefaults(days({ kind: 'some', weekdays: [1] })), SIZE_DEFAULTS.weekly);
  assert.equal(sizeDefaults(days({ kind: 'monthly', day: 1 })), SIZE_DEFAULTS.weekly);
  assert.equal(sizeDefaults(days({ kind: 'every', n: 7, from: '2026-10-01' })), SIZE_DEFAULTS.weekly);
  for (const d of [{ kind: 'daily' }, { kind: 'weekdays' }, { kind: 'some', weekdays: [1, 3, 5] }, { kind: 'every', n: 3, from: '2026-10-01' }]) assert.equal(sizeDefaults(days(d)), SIZE_DEFAULTS.daily);
});

test('what stops a save is said in plain words, one thing at a time', () => {
  const f = newForm();
  assert.equal(radarProblem(f), 'Add at least one topic to look for.');
  f.profile.topics.push(topic('phonons'));
  assert.equal(radarProblem(f), null);
  f.name = '  ';
  assert.equal(radarProblem(f), 'Give the radar a name.');
  f.name = 'R';
  f.scope = { kind: 'collections', keys: [] };
  assert.equal(radarProblem(f), 'Pick at least one collection, or look at the whole library.');
  f.scope = { kind: 'library' };
  for (const id of Object.keys(f.databases)) f.databases[id] = false;
  assert.equal(radarProblem(f), 'Turn on at least one place to look.');
  f.databases.arxiv = true;
  f.size.fresh = 0;
  assert.equal(radarProblem(f), 'Show between 1 and 50 new papers.');
  f.size = { fresh: 8, older: 21, discover: 3 };
  assert.equal(radarProblem(f), 'Show between 0 and 20 older papers.');
  f.size = { fresh: 8, older: 1, discover: 3 };
  f.when.times = [];
  assert.ok(radarProblem(f), 'a schedule with no time is refused with the engine\'s words');
});

test('the draft passes the engine\'s own validation, with authors and journals followed only when OpenAlex matched them', () => {
  const f = ready();
  f.profile.authors.push(person('Giulia Galli', 'A1', 'seed', 'Giulia Galli, U Chicago, 781 works'), person('Nobody Known'));
  f.profile.journals.push(person('Physical Review B', 'S7', 'seed'), person('Journal of Nothing'));
  f.feeds.push({ url: 'https://good.example/feed', title: 'Good feed', on: true });
  addJournal(f, { openalexId: 'S5', name: 'npj Computational Materials', issn: '2057-3960', match: '' });
  const draft = draftFromForm(f);
  const out = validateDraft(draft);
  assert.equal(out.kind, 'radar');
  assert.equal(out.prompt, 'Reading radar');
  assert.deepEqual(out.target, { kind: 'session' });
  assert.deepEqual(out.radar.sources.filter((s) => s.on).map((s) => s.id), [
    'database:arxiv', 'database:chemrxiv', 'database:openalex', 'feed:https://good.example/feed', 'journal:S5', 'author:A1', 'journal:S7',
  ]);
  assert.equal(out.radar.profile.authors[0].match, 'Giulia Galli, U Chicago, 781 works', 'the match label is kept for the next edit');
  assert.deepEqual(out.radar.size, { fresh: 8, older: 1, discover: 3 });
});

test('editing a radar gives back the same sources, without listing a followed journal twice', () => {
  const f = ready();
  f.profile.journals.push(person('Physical Review B', 'S7', 'seed'));
  f.profile.authors.push(person('Giulia Galli', 'A1', 'seed'));
  f.feeds.push({ url: 'https://good.example/feed', title: 'Good feed', on: false });
  f.mcp.push({ server: 'huggingface', tool: 'hf_fs', label: 'x', args: { operations: [] }, on: true });
  f.size = { fresh: 15, older: 5, discover: 3 };
  const saved = validateDraft(draftFromForm(f));
  const back = formFromRoutine({ ...saved, id: 'r1' });
  assert.deepEqual(back.journals, [], 'S7 is the profile\'s, not a second source');
  assert.equal(back.sizeTouched, true, 'a saved size is the user\'s');
  assert.deepEqual(back.size, { fresh: 15, older: 5, discover: 3 });
  assert.equal(back.mcp[0].label, 'Hugging Face papers');
  assert.deepEqual(sourcesOf(back), sourcesOf(f));
  assert.equal(back.feeds[0].on, false);
  assert.equal(draftFromForm(back).name, 'Reading radar');
});

test('refreshing the profile from the library keeps what the user added and replaces what it suggested', () => {
  const have = { topics: [topic('mine'), topic('old suggestion', 'seed')], authors: [person('Giulia Galli', 'A1', 'seed'), person('Added Person')], journals: [] };
  const seeded = { topics: [topic('new suggestion', 'seed'), topic('MINE', 'seed')], authors: [person('Giulia Galli', 'A1', 'seed'), person('Added Person', 'A9', 'seed')], journals: [person('Nature', 'S1', 'seed')] };
  const out = mergeSeed(have, seeded);
  assert.deepEqual(out.topics.map((t) => t.text), ['mine', 'new suggestion']);
  assert.deepEqual(out.authors.map((a) => a.name), ['Added Person', 'Giulia Galli']);
  assert.equal(out.authors[0].origin, 'user', 'the user\'s own row wins over the suggestion of the same name');
  assert.deepEqual(out.journals.map((j) => j.name), ['Nature']);
});

test('adding a topic trims it, refuses an empty one and a repeat; removing takes one out', () => {
  const none = [];
  assert.equal(addEntry(none, 'text', '   ').added, false);
  const one = addEntry(none, 'text', '  perovskite   solar cells ');
  assert.deepEqual(one.list, [{ text: 'perovskite solar cells', weight: 1, origin: 'user' }]);
  assert.equal(addEntry(one.list, 'text', 'Perovskite Solar Cells').added, false);
  assert.deepEqual(addEntry([], 'name', 'Ada L.').list, [{ name: 'Ada L.', openalexId: null, weight: 1, origin: 'user', }]);
  assert.deepEqual(removeAt(['a', 'b', 'c'], 1), ['a', 'c']);
});

test('a match line says who OpenAlex found, or that nothing matched', () => {
  assert.equal(matchLine(person('G', 'A1', 'seed', 'Giulia Galli, U Chicago, 781 works')), 'Giulia Galli, U Chicago, 781 works');
  assert.equal(matchLine(person('G', 'A1')), 'Matched in OpenAlex');
  assert.equal(matchLine(person('G', null, 'seed')), 'No match in OpenAlex, so it will not be followed');
  assert.equal(matchLine(person('G', null, 'user')), 'Not matched in OpenAlex yet');
});

test('a source\'s status line shows its last answer, a failure with its reason, and nothing before the first run', () => {
  const now = Date.parse('2026-10-11T09:00:00Z');
  assert.equal(statusLine(undefined, now), '');
  assert.equal(statusLine({ at: '2026-10-11T07:00:00Z', items: 14, error: null, quietRuns: 0 }, now), 'Fetched 2 hours ago, 14 papers');
  assert.equal(statusLine({ at: '2026-10-11T08:59:50Z', items: 1, error: null, quietRuns: 0 }, now), 'Fetched just now, 1 paper');
  assert.equal(statusLine({ at: '2026-10-11T07:00:00Z', items: 0, error: null, quietRuns: 3 }, now), 'Fetched 2 hours ago, nothing new');
  assert.equal(statusLine({ at: '2026-10-11T07:00:00Z', items: 0, error: 'HTTP 403', quietRuns: 0 }, now), 'Failed 2 hours ago: HTTP 403');
});

test('a blocked feed says why and offers the journal by name; a feed, a journal and an error each read plainly', () => {
  const journals = [{ openalexId: 'S1', name: 'Nature Communications', issn: '2041-1723', match: 'Nature Communications, Springer Nature, 60,000 works' }];
  const blocked = checkNotice({ kind: 'feed-blocked', url: 'https://www.nature.com/ncomms.rss', reason: 'This site sends feed requests to a sign-in page.', journals });
  assert.equal(blocked.offer, BLOCKED_OFFER);
  assert.equal(BLOCKED_OFFER, 'Add the journal by name');
  assert.equal(blocked.text, 'This site sends feed requests to a sign-in page. The radar can still follow the journal itself.');
  assert.deepEqual(blocked.options, journals);
  assert.equal(blocked.tone, 'warn');
  assert.match(checkNotice({ kind: 'feed-blocked', url: 'u', reason: 'R.', journals: [] }).text, /Type its name or ISSN\.$/);
  assert.deepEqual(checkNotice({ kind: 'feed', url: 'https://good.example/feed', title: 'Good', items: 1 }).feed, { url: 'https://good.example/feed', title: 'Good' });
  assert.equal(checkNotice({ kind: 'feed', url: 'u', title: 'Good', items: 1 }).text, 'Good: a feed with 1 item.');
  assert.equal(checkNotice({ kind: 'journals', options: journals }).options.length, 1);
  assert.deepEqual(checkNotice({ kind: 'error', message: 'No journal has the ISSN 1234-5678.' }), { tone: 'error', text: 'No journal has the ISSN 1234-5678.', options: [], offer: null, feed: null });
});

test('a feed or journal is added once', () => {
  const f = ready();
  assert.equal(addFeed(f, { url: 'https://a.example/f', title: 'A' }), true);
  assert.equal(addFeed(f, { url: 'https://a.example/f', title: 'A' }), false);
  const j = { openalexId: 'S5', name: 'J', issn: null, match: '' };
  assert.equal(addJournal(f, j), true);
  assert.equal(addJournal(f, j), false);
  f.profile.journals.push(person('K', 'S9'));
  assert.equal(addJournal(f, { ...j, openalexId: 'S9' }), false, 'the profile already follows it');
  assert.equal(new Set(sourcesOf(f).map((s) => s.id)).size, sourcesOf(f).length);
});

test('the Hugging Face preset is offered only when that server is connected, and a used tool that disconnected is kept', () => {
  const hf = { config: { name: 'huggingface' }, state: 'connected', tools: [{ name: 'hf_fs', description: 'Hub filesystem' }, { name: 'hub_repo_search', description: 'Search models' }] };
  const other = { config: { name: 'scholar' }, state: 'connected', tools: [{ name: 'semanticSearch', description: 'Search scholarly papers' }, { name: 'ping', description: 'Ping' }] };
  const down = { config: { name: 'huggingface' }, state: 'failed', tools: [{ name: 'hf_fs', description: '' }] };
  assert.deepEqual(mcpChoices([hf, other]).map((c) => `${c.server}/${c.tool}`), ['huggingface/hf_fs', 'scholar/semanticSearch']);
  assert.equal(mcpChoices([hf])[0].label, 'Hugging Face papers');
  assert.deepEqual(mcpChoices([hf])[0].args.operations[0].args, ['hf://papers', '{query}']);
  assert.deepEqual(mcpChoices([down]), []);
  const used = [{ server: 'huggingface', tool: 'hf_fs', label: 'Hugging Face papers', on: true }, { server: 'gone', tool: 't', label: 'gone: t', on: true }];
  const merged = mergeMcp(mcpChoices([hf, other]), used);
  assert.deepEqual(merged.map((m) => [m.tool, m.on]), [['hf_fs', true], ['semanticSearch', false], ['t', true]]);
});

test('the starter card only shows on the library server', () => {
  assert.equal(RADAR_CARD.title, 'Reading radar');
  assert.equal(radarAvailable('server'), true);
  assert.equal(radarAvailable('local'), false);
  assert.equal(radarAvailable('offline'), false);
});

test('a radar shows between 0 and 10 papers that might interest the reader, and keeps a size it was saved with', () => {
  const f = newForm();
  f.profile.topics.push({ text: 'voles', weight: 1, origin: 'user' });
  f.size = { fresh: 8, older: 1, discover: 11 };
  assert.match(radarProblem(f), /between 0 and 10 papers that might interest you/);
  f.size = { fresh: 8, older: 1, discover: 0 };
  assert.equal(radarProblem(f), null);
  assert.equal(draftFromForm(f).radar.size.discover, 0);
  const back = formFromRoutine({ id: 'r', name: 'R', radar: { size: { fresh: 8, older: 1, discover: 5 }, profile: {}, sources: [] }, schedule: null });
  assert.equal(back.size.discover, 5);
  assert.equal(formFromRoutine({ id: 'r', name: 'R', radar: { size: { fresh: 8, older: 1 }, profile: {}, sources: [] }, schedule: null }).size.discover, 3, 'a radar saved before this has the default');
});

// ---------- seed radar (server spec 021 G1)
import { seedCount, SEED_FRESH } from '../src/chat/radar-data.js';
import { seedSummary } from '../src/web/seeds-view.js';

test('seed papers: counted once, a radar with seeds needs no topics, saves 15 a day with its seeds and threshold', () => {
  const seeds = { mine: [{ title: 'A', year: 2025, doi: null, key: 'K1', abstract: '', openalexId: null }, { title: 'B', year: 2024, doi: null, key: null, abstract: 'b', openalexId: null }, { title: 'C', year: 2023, doi: null, key: null, abstract: '', openalexId: null }], papers: ['K1', 'K2'], collections: [], author: null, categories: [] };
  assert.equal(seedCount(seeds), 3, 'K1 counts once; a paper with neither key nor abstract not at all');
  assert.equal(seedSummary(seeds), '3 seed papers');
  assert.equal(seedSummary({ ...seeds, papers: [] }), '2 seed papers (at least 3 needed)');
  assert.equal(seedSummary(null), 'No seed papers yet.');
  const form = newForm();
  form.seeds = seeds;
  form.threshold = { abstract: 0.77, full: 0.81 };
  form.databases.arxiv = true;
  assert.equal(radarProblem(form), null, 'no topics needed with seeds');
  const draft = draftFromForm(form);
  assert.equal(draft.radar.size.fresh, SEED_FRESH);
  assert.deepEqual(draft.radar.threshold, { abstract: 0.77, full: 0.81 });
  assert.equal(formFromRoutine({ name: 'R', radar: draft.radar }).seeds?.papers.length, 2);
  form.seeds = { ...seeds, mine: [], papers: ['K1'] };
  assert.match(radarProblem(form) ?? '', /at least 3 papers/);
});

test('the threshold reads in words once calibrated against the field', async () => {
  const { thresholdText } = await import('../src/web/seeds-view.js');
  assert.equal(thresholdText({ abstract: 0.77, full: 0.81 }, []), 'Keeping papers at least 0.77 close to a seed (abstract), 0.81 for papers read whole.');
  assert.match(thresholdText({ abstract: 0.067, full: 0.033, calibration: /** @type {any} */ ({ abstract: { field_cut: 0.067 } }) }, ['cond-mat.mtrl-sci']), /^Keeping about the closest tenth of new papers in cond-mat\.mtrl-sci/);
});
