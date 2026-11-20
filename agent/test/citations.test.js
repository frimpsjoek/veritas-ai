import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCitationRefs, citationKey, validateCitations, rescueFromThread, scopeKey } from '../src/citations.js';

function fakeLibrary(known) {
  return {
    async resolve(refs) {
      const map = new Map();
      for (const ref of refs) {
        const key = citationKey(ref);
        map.set(key, known.has(key) ? { title: known.get(key) } : null);
      }
      return map;
    },
  };
}

test('extractCitationRefs finds [[notes]], [@citekeys] and bare URLs', () => {
  const refs = extractCitationRefs('See [[Graphene synthesis]] and [@smith2021], also https://example.com/paper.pdf.');
  assert.deepEqual(refs, [
    { kind: 'note', path: 'Graphene synthesis' },
    { kind: 'paper', citekey: 'smith2021' },
    { kind: 'web', url: 'https://example.com/paper.pdf' },
  ]);
});

test('validateCitations resolves a real note and paper, flags a fabricated citekey as unknown', async () => {
  const library = fakeLibrary(new Map([['note:Graphene synthesis', 'Graphene synthesis'], ['paper:smith2021', 'Smith 2021']]));
  const citations = await validateCitations('[[Graphene synthesis]] and [@smith2021] but not [@fabricated9999]', library, []);
  assert.equal(citations.find((c) => c.ref.kind === 'note').status, 'resolved');
  assert.equal(citations.find((c) => c.ref.citekey === 'smith2021').status, 'resolved');
  assert.equal(citations.find((c) => c.ref.citekey === 'fabricated9999').status, 'unknown');
});

test('a web link only resolves if a tool returned it this turn', async () => {
  const library = fakeLibrary(new Map());
  const seen = [{ kind: 'web', url: 'https://example.com/a' }];
  const citations = await validateCitations('https://example.com/a and https://example.com/b', library, seen);
  assert.equal(citations.find((c) => c.ref.url === 'https://example.com/a').status, 'resolved');
  assert.equal(citations.find((c) => c.ref.url === 'https://example.com/b').status, 'unknown');
});

test('no citations in text returns an empty list without calling the library', async () => {
  let called = false;
  const library = { async resolve() { called = true; return new Map(); } };
  const citations = await validateCitations('Plain text with no citations.', library, []);
  assert.deepEqual(citations, []);
  assert.equal(called, false);
});

test('extractCitationRefs keeps a note title that itself contains brackets', () => {
  const refs = extractCitationRefs('See [[Tidal Energy Basics and why they matter [a05838e1]]] and [[Graphene synthesis]].');
  assert.deepEqual(refs.filter((r) => r.kind === 'note').map((r) => r.path), [
    'Tidal Energy Basics and why they matter [a05838e1]',
    'Graphene synthesis',
  ]);
});

test('spec 030 R11: a web link the thread already holds (any DOI spelling) is resolved; a link it does not hold, and an unknown citekey, stay unknown', () => {
  const known = new Map([[scopeKey({ kind: 'web', url: 'https://doi.org/10.1107/S0909049599001697' }), 'L-edge XANES of 3d metals']]);
  const cited = [
    { ref: { kind: 'web', url: 'https://doi.org/10.1107/s0909049599001697' }, status: 'unknown' },
    { ref: { kind: 'web', url: 'https://example.org/made-up' }, status: 'unknown' },
    { ref: { kind: 'paper', citekey: 'fake2020' }, status: 'unknown' },
    { ref: { kind: 'web', url: 'https://a.example/' }, status: 'resolved', title: 'A', retrievedThisTurn: true },
  ];
  const out = rescueFromThread(/** @type {any} */ (cited), known);
  assert.deepEqual(out[0], { ref: cited[0].ref, status: 'resolved', title: 'L-edge XANES of 3d metals', retrievedThisTurn: false });
  assert.equal(out[1].status, 'unknown');
  assert.equal(out[2].status, 'unknown');
  assert.deepEqual(out[3], cited[3]);
  assert.equal(rescueFromThread(/** @type {any} */ (cited), new Map()), cited);
});

test('a web link a tool returned counts in any spelling: http/https, arXiv version, abs/pdf, DOI forms; an invented one does not', async () => {
  const library = { async resolve() { return new Map(); } };
  const seen = [{ kind: 'web', url: 'http://arxiv.org/abs/2610.00636v1' }, { kind: 'web', url: 'https://doi.org/10.1107/S1' }, { kind: 'web', url: 'https://www.example.org/paper/' }];
  const text = 'A https://arxiv.org/abs/2610.00636 B https://arxiv.org/pdf/2610.00636v2 C http://dx.doi.org/10.1107/s1 D https://example.org/paper E https://arxiv.org/abs/2611.99999';
  const got = Object.fromEntries((await validateCitations(text, /** @type {any} */ (library), /** @type {any} */ (seen))).map((c) => [c.ref.url, c.status]));
  assert.deepEqual(got, {
    'https://arxiv.org/abs/2610.00636': 'resolved', 'https://arxiv.org/pdf/2610.00636v2': 'resolved', 'http://dx.doi.org/10.1107/s1': 'resolved',
    'https://example.org/paper': 'resolved', 'https://arxiv.org/abs/2611.99999': 'unknown',
  });
});
