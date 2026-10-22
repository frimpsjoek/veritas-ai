#!/usr/bin/env node
// spec 016 E2 live check: one real Claude turn through claudeProvider with model "sonnet" (one paid call), printing the
// argv the provider spawned so `--model sonnet` is visible.   node dev/probe-model.mjs [model] [effort]
import { createNodePlatform } from '../src/node/platform.mjs';
import { createProviders } from '../src/providers/index.js';

const model = process.argv[2] ?? 'sonnet';
const effort = process.argv[3] ?? undefined;
const home = process.env.HOME;
const base = createNodePlatform({ homeDir: home });
const spawned = [];
const platform = { ...base, async spawn(spec) { spawned.push(spec.args); return base.spawn(spec); } };
const dataDir = `${process.env.TMPDIR ?? '/tmp'}/probe-model-${process.pid}`;
const claude = createProviders(platform, { dataDir, home, claude: { binaryPath: process.env.CLAUDE_BINARY ?? null } }).get('claude');

const tools = { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: 'http://127.0.0.1:9/mcp', token: 'x' }, seen: () => [], close() {} };
const events = [];
for await (const ev of claude.turn({ sessionKey: 'probe', model: { provider: 'claude', model, ...(effort ? { effort } : {}) }, instructions: 'Answer in one word.', history: [], input: 'say ok', tools, web: 'off', outputSchema: null }, new AbortController().signal)) events.push(ev);
const args = spawned[0] ?? [];
const at = args.indexOf('--model');
console.log(JSON.stringify({ modelArg: at >= 0 ? args[at + 1] : null, effortArg: args.includes('--effort') ? args[args.indexOf('--effort') + 1] : null, final: events.find((e) => e.type === 'final')?.text ?? events.at(-1) }));
await claude.dispose();
process.exit(0);
