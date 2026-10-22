import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openaiProvider, applyChunk, createStreamState, toOpenAiTools, buildMessages, parseSse,
  looksLikeStatusMarkdownSchema, wrapAsAnsweredMarkdown,
} from '../src/providers/openai.js';
import { scriptedFetch } from './fake-openai.mjs';
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

// ---------- full turn loop ----------

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
});

test('turn(): a 401 is reported as failed{signed_out}', async () => {
  const fetchFn = scriptedFetch([{ status: 401, text: 'unauthorized' }]);
  const provider = openaiProvider(fakePlatform(fetchFn), { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'bad' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(events[0].error.kind, 'signed_out');
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
