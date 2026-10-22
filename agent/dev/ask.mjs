#!/usr/bin/env node
// agent-src/dev/ask.mjs. One-shot Ask harness for manual smoke tests and the T1.5/T2.3 checkpoints:
//   node dev/ask.mjs "question" [--provider codex|claude|openai] [--sources papers,notes,scholarly,web]
// Env: CODEX_BINARY, CLAUDE_BINARY, SECOND_BRAIN_DATA_DIR, SECOND_BRAIN_KB_URL, SECOND_BRAIN_KB_TOKEN,
// SECOND_BRAIN_MODEL, SECOND_BRAIN_WEB, and for --provider openai: SECOND_BRAIN_OSS_URL (base URL, e.g. a local
// mlx_lm.server), SECOND_BRAIN_OSS_KEY (optional). Streams text and tool activity to stderr, then prints the
// validated answer. --sources (spec 005) defaults to papers,notes: a comma list of papers/notes/scholarly/web.
import { createNodePlatform } from '../src/node/platform.mjs';
import { createHttpLibraryBackend, createHttpNoteSink } from '../src/library-http.js';
import { createToolGateway, createMcpHttpHandler } from '../src/tools.js';
import { createTurnRunner, createSlots, ASK_SCHEMA, ASK_INSTRUCTIONS, createLocalRuntime } from '../src/core.js';
import { createProviders } from '../src/providers/index.js';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const providerFlagIndex = args.indexOf('--provider');
const providerName = providerFlagIndex >= 0 ? args[providerFlagIndex + 1] : 'codex';
const sourcesFlagIndex = args.indexOf('--sources');
const sourcesList = sourcesFlagIndex >= 0 ? args[sourcesFlagIndex + 1].split(',').map((s) => s.trim()) : ['papers', 'notes'];
// spec 007 E1 verify: put a fixture paper set into a fresh session, ask a follow-up about it, and confirm the
// transcript shows read_result (and no search_library/search_scholarly) instead of re-searching.
const sessionFlag = args.includes('--session');
const question = args.filter((a, i) =>
  a !== '--provider' && i !== providerFlagIndex + 1 && a !== '--sources' && !(sourcesFlagIndex >= 0 && i === sourcesFlagIndex + 1) && a !== '--session')[0];
if (!question || !['codex', 'claude', 'openai'].includes(providerName)) {
  console.error('usage: node dev/ask.mjs "question" [--provider codex|claude|openai] [--session]');
  process.exit(1);
}
const providerId = providerName === 'openai' ? 'oss:default' : providerName;

const home = process.env.HOME;
const dataDir = process.env.SECOND_BRAIN_DATA_DIR ?? fileURLToPath(new URL('../../server/data/agent-dev', import.meta.url));
const kbBaseUrl = process.env.SECOND_BRAIN_KB_URL ?? 'http://127.0.0.1:27182';

const platform = createNodePlatform({ homeDir: home });
const library = createHttpLibraryBackend(platform.fetch, { baseUrl: kbBaseUrl, token: process.env.SECOND_BRAIN_KB_TOKEN ?? null });

const gatewaySettings = { scholarly: ['openalex', 'arxiv', 'crossref', 'europepmc'], mcpUrl: undefined };
const gateway = await createToolGateway(platform.fetch, library, gatewaySettings);
const mount = await platform.serve('/mcp', createMcpHttpHandler(gateway));
gatewaySettings.mcpUrl = mount.url; // known only once the shared HTTP server is up; sessions opened after this see it

const providers = createProviders(platform, {
  dataDir, home,
  codex: { binaryPath: process.env.CODEX_BINARY ?? null },
  claude: { binaryPath: process.env.CLAUDE_BINARY ?? null },
  oss: process.env.SECOND_BRAIN_OSS_URL ? { baseUrl: process.env.SECOND_BRAIN_OSS_URL, apiKey: process.env.SECOND_BRAIN_OSS_KEY ?? null } : undefined,
});
const runner = createTurnRunner({
  providers,
  getRoleModel: async () => ({ provider: providerId, model: process.env.SECOND_BRAIN_MODEL ?? null }),
  gateway,
  slots: createSlots({ total: 6, perRole: { researcher: 3 } }),
  library,
});

