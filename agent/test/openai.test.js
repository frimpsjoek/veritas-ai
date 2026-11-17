import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openaiProvider, applyChunk, createStreamState, toOpenAiTools, buildMessages, parseSse,
  looksLikeStatusMarkdownSchema, wrapAsAnsweredMarkdown,
} from '../src/providers/openai.js';
import { scriptedFetch, sseBody } from './fake-openai.mjs';
import { ASK_SCHEMA } from '../src/core.js';

function fakePlatform(fetchFn) {
  return { fetch: fetchFn, async spawn() { throw new Error('not used'); }, async which() { return null; }, fs: {}, async serve() { throw new Error('not used'); }, homeDir: '/fake/home' };
}

function toolSession(callImpl) {
  return {
    specs: [{ name: 'search_library', description: 'search', inputSchema: { type: 'object' } }],
    call: callImpl ?? (async () => ({ ok: true, text: 'no-op' })),
    seen: () => [],
    close() {},
    mcp: { url: '', token: '' },
  };
}

function baseReq(overrides = {}) {
  return { sessionKey: 's1', model: { provider: 'oss:default', model: 'local-model' }, instructions: 'be terse', history: [], input: 'hello', tools: toolSession(), web: 'off', outputSchema: null, ...overrides };
}

async function collect(iterable) {
  const events = [];
  for await (const ev of iterable) events.push(ev);
  return events;
}

function unterminatedBody(text, onCancel) {
  let reads = 0;
  return { getReader: () => ({
    async read() {
      reads += 1;
      return reads === 1 ? { done: false, value: new TextEncoder().encode(text) } : { done: true };
    },
    async cancel() { onCancel(); },
    releaseLock() {},
  }) };
}

function trackedBody(chunks, { cancelError, readError } = {}) {
  const iterator = chunks[Symbol.iterator]();
  const counts = { reads: 0, cancellations: 0, releases: 0 };
  return { counts, getReader: () => ({
    async read() {
      counts.reads += 1;
      if (readError) throw readError;
      return iterator.next();
    },
    async cancel() {
      counts.cancellations += 1;
      if (cancelError) throw cancelError;
    },
    releaseLock() { counts.releases += 1; },
  }) };
}

// ---------- pure helpers ----------

test('toOpenAiTools maps ToolSession.specs to function tool defs', () => {
  const tools = toOpenAiTools([{ name: 'search_library', description: 'x', inputSchema: { type: 'object' } }]);
  assert.deepEqual(tools, [{ type: 'function', function: { name: 'search_library', description: 'x', parameters: { type: 'object' } } }]);
});

test('buildMessages puts instructions first, then history, then the new user turn', () => {
  const messages = buildMessages({ instructions: 'sys', history: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }], input: 'c' });
  assert.deepEqual(messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
});

test('applyChunk accumulates text deltas and streamed tool-call arguments by index', () => {
  const state = createStreamState();
  applyChunk(state, { choices: [{ delta: { content: 'Hel' } }] });
  applyChunk(state, { choices: [{ delta: { content: 'lo' } }] });
  applyChunk(state, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '' } }] } }] });
  applyChunk(state, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] });
  applyChunk(state, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] });
  assert.equal(state.text, 'Hello');
  assert.deepEqual(state.toolCalls, [{ id: 'call_1', name: 'search', arguments: '{"q":"x"}' }]);
  assert.equal(state.finishReason, 'tool_calls');
});

test('parseSse yields parsed JSON chunks and stops at [DONE]', async () => {
  const encoder = new TextEncoder();
  const lines = ['data: {"a":1}\n\n', 'data: {"a":2}\n\n', 'data: [DONE]\n\n'];
  let i = 0;
  const body = { getReader: () => ({ async read() { if (i >= lines.length) return { done: true }; return { done: false, value: encoder.encode(lines[i++]) }; } }) };
  const chunks = [];
  for await (const c of parseSse(body)) chunks.push(c);
  assert.deepEqual(chunks, [{ a: 1 }, { a: 2 }]);
});

