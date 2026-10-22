import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSize, buttonLabel, modelRows, menuGroups, isTested, selectedId, cloudChoice, planSwitch, statusLines, isLocal, HONEST_NOTE } from '../src/chat/local-menu-data.js';

const GB = 1024 ** 3;
const models = [
  { id: 'mlx:a/Woof-4B', label: 'Woof 4B', isDefault: true, sizeBytes: 4.2 * GB, note: 'Best of the models tried here.', unavailable: null },
  { id: 'mlx:a/Other', label: 'Other', isDefault: false, sizeBytes: 800 * 1024 ** 2, note: 'Not tested on your library.', unavailable: "Needs mlx-lm, which isn't installed." },
  { id: 'ollama:x', label: 'x', isDefault: false, sizeBytes: null, note: 'Served by Ollama.', unavailable: null },
];
const cloudRoles = { chat: { provider: 'claude', model: 'opus' }, ask: { provider: 'codex', model: null } };
const localRoles = { chat: { provider: 'local', model: 'mlx:a/Woof-4B' }, ask: { provider: 'local', model: 'mlx:a/Woof-4B' } };

test('sizes are plain', () => {
  assert.equal(formatSize(4.2 * GB), '4.2 GB');
  assert.equal(formatSize(800 * 1024 ** 2), '800 MB');
  assert.equal(formatSize(null), '');
});

test('the button says Cloud, or which Mac model; a local role with no model named means the default', () => {
  assert.equal(buttonLabel({ chat: { provider: 'codex', model: null } }, models), 'Cloud');
  assert.equal(buttonLabel(cloudRoles, models), 'opus', 'a cloud model with no listed name shows its id');
  assert.equal(buttonLabel(localRoles, models), 'On this Mac: Woof 4B');
  assert.equal(buttonLabel({ chat: { provider: 'local', model: null } }, models), 'On this Mac: Woof 4B');
  assert.equal(buttonLabel({ chat: { provider: 'local', model: 'gone' } }, models), 'On this Mac: default model');
  assert.equal(isLocal({}), false);
});

test('rows carry size and note, and a model that cannot run says why and is disabled', () => {
  assert.deepEqual(modelRows(models).map((r) => [r.label, r.hint, r.disabled]), [
    ['Woof 4B', '4.2 GB · Best of the models tried here.', false],
    ['Other', "800 MB · Needs mlx-lm, which isn't installed.", true],
    ['x', 'Served by Ollama.', false],
  ]);
  assert.equal(selectedId(cloudRoles, models), null);
  assert.equal(selectedId({ chat: { provider: 'local', model: null } }, models), 'mlx:a/Woof-4B');
});

test('switching to a Mac model moves Chat and Ask together and remembers the cloud choice it replaced', () => {
  const plan = planSwitch({ target: 'mlx:a/Woof-4B', roles: cloudRoles, saved: null });
  assert.deepEqual(plan.set, [{ role: 'chat', choice: { provider: 'local', model: 'mlx:a/Woof-4B' } }, { role: 'ask', choice: { provider: 'local', model: 'mlx:a/Woof-4B' } }]);
  assert.deepEqual(plan.saveCloud, { chat: { provider: 'claude', model: 'opus' }, ask: { provider: 'codex', model: null } });
  // switching between two Mac models does not overwrite what was saved
  assert.equal(planSwitch({ target: 'ollama:x', roles: localRoles, saved: plan.saveCloud }).saveCloud, null);
});

test('switching back restores the saved cloud choice, else Codex', () => {
  const saved = { chat: { provider: 'claude', model: 'opus' }, ask: { provider: 'codex', model: null } };
  assert.deepEqual(planSwitch({ target: null, roles: localRoles, saved }).set.map((s) => s.choice.provider), ['claude', 'codex']);
  assert.deepEqual(planSwitch({ target: null, roles: localRoles, saved: null }).set.map((s) => s.choice), [{ provider: 'codex', model: null }, { provider: 'codex', model: null }]);
  assert.deepEqual(cloudChoice({ chat: { provider: 'local', model: 'x' } }, cloudRoles, 'chat'), { provider: 'claude', model: 'opus' }, 'a saved local choice is never "restored"');
});

test('status lines: the detail, plus the fix only when it is not ready', () => {
  assert.deepEqual(statusLines({ state: 'ready', detail: '3 models found.', installHelp: 'ignored' }), [], 'a ready provider says nothing');
  assert.deepEqual(statusLines({ state: 'missing', detail: 'Local models need mlx-lm.', installHelp: 'Install it with: pip install mlx-lm' }), ['Local models need mlx-lm.', 'Install it with: pip install mlx-lm']);
  assert.deepEqual(statusLines(null), []);
  assert.match(HONEST_NOTE, /can get facts wrong/);
});

test('with no saved choice, Cloud goes to the first ready cloud provider (Codex, then Claude Code), else Codex', async () => {
  const { readyCloud } = await import('../src/chat/local-menu-data.js');
  const statuses = [{ provider: 'codex', state: 'missing' }, { provider: 'claude', state: 'ready' }, { provider: 'local', state: 'ready' }];
  assert.deepEqual(readyCloud(statuses), ['claude']);
  const localRoles = { chat: { provider: 'local', model: 'm' }, ask: { provider: 'local', model: 'm' } };
  assert.deepEqual(planSwitch({ target: null, roles: localRoles, saved: null, ready: readyCloud(statuses) }).set.map((s) => s.choice.provider), ['claude', 'claude']);
  assert.deepEqual(planSwitch({ target: null, roles: localRoles, saved: null, ready: [] }).set.map((s) => s.choice.provider), ['codex', 'codex']);
  const both = [{ provider: 'claude', state: 'ready' }, { provider: 'codex', state: 'ready' }];
  assert.equal(cloudChoice(null, localRoles, 'chat', readyCloud(both)).provider, 'codex');
});

