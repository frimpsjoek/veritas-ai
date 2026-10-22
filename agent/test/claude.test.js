import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  binaryCandidates, claudeMcpConfigPlan, claudeLaunch, createClaudeParser, createWarmPool, claudeProvider,
} from '../src/providers/claude.js';
import { spawnFakeClaude } from './support/spawn-fake-claude.mjs';

function memoryFs() {
  const files = new Map();
  return {
    files,
    async read(path) { return files.has(path) ? files.get(path) : null; },
    async writeAtomic(path, text) { files.set(path, text); },
    async append() { throw new Error('not used'); },
    async list() { return [...files.keys()]; },
    async remove(path) { files.delete(path); },
    async symlink() { throw new Error('not used'); },
  };
}

function fakePlatform(fixtureName, fs = memoryFs()) {
  return {
    async spawn() { return spawnFakeClaude(fixtureName); },
    async which() { return '/fake/claude'; },
    fetch,
    fs,
    async serve() { throw new Error('not used'); },
    homeDir: '/fake/home',
  };
}

function baseReq(input = 'hello') {
  return {
    sessionKey: `test-${Math.random()}`, model: { provider: 'claude', model: null }, instructions: '', history: [], input,
    tools: { specs: [{ name: 'search_library', description: '', inputSchema: {} }], seen: () => [], close() {}, mcp: { url: 'http://127.0.0.1:1/mcp', token: 'tok' } },
    web: 'off', outputSchema: null,
  };
}

async function collect(iterable) {
  const events = [];
  for await (const ev of iterable) events.push(ev);
  return events;
}

// ---------- pure functions ----------

test('binaryCandidates: settings path, then env, then the known install path, then PATH', () => {
  assert.deepEqual(binaryCandidates('/set/claude', { CLAUDE_BINARY: '/env/claude', HOME: '/home/u' }), [
    '/set/claude', '/env/claude', '/home/u/.local/bin/claude', 'claude',
  ]);
  assert.deepEqual(binaryCandidates(null, {}), ['claude']);
});

test('claudeMcpConfigPlan is pure and puts the bearer token in the header, not the URL', () => {
  const plan = claudeMcpConfigPlan('/data', 'abc', 'http://x/mcp', 'tok');
  assert.equal(plan.path, '/data/claude-mcp/abc.json');
  const parsed = JSON.parse(plan.content);
  assert.equal(parsed.mcpServers.lib.url, 'http://x/mcp');
  assert.equal(parsed.mcpServers.lib.headers.Authorization, 'Bearer tok');
});

test('claudeLaunch sets the isolation flags and lists only our MCP tools', () => {
  const launch = claudeLaunch({
    binary: '/bin/claude', dataDir: '/data', cwd: '/data/cwd', configId: 'x', mcpUrl: 'http://x/mcp', mcpToken: 'tok',
    toolNames: ['search_library', 'read_source'], webMode: 'off',
  });
  const args = launch.spec.args;
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__lib__search_library,mcp__lib__read_source');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(launch.spec.cwd, '/data/cwd');
});

test('claudeLaunch adds WebSearch and WebFetch to both tool lists when web is on', () => {
  const launch = claudeLaunch({
    binary: '/bin/claude', dataDir: '/data', cwd: '/data/cwd', configId: 'x', mcpUrl: 'http://x/mcp', mcpToken: 'tok',
    toolNames: ['search_library'], webMode: 'live',
  });
  const args = launch.spec.args;
  assert.equal(args[args.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__lib__search_library,WebSearch,WebFetch');
});

test('claudeLaunch passes instructions via --system-prompt (a full replacement, not --append-system-prompt)', () => {
  const launch = claudeLaunch({
    binary: '/bin/claude', dataDir: '/data', cwd: '/data/cwd', configId: 'x', mcpUrl: 'http://x/mcp', mcpToken: 'tok',
    toolNames: ['search_library'], webMode: 'off', instructions: 'You have no shell.',
  });
  const args = launch.spec.args;
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'You have no shell.');
  assert.ok(!args.includes('--append-system-prompt'));
});

test('claudeLaunch omits --system-prompt when no instructions are given', () => {
  const launch = claudeLaunch({
    binary: '/bin/claude', dataDir: '/data', cwd: '/data/cwd', configId: 'x', mcpUrl: 'http://x/mcp', mcpToken: 'tok',
    toolNames: ['search_library'], webMode: 'off',
  });
  assert.ok(!launch.spec.args.includes('--system-prompt'));
});

test('createClaudeParser maps streaming text deltas', () => {
  const parser = createClaudeParser();
  assert.deepEqual(parser.parse({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }), [{ type: 'text', delta: 'hi' }]);
});

test('createClaudeParser turns a Bash/Edit/Write tool_use into a policy violation and never emits its end activity', () => {
  const parser = createClaudeParser();
  const started = parser.parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
  assert.equal(started[0].type, 'failed');
  assert.equal(started[0].error.kind, 'policy_violation');
  const ended = parser.parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [], is_error: false }] } });
  assert.deepEqual(ended, []);
});

