#!/usr/bin/env node
// Stands in for `codex app-server` in tests. Replays the fixture named by the FIXTURE env var, verbatim and in
// order, as soon as it sees the client's "initialize" request (fixtures are already recorded in chronological
// order, so nothing needs re-timing). turn/interrupt is handled globally rather than by any one fixture: real
// P0 recordings never interrupted a turn, so this is the one behavior every fixture gets for free.
//
// A fixture may contain more than one turn, separated by a "---TURN---" marker line: block 0 replays on
// "initialize" as before (a full handshake plus the first turn/completed); each later block replays on the
// *next* "turn/start" this process sees after that, which is exactly what a warm-reused Codex thread looks
// like on the wire (no repeated initialize/thread/start — just another turn/start on the same process).
import { readFileSync } from 'node:fs';
import readline from 'node:readline';

const blocks = readFileSync(process.env.FIXTURE, 'utf8').trim().split('\n---TURN---\n')
  .map((block) => block.trim().split('\n').filter(Boolean));
let started = false;
let turnStartsSeen = 0;
let nextBlock = 1;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === 'turn/interrupt') {
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'interrupted', items: [] } } }) + '\n');
    process.exit(0);
  }

  if (!started && msg.method === 'initialize') {
    started = true;
    for (const fixtureLine of blocks[0]) process.stdout.write(fixtureLine + '\n');
    // Only the crash fixture exits on its own; every other fixture stays alive (idle, or waiting for
    // turn/interrupt) until the client kills it at the end of the turn, same as a real app-server process.
    if (/crash/.test(process.env.FIXTURE)) process.exit(1);
    return;
  }

  if (started && msg.method === 'turn/start') {
    turnStartsSeen += 1;
    // The very first turn/start of the process is already answered eagerly by block 0 above (it doesn't wait
    // for turn/start to literally arrive); only the second and later ones get a fresh block.
    if (turnStartsSeen >= 2 && nextBlock < blocks.length) {
      for (const fixtureLine of blocks[nextBlock]) process.stdout.write(fixtureLine + '\n');
      nextBlock += 1;
    }
  }
});