const untested = (id) => ({ id, label: id, isDefault: false, sizeBytes: 2 * GB, note: 'Not tested on your library.', unavailable: null });

test('tested models come first; untested ones fold behind "More models", and a note is one short sentence', () => {
  const list = [models[0], untested('u1'), untested('u2')];
  assert.equal(isTested(models[0]), true);
  assert.equal(isTested(untested('u1')), false);
  const { top, more } = menuGroups(list, null);
  assert.deepEqual(top.map((r) => [r.label, r.hint]), [['Woof 4B', '4.2 GB · Best of the models tried here.']]);
  assert.deepEqual(more.map((r) => [r.label, r.hint]), [['u1', '2.0 GB'], ['u2', '2.0 GB']], 'no repeated "Not tested" on every row');
  assert.deepEqual(menuGroups([models[0], { ...models[0], note: 'Best of the models tried here. Still gets some facts wrong.' }], null).top.map((r) => r.hint), ['4.2 GB · Best of the models tried here.', '4.2 GB · Best of the models tried here.']);
});

test('the selected model stays in the top group even when it was never tested, keeping list order', () => {
  const list = [models[0], untested('u1'), untested('u2')];
  const { top, more } = menuGroups(list, 'u2');
  assert.deepEqual(top.map((r) => r.id), ['mlx:a/Woof-4B', 'u2']);
  assert.deepEqual(more.map((r) => r.id), ['u1']);
  assert.deepEqual(menuGroups([untested('u1')], null), { top: [], more: [{ id: 'u1', label: 'u1', hint: '2.0 GB', disabled: false }] });
});

import { cloudRows, planCloudModel, planDefault } from '../src/chat/local-menu-data.js';

const claudeList = [
  { id: 'sonnet', label: 'Sonnet', hint: 'good for most questions', efforts: [], source: 'builtin', isDefault: false },
  { id: 'opus', label: 'Opus', hint: null, efforts: [], source: 'builtin', isDefault: false },
  { id: 'haiku', label: 'Haiku', hint: null, efforts: [], source: 'builtin', isDefault: false },
];

test('the Cloud group lists exactly the ticked models, in ticked order, with the provider under each and the current one selected', () => {
  const roles = { chat: { provider: 'claude', model: 'opus' }, ask: { provider: 'claude', model: 'opus' } };
  const rows = cloudRows(['claude:sonnet', 'claude:opus', 'codex:gpt-5.5'], { claude: claudeList }, roles);
  assert.deepEqual(rows.map((r) => [r.label, r.hint, r.selected]), [['Sonnet', 'Claude Code', false], ['Opus', 'Claude Code', true], ['gpt-5.5', 'Codex', false]]);
  assert.ok(!rows.some((r) => r.label === 'Haiku'), 'an unticked model is not listed');
  assert.deepEqual(cloudRows([], { claude: claudeList }, roles), []);
  assert.ok(cloudRows(['claude:opus'], { claude: claudeList }, localRoles).every((r) => !r.selected), 'a Mac model on Chat means no cloud row is checked');
});

test('the button names the chosen cloud model, and says Cloud when Chat names none', () => {
  const labels = { 'claude:sonnet': 'Sonnet' };
  assert.equal(buttonLabel({ chat: { provider: 'claude', model: 'sonnet' } }, models, labels), 'Sonnet');
  assert.equal(buttonLabel({ chat: { provider: 'claude', model: 'typed-id' } }, models, labels), 'typed-id');
  assert.equal(buttonLabel(cloudRoles, models, labels), 'opus', 'an id with no listed name shows as typed');
  assert.equal(buttonLabel({ chat: { provider: 'codex', model: null } }, models, labels), 'Cloud');
});

test('choosing a cloud model sets Chat and Ask to that provider and model, and saves nothing to restore', () => {
  const plan = planCloudModel({ provider: 'claude', model: 'sonnet' });
  assert.deepEqual(plan.set, [{ role: 'chat', choice: { provider: 'claude', model: 'sonnet' } }, { role: 'ask', choice: { provider: 'claude', model: 'sonnet' } }]);
  assert.equal(plan.saveCloud, null);
});

test('Set as default makes what Chat uses the default model and clears the tasks already equal to it; null when it already is', () => {
  const roles = { chat: { provider: 'claude', model: 'opus' }, ask: { provider: 'claude', model: 'opus' }, writer: { provider: 'codex', model: null } };
  const patch = planDefault({ roles, defaultModel: null }, roles);
  assert.deepEqual(patch.defaultModel, { provider: 'claude', model: 'opus' });
  assert.deepEqual(patch.roles, { chat: null, ask: null });
  assert.equal(planDefault({ roles, defaultModel: { provider: 'claude', model: 'opus' } }, roles), null);
  assert.equal(planDefault({ roles: {}, defaultModel: null }, {}), null);
});
