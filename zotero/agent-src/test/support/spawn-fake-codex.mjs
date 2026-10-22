// Wraps `node fake-codex.mjs` as a platform.d.ts ChildProcess, without depending on the Node platform (T1.5's
// job). Test-only: the real node/platform.mjs implements the same interface against a real subprocess.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const FAKE_CODEX = fileURLToPath(new URL('../fake-codex.mjs', import.meta.url));

/**
 * @param {string} fixtureName
 * @param {{ sent?: string[] }} [opts] When given, every line this process's caller writes to stdin (i.e. every
 *   JSON-RPC request/notification codex.js sends) is also pushed here, verbatim, so a test can inspect exactly
 *   what a warm-reused vs. a fresh thread sent for a given turn.
 */
export function spawnFakeCodex(fixtureName, opts = {}) {
  const child = spawn(process.execPath, [FAKE_CODEX], {
    env: { ...process.env, FIXTURE: fileURLToPath(new URL(`../fixtures/${fixtureName}`, import.meta.url)) },
  });
  // Same as src/node/platform.mjs: the crash fixture's process exits while the client is still writing (EPIPE).
  child.stdin.on('error', () => {});
  let stderrTail = '';
  child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-4000); });

  return {
    lines() {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      return { [Symbol.asyncIterator]: () => rl[Symbol.asyncIterator]() };
    },
    async write(line) {
      opts.sent?.push(line);
      if (child.stdin.writable) child.stdin.write(line + '\n');
    },
    stderrTail() { return stderrTail; },
    async kill() {
      if (!child.killed) child.kill();
    },
    exited: new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0))),
  };
}
