import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedProfile, checkSource } from '../src/radar-setup.js';
import { feedXml, res, radarLibrary } from './support/radar-fakes.mjs';

const OA = 'https://api.openalex.org';
const source = (n, over = {}) => ({ id: `https://openalex.org/S${n}`, display_name: `Journal ${n}`, issn_l: `2057-396${n}`, works_count: 1200, host_organization_name: 'Invented Press', ...over });
const json = (results) => res(200, JSON.stringify({ results }));

/** Answers by the first route whose key the URL contains; `calls` lists every URL. */
function fake(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    if (!hit) return res(404);
    return typeof hit[1] === 'function' ? hit[1](String(url)) : hit[1];
  };
  fn.calls = calls;
  return fn;
}
const library = (seed) => { const lib = { ...radarLibrary(), async radarProfile(q) { lib.asked = q; return seed; } }; return lib; };

test('seedProfile resolves each author and journal once, keeps the match label, and leaves unmatched ones unmatched', async () => {
  const lib = library({
    topics: [{ text: 'phonon transport', weight: 4 }, { text: 'defect chemistry', weight: 1 }],
    authors: [{ name: 'Galli, G.', count: 9 }, { name: 'Unknown Person', count: 3 }],
    journals: [{ name: 'Phys. Rev. B', count: 20 }, { name: 'Journal of Nothing', count: 2 }],
  });
  const f = fake({
    '/authors?search=G.%20Galli': json([{ id: 'https://openalex.org/A1', display_name: 'Giulia Galli', works_count: 781, last_known_institutions: [{ display_name: 'U Chicago' }] }]),
    '/authors?search=Unknown': json([{ id: 'https://openalex.org/A2', display_name: 'Someone Else', works_count: 5 }]),
    '/sources?search=Phys.%20Rev.%20B': json([source(7, { display_name: 'Physical Review B', abbreviated_title: 'Phys. Rev. B', host_organization_name: 'American Physical Society' })]),
    '/sources?search=Journal%20of%20Nothing': json([source(8)]),
  });
  const out = await seedProfile({ fetch: f, library: lib, scope: { kind: 'collections', keys: ['K1'] } });
  assert.deepEqual(lib.asked, { scope: { collections: ['K1'] } });
  assert.deepEqual(out.topics, [{ text: 'phonon transport', weight: 1, origin: 'seed' }, { text: 'defect chemistry', weight: 0.25, origin: 'seed' }]);
  assert.deepEqual(out.authors[0], { name: 'Galli, G.', weight: 1, origin: 'seed', openalexId: 'A1', match: 'Giulia Galli, U Chicago, 781 works' });
  assert.deepEqual(out.authors[1], { name: 'Unknown Person', weight: 1, origin: 'seed', openalexId: null, match: null }, 'a different person is not offered as a match');
  assert.equal(out.journals[0].openalexId, 'S7');
  assert.equal(out.journals[0].match, 'Physical Review B, American Physical Society, 1,200 works');
  assert.equal(out.journals[1].openalexId, null, 'a title that does not match is not offered');
  assert.equal(f.calls.length, 4, 'one request per author and journal');
});

test('seedProfile asks for at most 8 authors and 8 journals, and a failed lookup leaves a row unmatched', async () => {
  const many = (n, key) => Array.from({ length: n }, (_, i) => ({ name: `${key} ${i}`, count: 1 }));
  const lib = library({ topics: [], authors: many(12, 'Person'), journals: many(12, 'Journal') });
  const f = fake({ '/authors': () => { throw new Error('offline'); }, '/sources': res(500) });
  const out = await seedProfile({ fetch: f, library: lib });
  assert.equal(out.authors.length, 8);
  assert.equal(out.journals.length, 8);
  assert.ok([...out.authors, ...out.journals].every((r) => r.openalexId === null && r.match === null));
  assert.equal(f.calls.length, 16);
  assert.deepEqual(lib.asked, { scope: { collections: null } });
});

test('without the library server the radar setup says so', async () => {
  const lib = { async search() { return []; } };
  await assert.rejects(seedProfile({ fetch: fake({}), library: lib }), /needs the library server/);
  await assert.rejects(checkSource({ fetch: fake({}), library: lib, input: 'x' }), /needs the library server/);
});

const lib = library({ topics: [], authors: [], journals: [] });
const check = (input, routes) => checkSource({ fetch: fake(routes), library: lib, input });

