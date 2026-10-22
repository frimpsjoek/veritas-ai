#!/usr/bin/env node
// agent-src/dev/extract.mjs. Real-provider check for spec 007 E4 (columns on a paper set):
//   node dev/extract.mjs [--provider claude|codex] [--text abstract|best]
// Puts a 6-paper fixture set (invented titles, abstracts written to read like real ones) into a temp session, runs
// two columns through sessions.run (one extraction turn for the six papers), prints every event and the verified-
// quote ratio. Env: CLAUDE_BINARY, CODEX_BINARY, SECOND_BRAIN_MODEL, SECOND_BRAIN_DATA_DIR (default: a temp dir).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createNodePlatform } from '../src/node/platform.mjs';
import { createToolGateway } from '../src/tools.js';
import { createLocalRuntime } from '../src/core.js';
import { createProviders } from '../src/providers/index.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const providerId = flag('provider', 'claude');
const text = flag('text', 'abstract');
const home = process.env.HOME;
const dataDir = process.env.SECOND_BRAIN_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sb-extract-'));

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
const gateway = await createToolGateway(platform.fetch, library, { scholarly: [], mcpUrl: undefined });
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
const input = {
  kind: 'columns', on: put.ref, rows: 'all', text,
  add: [
    { id: 'limitations', name: 'Limitations', instruction: 'the limitations the authors state', kind: 'text' },
    { id: 'sample', name: 'Sample size', instruction: 'how many participants were studied', kind: 'text' },
  ],
};
console.error('estimate:', JSON.stringify(await ai.sessions.estimate(id, input)));
const started = Date.now();
const { step } = await ai.sessions.run(id, input);
let end = null;
for await (const ev of ai.sessions.events(id, step, 0)) {
  const d = ev.data;
  if (d.type === 'cell') console.log(`#${ev.seq} cell ${d.row} ${d.column}: ${d.cell.state === 'filled' ? `${d.cell.value}  [${d.cell.quotes.map((q) => (q.verified ? 'verified' : 'UNVERIFIED')).join(', ') || 'no quote'}]` : JSON.stringify(d.cell)}`);
  else console.log(`#${ev.seq} ${JSON.stringify(d)}`);
  if (d.type === 'end') end = d;
}
const v2 = await ai.sessions.read(id, { id: put.ref.id, version: 2 });
let quotes = 0; let verified = 0; let filled = 0; let cells = 0;
for (const perRow of Object.values(v2?.cells ?? {})) for (const cell of Object.values(perRow)) {
  cells += 1;
  if (cell.state === 'filled') { filled += 1; for (const q of cell.quotes) { quotes += 1; if (q.verified) verified += 1; } }
}
console.log(`\nstatus=${end?.status} cells=${cells} filled=${filled} quotes=${quotes} verified=${verified} ratio=${quotes ? (verified / quotes).toFixed(2) : 'n/a'} seconds=${((Date.now() - started) / 1000).toFixed(1)}`);
console.log(`change line: ${v2?.change}`);
console.log(`data dir: ${dataDir}`);
await ai.dispose();
process.exit(end?.status === 'done' ? 0 : 1);
