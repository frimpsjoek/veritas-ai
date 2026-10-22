// Spec 017 K3: learned topics get a search slot. Invented topics only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topicsOf, fetchSource, fetchAll } from '../src/radar-sources.js';
import { collectRadar } from '../src/radar-run.js';
import { emptyState } from '../src/radar-state.js';
import { LEARNED_FLOOR } from '../src/radar-phrases.js';
import { res, routedFetch, radarLibrary } from './support/radar-fakes.mjs';

const user = Array.from({ length: 12 }, (_, i) => ({ text: `user topic ${String.fromCharCode(97 + i)}`, weight: 1 - i * 0.05, origin: i % 2 ? 'user' : 'seed' }));
const learned = (text, weight = 0.6) => ({ text, weight, origin: 'learned', papers: 3 });
const profile = (extra) => ({ topics: [...user, ...extra], authors: [], journals: [] });

test('12 user topics and 2 learned: 4 user topics plus a different learned one each run (success check 4)', async () => {
  const p = profile([learned('alpha learned'), learned('beta learned')]);
  const asked = [];
  const db = { id: 'database:openalex', on: true, kind: 'database', db: 'openalex' };
  for (const rotation of [0, 1]) {
    const fetchFn = routedFetch({});
    await fetchAll({ sources: [db], profile: p, since: '2026-10-01', fetch: fetchFn, rotation });
    asked.push(fetchFn.calls.map((c) => decodeURIComponent(/search=([^&]*)/.exec(c.url)[1]).replace(/\+/g, ' ')));
  }
  for (const run of asked) assert.deepEqual(run.slice(0, 4), ['user topic a', 'user topic b', 'user topic c', 'user topic d']);
  assert.equal(asked[0].length, 5);
  assert.notEqual(asked[0][4], asked[1][4]);
  assert.deepEqual([asked[0][4], asked[1][4]].sort(), ['alpha learned', 'beta learned']);
});

test('MCP tools take 2 user topics and 1 learned one', () => {
  const p = profile([learned('alpha learned'), learned('beta learned')]);
  const got = [0, 1, 2].map((turn) => topicsOf(p, 3, turn));
  for (const g of got) assert.deepEqual(g.slice(0, 2), ['user topic a', 'user topic b']);
  assert.deepEqual(got.map((g) => g[2]), ['alpha learned', 'beta learned', 'alpha learned']);
});

test('a learned topic below the floor is never asked for, and no learned topic leaves the top 5 as before', () => {
  const weak = profile([learned('weak learned', LEARNED_FLOOR - 0.05)]);
  assert.deepEqual(topicsOf(weak, 5, 3), user.slice(0, 5).map((t) => t.text));
  assert.deepEqual(topicsOf(profile([]), 3), ['user topic a', 'user topic b', 'user topic c']);
});

test('with fewer user topics than slots the learned ones fill the rest, each at most once', () => {
  const p = { topics: [user[0], learned('one learned'), learned('two learned'), learned('three learned')], authors: [], journals: [] };
  assert.deepEqual(topicsOf(p, 5, 0), ['user topic a', 'one learned', 'three learned', 'two learned']);
});

test('two database sources do not ask for the same learned topic in the same run', async () => {
  const p = profile([learned('alpha learned'), learned('beta learned')]);
  const sources = ['openalex', 'arxiv'].map((db) => ({ id: `database:${db}`, on: true, kind: 'database', db }));
  const fetchFn = routedFetch({});
  await fetchAll({ sources, profile: p, since: '2026-10-01', fetch: fetchFn, rotation: 0 });
  const queries = fetchFn.calls.map((c) => decodeURIComponent(c.url));
  assert.ok(queries.some((u) => u.includes('openalex') && u.includes('alpha learned')));
  assert.ok(queries.some((u) => u.includes('arxiv') && u.includes('beta')));
});

test('a run advances the rotation by one and hands back what was learned since the last digest', async () => {
  const cfg = { scope: { kind: 'library' }, profile: profile([learned('alpha learned'), learned('beta learned')]), sources: [{ id: 'mcp:x', on: true, kind: 'mcp', server: 'x', tool: 't' }], size: { fresh: 8, older: 0 }, note: false };
  const asked = [];
  const hub = { call: async (_s, _t, args) => { asked.push(args.query); return ''; } };
  const state = emptyState();
  state.phrases.announce = ['alpha learned'];
  const run = (st) => collectRadar({ config: cfg, since: '2026-10-01', now: '2026-10-13T07:00:00.000Z', fetch: async () => res(404), hub, library: radarLibrary(), state: st });
  const a = await run(state);
  assert.deepEqual(a.announced, ['alpha learned']);
  assert.deepEqual(a.state.phrases.announce, []);
  assert.equal(a.state.phrases.rotation, 1);
  const b = await run(a.state);
  assert.deepEqual(b.announced, []);
  assert.deepEqual([asked[2], asked[5]], ['alpha learned', 'beta learned']);
});
