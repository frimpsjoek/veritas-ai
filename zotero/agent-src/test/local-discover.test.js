import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createNodePlatform } from '../src/node/platform.mjs';
import { scanModels, inspectModel, expandHome } from '../src/local/discover.js';
import { parseVmStat, availableFromVmStat, memoryVerdict, neededBytes, swapFreeFrom } from '../src/local/memory.js';
import { makeRoot, removeRoot, writeModel } from './support/model-tree.mjs';

const fs = createNodePlatform().fs;

async function fixture() {
  const root = await makeRoot();
  const models = path.join(root, 'models');
  // chat models
  await writeModel(path.join(models, 'ConwayResearch', 'Underdog-Woof-4B-1.1'), { weights: 4000 });
  await writeModel(path.join(models, 'ConwayResearch', 'Underdog-Woof-2B-1.1'), { weights: 2000 });
  await writeModel(path.join(models, 'mlx-community', 'Qwen3.5-4B-MLX-4bit'), { template: 'file', weights: 3000 });
  // not chat models
  await writeModel(path.join(models, 'mlx-community', 'Qwen3-ASR-0.6B-4bit'));
  await writeModel(path.join(models, 'mlx-community', 'whisper-large-v3-turbo'), { arch: 'WhisperForConditionalGeneration' });
  await writeModel(path.join(models, 'embeddings', 'bge-small'), { arch: 'BertModel' });
  await writeModel(path.join(models, 'mlx-community', 'some-tts-model'));
  await writeModel(path.join(models, 'ConwayResearch', 'pii-30M-mlx-4bit'));
  await writeModel(path.join(models, 'google', 'gemma-gguf-only'), { weights: null });
  await writeModel(path.join(models, 'mlx-community', 'no-template'), { template: false });
  await writeModel(path.join(models, 'mlx-community', 'no-config'), { config: false });
  // a duplicate of a models-dir model inside the HF cache, plus a cache-only model
  const cache = path.join(root, 'cache');
  await writeModel(path.join(cache, 'models--ConwayResearch--Underdog-Woof-4B-1.1', 'snapshots', 'abc123'), { weights: 9999 });
  await writeModel(path.join(cache, 'models--ConwayResearch--woof-1.0-4B', 'snapshots', 'def456'), { weights: 4100 });
  await fsp.mkdir(path.join(cache, 'datasets--allenai--ai2_arc'), { recursive: true });
  return { root, models, cache };
}

test('scanModels lists exactly the chat models, once each, Woof 4B first, with sizes', async () => {
  const { root, models, cache } = await fixture();
  try {
    const { models: found, missing } = await scanModels({ fs, dirs: [models, cache] });
    assert.deepEqual(missing, []);
    assert.deepEqual(found.map((m) => m.id), [
      'mlx:ConwayResearch/Underdog-Woof-4B-1.1', // newest Woof 4B first
      'mlx:ConwayResearch/woof-1.0-4B',
      'mlx:ConwayResearch/Underdog-Woof-2B-1.1',
      'mlx:mlx-community/Qwen3.5-4B-MLX-4bit',
    ]);
    assert.equal(found[0].isDefault, true);
    assert.equal(found.filter((m) => m.isDefault).length, 1);
    assert.equal(found[0].sizeBytes, 4000, 'the first folder scanned wins over the cache copy');
    assert.equal(found[0].path, path.join(models, 'ConwayResearch', 'Underdog-Woof-4B-1.1'));
    assert.equal(found[1].path.includes('snapshots'), true);
    assert.match(found[0].note, /Best of the models tried here/);
    assert.match(found[2].note, /refuses or misses/);
    assert.match(found[3].note, /Not tested/);
    assert.equal(found[0].label, 'Underdog Woof 4B 1.1');
    assert.equal(found.every((m) => m.source === 'mlx'), true);
  } finally { await removeRoot(root); }
});

test('stray files (.DS_Store) in the models folder or an org folder do not break the scan', async () => {
  const root = await makeRoot();
  try {
    const models = path.join(root, 'models');
    await writeModel(path.join(models, 'ConwayResearch', 'Underdog-Woof-4B-1.1'), { weights: 4000 });
    await fsp.writeFile(path.join(models, '.DS_Store'), 'x');
    await fsp.writeFile(path.join(models, 'ConwayResearch', '.DS_Store'), 'x');
    const { models: found } = await scanModels({ fs, dirs: [models], home: '/h' });
    assert.deepEqual(found.map((m) => m.id), ['mlx:ConwayResearch/Underdog-Woof-4B-1.1']);
  } finally { await removeRoot(root); }
});

