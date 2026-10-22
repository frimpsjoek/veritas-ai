import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  binaryCandidates, codexHomePlan, ensureCodexHome, codexLaunch, parseCodexMessage, codexProvider,
  createCodexPool, formatCodexInput, parseCodexLoginStatus,
} from '../src/providers/codex.js';
import { spawnFakeCodex } from './support/spawn-fake-codex.mjs';

function memoryFs() {
  const files = new Map();
  return {
    files,
    async read(path) { return files.has(path) ? files.get(path) : null; },
    async writeAtomic(path, text) { files.set(path, text); },
    async append() { throw new Error('not used'); },
    async list() { return [...files.keys()]; },
    async remove(path) { files.delete(path); },
    async symlink(target, path) { files.set(path, `symlink:${target}`); },
  };
}

function fakePlatform(fixtureName, fs = memoryFs()) {
  return {
    async spawn() { return spawnFakeCodex(fixtureName); },
    async which() { return '/fake/codex'; },
    fetch,
    fs,
    async serve() { throw new Error('not used'); },
    homeDir: '/fake/home',
  };
}

/** Counts platform.spawn() calls and records every line written to the (single) fake process's stdin, so a
 *  test can tell a warm-reused turn (no second spawn) from a fresh one, and inspect what each turn actually
 *  sent. */
function spyingPlatform(fixtureName) {
  const sent = [];
  let spawnCount = 0;
  return {
    sent,
    spawnCount: () => spawnCount,
    async spawn() { spawnCount += 1; return spawnFakeCodex(fixtureName, { sent }); },
    async which() { return '/fake/codex'; },
    fetch,
    fs: memoryFs(),
    async serve() { throw new Error('not used'); },
    homeDir: '/fake/home',
  };
}

function baseReq(input = 'hello') {
  return {
    sessionKey: 'test', model: { provider: 'codex', model: null }, instructions: '', history: [], input,
    tools: { specs: [], seen: () => [], close() {}, mcp: { url: 'http://127.0.0.1:1/mcp', token: 'tok' } },
    web: 'off', outputSchema: null,
  };
}

async function collect(iterable) {
  const events = [];
  for await (const ev of iterable) events.push(ev);
  return events;
}

// ---------- pure functions ----------

test('binaryCandidates: settings path, then env, then the app bundle, then PATH', () => {
  assert.deepEqual(binaryCandidates('/set/codex', { CODEX_BINARY: '/env/codex' }), [
    '/set/codex', '/env/codex', '/Applications/ChatGPT.app/Contents/Resources/codex', 'codex',
  ]);
  assert.deepEqual(binaryCandidates(null, {}), ['/Applications/ChatGPT.app/Contents/Resources/codex', 'codex']);
});

test('codexLaunch is pure and isolates CODEX_HOME, sandbox and approval policy', () => {
  const launch = codexLaunch({ binary: '/bin/codex', dataDir: '/data', home: '/home/u', mcpUrl: 'http://x/mcp', mcpToken: 'tok', model: 'gpt-x' });
  assert.equal(launch.spec.cmd, '/bin/codex');
  assert.deepEqual(launch.spec.args, ['app-server']);
  assert.equal(launch.spec.env.CODEX_HOME, '/data/codex-home');
  assert.equal(launch.threadStart.sandbox, 'read-only');
  assert.equal(launch.threadStart.approvalPolicy, 'never');
  assert.equal(launch.threadStart.config.mcp_servers.lib.url, 'http://x/mcp');
  assert.equal(launch.threadStart.config.mcp_servers.lib.http_headers.Authorization, 'Bearer tok');
  assert.equal(launch.homePlan.authSymlink.from, '/home/u/.codex/auth.json');
});

test('ensureCodexHome is idempotent: writes config once, symlinks auth once, never overwrites an existing auth link', async () => {
  const fs = memoryFs();
  const plan = codexHomePlan('/data', '/home/u');
  await ensureCodexHome(fs, plan);
  assert.equal(fs.files.get(plan.configTomlPath), plan.configToml);
  assert.equal(fs.files.get(plan.authSymlink.to), 'symlink:/home/u/.codex/auth.json');

  fs.files.set(plan.authSymlink.to, 'real-auth-contents'); // simulate a real sign-in having replaced the symlink
  await ensureCodexHome(fs, plan);
  assert.equal(fs.files.get(plan.authSymlink.to), 'real-auth-contents', 'a second run must not clobber a real auth.json');
});

