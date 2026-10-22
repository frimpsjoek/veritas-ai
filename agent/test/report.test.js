import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { screen, renderReport, stripUnknownCitations } from '../src/report.js';

const goldenDir = fileURLToPath(new URL('./golden/', import.meta.url));

/** Compares against a checked-in file; set UPDATE_GOLDEN=1 to (re)write it after an intentional change. */
function assertGolden(name, actual) {
  const path = `${goldenDir}${name}`;
  if (process.env.UPDATE_GOLDEN || !existsSync(path)) { writeFileSync(path, actual); return; }
  assert.equal(actual, readFileSync(path, 'utf8'));
}

const src = (over) => ({ citekey: null, doi: null, url: null, title: 't', year: null, inLibrary: false, ...over });

test('screen dedupes by DOI, citekey and normalized title, and splits sources outside the library', () => {
  const all = [
    {
      subQuestion: 'sq1',
      findings: [
        { claim: 'A', sources: [src({ citekey: 'smith2021', title: 'Sleep and Memory', year: 2021, inLibrary: true })], quotes: [], confidence: 'high' },
        { claim: 'B', sources: [src({ doi: '10.1/X', title: 'REM cycles', year: 2019 })], quotes: [], confidence: 'medium' },
      ],
      searchLog: [{ query: 'sleep memory', source: 'library', results: 3 }],
    },
    {
      subQuestion: 'sq2',
      // same paper as sq1's first finding, found again via a plain scholarly search with no citekey this time
      findings: [
        { claim: 'A restated', sources: [src({ title: 'Sleep AND Memory', year: 2021 })], quotes: [], confidence: 'low' },
        { claim: 'C', sources: [src({ doi: '10.1/x', title: 'REM cycles (dup)', year: 2019 })], quotes: [], confidence: 'high' }, // same DOI, different case/title
      ],
      searchLog: [{ query: 'REM cycles', source: 'scholarly', results: 5 }],
    },
  ];
  const out = screen(all);
  assert.equal(out.findings.length, 4);
  assert.equal(out.searchLog.length, 2);
  // "Sleep and Memory" merged across sq1/sq2 (title match), stays in-library because one occurrence had inLibrary: true
  const memory = out.sources.find((s) => s.citekey === 'smith2021');
  assert.ok(memory, JSON.stringify(out));
  assert.equal(out.sources.length, 1);
  // REM cycles merged by DOI (case-insensitive), has no citekey so stays "outside"
  assert.equal(out.outside.length, 1);
  assert.equal(out.outside[0].doi, '10.1/X'); // dedup matching is case-insensitive; the stored value keeps first-seen casing
  assert.equal(out.outside[0].title, 'REM cycles'); // first-seen title wins
});

test('screen on no findings returns empty, still-valid Screened shape', () => {
  assert.deepEqual(screen([]), { findings: [], sources: [], outside: [], searchLog: [] });
});

