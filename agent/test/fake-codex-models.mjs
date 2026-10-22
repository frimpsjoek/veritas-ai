#!/usr/bin/env node
// Stands in for `codex app-server` where only the handshake and `model/list` matter. PAGES (env) is a JSON array of
// `model/list` results, served in order; MODE=error answers model/list with a JSON-RPC error, MODE=silent never answers it.
import readline from 'node:readline';

const pages = JSON.parse(process.env.PAGES ?? '[]');
let page = 0;
const say = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') say({ id: msg.id, result: { userAgent: 'codex-fake' } });
  else if (msg.method === 'model/list') {
    if (process.env.MODE === 'silent') return;
    if (process.env.MODE === 'error') say({ id: msg.id, error: { code: -32600, message: 'model/list is not supported' } });
    else say({ id: msg.id, result: pages[page++] ?? { data: [], nextCursor: null } });
  }
});