test('parseCodexMessage maps streaming text deltas', () => {
  assert.deepEqual(parseCodexMessage({ method: 'item/agentMessage/delta', params: { delta: 'hi' } }), [{ type: 'text', delta: 'hi' }]);
});

test('parseCodexMessage flags commandExecution and fileChange as policy violations', () => {
  const cmd = parseCodexMessage({ method: 'item/completed', params: { item: { type: 'commandExecution' } } });
  assert.equal(cmd[0].type, 'failed');
  assert.equal(cmd[0].error.kind, 'policy_violation');
  const file = parseCodexMessage({ method: 'item/completed', params: { item: { type: 'fileChange' } } });
  assert.equal(file[0].error.kind, 'policy_violation');
});

test('parseCodexMessage flags any *requestApproval as a policy violation', () => {
  const events = parseCodexMessage({ id: 9, method: 'commandExecutionRequestApproval', params: {} });
  assert.equal(events[0].type, 'failed');
  assert.equal(events[0].error.kind, 'policy_violation');
});

// ---------- code-mode exec, scoped to our own gateway (fix-codemode: disabling features.code_mode_host broke
// real tool calling, so exec stays on and is checked instead; see providers/codex.js's own comment) ----------

test('parseCodexMessage: a code-mode exec item that only calls tools.mcp__lib__* is a normal activity, not a violation', () => {
  const item = { type: 'customToolCall', id: 'x1', tool: 'exec', arguments: { code: 'text(tools.mcp__lib__search_library({query:"x"}))' } };
  const started = parseCodexMessage({ method: 'item/started', params: { item } });
  assert.equal(started[0].type, 'activity');
  assert.equal(started[0].phase, 'start');
  const completed = parseCodexMessage({ method: 'item/completed', params: { item } });
  assert.equal(completed[0].type, 'activity');
  assert.equal(completed[0].phase, 'end');
});

test('parseCodexMessage: a code-mode exec item whose body calls a tool row outside our own gateway is a policy violation', () => {
  const item = { type: 'customToolCall', id: 'x2', tool: 'exec', arguments: { code: 'text(tools.mcp__someOtherServer__run({cmd:"whoami"}));' } };
  const events = parseCodexMessage({ method: 'item/completed', params: { item } });
  assert.equal(events[0].type, 'failed');
  assert.equal(events[0].error.kind, 'policy_violation');
});

test('parseCodexMessage: a code-mode exec item that shells out (require/child_process) or reads process/fs is a policy violation', () => {
  for (const code of [
    'const cp = require("child_process"); cp.execSync("ls");',
    'process.env.HOME',
    'fs.readFileSync("/etc/passwd")',
  ]) {
    const events = parseCodexMessage({ method: 'item/completed', params: { item: { type: 'customToolCall', id: 'x3', tool: 'exec', arguments: { code } } } });
    assert.equal(events[0]?.error?.kind, 'policy_violation', `expected a policy_violation for: ${code}`);
  }
});

// ---------- full turn loop against the fake app server ----------