if (sessionFlag) {
  const notes = createHttpNoteSink(platform.fetch, { baseUrl: kbBaseUrl });
  const ai = await createLocalRuntime({
    platform, library, notes, dataDir, providers, gateway,
    getRoleModel: async () => ({ provider: providerId, model: process.env.SECOND_BRAIN_MODEL ?? null }),
  });
  const id = await ai.conversations.create('chat');
  const fixturePaper = {
    id: 'x:1', ref: { kind: 'web', url: 'https://doi.org/10.9999/fixture' }, inLibrary: false,
    title: 'A study of widgets (fixture)', authors: ['Doe, J.'], year: 2021, venue: 'J. Widgets',
    doi: '10.9999/fixture', url: null, abstract: 'Widgets are studied in this fixture paper.', citations: null,
    fullText: false, pdfUrl: null, studyType: null, foundBy: ['fixture'],
  };
  const summary = await ai.sessions.put(
    id, { kind: 'find', query: 'widgets', sources: ctxSources(), scope: { kind: 'library' } },
    { kind: 'papers', ref: { id: '', version: 0 }, title: 'Widgets (fixture)', created: '', madeBy: '', from: [], change: 'Found 1 fixture paper', query: 'widgets', rows: [fixturePaper], columns: [], cells: {}, screening: null, summary: null },
  );
  console.error(`put fixture result ${summary.ref.id} V${summary.ref.version} (${summary.rows} rows)`);

  const toolsCalled = [];
  let sawFailure = false;
  for await (const ev of ai.conversations.send(id, { text: question })) {
    if (ev.type === 'text') process.stdout.write(ev.delta);
    else if (ev.type === 'activity' && ev.phase === 'start') { toolsCalled.push(ev.kind); process.stderr.write(`\n[${ev.kind}] ${ev.label}\n`); }
    else if (ev.type === 'notice') process.stderr.write(`\n(${ev.kind}: ${ev.text})\n`);
    else if (ev.type === 'result') console.log(`\n--- result event ---\n${JSON.stringify(ev)}`); // spec 007 E3: a chat-made table
    else if (ev.type === 'done') {
      if (ev.notice) console.log(`\n(notice: ${ev.notice})`);
      console.log('\n\n--- citations ---');
      for (const c of ev.answer.citations) console.log(c.status === 'resolved' ? `resolved: ${JSON.stringify(c.ref)} (${c.title})` : `UNKNOWN: ${JSON.stringify(c.ref)}`);
    } else if (ev.type === 'failed') { sawFailure = true; console.error(`\nFAILED [${ev.error.kind}]: ${ev.error.message}`); }
  }
  const view = await ai.sessions.view(id);
  console.log('\n--- session view results ---', JSON.stringify(view.results));
  console.log('--- data dir ---', `${dataDir}/chats/${id}.d`);
  console.log('\n--- tool activity ---', JSON.stringify(toolsCalled));
  console.log(toolsCalled.includes('result') ? 'PASS: called read_result' : 'no read_result call seen');
  console.log(toolsCalled.some((k) => k === 'library' || k === 'scholarly') ? 'WARN: also called a search tool' : 'PASS: no search_* call');
  await gateway.dispose();
  process.exit(sawFailure ? 1 : 0);
}

function ctxSources() {
  return { papers: sourcesList.includes('papers'), notes: sourcesList.includes('notes'), scholarly: sourcesList.includes('scholarly'), web: sourcesList.includes('web') };
}

const ctx = {
  scope: { kind: 'library' },
  web: process.env.SECOND_BRAIN_WEB ?? 'off',
  sources: {
    papers: sourcesList.includes('papers'), notes: sourcesList.includes('notes'),
    scholarly: sourcesList.includes('scholarly'), web: sourcesList.includes('web') || (process.env.SECOND_BRAIN_WEB ?? 'off') !== 'off',
  },
  audit: `ask-harness:${Date.now()}`,
};

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());

let sawFailure = false;
for await (const ev of runner.stream(
  'ask',
  { sessionKey: `ask:${Date.now()}`, instructions: ASK_INSTRUCTIONS, history: [], input: question, tools: ctx, outputSchema: ASK_SCHEMA },
  controller.signal,
)) {
  if (ev.type === 'text') process.stdout.write(ev.delta);
  else if (ev.type === 'activity' && ev.phase === 'start') process.stderr.write(`\n[${ev.kind}] ${ev.label}\n`);
  else if (ev.type === 'notice') process.stderr.write(`\n(${ev.kind}: ${ev.text})\n`);
  else if (ev.type === 'done') {
    console.log('\n\n--- structured ---');
    console.log(JSON.stringify(ev.answer.structured, null, 2));
    console.log('--- citations ---');
    for (const c of ev.answer.citations) {
      console.log(c.status === 'resolved' ? `resolved: ${JSON.stringify(c.ref)} (${c.title})` : `UNKNOWN: ${JSON.stringify(c.ref)}`);
    }
  } else if (ev.type === 'failed') {
    sawFailure = true;
    console.error(`\nFAILED [${ev.error.kind}]: ${ev.error.message}`);
  }
}

await gateway.dispose();
process.exit(sawFailure ? 1 : 0);
