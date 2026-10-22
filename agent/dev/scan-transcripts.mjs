#!/usr/bin/env node
// Success criterion 6 audit: no stored transcript may hold a shell command or a file edit by an agent.
//
//   node dev/scan-transcripts.mjs [--json] [extra-root ...]
//
// Walks every stored conversation, review and provider state file it can find and reports, per source:
//   commandExecution / fileChange   Codex thread items (what codex.js turns into failed{policy_violation})
//   Bash / Edit / Write / NotebookEdit tool_use   Claude Code tool calls of the same kind
//   policy_violation                a turn our own guard stopped (an attempt, blocked; listed, not a leak)
//   Codex code-mode `exec` calls    Codex can wrap tool calls in model-written JavaScript ("ToolCall: exec" in
//                                   its logs). Not a shell or edit item, but code: each body is checked for
//                                   anything besides our own tools.mcp__lib__* (other tools, process, require, fs)
// JSON and JSONL files are parsed and walked; binary files (Codex's SQLite state and logs) are searched for the
// same markers as raw text. Test fixtures are scanned too but reported apart: they contain these items on
// purpose, to prove the guard fires. Exit code 1 when any non-fixture source has a command or edit item.
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentSrc = path.resolve(here, '..');
const home = os.homedir();
const kb = process.env.SECOND_BRAIN_KB ?? path.join(home, 'obsidian-kb');

const FORBIDDEN_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);
const RAW_MARKERS = {
  commandExecution: /"type"\s*:\s*"commandExecution"/g,
  fileChange: /"type"\s*:\s*"fileChange"/g,
  forbiddenToolUse: /"type"\s*:\s*"tool_use"[^{}]{0,200}"name"\s*:\s*"(?:Bash|Edit|Write|NotebookEdit)"/g,
  policyViolation: /policy_violation/g,
};
const EXEC_CALL = /ToolCall: exec ([^\x00\n]{0,4000})/g;
const EXEC_BEYOND_LIBRARY = /tools\.(?!mcp__lib__)[A-Za-z_]\w*|\brequire\(|\bimport\(|\bprocess\.|child_process|\bfs\.|\bDeno\./;

/** Default sources: [label, root, kind]. Missing roots are reported as absent, never an error. */
function defaultSources() {
  return [
    ['sidecar conversations', path.join(kb, 'data/agent/chats'), 'data'],
    ['sidecar reviews', path.join(kb, 'data/agent/reviews'), 'data'],
    ['sidecar Codex state (private CODEX_HOME)', path.join(kb, 'data/agent/codex-home'), 'data'],
    ['sidecar Claude scratch', path.join(kb, 'data/agent/claude-mcp'), 'data'],
    ['Zotero standalone data (<Zotero data dir>/second-brain)', path.join(home, 'Zotero/second-brain'), 'data'],
    ['headless Zotero harness', process.env.SB_HARNESS_DIR ?? '/private/tmp/sb-harness-int/data/second-brain', 'data'],
    ['recorded real-run evidence (specs/.../evidence)', path.join(kb, 'specs/001-second-brain-ai/evidence'), 'data'],
    ['test fixtures (deliberate)', path.join(agentSrc, 'test/fixtures'), 'fixture'],
  ];
}

async function* files(root) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (entry.isFile()) yield full;
  }
}

function emptyCounts() {
  return { commandExecution: 0, fileChange: 0, forbiddenToolUse: 0, policyViolation: 0, codeModeExec: 0, codeModeBeyondLibrary: 0 };
}

/** Walks one parsed JSON value and counts the items criterion 6 forbids. */
function walk(value, counts) {
  if (Array.isArray(value)) { for (const v of value) walk(v, counts); return; }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'commandExecution') counts.commandExecution += 1;
  if (value.type === 'fileChange') counts.fileChange += 1;
  if (value.type === 'tool_use' && FORBIDDEN_TOOLS.has(value.name)) counts.forbiddenToolUse += 1;
  if (value.kind === 'policy_violation') counts.policyViolation += 1;
  for (const v of Object.values(value)) walk(v, counts);
}

function parseAll(text) {
  try { return [JSON.parse(text)]; } catch { /* JSONL, or not JSON at all */ }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { return null; }
  }
  return out;
}

async function scanFile(file, counts) {
  const buf = await readFile(file);
  const text = buf.toString('utf8');
  if (/\.(jsonl?|txt)$/.test(file)) {
    const values = parseAll(text);
    if (values) { for (const v of values) walk(v, counts); return 'parsed'; }
  }
  // Binary (SQLite, WAL) or free text: search for the markers as raw text.
  const raw = buf.toString('latin1');
  for (const [key, re] of Object.entries(RAW_MARKERS)) counts[key] += (raw.match(re) ?? []).length;
  for (const m of raw.matchAll(EXEC_CALL)) {
    counts.codeModeExec += 1;
    if (EXEC_BEYOND_LIBRARY.test(m[1])) counts.codeModeBeyondLibrary += 1;
  }
  return 'raw';
}

async function scanSource([label, root, kind]) {
  const counts = emptyCounts();
  const exists = await stat(root).then((s) => s.isDirectory(), () => false);
  let parsed = 0; let raw = 0;
  if (exists) {
    for await (const file of files(root)) {
      if ((await scanFile(file, counts)) === 'parsed') parsed += 1; else raw += 1;
    }
  }
  return { label, root, kind, exists, filesParsed: parsed, filesRaw: raw, ...counts };
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const extra = args.filter((a) => a !== '--json').map((root) => [`extra: ${root}`, path.resolve(root), 'data']);
const results = [];
for (const source of [...defaultSources(), ...extra]) results.push(await scanSource(source));

const leaks = results.filter((r) => r.kind === 'data' && (r.commandExecution || r.fileChange || r.forbiddenToolUse || r.codeModeBeyondLibrary));
if (asJson) {
  console.log(JSON.stringify({ scannedAt: new Date().toISOString(), results, leaks: leaks.length }, null, 2));
} else {
  for (const r of results) {
    const where = r.root.startsWith(home) ? `~${r.root.slice(home.length)}` : r.root;
    if (!r.exists) { console.log(`${r.label}\n  ${where}: not present\n`); continue; }
    console.log(`${r.label}${r.kind === 'fixture' ? ' [fixtures: expected to contain these]' : ''}\n  ${where}: ${r.filesParsed} JSON/JSONL files walked, ${r.filesRaw} searched as raw text\n  commandExecution ${r.commandExecution}, fileChange ${r.fileChange}, Bash/Edit/Write tool_use ${r.forbiddenToolUse}, policy_violation (blocked attempts) ${r.policyViolation}\n  Codex code-mode exec occurrences ${r.codeModeExec} (reaching beyond our read-only tools: ${r.codeModeBeyondLibrary})\n`);
  }
  console.log(leaks.length ? `FAIL: ${leaks.length} source(s) outside test fixtures hold a command, edit, or code that reaches past our tools.` : 'PASS: no command or file-edit items outside test fixtures, and every code-mode exec only called our read-only tools.');
  console.log('Raw counts in SQLite files are text occurrences: a WAL file can repeat rows its database also holds.');
}
process.exitCode = leaks.length ? 1 : 0;
