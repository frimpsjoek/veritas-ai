#!/usr/bin/env node
// agent-src/dev/live-timing.mjs. Runs ONE real turn through the runtime engine and prints every activity event with
// the milliseconds since the send, to show the live feed is spread over the run, not bursts.
//   node dev/live-timing.mjs [--provider codex|claude] ["question"]
// Uses a temp dataDir and its own in-process gateway (never the running sidecar). Library: the kb server at
// SECOND_BRAIN_KB_URL (default http://127.0.0.1:27182), read-only.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createNodePlatform } from '../src/node/platform.mjs';
import { createHttpLibraryBackend } from '../src/library-http.js';
import { createToolGateway, createMcpHttpHandler } from '../src/tools.js';
import { createTurnRunner, createSlots, ASK_INSTRUCTIONS } from '../src/core.js';
import { createProviders } from '../src/providers/index.js';

const args = process.argv.slice(2);
const pi = args.indexOf('--provider');
const providerName = pi >= 0 ? args[pi + 1] : 'codex';
const question = args.filter((a, i) => a !== '--provider' && i !== pi + 1)[0]
  ?? 'Search my library for papers on transferable machine-learned Hamiltonians, then read the three most relevant ones and tell me what each contributes.';

const home = os.homedir();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-timing-'));
const platform = createNodePlatform({ homeDir: home });
const library = createHttpLibraryBackend(platform.fetch, { baseUrl: process.env.SECOND_BRAIN_KB_URL ?? 'http://127.0.0.1:27182', token: process.env.SECOND_BRAIN_KB_TOKEN ?? null });
const settings = { scholarly: [], mcpUrl: undefined };
const gateway = await createToolGateway(platform.fetch, library, settings);
const mount = await platform.serve('/mcp', createMcpHttpHandler(gateway));
settings.mcpUrl = mount.url;
const providers = createProviders(platform, {
  dataDir, home,
  codex: { binaryPath: process.env.CODEX_BINARY ?? '/Applications/ChatGPT.app/Contents/Resources/codex' },
  claude: { binaryPath: process.env.CLAUDE_BINARY ?? null },
});
const runner = createTurnRunner({
  providers, getRoleModel: async () => ({ provider: providerName, model: process.env.SECOND_BRAIN_MODEL ?? null }),
  gateway, library, slots: createSlots({ total: 2 }),
});

const t0 = Date.now();
const at = () => `${String(Date.now() - t0).padStart(6)} ms`;
const rows = [];
let firstText = null;
for await (const ev of runner.stream('chat', {
  sessionKey: `timing:${Date.now()}`, instructions: ASK_INSTRUCTIONS, history: [], input: question,
  tools: { scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: false, web: false }, audit: 'live-timing' },
}, new AbortController().signal)) {
  if (ev.type === 'activity') {
    rows.push({ ms: Date.now() - t0, phase: ev.phase });
    console.log(`${at()}  ${ev.phase.padEnd(5)} ${ev.id.padEnd(5)} [${ev.kind}] ${ev.label}${ev.detail ? `  -> ${ev.detail}` : ''}${ev.source ? `  (${ev.source.title})` : ''}`);
  } else if (ev.type === 'text' && firstText === null) { firstText = Date.now() - t0; console.log(`${at()}  first text`); }
  else if (ev.type === 'reasoning') { /* not shown */ }
  else if (ev.type === 'done') console.log(`${at()}  done (${ev.answer.text.length} chars)`);
  else if (ev.type === 'failed') console.log(`${at()}  FAILED [${ev.error.kind}] ${ev.error.message}`);
}
const starts = rows.filter((r) => r.phase === 'start').map((r) => r.ms);
console.log(`\n${starts.length} starts; first start ${starts[0] ?? 'n/a'} ms; last start ${starts.at(-1) ?? 'n/a'} ms; provider ${providerName}`);
await gateway.dispose();
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