test('turn(): streams text and ends with final', async () => {
  const provider = codexProvider(fakePlatform('codex-text.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  await provider.dispose();
  assert.ok(events.some((e) => e.type === 'text' && e.delta === 'Hel'));
  const final = events.find((e) => e.type === 'final');
  assert.equal(final.text, 'Hello there');
});

test('turn(): an MCP tool call becomes start/end activity, then final', async () => {
  const provider = codexProvider(fakePlatform('codex-mcp-tool.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq("search for 'graphene'"), new AbortController().signal));
  await provider.dispose();
  const activities = events.filter((e) => e.type === 'activity');
  assert.equal(activities.length, 2);
  assert.equal(activities[0].phase, 'start');
  assert.equal(activities[0].kind, 'library');
  assert.equal(activities[1].phase, 'end');
  assert.equal(activities[1].ok, true);
  const final = events.find((e) => e.type === 'final');
  assert.match(final.text, /graphene/);
});

test('turn(): missing binary is reported as failed{not_installed}, no process spawned', async () => {
  const platform = fakePlatform('codex-text.jsonl');
  platform.which = async () => null;
  const provider = codexProvider(platform, { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'failed');
  assert.equal(events[0].error.kind, 'not_installed');
  await provider.dispose();
});

test('turn(): a command execution ends the turn with failed{policy_violation}', async () => {
  const provider = codexProvider(fakePlatform('codex-policy-violation.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  await provider.dispose();
  const failure = events.find((e) => e.type === 'failed');
  assert.ok(failure, 'expected a failed event');
  assert.equal(failure.error.kind, 'policy_violation');
  assert.ok(!events.some((e) => e.type === 'final'), 'must not also report success');
});

test('turn(): a requestApproval is declined and ends the turn with failed{policy_violation}', async () => {
  const provider = codexProvider(fakePlatform('codex-approval-declined.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  await provider.dispose();
  const failure = events.find((e) => e.type === 'failed');
  assert.equal(failure.error.kind, 'policy_violation');
});

test('turn(): interrupt sends turn/interrupt and ends with failed{cancelled}', async () => {
  const provider = codexProvider(fakePlatform('codex-interrupt.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const controller = new AbortController();
  const events = [];
  const iterator = provider.turn(baseReq(), controller.signal)[Symbol.asyncIterator]();
  // Let the first delta through, then abort mid-stream.
  events.push((await iterator.next()).value);
  controller.abort();
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    events.push(value);
  }
  await provider.dispose();
  const failure = events.find((e) => e && e.type === 'failed');
  assert.ok(failure, 'expected a failed event after interrupt');
  assert.equal(failure.error.kind, 'cancelled');
});

test('turn(): Stop sends turn/interrupt with the turn id Codex requires, not the thread id alone', async () => {
  // Found live in T7.1: {threadId} alone gets "Invalid request: missing field `turnId`", so a cancelled review
  // was recorded as provider_crashed and the turn was not interrupted.
  const platform = spyingPlatform('codex-interrupt.jsonl');
  const provider = codexProvider(platform, { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const controller = new AbortController();
  const iterator = provider.turn(baseReq(), controller.signal)[Symbol.asyncIterator]();
  const first = (await iterator.next()).value; // the first text delta: the turn has started
  assert.equal(first.type, 'text');
  controller.abort();
  const rest = [];
  for (;;) { const { value, done } = await iterator.next(); if (done) break; rest.push(value); }
  await provider.dispose();
  const interrupt = platform.sent.map((l) => JSON.parse(l)).find((m) => m.method === 'turn/interrupt');
  assert.deepEqual(interrupt?.params, { threadId: 'thread-interrupt-1', turnId: 'turn-interrupt-1' });
  assert.equal(rest.find((e) => e.type === 'failed')?.error.kind, 'cancelled');
});

test('turn(): the app-server process dying mid-turn is reported as failed{provider_crashed}', async () => {
  const provider = codexProvider(fakePlatform('codex-crash.jsonl'), { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  await provider.dispose();
  const failure = events.find((e) => e.type === 'failed');
  assert.ok(failure, 'expected a failed event');
  assert.equal(failure.error.kind, 'provider_crashed');
});

test('turn(): missing binary is reported as failed{not_installed}, no process spawned', async () => {
  const platform = fakePlatform('codex-text.jsonl');
  platform.which = async () => null;
  const provider = codexProvider(platform, { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const events = await collect(provider.turn(baseReq(), new AbortController().signal));
  assert.equal(events.length, 1);
  assert.equal(events[0].error.kind, 'not_installed');
});

// ---------- chat history (seam 1: the Codex provider used to ignore req.history entirely) ----------

test('formatCodexInput: empty history passes the input through unchanged; non-empty history is replayed as a transcript', () => {
  assert.equal(formatCodexInput([], 'hello'), 'hello');
  const withHistory = formatCodexInput(
    [{ role: 'user', text: 'What does my library say about embeddings?' }, { role: 'assistant', text: 'Three notes cover cosine similarity.' }],
    'Which of those is the oldest?',
  );
  assert.match(withHistory, /What does my library say about embeddings\?/);
  assert.match(withHistory, /Three notes cover cosine similarity\./);
  assert.match(withHistory, /Which of those is the oldest\?/);
});

test('createCodexPool evicts the least-recently-used entry beyond max', async () => {
  const killed = [];
  let t = 0;
  const pool = createCodexPool({ max: 2, now: () => t, kill: async (c) => { killed.push(c); }, schedule: () => 0, clear: () => {} });
  pool.set('a', { child: 'child-a', threadId: 't-a', seenLen: 0, idCounter: 1 }); t += 1;
  pool.set('b', { child: 'child-b', threadId: 't-b', seenLen: 0, idCounter: 1 }); t += 1;
  pool.touch('a'); t += 1; // b is now the least recently used
  pool.set('c', { child: 'child-c', threadId: 't-c', seenLen: 0, idCounter: 1 });
  assert.equal(pool.size(), 2);
  assert.deepEqual(killed, ['child-b']);
  assert.equal(pool.get('a').child, 'child-a');
  assert.equal(pool.get('c').child, 'child-c');
});

test('turn(): the thread stays warm when the caller stops reading at `final`, as TurnRunner does', async () => {
  // Found in T7.1: cacheable was set on the line after `yield final`, which never runs once the consumer breaks
  // there, so every real turn through core.js killed its app server and the next one started cold.
  const platform = spyingPlatform('codex-two-turns.jsonl');
  const provider = codexProvider(platform, { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const untilFinal = async (req) => {
    for await (const ev of provider.turn(req, new AbortController().signal)) if (ev.type === 'final') return ev;
    return null;
  };
  const first = await untilFinal({ ...baseReq('Which of my notes is the oldest?'), sessionKey: 's', history: [] });
  const second = await untilFinal({
    ...baseReq('Is that one from 2023?'), sessionKey: 's',
    history: [{ role: 'user', text: 'Which of my notes is the oldest?' }, { role: 'assistant', text: first.text }],
  });
  await provider.dispose();
  assert.match(second.text, /2023/);
  assert.equal(platform.spawnCount(), 1, 'the second turn must reuse the first turn\'s app server');
});

test('turn(): a matching warm thread gets only the new message; the whole conversation happens on one process', async () => {
  const platform = spyingPlatform('codex-two-turns.jsonl');
  const provider = codexProvider(platform, { binaryPath: null, dataDir: '/data', home: '/home/u' });

  const turn1Input = 'Which of my notes is the oldest?';
  const first = await collect(provider.turn({ ...baseReq(turn1Input), sessionKey: 's', history: [] }, new AbortController().signal));
  const firstFinal = first.find((e) => e.type === 'final');
  assert.match(firstFinal.text, /Notes on Catalyst Screening/);

  const turn2Input = 'Is that one from 2023?';
  const second = await collect(provider.turn({
    ...baseReq(turn2Input),
    sessionKey: 's',
    history: [{ role: 'user', text: turn1Input }, { role: 'assistant', text: firstFinal.text }],
  }, new AbortController().signal));
  const secondFinal = second.find((e) => e.type === 'final');
  assert.match(secondFinal.text, /2023/);

  await provider.dispose();

  // Turn 2 saw turn 1 because it ran on the very same warm process, not because it was told about it again.
  assert.equal(platform.spawnCount(), 1, 'a warm, matching thread must not spawn a second process');
  const turnStarts = platform.sent.map((line) => JSON.parse(line)).filter((m) => m.method === 'turn/start');
  assert.equal(turnStarts.length, 2);
  assert.equal(turnStarts[1].params.input[0].text, turn2Input, 'a warm reuse sends only the new message, no replayed transcript');
});

test('turn(): no matching warm thread (e.g. after a restart) replays history into the fresh thread', async () => {
  const platform = spyingPlatform('codex-text.jsonl');
  const provider = codexProvider(platform, { binaryPath: null, dataDir: '/data', home: '/home/u' });

  const history = [
    { role: 'user', text: 'What does my library say about embeddings?' },
    { role: 'assistant', text: 'Three notes cover cosine similarity.' },
  ];
  const events = await collect(provider.turn({ ...baseReq('Which of those is the oldest?'), sessionKey: 'restarted', history }, new AbortController().signal));
  await provider.dispose();

  assert.ok(events.some((e) => e.type === 'final'));
  const turnStart = platform.sent.map((line) => JSON.parse(line)).find((m) => m.method === 'turn/start');
  assert.match(turnStart.params.input[0].text, /What does my library say about embeddings\?/);
  assert.match(turnStart.params.input[0].text, /Three notes cover cosine similarity\./);
  assert.match(turnStart.params.input[0].text, /Which of those is the oldest\?/);
});

// ---------- T6.2: provider status ----------

test('parseCodexLoginStatus: codex-cli prints "Logged in..." to stderr, not stdout, when not a tty', () => {
  // Found live against the real binary (evidence/p6-t62-codex-status.txt): `codex login status < /dev/null`
  // writes its answer to stderr with empty stdout. This is a regression test for that exact shape.
  assert.deepEqual(parseCodexLoginStatus([], 'Logged in using ChatGPT\n'), { state: 'ready', account: { kind: 'chatgpt', label: null, plan: null } });
  assert.deepEqual(parseCodexLoginStatus([], 'Logged in using an API key\n'), { state: 'ready', account: { kind: 'api_key', label: null, plan: null } });
  assert.deepEqual(parseCodexLoginStatus([], 'Not logged in\n'), { state: 'signed_out', account: { kind: 'none', label: null, plan: null } });
  assert.deepEqual(parseCodexLoginStatus([], ''), { state: 'signed_out', account: { kind: 'none', label: null, plan: null } });
});

test('codexLaunch puts the web mode in top-level web_search, the only shape codex-cli accepts', () => {
  const live = codexLaunch({ binary: '/bin/codex', dataDir: '/data', home: '/home/u', mcpUrl: 'http://x/mcp', mcpToken: 'tok', webMode: 'live' });
  assert.equal(live.threadStart.config.web_search, 'live');
  assert.equal(live.threadStart.config.tools, undefined);
  const off = codexLaunch({ binary: '/bin/codex', dataDir: '/data', home: '/home/u', mcpUrl: 'http://x/mcp', mcpToken: 'tok', webMode: 'off' });
  assert.equal(off.threadStart.config.web_search, undefined);
});

test('parseCodexMessage keeps the rate-limit numbers as structured usage next to the text (spec 011 U4)', () => {
  const [ev] = parseCodexMessage({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 63, windowDurationMins: 300, resetsAt: 1790329684 } } } });
  assert.equal(ev.type, 'notice');
  assert.equal(ev.kind, 'rate_limit');
  assert.equal(ev.text, 'Codex: 63% of the 5h window used');
  assert.deepEqual(ev.usage, { percentUsed: 63, windowMinutes: 300, resetsAt: new Date(1790329684 * 1000).toISOString() });
});

// ---------- effort on turn/start (spec 016) ----------

test('turn(): the chosen effort goes to the app server on turn/start, on a fresh thread and on a warm one', async () => {
  const platform = spyingPlatform('codex-two-turns.jsonl');
  const provider = codexProvider(platform, { binaryPath: null, dataDir: '/data', home: '/home/u' });
  const first = await collect(provider.turn({ ...baseReq('one'), sessionKey: 'e', model: { provider: 'codex', model: 'gpt-5.5', effort: 'high' } }, new AbortController().signal));
  const text = first.find((e) => e.type === 'final').text;
  await collect(provider.turn({ ...baseReq('two'), sessionKey: 'e', model: { provider: 'codex', model: 'gpt-5.5', effort: 'max' }, history: [{ role: 'user', text: 'one' }, { role: 'assistant', text }] }, new AbortController().signal));
  await provider.dispose();
  const starts = platform.sent.map((line) => JSON.parse(line)).filter((m) => m.method === 'turn/start');
  assert.deepEqual(starts.map((m) => m.params.effort), ['high', 'xhigh'], 'max is Codex xhigh');
});

test('turn(): with no effort chosen, turn/start carries none', async () => {
  const platform = spyingPlatform('codex-text.jsonl');
  const provider = codexProvider(platform, { binaryPath: null, dataDir: '/data', home: '/home/u' });
  await collect(provider.turn(baseReq(), new AbortController().signal));
  await provider.dispose();
  const start = platform.sent.map((line) => JSON.parse(line)).find((m) => m.method === 'turn/start');
  assert.ok(start && !('effort' in start.params) && start.params.input[0].text === 'hello');
});

test('codexTurnEffort passes the four Codex levels, maps max, and drops anything unknown', async () => {
  const { codexTurnEffort } = await import('../src/providers/codex.js');
  assert.deepEqual(['low', 'medium', 'high', 'xhigh', 'max', 'turbo', null, undefined].map(codexTurnEffort), ['low', 'medium', 'high', 'xhigh', 'xhigh', undefined, undefined, undefined]);
});
