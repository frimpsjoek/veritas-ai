import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALCF_ENDPOINTS, ALCF_DISCOVERY_URL, assertAlcfUrl, modelsFromCatalog, createAlcfProviders,
} from '../src/providers/alcf.js';

function catalog() {
  return {
    clusters: {
      sophia: { frameworks: { vllm: { models: ['openai/gpt-oss-120b'], endpoints: ['/v1/chat/completions'] } } },
      metis: { frameworks: { api: { models: ['gpt-oss-120b', 'MiniMax-M3'], endpoints: ['/v1/chat/completions'] } } },
      minerva: { frameworks: { api: { models: ['kimi-k3.1-pro'], endpoints: ['/v1/chat/completions'] } } },
      tara: { frameworks: { api: { models: ['mistral-large-4'], endpoints: ['/v1/chat/completions'] } } },
    },
  };
}

function fakePlatform(steps) {
  const calls = [];
  return {
    calls,
    fetch: async (url, opts = {}) => {
      const i = calls.length;
      calls.push({ url: String(url), opts });
      if (i >= steps.length) throw new Error(`unexpected fetch ${url}`);
      const step = steps[i];
      if (step.throw) throw step.throw;
      return {
        ok: step.status ? step.status >= 200 && step.status < 300 : true,
        status: step.status ?? 200,
        headers: { get: (name) => name.toLowerCase() === 'content-length' && step.contentLength ? String(step.contentLength) : null },
        text: async () => step.text ?? JSON.stringify(step.body ?? {}),
        json: async () => step.body ?? {},
      };
    },
  };
}

const validPaths = [
  ALCF_DISCOVERY_URL,
  ...Object.values(ALCF_ENDPOINTS),
];

test('ALCF exposes exactly the four approved OpenAI-compatible endpoints', () => {
  assert.deepEqual(ALCF_ENDPOINTS, {
    'oss:alcf-sophia': 'https://inference-api.alcf.anl.gov/resource_server/sophia/vllm/v1',
    'oss:alcf-metis': 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    'oss:alcf-minerva': 'https://inference-api.alcf.anl.gov/resource_server/minerva/api/v1',
    'oss:alcf-tara': 'https://inference-api.alcf.anl.gov/resource_server/tara/api/v1',
  });
  for (const url of validPaths) assert.equal(assertAlcfUrl(url), url);
  for (const url of [
    'http://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    'https://inference-api.alcf.anl.gov.evil.example/resource_server/metis/api/v1',
    'https://inference-api.alcf.anl.gov@evil.example/resource_server/metis/api/v1',
    'https://inference-api.alcf.anl.gov:8443/resource_server/metis/api/v1',
    'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1?x=1',
    'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1#token',
    'https://inference-api.alcf.anl.gov/resource_server/metis/extra/v1',
    'https://inference-api.alcf.anl.gov/not-resource/metis/api/v1',
  ]) assert.throws(() => assertAlcfUrl(url), /ALCF/);
});

test('catalog parsing is scoped to exact cluster and framework', () => {
  assert.deepEqual(modelsFromCatalog(catalog(), ALCF_ENDPOINTS['oss:alcf-metis']), ['gpt-oss-120b', 'MiniMax-M3']);
  assert.deepEqual(modelsFromCatalog(catalog(), `${ALCF_ENDPOINTS['oss:alcf-metis']}/`), ['gpt-oss-120b', 'MiniMax-M3']);
  assert.deepEqual(modelsFromCatalog(catalog(), ALCF_ENDPOINTS['oss:alcf-sophia']), ['openai/gpt-oss-120b']);
  assert.deepEqual(modelsFromCatalog(catalog(), ALCF_ENDPOINTS['oss:alcf-tara']), ['mistral-large-4']);
  assert.deepEqual(modelsFromCatalog(catalog(), ALCF_ENDPOINTS['oss:alcf-minerva']), ['kimi-k3.1-pro']);
});

test('malformed or wrong-path catalogs are unknown, never an invented empty list', () => {
  for (const body of [null, {}, { clusters: [] }, { clusters: { metis: {} } },
    { clusters: { metis: { frameworks: { api: {} } } } },
    { clusters: { metis: { frameworks: { api: { models: {} } } } } }]) {
    assert.equal(modelsFromCatalog(body, ALCF_ENDPOINTS['oss:alcf-metis']), null);
  }
  const empty = { clusters: { metis: { frameworks: { api: { models: [] } } } } };
  assert.deepEqual(modelsFromCatalog(empty, ALCF_ENDPOINTS['oss:alcf-metis']), []);
  const other = ALCF_ENDPOINTS['oss:alcf-metis'].replace('/metis/', '/other/');
  assert.throws(() => modelsFromCatalog(catalog(), other), /ALCF/);
});

