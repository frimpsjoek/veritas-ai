#!/usr/bin/env node
// Stands in for `claude -p --input-format stream-json --output-format stream-json`. Replays the fixture named
// by the FIXTURE env var as soon as it sees one line of stdin (the turn's user message) — real content doesn't
// matter for the fixture-replay tests, only that a turn was sent. Stays alive afterward (idle) unless the
// fixture name contains "crash", matching a real claude process that would wait for the next stream-json turn.
import { readFileSync } from 'node:fs';
import readline from 'node:readline';

const fixture = readFileSync(process.env.FIXTURE, 'utf8').trim().split('\n').filter(Boolean);
let replayed = false;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (replayed) return; // one turn per fixture; a warm-reuse test spawns a fresh fake process per turn instead
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== 'user') return;
  replayed = true;
  for (const fixtureLine of fixture) process.stdout.write(fixtureLine + '\n');
  if (/crash/.test(process.env.FIXTURE)) process.exit(1);
});
