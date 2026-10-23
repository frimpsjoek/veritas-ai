import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupSteps, currentStep } from '../src/setup-card.js';

const done = (steps) => Object.fromEntries(steps.map((s) => [s.id, s.done]));

test('a new user: nothing is done and the first step is open', () => {
  const steps = setupSteps({ sources: { main_is_vault: false, folders: [{ name: 'veritas', kind: 'plain', role: 'main', enabled: true, documents: 2 }] }, providers: [{ provider: 'claude', state: 'missing' }], routines: [], mcp: [] });
  assert.deepEqual(done(steps), { library: false, notes: false, ai: false, papers: false, valency: false });
  assert.equal(currentStep(steps, []).id, 'library');
  assert.equal(steps[4].optional, true);
});

test('a folder counts as soon as it is listed, before indexing finishes', () => {
  const steps = setupSteps({ sources: { main_is_vault: false, folders: [
    { name: 'zotero', kind: 'zotero', role: 'zotero', enabled: true, documents: 0 },
    { name: 'papers', kind: 'pdf', role: 'listed', enabled: true, documents: 12 },
    { name: 'notes', kind: 'obsidian', role: 'listed', enabled: true, documents: 0 }] } });
  assert.deepEqual([done(steps).library, done(steps).notes], [true, true]);
  assert.equal(steps[0].detail, 'zotero (indexing), papers (12 items)');
  assert.equal(currentStep(steps, []).id, 'ai');
});

test('skipped steps are passed over; all done or skipped means no open step', () => {
  const steps = setupSteps({});
  assert.equal(currentStep(steps, ['library', 'notes']).id, 'ai');
  assert.equal(currentStep(steps, ['library', 'notes', 'ai', 'papers', 'valency']), null);
});

test('a set-up user: every step is done and says what it found', () => {
  const steps = setupSteps({
    sources: { main_is_vault: true, folders: [
      { name: 'lab-notebook', kind: 'obsidian', role: 'main', enabled: true, documents: 489 },
      { name: 'zotero', kind: 'zotero', role: 'zotero', enabled: true, documents: 3534 },
      { name: 'old', kind: 'plain', role: 'off', enabled: false, documents: 0 }] },
    providers: [{ provider: 'codex', state: 'ready' }, { provider: 'claude', state: 'ready' }],
    routines: [{ kind: 'radar', status: 'archived', radar: { seeds: { mine: ['A'] } } }, { kind: 'radar', status: 'active', radar: { seeds: { mine: ['A', 'B', 'C'] } } }],
    mcp: [{ state: 'connected', config: { name: 'valency' }, tools: new Array(38).fill({}) }],
  });
  assert.deepEqual(done(steps), { library: true, notes: true, ai: true, papers: true, valency: true });
  assert.equal(steps[0].detail, 'zotero (3,534 items)');
  assert.equal(steps[1].detail, 'lab-notebook (489 notes)');
  assert.equal(steps[2].detail, 'Codex and Claude ready');
  assert.equal(steps[3].detail, 'Reading radar from 3 of your papers');
  assert.equal(steps[4].detail, 'Connected: 38 tools over 500M+ papers and preprints');
  assert.equal(currentStep(steps, []), null);
});