test('parseSse frames a long chunked line without re-encoding or decoding unfinished prefixes', async (t) => {
  const text = 'x'.repeat(256 * 1024);
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ text })}\n`);
  function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += 31) yield bytes.subarray(offset, offset + 31);
  }
  const body = trackedBody(chunks());
  const encode = t.mock.method(TextEncoder.prototype, 'encode');
  const decode = t.mock.method(TextDecoder.prototype, 'decode');
  assert.deepEqual(await collect(parseSse(body, { maxBytes: bytes.length, maxLineBytes: bytes.length - 1 })), [{ text }]);
  assert.equal(encode.mock.callCount(), 0, 'raw-byte framing must not re-encode accumulated text');
  assert.equal(decode.mock.callCount(), 1, 'decode only the complete line');
  assert.deepEqual(body.counts, { reads: Math.ceil(bytes.length / 31) + 1, cancellations: 0, releases: 1 });
});

test('parseSse preserves UTF-8, CRLF, multiple lines, ignored fields and the unterminated-tail behavior', async () => {
  const expected = { text: '\u00e9\u4e2d\ud83d\ude00' };
  const first = `data: ${JSON.stringify(expected)}\r\n`;
  const bytes = new TextEncoder().encode(`${first}\n: comment\nevent: message\ndata: invalid\ndata: {"n":2}\ndata: {"ignored":true}`);
  // Every possible split includes splits inside multibyte characters and CRLF.
  for (let split = 0; split <= bytes.length; split += 1) {
    const body = trackedBody([bytes.subarray(0, split), bytes.subarray(split)]);
    assert.deepEqual(await collect(parseSse(body, { maxBytes: bytes.length, maxLineBytes: new TextEncoder().encode(first).length - 1 })), [expected, { n: 2 }]);
    assert.deepEqual(body.counts, { reads: 3, cancellations: 0, releases: 1 });
  }
});

test('parseSse cancels chunked line overflow before decoding or reading further', async (t) => {
  const block = new Uint8Array(1024).fill(120);
  const body = trackedBody(Array(66).fill(block));
  const decode = t.mock.method(TextDecoder.prototype, 'decode');
  await assert.rejects(collect(parseSse(body, { maxBytes: 128 * 1024, maxLineBytes: 64 * 1024 })), {
    message: 'ALCF completion stream limit exceeded', status: 413,
  });
  assert.equal(decode.mock.callCount(), 0);
  assert.deepEqual(body.counts, { reads: 65, cancellations: 1, releases: 1 });
});

test('parseSse enforces raw-byte line limits, including partial UTF-8 and complete lines', async () => {
  for (const chunks of [
    [new Uint8Array([0xf0, 0x9f]), new Uint8Array([0x98])],
    [new TextEncoder().encode('abc\n')],
  ]) {
    const body = trackedBody(chunks, { cancelError: new Error('private cancellation failure') });
    await assert.rejects(collect(parseSse(body, { maxBytes: 100, maxLineBytes: 2 })), {
      message: 'ALCF completion stream limit exceeded', status: 413,
    });
    assert.equal(body.counts.cancellations, 1);
    assert.equal(body.counts.releases, 1);
  }
});

test('parseSse checks the total cap before decoding even a chunk containing complete lines', async (t) => {
  const line = new TextEncoder().encode('data: {"n":1}\n');
  const body = trackedBody([line, line, line]);
  const decode = t.mock.method(TextDecoder.prototype, 'decode');
  const stream = parseSse(body, { maxBytes: line.length * 2 - 1, maxLineBytes: line.length - 1 });
  assert.deepEqual((await stream.next()).value, { n: 1 });
  await assert.rejects(stream.next(), { status: 413 });
  assert.equal(decode.mock.callCount(), 1);
  assert.deepEqual(body.counts, { reads: 2, cancellations: 1, releases: 1 });
});

test('parseSse stops at DONE without decoding trailing lines and cancels once', async (t) => {
  const bytes = new TextEncoder().encode('data: {"n":1}\ndata: [DONE]\ndata: {"n":2}\n');
  const body = trackedBody([bytes, bytes]);
  const decode = t.mock.method(TextDecoder.prototype, 'decode');
  assert.deepEqual(await collect(parseSse(body)), [{ n: 1 }]);
  assert.equal(decode.mock.callCount(), 2);
  assert.deepEqual(body.counts, { reads: 1, cancellations: 1, releases: 1 });
});

test('parseSse cancels once on consumer return or break, even if cancellation rejects', async () => {
  for (const explicitReturn of [true, false]) {
    const body = trackedBody([new TextEncoder().encode('data: {"n":1}\ndata: {"n":2}\n')], {
      cancelError: new Error('private cancellation failure'),
    });
    const stream = parseSse(body);
    if (explicitReturn) {
      assert.deepEqual((await stream.next()).value, { n: 1 });
      await stream.return();
      await stream.return();
    } else {
      for await (const chunk of stream) { assert.deepEqual(chunk, { n: 1 }); break; }
    }
    assert.deepEqual(body.counts, { reads: 1, cancellations: 1, releases: 1 });
  }
});

test('parseSse preserves read failures and releases its reader after attempted cancellation', async () => {
  const error = new Error('read failed');
  const body = trackedBody([], { readError: error, cancelError: new Error('cancel failed') });
  await assert.rejects(collect(parseSse(body)), (actual) => actual === error);
  assert.deepEqual(body.counts, { reads: 1, cancellations: 1, releases: 1 });
});

test('parseSse owns unfinished fragments rather than retaining input buffer views', async () => {
  const buffer = new Uint8Array(1024 * 1024);
  const first = new TextEncoder().encode('data: {"text":"');
  buffer.set(first);
  function* chunks() {
    yield buffer.subarray(0, first.length);
    buffer.fill(120);
    yield new TextEncoder().encode('ok"}\n');
  }
  assert.deepEqual(await collect(parseSse(trackedBody(chunks()))), [{ text: 'ok' }]);
});

// ---------- full turn loop ----------

test('turn releases and cancels a real response stream once on abort or consumer return', async () => {
  for (const abort of [true, false]) {
    let cancellations = 0;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n'));
      },
      cancel() { cancellations += 1; },
    });
    const provider = openaiProvider(fakePlatform(async () => ({ ok: true, body })), {
      baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
      apiKey: async () => 'user-token',
    });
    const controller = new AbortController();
    const turn = provider.turn(baseReq(), controller.signal);
    assert.deepEqual((await turn.next()).value, { type: 'text', delta: 'hi' });
    assert.equal(body.locked, true);
    if (abort) {
      controller.abort();
      assert.deepEqual(await collect(turn), [{ type: 'failed', error: { kind: 'cancelled', message: 'Interrupted.' } }]);
    } else {
      await turn.return();
      await turn.return();
    }
    assert.equal(body.locked, false);
    assert.equal(cancellations, 1);
  }
});

test('dynamic completions default to a 64 MiB total cap across short-enough lines', async () => {
  const block = new Uint8Array(1024 * 1024).fill(120);
  block[block.length - 1] = 10;
  const body = trackedBody(Array(66).fill(block));
  const provider = openaiProvider(fakePlatform(async () => ({ ok: true, body })), {
    baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    apiKey: async () => 'user-token',
  });
  assert.deepEqual(await collect(provider.turn(baseReq(), new AbortController().signal)), [{
    type: 'failed', error: { kind: 'provider_crashed', message: 'ALCF completion stream is too large.' },
  }]);
  assert.deepEqual(body.counts, { reads: 65, cancellations: 1, releases: 1 });
});

test('static endpoints remain unbounded even with a configured dynamic stream limit', async () => {
  const provider = openaiProvider(fakePlatform(scriptedFetch([
    { chunks: [{ choices: [{ delta: { content: 'static answer' } }] }] },
  ])), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'static-key', maxStreamBytes: 1 });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(events.at(-1).type, 'final');
  assert.equal(events.at(-1).text, 'static answer');
});

test('turn(): a tool call is executed in-process via ToolSession.call, then the model answers', async () => {
  const calls = [];
  const session = toolSession(async (name, args) => { calls.push({ name, args }); return { ok: true, text: '1 paper found for graphene' }; });
  const fetchFn = scriptedFetch([
    { chunks: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_library', arguments: '{"query":"graphene"}' } } ] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }] },
    { chunks: [{ choices: [{ delta: { content: '1 paper found for graphene [@smith2021]' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }] },
  ]);
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: null });
  const events = await collect(provider.turn(baseReq({ tools: session }), new AbortController().signal));
  assert.deepEqual(calls, [{ name: 'search_library', args: { query: 'graphene' } }]);
  const activities = events.filter((e) => e.type === 'activity');
  assert.equal(activities[0].phase, 'start');
  assert.equal(activities[1].phase, 'end');
  assert.equal(activities[1].ok, true);
  const final = events.find((e) => e.type === 'final');
  assert.match(final.text, /graphene/);
  assert.equal(final.usage.inputTokens, 10);
});

test('turn(): a 400 on response_format retries once without it', async () => {
  const fetchFn = scriptedFetch([
    { status: 400, text: 'response_format not supported' },
    { chunks: [{ choices: [{ delta: { content: '{"status":"answered","markdown":"hi"}' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] },
  ]);
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: null });
  const schema = { type: 'object', properties: { status: { type: 'string' }, markdown: { type: 'string' } } };
  const events = await collect(provider.turn(baseReq({ outputSchema: schema }), new AbortController().signal));
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(fetchFn.calls[0].body.response_format.type, 'json_schema');
  assert.equal(fetchFn.calls[1].body.response_format, undefined);
  const final = events.find((e) => e.type === 'final');
  assert.equal(JSON.parse(final.text).status, 'answered');
});

test('response-format retry cancels the rejected 400 body before replacing it', async () => {
  const rejected = new Response('response_format not supported', { status: 400 });
  let cancellations = 0;
  const cancel = rejected.body.cancel.bind(rejected.body);
  rejected.body.cancel = async (...args) => { cancellations += 1; return cancel(...args); };
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 1) return rejected;
    return { ok: true, status: 200, body: sseBody([
      { choices: [{ delta: { content: '{"status":"answered","markdown":"hi"}' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]) };
  };
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: null });
  const schema = { type: 'object', properties: { status: { type: 'string' }, markdown: { type: 'string' } } };
  const events = await collect(provider.turn(baseReq({ outputSchema: schema }), new AbortController().signal));
  assert.equal(calls, 2);
  assert.equal(cancellations, 1);
  assert.equal(JSON.parse(events.at(-1).text).status, 'answered');
});

test('a non-auth forced-final failure cancels its body and preserves text fallback', async () => {
  const failure = new Response('private upstream diagnostic', { status: 500 });
  let cancellations = 0;
  const cancel = failure.body.cancel.bind(failure.body);
  failure.body.cancel = async (...args) => { cancellations += 1; return cancel(...args); };
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 2) return failure;
    return { ok: true, status: 200, body: sseBody([
      { choices: [{ delta: { content: 'Plain answer, still useful.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]) };
  };
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: null });
  const events = await collect(provider.turn(baseReq({ outputSchema: ASK_SCHEMA }), new AbortController().signal));
  assert.equal(calls, 2);
  assert.equal(cancellations, 1);
  assert.equal(events.at(-1).type, 'final');
  assert.equal(JSON.parse(events.at(-1).text).markdown, 'Plain answer, still useful.');
  assert.ok(events.some((event) => event.type === 'notice' && event.kind === 'format_fallback'));
});

test('an unterminated oversized ALCF completion line is cancelled and fails safely', async () => {
  let cancellations = 0;
  const provider = openaiProvider(fakePlatform(async () => ({
    ok: true,
    status: 200,
    body: unterminatedBody('private-without-newline', () => { cancellations += 1; }),
  })), {
    baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    apiKey: async () => 'user-token',
    maxStreamBytes: 8,
  });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.deepEqual(events, [{
    type: 'failed', error: { kind: 'provider_crashed', message: 'ALCF completion stream is too large.' },
  }]);
  assert.equal(cancellations, 1);
  assert.ok(!events[0].error.message.includes('private-without-newline'));
});

test('an oversized forced schema-repair stream fails safely instead of returning a fallback final', async () => {
  let calls = 0;
  let cancellations = 0;
  const provider = openaiProvider(fakePlatform(async () => {
    calls += 1;
    if (calls === 1) return { ok: true, status: 200, body: sseBody([
      { choices: [{ delta: { content: 'plain answer' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]) };
    return { ok: true, status: 200, body: unterminatedBody('private-repair-overflow'.repeat(100), () => { cancellations += 1; }) };
  }), {
    baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    apiKey: async () => 'user-token',
    maxStreamBytes: 1024,
  });
  const events = await collect(provider.turn(baseReq({ outputSchema: ASK_SCHEMA }), new AbortController().signal));
  assert.deepEqual(events.at(-1), {
    type: 'failed', error: { kind: 'provider_crashed', message: 'ALCF completion stream is too large.' },
  });
  assert.ok(!events.some((event) => event.type === 'final'));
  assert.equal(calls, 2);
  assert.equal(cancellations, 1);
});

test('an oversized forced answer after tool exhaustion fails safely instead of emitting final', async () => {
  let calls = 0;
  let cancellations = 0;
  const provider = openaiProvider(fakePlatform(async () => {
    calls += 1;
    if (calls <= 8) return { ok: true, status: 200, body: sseBody([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'search_library', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]) };
    return { ok: true, status: 200, body: unterminatedBody('private-forced-overflow'.repeat(100), () => { cancellations += 1; }) };
  }), {
    baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    apiKey: async () => 'user-token',
    maxStreamBytes: 1024,
  });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.deepEqual(events.at(-1), {
    type: 'failed', error: { kind: 'provider_crashed', message: 'ALCF completion stream is too large.' },
  });
  assert.equal(calls, 9);
  assert.equal(cancellations, 1);
  assert.ok(!events.some((event) => event.type === 'final'));
});

test('turn(): a non-JSON answer under an output schema gets one repair turn', async () => {
  const fetchFn = scriptedFetch([
    { chunks: [{ choices: [{ delta: { content: 'Sure, here is the answer: hi' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] },
    { chunks: [{ choices: [{ delta: { content: '{"status":"answered","markdown":"hi"}' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] },
  ]);
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: null });
  const schema = { type: 'object', properties: { status: { type: 'string' }, markdown: { type: 'string' } } };
  const events = await collect(provider.turn(baseReq({ outputSchema: schema }), new AbortController().signal));
  assert.equal(fetchFn.calls.length, 2);
  const final = events.find((e) => e.type === 'final');
  assert.equal(JSON.parse(final.text).status, 'answered');
});

test('turn(): a persistent non-2xx is reported as failed{provider_crashed}', async () => {
  const fetchFn = scriptedFetch([{ status: 500, text: 'boom' }]);
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: null });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(events.length, 1);
  assert.equal(events[0].error.kind, 'provider_crashed');
  assert.equal(events[0].error.message, 'boom', 'static-key endpoints retain their diagnostic response text');
});

test('dynamic ALCF non-auth failures cancel and conceal the upstream response body', async () => {
  let bodyReads = 0;
  let cancellations = 0;
  const fetchFn = async () => ({
    ok: false,
    status: 500,
    text: async () => {
      bodyReads += 1;
      return 'private prompt and authorization: Bearer raw-upstream-secret';
    },
    body: { cancel: async () => { cancellations += 1; } },
  });
  const provider = openaiProvider(fakePlatform(fetchFn), {
    baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    apiKey: async () => 'user-token',
  });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.deepEqual(events, [{
    type: 'failed',
    error: { kind: 'provider_crashed', message: 'ALCF request returned HTTP 500.' },
  }]);
  assert.equal(bodyReads, 0);
  assert.equal(cancellations, 1);
  assert.ok(!events[0].error.message.includes('private prompt'));
  assert.ok(!events[0].error.message.includes('raw-upstream-secret'));
});

test('turn(): a 401 is reported as failed{signed_out}', async () => {
  const fetchFn = scriptedFetch([{ status: 401, text: 'unauthorized' }]);
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'bad' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(events[0].error.kind, 'signed_out');
});

test('dynamic credentials are read per request and a 401 refreshes and retries once', async () => {
  const fetchFn = scriptedFetch([
    { models: ['model-a'] },
    { models: ['model-a'] },
    { status: 401, text: 'expired' },
    { chunks: [{ choices: [{ delta: { content: 'fresh answer' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] },
  ]);
  const credentials = [];
  const apiKey = async (force = false) => {
    credentials.push(force);
    return force ? 'fresh-token' : 'stale-token';
  };
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1', apiKey });
  assert.equal((await provider.status()).state, 'ready');
  assert.deepEqual((await provider.models()).map((m) => m.id), ['model-a']);
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(events.at(-1).text, 'fresh answer');
  assert.equal(fetchFn.calls.filter((call) => call.url.endsWith('/chat/completions')).length, 2);
  assert.deepEqual(credentials, [false, false, false, true]);
  for (const call of fetchFn.calls.slice(0, 3)) assert.equal(call.opts.headers.authorization, 'Bearer stale-token');
  assert.equal(fetchFn.calls.at(-1).opts.headers.authorization, 'Bearer fresh-token');
});

test('dynamic credentials refresh and retry once after a 403 completion rejection', async () => {
  const fetchFn = scriptedFetch([
    { status: 403, text: 'forbidden' },
    { chunks: [{ choices: [{ delta: { content: 'fresh answer' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] },
  ]);
  const credentials = [];
  const provider = openaiProvider(fakePlatform(fetchFn), {
    baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    apiKey: async (force = false) => {
      credentials.push(force);
      return force ? 'fresh-token' : 'stale-token';
    },
  });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(events.at(-1).text, 'fresh answer');
  assert.equal(fetchFn.calls.length, 2);
  assert.deepEqual(credentials, [false, true]);
  assert.equal(fetchFn.calls[0].opts.headers.authorization, 'Bearer stale-token');
  assert.equal(fetchFn.calls[1].opts.headers.authorization, 'Bearer fresh-token');
});

test('a persistent dynamic 403 is signed out without reading or exposing the upstream body', async () => {
  const calls = [];
  const credentials = [];
  let bodyReads = 0;
  async function fetchFn(url, opts = {}) {
    calls.push({ url, opts });
    return {
      ok: false,
      status: 403,
      text: async () => { bodyReads += 1; return 'raw-upstream-secret'; },
      body: { cancel: async () => {} },
    };
  }
  const provider = openaiProvider(fakePlatform(fetchFn), {
    baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    apiKey: async (force = false) => {
      credentials.push(force);
      return force ? 'fresh-token' : 'stale-token';
    },
  });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(calls.length, 2);
  assert.deepEqual(credentials, [false, true]);
  assert.equal(bodyReads, 0);
  assert.deepEqual(events, [{
    type: 'failed',
    error: { kind: 'signed_out', message: 'Sign in with Globus again.' },
  }]);
  assert.ok(!events[0].error.message.includes('raw-upstream-secret'));
});

test('a rejected forced credential refresh is signed out without a third completion request', async () => {
  const fetchFn = scriptedFetch([{ status: 401, text: 'expired' }]);
  const provider = openaiProvider(fakePlatform(fetchFn), {
    baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    apiKey: async (force = false) => {
      if (force) throw Object.assign(new Error('ALCF credential delivery was rejected'), { status: 401 });
      return 'stale-token';
    },
  });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].error, { kind: 'signed_out', message: 'Sign in with Globus again.' });
  assert.equal(fetchFn.calls.length, 1);
  assert.ok(!events[0].error.message.includes('stale-token'));
});

test('dynamic credential rejection during schema repair emits signed_out instead of a wrapped final', async () => {
  const fetchFn = scriptedFetch([
    { chunks: [{ choices: [{ delta: { content: 'not JSON' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] },
    { status: 403, text: 'raw-repair-secret' },
    { status: 401, text: 'raw-refresh-secret' },
  ]);
  const credentials = [];
  const provider = openaiProvider(fakePlatform(fetchFn), {
    baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    apiKey: async (force = false) => {
      credentials.push(force);
      return force ? 'fresh-token' : 'stale-token';
    },
  });
  const schema = { type: 'object', properties: { status: { type: 'string' }, markdown: { type: 'string' } } };
  const events = await collect(provider.turn(baseReq({ outputSchema: schema }), new AbortController().signal));
  assert.equal(fetchFn.calls.length, 3, 'one answer plus one repair and one forced-credential retry');
  assert.deepEqual(credentials, [false, false, true]);
  assert.ok(!events.some((event) => event.type === 'final'));
  assert.deepEqual(events.at(-1), {
    type: 'failed', error: { kind: 'signed_out', message: 'Sign in with Globus again.' },
  });
  assert.ok(!events.at(-1).error.message.includes('raw-refresh-secret'));
});

test('dynamic credential rejection after tool-step exhaustion emits signed_out instead of an empty final', async () => {
  const toolCallChunk = { chunks: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'search_library', arguments: '{}' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }] };
  const fetchFn = scriptedFetch([
    ...Array.from({ length: 8 }, () => toolCallChunk),
    { status: 403, text: 'raw-forced-secret' },
    { status: 403, text: 'raw-refresh-secret' },
  ]);
  const credentials = [];
  const provider = openaiProvider(fakePlatform(fetchFn), {
    baseUrl: 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
    apiKey: async (force = false) => {
      credentials.push(force);
      return force ? 'fresh-token' : 'stale-token';
    },
  });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(fetchFn.calls.length, 10, 'eight normal steps plus one forced answer and one credential retry');
  assert.deepEqual(credentials, [...Array(9).fill(false), true]);
  assert.ok(!events.some((event) => event.type === 'final'));
  assert.deepEqual(events.at(-1), {
    type: 'failed', error: { kind: 'signed_out', message: 'Sign in with Globus again.' },
  });
});

test('turn(): reaching the tool-call step cap forces one tools-off final answer instead of failing', async () => {
  const toolCallChunk = { chunks: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'search_library', arguments: '{}' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }] };
  const finalChunk = { chunks: [{ choices: [{ delta: { content: 'Here is what I found so far.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] };
  const fetchFn = scriptedFetch([...Array.from({ length: 8 }, () => toolCallChunk), finalChunk]);
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: null });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.ok(!events.some((e) => e.type === 'failed'), 'the step cap must not fail the turn');
  const final = events.find((e) => e.type === 'final');
  assert.equal(final.text, 'Here is what I found so far.');
  assert.equal(fetchFn.calls.length, 9, '8 normal steps plus one forced-final call');
  const forcedCall = fetchFn.calls.at(-1);
  assert.equal(forcedCall.body.tools, undefined, 'the forced-final call must have tools disabled');
  assert.match(forcedCall.body.messages.at(-1).content, /Stop calling tools/);
});

test('turn(): a repair turn that still fails to produce JSON still returns a final event (a provider-level "answer", even if TurnRunner later reports bad_output), not failed', async () => {
  const nonJson = { chunks: [{ choices: [{ delta: { content: 'Sure, here you go: hi' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] };
  const stillNonJson = { chunks: [{ choices: [{ delta: { content: 'hi again' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] };
  const fetchFn = scriptedFetch([nonJson, stillNonJson]);
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: null });
  const schema = { type: 'object', properties: { status: { type: 'string' } } };
  const events = await collect(provider.turn(baseReq({ outputSchema: schema }), new AbortController().signal));
  assert.ok(!events.some((e) => e.type === 'failed'));
  const final = events.find((e) => e.type === 'final');
  assert.equal(final.text, 'Sure, here you go: hi', 'the repair result is only adopted when it actually parses as JSON');
});

// ---------- local-model hardening (seam 6): a plain-markdown answer under ASK_SCHEMA is wrapped, not failed ----------

test('looksLikeStatusMarkdownSchema recognizes ASK_SCHEMA and rejects an unrelated schema', () => {
  assert.equal(looksLikeStatusMarkdownSchema(ASK_SCHEMA), true);
  assert.equal(looksLikeStatusMarkdownSchema({ type: 'object', properties: { status: { type: 'string' } } }), false, 'no markdown property');
  assert.equal(looksLikeStatusMarkdownSchema({ type: 'object', properties: { status: { type: 'string' }, markdown: { type: 'string' } } }), false, 'status has no enum');
  assert.equal(looksLikeStatusMarkdownSchema(null), false);
});

test('wrapAsAnsweredMarkdown wraps non-blank text under ASK_SCHEMA, and returns null otherwise', () => {
  assert.deepEqual(JSON.parse(wrapAsAnsweredMarkdown(ASK_SCHEMA, 'Three notes cover this [@smith2021].')), {
    status: 'answered', markdown: 'Three notes cover this [@smith2021].',
  });
  assert.equal(wrapAsAnsweredMarkdown(ASK_SCHEMA, '   '), null, 'nothing to wrap');
  assert.equal(wrapAsAnsweredMarkdown({ type: 'object' }, 'hi'), null, 'an unrecognized schema is left alone');
});

test("turn(): a local model that never produces ASK_SCHEMA JSON, even after the repair turn, gets its plain answer wrapped and a 'format_fallback' notice, not bad_output", async () => {
  const answer = { chunks: [{ choices: [{ delta: { content: 'Three notes cover cosine similarity [@smith2021].' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] };
  const stillPlain = { chunks: [{ choices: [{ delta: { content: 'Same answer, still not JSON.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }] };
  const fetchFn = scriptedFetch([answer, stillPlain]);
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: null });
  const events = await collect(provider.turn(baseReq({ outputSchema: ASK_SCHEMA }), new AbortController().signal));

  assert.ok(!events.some((e) => e.type === 'failed'), 'must not fail the turn');
  const notice = events.find((e) => e.type === 'notice');
  assert.ok(notice, 'expected a notice');
  assert.equal(notice.kind, 'format_fallback');
  assert.match(notice.text, /without the expected format/);

  const final = events.find((e) => e.type === 'final');
  const parsed = JSON.parse(final.text);
  assert.equal(parsed.status, 'answered');
  assert.equal(parsed.markdown, 'Same answer, still not JSON.', 'wraps the repair turn\'s text, its best available answer');
});

test('models() lists ids from GET /v1/models', async () => {
  const fetchFn = scriptedFetch([{ models: ['woof-4b', 'qwen3.5-9b'] }]);
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: null });
  const models = await provider.models();
  assert.deepEqual(models.map((m) => m.id), ['woof-4b', 'qwen3.5-9b']);
});

test('status() reports unreachable when the endpoint errors', async () => {
  async function brokenFetch() { throw new Error('ECONNREFUSED'); }
  const provider = openaiProvider(fakePlatform(brokenFetch), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: null });
  const status = await provider.status();
  assert.equal(status.state, 'unreachable');
});