test('renderReport golden: a full report with themes, evidence, disagreements and references', () => {
  const request = { question: 'Does spaced repetition beat massed practice for long-term retention?', scope: { kind: 'collection', name: 'Learning' }, sources: ['library', 'scholarly'], years: { from: 2015, to: null }, depth: 'quick' };
  const report = {
    title: 'Spaced repetition and long-term retention',
    scope: 'the "Learning" collection',
    method: 'Searched the library and scholarly databases for controlled comparisons of spaced vs. massed practice.',
    themes: [
      { heading: 'Consistent long-term advantage', body: 'Multiple studies found spaced repetition outperforms massed practice on delayed recall tests.' },
      { heading: 'Effect size varies by interval', body: 'The advantage grows with longer retention intervals and shrinks for immediate recall.' },
    ],
    evidence: [
      { claim: 'Spaced practice improves 1-week retention over massed practice.', sources: ['cepeda2006', 'roediger2011'], strength: 'strong' },
      { claim: 'The effect is smaller for tests given within an hour of study.', sources: ['cepeda2006'], strength: 'moderate' },
    ],
    disagreements: 'One study (unindexed) reported no difference at very short intervals; the majority disagree.',
    gaps: 'Little coverage of spaced repetition for motor skills specifically.',
    references: [
      src({ citekey: 'cepeda2006', title: 'Distributed practice in verbal recall tasks', year: 2006, doi: '10.1037/0033-2909.132.3.354', inLibrary: true }),
      src({ citekey: 'roediger2011', title: 'Test-enhanced learning', year: 2011, inLibrary: true }),
    ],
  };
  const searchLog = [
    { query: 'spaced repetition retention', source: 'library', results: 4 },
    { query: 'massed vs spaced practice', source: 'scholarly', results: 12 },
  ];
  const { markdown, frontMatter } = renderReport(report, request, { model: 'codex/gpt-5', date: '2026-09-25' }, searchLog);

  assert.deepEqual(frontMatter, {
    question: request.question,
    scope: 'the "Learning" collection',
    model: 'codex/gpt-5',
    sources: ['library', 'scholarly'],
  });
  for (const heading of ['## Question and scope', '## Method', '## Themes', '## Evidence table', '## Disagreements', '## Gaps and future work', '## References']) {
    assert.ok(markdown.includes(heading), `missing section ${heading}`);
  }
  assertGolden('report-full.md', markdown);
});

test('renderReport handles empty themes/evidence/references without crashing (edge of a thin review)', () => {
  const request = { question: 'Q', scope: { kind: 'library' }, sources: ['library'], years: { from: null, to: null }, depth: 'quick' };
  const report = { title: 'Q', scope: 'the whole library', method: 'No sources found.', themes: [], evidence: [], disagreements: '', gaps: '', references: [] };
  const { markdown } = renderReport(report, request, { model: 'codex/gpt-5', date: '2026-09-25' }, []);
  assert.match(markdown, /\(No themes identified\.\)/);
  assert.match(markdown, /\(No evidence table entries\.\)/);
  assert.match(markdown, /None found\./);
  assert.match(markdown, /\(None noted\.\)/);
  assert.match(markdown, /\(No references\.\)/);
  assert.match(markdown, /\(no searches logged\)/);
});

test('renderReport with a body: the body, then Method and References, none of the themed headings', () => {
  const request = { question: 'Q', scope: { kind: 'library' }, sources: ['papers'], years: { from: null, to: null }, depth: 'quick' };
  const report = { title: 'Q', scope: 'the whole library', method: 'Searched the library.', body: 'Short answer first [@a].\n\n- point', themes: [], evidence: [], disagreements: '', gaps: '', references: [src({ citekey: 'a', title: 'Alpha', inLibrary: true })] };
  const { markdown } = renderReport(report, request, { model: 'm', date: '2026-10-14' }, [{ query: 'q', source: 'papers', results: 1 }]);
  assert.ok(markdown.startsWith('Short answer first [@a].'));
  assert.ok(markdown.indexOf('## Method') < markdown.indexOf('## References'));
  assert.match(markdown, /Searched the library\./);
  assert.match(markdown, /\| q \| papers \| 1 \|/);
  assert.match(markdown, /Alpha\. .*\[@a\]/);
  assert.doesNotMatch(markdown, /## (Themes|Evidence table|Disagreements|Gaps and future work|Extraction table|Question and scope)/);
});

test('stripUnknownCitations keeps allowed keys, including inside a group, and removes the rest', () => {
  const allowed = new Set(['a', 'b']);
  assert.equal(stripUnknownCitations('One [@a] two [@ghost] three.', allowed), 'One [@a] two three.');
  assert.equal(stripUnknownCitations('X [@a; @ghost; @b].', allowed), 'X [@a; @b].');
  assert.equal(stripUnknownCitations('Y [@ghost; @nope].', allowed), 'Y.');
});
