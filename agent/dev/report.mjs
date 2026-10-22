#!/usr/bin/env node
// agent-src/dev/report.mjs. Spec 007 E7 verify: one real pipeline-2 Research report through createLocalRuntime, on the real
// library and a real provider, with the note sink in memory (nothing is written to the vault) and the run's files under
// --data (default: a fresh temp dir; pass ~/obsidian-kb/data/agent-dev to reuse its provider sign-in).
//   node dev/report.mjs "question" [--provider codex|claude] [--depth quick|standard] [--answer 1] [--sources papers,scholarly] [--data <dir>] [--resume <reviewId>] [--systematic]
// Answers each clarify card with the given choice number (default 1), approves the plan as it stands, prints one timed
// line per progress snapshot, then checks that every evidence cell exists in table.json and every quote is verified.
import { createNodePlatform } from '../src/node/platform.mjs';
import { createHttpLibraryBackend } from '../src/library-http.js';
import { createToolGateway, createMcpHttpHandler } from '../src/tools.js';
import { createLocalRuntime } from '../src/core.js';
import { createProviders } from '../src/providers/index.js';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const question = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? (args.includes('--resume') ? '(resume)' : undefined);
const providerName = flag('provider', 'codex');
if (!question) { console.error('usage: node dev/report.mjs "question" [--provider codex|claude] [--depth quick] [--answer 1] [--data <dir>]'); process.exit(1); }

const home = process.env.HOME;
const dataDir = flag('data', fileURLToPath(new URL('../../server/data/agent-dev', import.meta.url)));
const kbBaseUrl = process.env.SECOND_BRAIN_KB_URL ?? 'http://127.0.0.1:27182';
const platform = createNodePlatform({ homeDir: home });
const library = createHttpLibraryBackend(platform.fetch, { baseUrl: kbBaseUrl, token: process.env.SECOND_BRAIN_KB_TOKEN ?? null });
const gatewaySettings = { scholarly: ['openalex', 'arxiv', 'crossref', 'europepmc'], mcpUrl: undefined };
const gateway = await createToolGateway(platform.fetch, library, gatewaySettings);
const mount = await platform.serve('/mcp', createMcpHttpHandler(gateway));
gatewaySettings.mcpUrl = mount.url;
const providers = createProviders(platform, { dataDir, home, codex: { binaryPath: process.env.CODEX_BINARY ?? null }, claude: { binaryPath: process.env.CLAUDE_BINARY ?? null } });
const published = [];
const notes = { async publish(note) { published.push(note); return { path: `(memory)/${note.title}.md` }; } };
const ai = await createLocalRuntime({ platform, library, notes, dataDir, providers, gateway, getRoleModel: async () => ({ provider: providerName, model: process.env.SECOND_BRAIN_MODEL ?? null }) });

const t0 = Date.now();
const at = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`;
const resumeId = flag('resume', null);
const id = resumeId ?? await ai.reviews.start({ question, scope: { kind: 'library' }, sources: flag('sources', 'papers').split(','), years: { from: null, to: null }, depth: flag('depth', 'quick'), pipeline: 2, ...(args.includes('--systematic') ? { systematic: true } : {}) });
if (resumeId) await ai.reviews.resume(id);
console.log(`${at()} ${resumeId ? 'resumed' : 'started'} ${id} (files under ${dataDir}/reviews/${id})`);

let last = '';
let final = null;
for (let round = 0; round < 8 && !final; round++) {
  for await (const p of ai.reviews.watch(id)) {
    const s = p.status;
    const live = (p.lines ?? []).find((l) => l.state === 'running' && l.entries?.length);
    if (live) console.log(`${at()} LIVE ${live.title} | ${live.detail ?? ''} | ${live.entries.slice(-3).map((e) => `${e.state}:${e.label}`).join(' ; ')}`);
    const line = `${s.state}${s.stage ? `:${s.stage}` : ''} | ${(p.lines ?? []).map((l) => l.title).join(' > ')} | ${JSON.stringify(p.counts)}`;
    if (line !== last) { console.log(`${at()} ${line}`); last = line; }
    if (s.state === 'awaiting_answer') {
      console.log(`${at()} QUESTIONS: ${JSON.stringify(s.questions.map((q) => [q.question, q.choices]))}`);
      await ai.reviews.answer(id, s.questions.map((q) => ({ id: q.id, choice: Number(flag('answer', '1')) - 1, other: null })));
      break;
    }
    if (s.state === 'awaiting_review') {
      console.log(`${at()} UNCLEAR ${s.unclear.length} of ${s.total}: ${JSON.stringify(s.unclear.map((u) => [u.title.slice(0, 50), u.because]))}`);
      await ai.reviews.screened(id, []);
      break;
    }
    if (s.state === 'awaiting_approval') {
      console.log(`${at()} PLAN: ${JSON.stringify({ sq: s.plan.subQuestions.map((x) => x.question), protocol: s.plan.protocol, criteria: s.plan.criteria, columns: s.plan.columns?.map((c) => c.name), assumed: s.plan.assumed, caps: s.plan.caps })}`);
      await ai.reviews.approvePlan(id, s.plan);
      break;
    }
    if (s.state === 'stopped') { console.log(`${at()} STOPPED: ${JSON.stringify(s)}`); final = p; break; }
    if (s.state === 'done') { final = p; break; }
  }
}
if (!final || final.status.state !== 'done') { console.error('did not finish'); await gateway.dispose(); process.exit(1); }

const { report, table, counts } = final;
let cells = 0; let missing = 0; let quotes = 0; let unverified = 0;
for (const e of report.evidence) for (const c of e.cells ?? []) { cells += 1; if (table.cells[c.row]?.[c.column]?.state !== 'filled') missing += 1; }
for (const r of table.rows) for (const col of table.columns) for (const q of (table.cells[r.id]?.[col.id]?.quotes ?? [])) { quotes += 1; if (!q.verified) unverified += 1; }
console.log(`\n${at()} DONE  counts=${JSON.stringify(counts)}  evidence=${report.evidence.length} entries, ${cells} cells (${missing} missing)  quotes=${quotes} (${unverified} unverified, ${quotes ? Math.round(100 * (quotes - unverified) / quotes) : 0}% verified)`);
console.log(`title: ${report.title}\nmethod: ${published[0].markdown.split('## Method')[1].slice(0, 700)}`);
await gateway.dispose();
process.exit(missing ? 1 : 0);
