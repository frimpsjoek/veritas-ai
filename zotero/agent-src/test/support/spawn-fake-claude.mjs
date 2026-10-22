// Wraps `node fake-claude.mjs` as a platform.d.ts ChildProcess, the same shape spawn-fake-codex.mjs gives the
// Codex tests. Test-only: node/platform.mjs implements the same interface against a real subprocess.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const FAKE_CLAUDE = fileURLToPath(new URL('../fake-claude.mjs', import.meta.url));

export function spawnFakeClaude(fixtureName) {
  const child = spawn(process.execPath, [FAKE_CLAUDE], {
    env: { ...process.env, FIXTURE: fileURLToPath(new URL(`../fixtures/${fixtureName}`, import.meta.url)) },
  });
  let stderrTail = '';
  child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-4000); });

  return {
    lines() {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      return { [Symbol.asyncIterator]: () => rl[Symbol.asyncIterator]() };
    },
    async write(line) {
      if (child.stdin.writable) child.stdin.write(line + '\n');
    },
    stderrTail() { return stderrTail; },
    async kill() {
      if (!child.killed) child.kill();
    },
    exited: new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0))),
  };
}
