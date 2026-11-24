import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paperParts, plainProse, plainText, wordGroups } from '../src/paper-text.js';

// arXiv:2611.20723 as the arXiv API gives it (spec 028 G1)
const OXIRANE = JSON.parse(readFileSync(new URL('./fixtures/arxiv-2611.20723.json', import.meta.url), 'utf8'));

test('a formula written in TeX inside a word becomes subscripts and superscripts', () => {
  assert.deepEqual(paperParts('Superatomic Re$_{6}$Se$_{8}$Cl$_{2}$ crystals'), [
    { text: 'Superatomic Re' }, { sub: '6' }, { text: 'Se' }, { sub: '8' }, { text: 'Cl' }, { sub: '2' }, { text: ' crystals' },
  ]);
  assert.deepEqual(paperParts('the CuAu$_3$ phase'), [{ text: 'the CuAu' }, { sub: '3' }, { text: ' phase' }]);
  assert.deepEqual(paperParts('Fe$^{2+}$ and B19$^\\prime$'), [{ text: 'Fe' }, { sup: '2+' }, { text: ' and B19' }, { sup: '′' }]);
  assert.deepEqual(paperParts('Li$_{1-x}$CoO$_2$'), [{ text: 'Li' }, { sub: '1−x' }, { text: 'CoO' }, { sub: '2' }]);
});

test('other inline math is kept as TeX to draw', () => {
  assert.deepEqual(paperParts('a small time step $\\tau$, nearly'), [{ text: 'a small time step ' }, { tex: '\\tau' }, { text: ', nearly' }]);
  assert.deepEqual(paperParts('grows as $4^N$ with $N$ qubits'), [{ text: 'grows as ' }, { tex: '4^N' }, { text: ' with ' }, { tex: 'N' }, { text: ' qubits' }]);
});

test('money stays money', () => {
  assert.deepEqual(paperParts('costs $5 and $10 a month'), [{ text: 'costs $5 and $10 a month' }]);
  assert.deepEqual(paperParts('from $5, or $6'), [{ text: 'from $5, or $6' }]);
});

test('TeX in the words themselves reads as text', () => {
  assert.equal(plainProse('the M{\\o}ller-Plesset propagator'), 'the Møller-Plesset propagator');
  assert.equal(plainProse('Jordan--Wigner and Kohn---Sham'), 'Jordan–Wigner and Kohn—Sham');
  assert.equal(plainProse("``exact'' at 5\\% cost"), '“exact” at 5% cost');
  assert.equal(plainProse('\\textit{ab initio} and \\emph{in situ} with {GW}'), 'ab initio and in situ with GW');
  assert.equal(plainProse('Schr\\"odinger~equation'), 'Schrödinger equation');
  assert.equal(plainProse('plain text, 2-3 eV'), 'plain text, 2-3 eV');
});

test('text without TeX is one part, and nothing is one empty list', () => {
  assert.deepEqual(paperParts('A domain-specific model'), [{ text: 'A domain-specific model' }]);
  assert.deepEqual(paperParts(''), []);
  assert.deepEqual(paperParts(null), []);
});

test('mhchem formulas: digits after an atom or a bracket are subscripts, a bond is a dash, charges are superscripts', () => {
  assert.deepEqual(paperParts('oxide, \\ce{C2H4O})'), [{ text: 'oxide, C' }, { sub: '2' }, { text: 'H' }, { sub: '4' }, { text: 'O)' }]);
  assert.deepEqual(paperParts('(\\ce{S1})'), [{ text: '(S' }, { sub: '1' }, { text: ')' }]);
  assert.deepEqual(paperParts('\\ce{C-O} and \\ce{C=O} and \\ce{C#N}'), [{ text: 'C–O and C=O and C#N' }]);
  assert.deepEqual(paperParts('\\ce{Fe^{2+}} \\ce{OH^-} \\ce{SO4^2-}'), [{ text: 'Fe' }, { sup: '2+' }, { text: ' OH' }, { sup: '−' }, { text: ' SO' }, { sub: '4' }, { sup: '2−' }]);
  assert.deepEqual(paperParts('\\ce{2H2 + O2 -> 2H2O}'), [{ text: '2H' }, { sub: '2' }, { text: ' + O' }, { sub: '2' }, { text: ' → 2H' }, { sub: '2' }, { text: 'O' }]);
  assert.deepEqual(paperParts('\\ce{Ca(OH)2}'), [{ text: 'Ca(OH)' }, { sub: '2' }]);
  assert.deepEqual(paperParts('\\ce{A ->[\\Delta] B}'), [{ text: 'A ->[Delta] B' }], 'what it cannot read is its inner text, without the command');
});