test('a scan folder that does not exist (an unmounted drive) is reported, and the others still scan', async () => {
  const { root, cache } = await fixture();
  try {
    const gone = path.join(root, 'Volumes', 'Content', 'models');
    const { models, missing } = await scanModels({ fs, dirs: [gone, cache] });
    assert.deepEqual(missing, [gone]);
    assert.deepEqual(models.map((m) => m.id), ['mlx:ConwayResearch/Underdog-Woof-4B-1.1', 'mlx:ConwayResearch/woof-1.0-4B']);
  } finally { await removeRoot(root); }
});

test('with no Woof 4B the first model is the default; an empty scan has none', async () => {
  const root = await makeRoot();
  try {
    await writeModel(path.join(root, 'org', 'zeta-chat'));
    await writeModel(path.join(root, 'org', 'alpha-chat'));
    const { models } = await scanModels({ fs, dirs: [root] });
    assert.deepEqual(models.map((m) => [m.id, m.isDefault]), [['mlx:org/alpha-chat', true], ['mlx:org/zeta-chat', false]]);
    assert.deepEqual((await scanModels({ fs, dirs: [path.join(root, 'org', 'nothing-here')] })).models, []);
  } finally { await removeRoot(root); }
});

test('inspectModel needs weights, a chat template and a chat-looking name', async () => {
  const root = await makeRoot();
  try {
    await writeModel(path.join(root, 'ok'));
    await writeModel(path.join(root, 'bad'), { template: false });
    assert.deepEqual(await inspectModel(fs, path.join(root, 'ok'), 'org/ok'), { sizeBytes: 4096 });
    assert.equal(await inspectModel(fs, path.join(root, 'bad'), 'org/bad'), null);
    assert.equal(await inspectModel(fs, path.join(root, 'ok'), 'org/Qwen3-ASR-0.6B'), null);
    assert.equal(await inspectModel(fs, path.join(root, 'missing'), 'org/missing'), null);
  } finally { await removeRoot(root); }
});

test('expandHome only expands a leading ~', () => {
  assert.equal(expandHome('~/.cache/x', '/Users/u'), '/Users/u/.cache/x');
  assert.equal(expandHome('/Volumes/Content', '/Users/u'), '/Volumes/Content');
});

// ---------- memory ----------

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    24136.
Pages active:                                 149770.
Pages inactive:                               155225.
Pages speculative:                              1000.
Pages purgeable:                                 500.
`;

test('vm_stat output becomes available bytes (free + inactive + speculative + purgeable)', () => {
  assert.deepEqual(parseVmStat(VM_STAT), { pageSize: 16384, free: 24136, inactive: 155225, speculative: 1000, purgeable: 500 });
  assert.equal(availableFromVmStat(VM_STAT), (24136 + 155225 + 1000 + 500) * 16384);
  assert.equal(availableFromVmStat('garbage'), null);
});

test('memoryVerdict refuses plainly when the model clearly does not fit, and never blocks on an unknown', () => {
  const GB = 1024 ** 3;
  assert.equal(neededBytes(4 * GB), Math.round(4 * GB * 1.2 + 0.6 * GB));
  const no = memoryVerdict({ label: 'Woof 4B', modelBytes: 4 * GB, availableBytes: 1.1 * GB });
  assert.equal(no.ok, false);
  assert.match(no.message, /isn't enough free memory to open Woof 4B \(it needs about 5\.4 GB, about 1\.1 GB is free\)\. Close some apps and try again\./);
  assert.deepEqual(memoryVerdict({ label: 'x', modelBytes: 4 * GB, availableBytes: 8 * GB }), { ok: true });
  assert.deepEqual(memoryVerdict({ label: 'x', modelBytes: 4 * GB, availableBytes: null }), { ok: true });
  assert.deepEqual(memoryVerdict({ label: 'x', modelBytes: null, availableBytes: 1 }), { ok: true });
});

test('with swap nearly full, inactive memory counts only up to the swap that is left', () => {
  assert.equal(swapFreeFrom('total = 16384.00M  used = 15076.38M  free = 1307.62M  (encrypted)'), Math.round(1307.62 * 1024 ** 2));
  assert.equal(swapFreeFrom('nonsense'), null);
  const all = availableFromVmStat(VM_STAT);
  assert.equal(availableFromVmStat(VM_STAT, null), all, 'unknown swap: unchanged');
  assert.equal(availableFromVmStat(VM_STAT, 100 * 16384), (24136 + 1000 + 500 + 100) * 16384);
  assert.equal(availableFromVmStat(VM_STAT, 10 * 1024 ** 3), all, 'plenty of swap: unchanged');
});