test('createClaudeParser pairs a tool_use with its later tool_result by id', () => {
  const parser = createClaudeParser();
  const started = parser.parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__lib__search_library', input: { query: 'graphene' } }] } });
  assert.equal(started[0].phase, 'start');
  assert.equal(started[0].kind, 'library');
  const ended = parser.parse({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [], is_error: false }] } });
  assert.equal(ended[0].phase, 'end');
  assert.equal(ended[0].ok, true);
});

test('createClaudeParser maps a successful result to final, and an error result to failed', () => {
  const parser = createClaudeParser();
  const ok = parser.parse({ type: 'result', subtype: 'success', is_error: false, result: 'hi', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2 } });
  assert.equal(ok[0].type, 'final');
  assert.equal(ok[0].text, 'hi');
  assert.equal(ok[0].usage.usd, 0.01);
  const bad = parser.parse({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' });
  assert.equal(bad[0].type, 'failed');
  assert.equal(bad[0].error.kind, 'provider_crashed');
});

// ---------- warm pool ----------

test('createWarmPool evicts the least-recently-used entry beyond max', async () => {
  const killed = [];
  let t = 0;
  const pool = createWarmPool({ max: 2, now: () => t, kill: async (c) => { killed.push(c); }, schedule: () => 0, clear: () => {} });
  pool.set('a', 'child-a'); t += 1;
  pool.set('b', 'child-b'); t += 1;
  pool.touch('a'); t += 1; // b is now the least recently used
  pool.set('c', 'child-c');
  assert.equal(pool.size(), 2);
  assert.deepEqual(killed, ['child-b']);
  assert.equal(pool.get('a'), 'child-a');
  assert.equal(pool.get('c'), 'child-c');
});

test('createWarmPool schedules an idle eviction on set and reschedules on touch', () => {
  const scheduled = [];
  const pool = createWarmPool({ idleMs: 600000, schedule: (fn, ms) => { scheduled.push(ms); return scheduled.length; }, clear: () => {}, kill: async () => {} });
  pool.set('a', 'child-a');
  pool.touch('a');
  assert.deepEqual(scheduled, [600000, 600000]);
});

test('turn(): the warm pool is keyed on sessionKey plus a hash of instructions, so changed instructions spawn a fresh process', async () => {
  let spawnCount = 0;
  const platform = fakePlatform('claude-text.jsonl');
  const realSpawn = platform.spawn.bind(platform);
  platform.spawn = async (spec) => { spawnCount += 1; return realSpawn(spec); };
  const provider = claudeProvider(platform, { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const sessionKey = 'shared-session';
  await collect(provider.turn(baseReq('first'), new AbortController().signal));
  const first = { sessionKey, model: { provider: 'claude', model: null }, instructions: 'instructions A', history: [], input: 'a',
    tools: { specs: [{ name: 'search_library', description: '', inputSchema: {} }], seen: () => [], close() {}, mcp: { url: 'http://127.0.0.1:1/mcp', token: 'tok' } }, web: 'off', outputSchema: null };
  const second = { ...first, instructions: 'instructions B' };
  await collect(provider.turn(first, new AbortController().signal));
  await collect(provider.turn(second, new AbortController().signal));
  assert.equal(spawnCount, 3, 'different instructions text under the same sessionKey must not reuse a warm process');
  await provider.dispose();
});

// ---------- full turn loop against the fake claude process ----------

test('turn(): streams text and ends with final', async () => {
  const provider = claudeProvider(fakePlatform('claude-text.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.ok(events.some((e) => e.type === 'text' && e.delta === 'Hel'));
  const final = events.find((e) => e.type === 'final');
  assert.equal(final.text, 'Hello there');
  await provider.dispose();
});

test('turn(): an MCP tool call becomes start/end activity, then final', async () => {
  const provider = claudeProvider(fakePlatform('claude-mcp-tool.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq("search for 'graphene'"), new AbortController().signal));
  const activities = events.filter((e) => e.type === 'activity');
  assert.equal(activities.length, 2);
  assert.equal(activities[0].phase, 'start');
  assert.equal(activities[0].kind, 'library');
  assert.equal(activities[1].phase, 'end');
  assert.equal(activities[1].ok, true);
  const final = events.find((e) => e.type === 'final');
  assert.match(final.text, /graphene/);
  await provider.dispose();
});

test('turn(): a Bash tool_use ends the turn with failed{policy_violation}', async () => {
  const provider = claudeProvider(fakePlatform('claude-policy-violation.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  const failure = events.find((e) => e.type === 'failed');
  assert.ok(failure, 'expected a failed event');
  assert.equal(failure.error.kind, 'policy_violation');
  assert.ok(!events.some((e) => e.type === 'final'), 'must not also report success');
  await provider.dispose();
});

test('turn(): an error result ends the turn with failed{provider_crashed}', async () => {
  const provider = claudeProvider(fakePlatform('claude-error-result.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  const failure = events.find((e) => e.type === 'failed');
  assert.equal(failure.error.kind, 'provider_crashed');
  await provider.dispose();
});

test('turn(): abort kills the process and ends with failed{cancelled}', async () => {
  const provider = claudeProvider(fakePlatform('claude-interrupt.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const controller = new AbortController();
  const events = [];
  const iterator = provider.turn(baseReq(), controller.signal)[Symbol.asyncIterator]();
  events.push((await iterator.next()).value);
  controller.abort();
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    events.push(value);
  }
  const failure = events.find((e) => e && e.type === 'failed');
  assert.ok(failure, 'expected a failed event after abort');
  assert.equal(failure.error.kind, 'cancelled');
  await provider.dispose();
});

test('turn(): the process dying mid-turn is reported as failed{provider_crashed}', async () => {
  const provider = claudeProvider(fakePlatform('claude-crash.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  const failure = events.find((e) => e.type === 'failed');
  assert.ok(failure, 'expected a failed event');
  assert.equal(failure.error.kind, 'provider_crashed');
  await provider.dispose();
});

test('turn(): missing binary is reported as failed{not_installed}, no process spawned', async () => {
  const platform = fakePlatform('claude-text.jsonl');
  platform.which = async () => null;
  const provider = claudeProvider(platform, { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(events.length, 1);
  assert.equal(events[0].error.kind, 'not_installed');
  await provider.dispose();
});

test('turn(): the mcp-config temp file is written before spawn and removed after the turn', async () => {
  const fs = memoryFs();
  const provider = claudeProvider(fakePlatform('claude-text.jsonl', fs), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  await collect(provider.turn(baseReq(), new AbortController().signal));
  const leftover = [...fs.files.keys()].filter((p) => p.includes('claude-mcp'));
  assert.deepEqual(leftover, [], 'the per-turn mcp-config file must not leak');
  await provider.dispose();
});

test('createClaudeParser keeps the rate-limit numbers as structured usage next to the text (spec 011 U4)', () => {
  const parser = createClaudeParser();
  const [ev] = parser.parse({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.63, resetsAt: 1790329684 } } } });
  assert.equal(ev.kind, 'rate_limit');
  assert.equal(ev.text, 'Claude: 63% of the 5h window used');
  assert.deepEqual(ev.usage, { percentUsed: 63, windowMinutes: 300, resetsAt: new Date(1790329684 * 1000).toISOString() });
  const [bare] = parser.parse({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.1 } } } });
  assert.deepEqual(bare.usage, { percentUsed: 10, windowMinutes: 300 }, 'no reset time: the field is left out');
});
