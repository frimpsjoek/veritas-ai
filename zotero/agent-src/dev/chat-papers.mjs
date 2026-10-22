#!/usr/bin/env node
// agent-src/dev/chat-papers.mjs. Real-provider check for spec 007 E5 (chat with papers):
//   node dev/chat-papers.mjs [--provider claude|codex] [--question "..."] [--rows all|3]
// Puts a 6-paper fixture set (invented, abstracts written to read like real ones) into a temp session and asks one
// question with `on` set through the real provider. Prints the tool calls (read_result yes, search_* never), the answer and
// whether each citation resolved. Uses a temp data dir and never touches agentd. Env: CLAUDE_BINARY, CODEX_BINARY,
// SECOND_BRAIN_MODEL, SECOND_BRAIN_DATA_DIR.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createNodePlatform } from '../src/node/platform.mjs';
import { createToolGateway, createMcpHttpHandler } from '../src/tools.js';
import { createLocalRuntime } from '../src/core.js';
import { createProviders } from '../src/providers/index.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const providerId = flag('provider', 'claude');
const question = flag('question', 'Which of these papers found a benefit of an intervention on sleep, and which did not say anything about interventions?');
const subset = flag('rows', 'all');
const home = process.env.HOME;
const dataDir = process.env.SECOND_BRAIN_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sb-chatpapers-'));

const abstracts = [
  ['Effects of a four-week sleep extension on reaction time in university athletes',
    'Sleep restriction is common among collegiate athletes. We randomised 42 university athletes to four weeks of sleep extension (target 9 h in bed) or habitual sleep. Reaction time on a psychomotor vigilance task improved by 38 ms in the extension group (95% CI 21 to 55) and did not change in controls. Compliance was assessed by wrist actigraphy only, and the follow-up ended at the last training day.'],
  ['Slow-wave sleep and declarative memory consolidation in older adults: a cross-sectional study',
    'Slow-wave activity declines with age, but its link to memory in later life remains unclear. In 118 community-dwelling adults aged 60 to 84, overnight polysomnography was paired with a word-pair recall test. Higher slow-wave activity was associated with better next-morning recall (r = 0.34, p < 0.001). The cross-sectional design prevents causal inference, and the sample was recruited from a single city.'],
  ['Melatonin supplementation for delayed sleep phase in adolescents: a double-blind trial',
    'Delayed sleep phase is frequent in adolescence. In this double-blind trial, 64 adolescents received 3 mg melatonin or placebo for three weeks. Dim-light melatonin onset advanced by 52 minutes with melatonin versus 9 minutes with placebo. Participants were mostly recruited from one clinic, and school attendance was self-reported.'],
  ['Screen use before bed and sleep onset latency: a diary study of young adults',
    'Evening screen use has been linked to poor sleep. Two hundred and six young adults kept a sleep diary for 14 days and logged screen time in the hour before bed. Each additional 30 minutes of screen time was associated with a 4.1 minute longer sleep onset latency. Self-reported diaries are subject to recall bias, and content type was not recorded.'],
  ['Cognitive behavioural therapy for insomnia delivered by smartphone: a pilot randomised trial',
    'Access to cognitive behavioural therapy for insomnia is limited. We piloted a six-week smartphone programme in 30 adults with chronic insomnia against a waitlist. The Insomnia Severity Index fell by 7.2 points in the programme group and by 1.9 in the waitlist group. The pilot was not powered for efficacy, and no follow-up beyond the end of treatment was collected.'],
  ['Napping and afternoon alertness in shift workers: an observational study',
    'Shift workers often nap to offset sleep loss. We followed 75 hospital night-shift nurses for two weeks with actigraphy and hourly sleepiness ratings. Nap days were associated with lower peak sleepiness at 3 a.m. (mean difference 0.9 on a 9-point scale). Nap timing was not randomised, so nurses who napped may differ in other ways.'],
];
const rows = abstracts.map(([title, abstract], i) => ({
  id: `x:${i + 1}`, ref: { kind: 'web', url: `https://doi.org/10.9999/fixture.${i + 1}` }, inLibrary: false,
  title, authors: ['Fixture, A.'], year: 2019 + i, venue: 'J. Fixture Sleep', doi: `10.9999/fixture.${i + 1}`, url: null, abstract,
  citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: ['fixture'],
}));


const platform = createNodePlatform({ homeDir: home });
const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
const gatewaySettings = { scholarly: [], mcpUrl: undefined };
const gateway = await createToolGateway(platform.fetch, library, gatewaySettings);
const mount = await platform.serve('/mcp', createMcpHttpHandler(gateway)); // the Claude CLI reaches the tools over MCP
gatewaySettings.mcpUrl = mount.url;
const providers = createProviders(platform, {
  dataDir, home,
  codex: { binaryPath: process.env.CODEX_BINARY ?? null },
  claude: { binaryPath: process.env.CLAUDE_BINARY ?? null },
});
const ai = await createLocalRuntime({
  platform, library, notes: {}, dataDir, providers, gateway,
  getRoleModel: async () => ({ provider: providerId, model: process.env.SECOND_BRAIN_MODEL ?? null }),
});

const id = await ai.conversations.create('chat');
const put = await ai.sessions.put(id, { kind: 'find', query: 'sleep', sources: {}, scope: { kind: 'library' } }, {
  kind: 'papers', ref: { id: '', version: 0 }, title: 'Sleep studies (fixture)', created: '', madeBy: '', from: [], change: 'Found 6 fixture papers',
  query: 'sleep', rows, columns: [], cells: {}, screening: null, summary: null,
});
const on = { result: put.ref, rows: subset === 'all' ? 'all' : rows.slice(0, Number(subset)).map((r) => r.id) };
console.error(`asking (${on.rows === 'all' ? 'all 6' : on.rows.length} papers): ${question}`);
const started = Date.now();
let done = null;
const toolNames = [];
for await (const ev of ai.conversations.send(id, { text: question, on })) {
  if (ev.type === 'activity' && ev.phase === 'start') toolNames.push(ev.tool ?? ev.label);
  if (ev.type === 'activity' && ev.phase === 'start') console.log(`tool: ${ev.label}${ev.tool ? `  [${ev.tool}]` : ''}`);
  else if (ev.type === 'failed') console.log('FAILED', JSON.stringify(ev.error));
  else if (ev.type === 'done') done = ev;
}
const records = await ai.conversations.load(id);
console.log(`\n--- answer (${((Date.now() - started) / 1000).toFixed(1)} s) ---\n${done?.answer.text ?? '(none)'}`);
console.log('\n--- citations ---');
for (const c of done?.answer.citations ?? []) console.log(`${c.status.padEnd(8)} ${c.ref.kind === 'paper' ? c.ref.citekey : c.ref.url}${c.title ? `  ${c.title}` : ''}`);
console.log('\n--- transcript check ---');
console.log('tool calls:', toolNames.length ? toolNames.join(', ') : '(none)');
console.log('search_* / web used:', toolNames.some((t) => /search|web/i.test(t)) ? 'YES (bad)' : 'no');
const user = records.find((r) => r.type === 'user');
console.log('user.on:', JSON.stringify(user.on), 'step:', user.step);
console.log('step records:', records.filter((r) => r.type === 'step' || r.type === 'step_end').map((r) => `${r.type}:${r.id}:${r.type === 'step' ? r.input.kind : r.status}`).join(', '));
console.error('data dir:', dataDir);
await ai.dispose();
process.exit(0);
