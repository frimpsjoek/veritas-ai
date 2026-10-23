import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupSteps } from '../src/setup-card.js';

const done = (steps) => Object.fromEntries(steps.map((s) => [s.id, s.done]));

test('a new user: nothing is done, and each step says what to do', () => {
  const steps = setupSteps({ sources: { main_is_vault: false, folders: [{ name: 'veritas', kind: 'plain', role: 'main', enabled: true, documents: 2 }] }, providers: [{ provider: 'claude', state: 'not_installed' }], routines: [], mcp: [] });
  assert.deepEqual(done(steps), { library: false, notes: false, ai: false, papers: false, valency: false });
  assert.match(steps[0].detail, /Zotero/);
  assert.equal(steps[4].optional, true);
  assert.deepEqual(steps.map((s) => s.route.section), ['folders', 'folders', 'models', 'radar', 'sources']);
});

test('a set-up user: every step is done and says what it found', () => {
  const steps = setupSteps({
    sources: { main_is_vault: true, folders: [
      { name: 'lab-notebook', kind: 'obsidian', role: 'main', enabled: true, documents: 489 },
      { name: 'zotero', kind: 'zotero', role: 'zotero', enabled: true, documents: 3534 },
      { name: 'old', kind: 'plain', role: 'off', enabled: false, documents: 0 }] },
    providers: [{ provider: 'codex', state: 'ready' }, { provider: 'claude', state: 'ready' }, { provider: 'local', state: 'not_installed' }],
    routines: [{ kind: 'radar', status: 'archived', radar: { seeds: { mine: ['A'] } } }, { kind: 'radar', status: 'active', radar: { seeds: { mine: ['A', 'B', 'C'] } } }],
    mcp: [{ state: 'connected', config: { name: 'valency' }, tools: new Array(38).fill({}) }],
  });
  assert.deepEqual(done(steps), { library: true, notes: true, ai: true, papers: true, valency: true });
  assert.equal(steps[0].detail, 'Zotero: 3,534 items');
  assert.equal(steps[1].detail, 'lab-notebook: 489 notes');
  assert.equal(steps[2].detail, 'Codex and Claude ready');
  assert.equal(steps[3].detail, 'Reading radar from 3 of your papers');
  assert.equal(steps[4].detail, 'Connected: 38 tools over 500M+ papers and preprints');
  assert.equal(steps[4].brand, 'Valency Bond');
});

test('an archived radar or an output folder that is not a vault does not count', () => {
  const steps = setupSteps({ sources: { main_is_vault: false, folders: [{ name: 'Veritas', kind: 'plain', role: 'main', enabled: true, documents: 5 }] },
    routines: [{ kind: 'radar', status: 'archived', radar: { seeds: { mine: ['A'] } } }] });
  assert.equal(done(steps).notes, false);
  assert.equal(done(steps).papers, false);
});