test('providers discover raw model IDs through one bounded authenticated cache', async () => {
  const platform = fakePlatform([{ body: catalog() }]);
  let tokens = 0;
  const providers = createAlcfProviders(platform, { accessToken: async () => { tokens += 1; return 'user-token'; } });
  const lists = await Promise.all([...providers.values()].map((provider) => provider.models()));
  assert.equal(tokens, 1);
  assert.equal(platform.calls.length, 1);
  assert.deepEqual(lists[1].map((model) => model.id), ['gpt-oss-120b', 'MiniMax-M3']);
  assert.equal(platform.calls[0].url, ALCF_DISCOVERY_URL);
  assert.equal(platform.calls[0].opts.headers.authorization, 'Bearer user-token');
  assert.equal(platform.calls[0].opts.redirect, 'error');

  await providers.get('oss:alcf-metis').models();
  assert.equal(platform.calls.length, 1, 'a successful catalog is shared for 60 seconds');
  const ready = await providers.get('oss:alcf-metis').status();
  assert.equal(ready.state, 'ready');
  assert.ok(!JSON.stringify(ready).includes('user-token'));
});

test('discovery 401 forces one refresh and retry before signed-out failure', async () => {
  let now = 1_000_000;
  const platform = fakePlatform([{ body: catalog() }, { status: 401 }, { body: catalog() }]);
  const forced = [];
  const providers = createAlcfProviders(platform, {
    accessToken: async (force = false) => { forced.push(force); return force ? 'fresh-token' : 'stale-token'; },
    clock: () => now,
  });
  const provider = providers.get('oss:alcf-metis');
  assert.equal((await provider.status()).state, 'ready');
  now += 61_000;
  forced.length = 0;
  assert.equal((await provider.status()).state, 'ready', 'fresh discovery succeeds after expired-token 401');
  assert.deepEqual(forced, [false, true]);
  assert.equal(platform.calls[2].opts.headers.authorization, 'Bearer fresh-token');
});

test('discovery failures are private, uncached, and map auth rejection to signed out', async () => {
  let now = 1_000_000;
  const platform = fakePlatform([
    { body: catalog() },
    { status: 401, text: 'do not expose this body' },
    { status: 401, text: 'do not expose this body' },
    { status: 401, text: 'do not expose this body' },
    { status: 401, text: 'do not expose this body' },
    { body: catalog() },
  ]);
  let calls = 0;
  const providers = createAlcfProviders(platform, {
    accessToken: async () => { calls += 1; return calls === 2 ? 'other-token' : 'user-token'; },
    clock: () => now,
  });
  const provider = providers.get('oss:alcf-minerva');
  assert.equal((await provider.status()).state, 'ready');

  now += 61_000;
  const rejected = await provider.status();
  assert.equal(rejected.state, 'signed_out');
  assert.ok(!JSON.stringify(rejected).includes('do not expose this body'));
  assert.deepEqual(await provider.models(), [], 'an expired cache does not serve stale models after token rejection');
  assert.equal((await provider.status()).state, 'ready', 'the next call retries instead of caching the failure');
});

test('discovery rejects oversized and timed-out responses, then retries', async () => {
  const huge = fakePlatform([{ body: catalog(), contentLength: 2 * 1024 * 1024 + 1 }, { body: catalog() }]);
  const providers = createAlcfProviders(huge, { accessToken: async () => 'user-token' });
  const provider = providers.get('oss:alcf-tara');
  assert.equal((await provider.status()).state, 'unreachable');
  assert.equal((await provider.status()).state, 'ready');
  assert.equal(huge.calls.length, 2);

  const timeout = { calls: [], async fetch(url, opts) {
    timeout.calls.push({ url: String(url), opts });
    if (timeout.calls.length > 1) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(catalog()) };
    }
    return new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  } };
  const timed = createAlcfProviders(timeout, { accessToken: async () => 'user-token', discoveryTimeoutMs: 5 });
  const other = timed.get('oss:alcf-sophia');
  assert.equal((await other.status()).state, 'unreachable');
  assert.equal((await other.status()).state, 'ready');
  assert.ok(timeout.calls[0].opts.signal instanceof AbortSignal);
});

test('ALCF chat construction uses fixed destination and raw model selection', async () => {
  const platform = fakePlatform([
    { body: catalog() },
    { chunks: [{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] },
  ]);
  // Use a second scripted call for the SSE body shape consumed by the OpenAI client.
  platform.fetch = async (url, opts = {}) => {
    platform.calls.push({ url: String(url), opts });
    if (platform.calls.length === 1) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(catalog()) };
    }
    const { sseBody } = await import('./fake-openai.mjs');
    return { ok: true, status: 200, body: sseBody([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]) };
  };
  const providers = createAlcfProviders(platform, { accessToken: async () => 'user-token' });
  const provider = providers.get('oss:alcf-metis');
  await provider.models();
  const events = [];
  for await (const event of provider.turn({
    model: { provider: 'oss:alcf-metis', model: 'gpt-oss-120b' }, input: 'hello', history: [], tools: { specs: [] }, outputSchema: null,
  }, new AbortController().signal)) events.push(event);
  assert.equal(events.at(-1).text, 'ok');
  assert.equal(platform.calls[1].url, `${ALCF_ENDPOINTS['oss:alcf-metis']}/chat/completions`);
  assert.equal(platform.calls[1].opts.headers.authorization, 'Bearer user-token');
  assert.equal(platform.calls[1].opts.redirect, 'error');
  assert.equal(JSON.parse(platform.calls[1].opts.body).model, 'gpt-oss-120b');
});