test('\\textit and \\emph are italic, \\textbf bold, also inside brackets', () => {
  assert.deepEqual(paperParts('Using Time-Dependent \\textit{GW} Molecular'), [{ text: 'Using Time-Dependent ' }, { text: 'GW', italic: true }, { text: ' Molecular' }]);
  assert.deepEqual(paperParts('theory [\\textit{J. Chem. Phys.} \\textbf{160}, 184102 (2024)]'), [
    { text: 'theory [' }, { text: 'J. Chem. Phys.', italic: true }, { text: ' ' }, { text: '160', bold: true }, { text: ', 184102 (2024)]' },
  ]);
  assert.deepEqual(paperParts('\\emph{in situ} Re$_{6}$'), [{ text: 'in situ', italic: true }, { text: ' Re' }, { sub: '6' }]);
  assert.deepEqual(paperParts('\\textit{$GW$}'), [{ tex: 'GW' }], 'math inside an italic command is still math');
});

test('a dollar glued to a word opens math when a letter or a command follows it (TD$GW$-MD), not money', () => {
  assert.deepEqual(paperParts('(TD$GW$-MD)'), [{ text: '(TD' }, { tex: 'GW' }, { text: '-MD)' }]);
  assert.deepEqual(paperParts('costs US$5 or US$6'), [{ text: 'costs US$5 or US$6' }]);
});

test('the arXiv:2611.20723 title and abstract keep no TeX in their words', () => {
  for (const value of [OXIRANE.title, OXIRANE.abstract]) {
    const parts = paperParts(value);
    for (const p of parts) if ('text' in p) assert.doesNotMatch(p.text, /[\\$]|\b(?:ce|textit|textbf)\{/, p.text);
  }
  const abstract = paperParts(OXIRANE.abstract);
  assert.ok(abstract.some((p) => 'tex' in p && p.tex === '\\rightarrow'));
  assert.ok(abstract.some((p) => 'text' in p && p.italic && p.text === 'J. Chem. Phys.'));
  assert.ok(abstract.some((p) => 'text' in p && p.bold && p.text === '160'));
  assert.deepEqual(paperParts(OXIRANE.title).filter((p) => 'italic' in p), [{ text: 'GW', italic: true }]);
});

test('where only a string fits, the title reads as text: formulas in Unicode, math as words', () => {
  assert.equal(plainText(OXIRANE.title), 'Oxirane Ring-Opening Dynamics Mediated By The First Singlet Excitation Using Time-Dependent GW Molecular Dynamics');
  assert.equal(plainText('Oxirane (\\ce{C2H4O}): \\ce{S2} $\\rightarrow$ \\ce{S1}'), 'Oxirane (C₂H₄O): S₂ → S₁');
  assert.equal(plainText('Superatomic Re$_{6}$Se$_{8}$ and Fe$^{2+}$, a step $\\tau$'), 'Superatomic Re₆Se₈ and Fe²⁺, a step τ');
  assert.equal(plainText('the $\\mathrm{O}_2$ case and $x^{ab}$'), 'the O₂ case and xᵃᵇ');
  assert.equal(plainText('costs $5 and $10'), 'costs $5 and $10');
  assert.equal(plainText(null), '');
});

// wordGroups on stand-ins: strings are text, { k } a drawn piece of that kind
const kindOf = (/** @type {any} */ p) => (typeof p === 'string' ? 'text' : p.k);
const atom = { k: 'atom' }, italic = { k: 'inline' }, block = { k: 'block' };

test('wordGroups: a word glued to an inline formula is one group, spaces stay outside it ("(TD$GW$-MD), a")', () => {
  assert.deepEqual(wordGroups(['time (TD', atom, '-MD), a'], kindOf), ['time', ' ', { glue: ['(TD', atom, '-MD),'] }, ' ', 'a']);
});

test('wordGroups: italic, bold and scripts alone are never glued, so "[\\textit{J. Chem. Phys.}" can still wrap', () => {
  const out = wordGroups(['theory [', italic, ' 160'], kindOf);
  assert.ok(out.every((g) => !(typeof g === 'object' && 'glue' in g)), JSON.stringify(out));
  assert.deepEqual(wordGroups(['C', { k: 'inline' }, 'H'], kindOf), ['C', { k: 'inline' }, 'H']);
});

test('wordGroups: text with no drawn piece is passed on unchanged', () => {
  const out = wordGroups(['Proximity effects  in layered', ' heterostructures.'], kindOf);
  assert.equal(out.join(''), 'Proximity effects  in layered heterostructures.');
  assert.ok(out.every((g) => typeof g === 'string'));
});

test('wordGroups: a lone formula between spaces, and a display equation, are not wrapped', () => {
  assert.deepEqual(wordGroups(['a ', atom, ' b'], kindOf), ['a', ' ', atom, ' ', 'b']);
  assert.deepEqual(wordGroups(['see', block, '.'], kindOf), ['see', block, '.']);
});

test('wordGroups: an italic phrase with spaces touching a formula keeps its own places to break ("\\textit{ab initio study of}$\\alpha$-Fe")', () => {
  const phrase = { k: 'spaced' };
  assert.deepEqual(wordGroups(['an ', phrase, atom, '-Fe film'], kindOf), ['an', ' ', phrase, { glue: [atom, '-Fe'] }, ' ', 'film']);
});
