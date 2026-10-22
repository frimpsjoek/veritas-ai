#!/usr/bin/env node
// The first-token requirement: "first streamed token in 4 s or less after sending, with an already-running app
// server". One chat session on one provider: turn 0 starts the app server (cold, reported on its own line), then
// N follow-up turns reuse it (the warm samples). For every turn it prints the time from sending to the first event
// of any kind (text or tool activity) and to the first text token, plus how many app-server processes were
// started in total, so "warm" is shown rather than assumed.
//
//   node dev/first-token.mjs [--provider codex|claude] [--samples 5]
// Env: SECOND_BRAIN_DATA_DIR (default: a first-token/ folder in the OS temp dir), SECOND_BRAIN_KB_URL.
import os from 'node:os';
import path from 'node:path';
import { createNodePlatform } from '../src/node/platform.mjs';
import { createHttpLibraryBackend } from '../src/library-http.js';
import { createToolGateway, createMcpHttpHandler } from '../src/tools.js';
import { createTurnRunner, createSlots, ASK_INSTRUCTIONS } from '../src/core.js';
import { createProviders } from '../src/providers/index.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const providerId = opt('provider', 'codex');
const samples = Number(opt('samples', '5'));
const home = os.homedir();
const dataDir = process.env.SECOND_BRAIN_DATA_DIR ?? path.join(os.tmpdir(), 'second-brain-first-token');
const kbBaseUrl = process.env.SECOND_BRAIN_KB_URL ?? 'http://127.0.0.1:27182';

const PROMPTS = [
  'What does my library say about embeddings? Two sentences.',
  'In one sentence, what is the main idea of the first source you found?',
  'Name one limitation of that idea, in one sentence.',
  'Is there a second source that agrees? One sentence.',
  'Summarize our conversation so far in one sentence.',
  'What would be a good next paper to read on this? One sentence.',
  'Thank you. One sentence: what is the single most useful takeaway?',
];

const base = createNodePlatform({ homeDir: home });
let spawns = 0;
const platform = { ...base, spawn: (spec) => { spawns += 1; return base.spawn(spec); } };
const library = createHttpLibraryBackend(platform.fetch, { baseUrl: kbBaseUrl });
const gatewaySettings = { scholarly: [], mcpUrl: /** @type {string | undefined} */ (undefined) };
const gateway = await createToolGateway(platform.fetch, library, gatewaySettings);
const mount = await platform.serve('/mcp', createMcpHttpHandler(gateway));
gatewaySettings.mcpUrl = mount.url;
const providers = createProviders(platform, { dataDir, home });
const runner = createTurnRunner({
  providers, gateway, library,
  getRoleModel: async () => ({ provider: providerId, model: null }),
  slots: createSlots({ total: 6 }),
});

const tools = { scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: false, web: false }, audit: 'first-token' };
const sessionKey = `first-token:${Date.now()}`;
const history = [];
const rows = [];
for (let turn = 0; turn <= samples; turn += 1) {
  const input = PROMPTS[turn % PROMPTS.length];
  const spawnsBefore = spawns;
  const t0 = performance.now();
  let firstEvent = null; let firstText = null; let toolsBeforeText = 0; let text = ''; let outcome = 'no answer';
  for await (const ev of runner.stream('chat', { sessionKey, instructions: ASK_INSTRUCTIONS, history: history.slice(), input, tools }, new AbortController().signal)) {
    const now = performance.now() - t0;
    if (firstEvent === null) firstEvent = now;
    if (ev.type === 'activity' && ev.phase === 'start' && firstText === null) toolsBeforeText += 1;
    if (ev.type === 'text') { if (firstText === null) firstText = now; text += ev.delta; }
    if (ev.type === 'done') { outcome = 'done'; text = ev.answer.text; }
    if (ev.type === 'failed') outcome = `failed: ${ev.error.kind}`;
  }
  const total = performance.now() - t0;
  history.push({ role: 'user', text: input }, { role: 'assistant', text });
  const row = {
    turn, kind: turn === 0 ? 'cold (starts the app server)' : 'warm', outcome,
    firstEventMs: firstEvent === null ? null : Math.round(firstEvent), firstTextMs: firstText === null ? null : Math.round(firstText),
    toolCallsBeforeFirstText: toolsBeforeText, totalMs: Math.round(total), newProcesses: spawns - spawnsBefore,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const warm = rows.filter((r) => r.kind === 'warm');
const within = warm.filter((r) => r.firstTextMs !== null && r.firstTextMs <= 4000).length;
console.log(JSON.stringify({ provider: providerId, warmSamples: warm.length, firstTextMs: warm.map((r) => r.firstTextMs), firstEventMs: warm.map((r) => r.firstEventMs), firstTextWithin4s: `${within}/${warm.length}`, appServerProcessesStarted: spawns }));
for (const p of providers.values()) await p.dispose();
await gateway.dispose();
mount.unmount();
process.exit(0);
