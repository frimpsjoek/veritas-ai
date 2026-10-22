import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCitationRefs, citationKey, validateCitations } from '../src/citations.js';

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
