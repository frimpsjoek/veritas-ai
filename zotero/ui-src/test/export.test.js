// Spec 007 E3: the pure exporters, pinned by goldens (test/golden/*). Re-generate after a deliberate change with
// `UPDATE_GOLDEN=1 node --test test/export.test.js`, then read the diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toCsv, field } from '../src/export/csv.js';
import { toRis } from '../src/export/ris.js';
import { toMarkdown } from '../src/export/markdown.js';
import { papersV1, papersV2, tableV1, tableV2 } from './fixtures/artifacts.js';

const golden = (name) => fileURLToPath(new URL(`./golden/${name}`, import.meta.url));
function matchesGolden(name, actual) {
  if (process.env.UPDATE_GOLDEN || !existsSync(golden(name))) writeFileSync(golden(name), actual);
  assert.equal(actual, readFileSync(golden(name), 'utf8'), `${name} changed; if intended, re-run with UPDATE_GOLDEN=1`);
}

test('CSV: paper columns then result columns, quoting only where needed', () => {
  matchesGolden('papers-v2.csv', toCsv(papersV2));
  assert.equal(field('plain'), 'plain');
  assert.equal(field('a,b'), '"a,b"');
  assert.equal(field('say "hi"'), '"say ""hi"""');
  assert.equal(field('two\nlines'), '"two\nlines"');
  assert.equal(field(null), '');
});

test('CSV with quotes adds a "<Column> quote" column after each answer; unverified quotes say so', () => {
  const csv = toCsv(papersV2, { quotes: true });
  matchesGolden('papers-v2-quotes.csv', csv);
  assert.match(csv.split('\r\n')[0], /Main finding,Main finding quote,Sample size,Sample size quote$/);
  assert.match(csv, /across three meadows \[unverified\]/);
});

test('CSV: a papers result with no columns is just the paper columns; a table starts with Item', () => {
  assert.equal(toCsv(papersV1).split('\r\n')[0], 'Title,Authors,Year,Venue,DOI,In library');
  matchesGolden('table-v2.csv', toCsv(tableV2));
  assert.equal(toCsv(tableV2).split('\r\n')[0], 'Item,Approach,Main limitation');
});

test('CSV: `only` keeps just those rows (the ticked ones), in table order', () => {
  const csv = toCsv(papersV2, { only: new Set(['p:hoarding2018', 'p:bramblewood2021']) });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^Foraging Strategies/);
  assert.match(lines[2], /^"Voles, ""Squirrels"" and Other/);
});

test('RIS: byte-identical to the Find papers writer it replaced, one JOUR record per paper', () => {
  matchesGolden('papers.ris', toRis(papersV1.rows));
  // the old Find papers row shape (type may be "book"; year may be '')
  const ris = toRis([{ title: 'A  Book', authors: [], year: '', venue: '', doi: null, abstract: '', type: 'book' }]);
  assert.equal(ris, 'TY  - BOOK\r\nTI  - A Book\r\nER  - \r\n');
});

test('Markdown: a GitHub table with citekey and DOI links, quotes as footnotes', () => {
  const md = toMarkdown(papersV2);
  matchesGolden('papers-v2.md', md);
  matchesGolden('table-v2.md', toMarkdown(tableV2));
  assert.match(md, /\[\^1\]: “Voles leave a patch/);
  assert.match(md, /\(from full text, unverified\)/);
  assert.match(md, /\[@bramblewood2021\]/);
  assert.match(md, /\(https:\/\/doi\.org\/10\.9999\/jiz\.2021\.001\)/);
});

test('Markdown: pipes and line breaks inside a cell cannot break the table', () => {
  const result = { ...tableV1, cells: { 'x:1': { approach: { state: 'filled', value: 'a | b\nc', quotes: [], citations: [] } }, 'x:2': {} } };
  const rows = toMarkdown(result).split('\n').filter((l) => l.startsWith('| ') && !l.includes('---'));
  assert.ok(rows.every((l) => l.split(/(?<!\\)\|/).length === 4), rows.join('\n'));
  assert.match(rows[1], /a \\\| b<br>c/);
});

test('report and answer results export nothing but a heading and an empty table', () => {
  assert.equal(toCsv({ kind: 'report', title: 'R' }), 'Item\r\n');
});