test('checkSource: a feed address that parses is a feed with its title and item count', async () => {
  const out = await check('https://good.example/feed', { 'good.example': res(200, feedXml([{ title: 'One', link: 'https://good.example/1' }, { title: 'Two', link: 'https://good.example/2' }])) });
  assert.deepEqual(out, { kind: 'feed', url: 'https://good.example/feed', title: 'Feed', items: 2 });
});

test('checkSource: a feed that sends us to a sign-in is blocked, and journals are suggested from the publisher name', async () => {
  const routes = {
    'nature.com/ncomms.rss': res(303, '', { location: 'https://idp.nature.com/authorize?response_type=cookie' }),
    '/sources?search=nature': json([source(1, { display_name: 'Nature Communications', issn_l: '2041-1723' }), source(2, { display_name: 'Nature' })]),
  };
  const out = await check('https://www.nature.com/ncomms.rss', routes);
  assert.equal(out.kind, 'feed-blocked');
  assert.match(out.reason, /sign-in page/);
  assert.deepEqual(out.journals.map((j) => j.name), ['Nature Communications', 'Nature']);
  assert.equal(out.journals[0].openalexId, 'S1');

  const followed = { ...res(200, '<html><head><title>Sign in</title></head></html>'), redirected: true, url: 'https://idp.nature.com/login?x=1' };
  const again = await check('https://www.nature.com/ncomms.rss', { 'nature.com/ncomms.rss': followed, '/sources?search=nature': json([source(2, { display_name: 'Nature' })]) });
  assert.equal(again.kind, 'feed-blocked', 'a redirect the client followed to a login page is the same thing');
  assert.match(again.reason, /sign-in/);
});

test('checkSource: a 403 and a page that is not a feed are blocked with suggestions; a dead address is a plain error', async () => {
  const forbidden = await check('http://feeds.aps.org/rss/recent/prb.xml', { 'feeds.aps.org': res(403), '/sources?search=aps': json([source(3, { display_name: 'Physical Review B' })]) });
  assert.equal(forbidden.kind, 'feed-blocked');
  assert.match(forbidden.reason, /HTTP 403/);
  assert.equal(forbidden.journals[0].name, 'Physical Review B');

  const page = await check('https://journal.example/about', { 'journal.example': res(200, '<html><title>Invented Letters</title></html>'), '/sources?search=Invented': json([source(4, { display_name: 'Invented Letters' })]), '/sources?search=journal': json([]) });
  assert.equal(page.kind, 'feed-blocked');
  assert.match(page.reason, /not an RSS or Atom feed/);
  assert.equal(page.journals[0].name, 'Invented Letters', 'the page title is tried first');

  const gone = await check('https://good.example/missing', {});
  assert.deepEqual(gone, { kind: 'error', message: 'That address answered HTTP 404.' });
  const down = await checkSource({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); }, library: lib, input: 'https://nowhere.example/feed' });
  assert.equal(down.kind, 'error');
  assert.match(down.message, /Could not reach nowhere\.example: getaddrinfo ENOTFOUND/);
});

test('checkSource: an ISSN finds one journal, a name offers several, nothing found is a plain message', async () => {
  const issn = await check('2057-3960', { 'filter=issn:2057-3960': json([source(5, { display_name: 'npj Computational Materials', issn_l: '2057-3960' })]) });
  assert.deepEqual(issn, { kind: 'journal', openalexId: 'S5', name: 'npj Computational Materials', issn: '2057-3960', match: 'npj Computational Materials, Invented Press, 1,200 works' });
  const bare = await check('20573960', { 'filter=issn:2057-3960': json([]) });
  assert.deepEqual(bare, { kind: 'error', message: 'No journal has the ISSN 2057-3960.' });

  const named = await check('npj computational materials', { '/sources?search=npj%20computational%20materials': json([source(5, { display_name: 'npj Computational Materials' }), source(6, { display_name: 'npj Quantum Materials' })]) });
  assert.equal(named.kind, 'journals');
  assert.deepEqual(named.options.map((o) => o.openalexId), ['S5', 'S6']);

  assert.deepEqual(await check('zzzz qqqq', { '/sources?search=': json([]) }), { kind: 'error', message: 'No journal found for "zzzz qqqq". Try its full name or its ISSN.' });
  assert.equal((await check('   ', {})).kind, 'error');
  assert.equal((await check('npj computational materials', { '/sources': res(500) })).kind, 'error', 'a failing lookup never throws');
});
