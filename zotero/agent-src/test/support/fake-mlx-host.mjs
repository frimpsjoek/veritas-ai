// A fake Platform slice + fake clock for the local-server tests (spec 010): spawn() pretends to be python/vm_stat/ps/kill,
// fetch() pretends the started server answers /v1/models after a few polls, timers are advanced by hand.
import { memoryFs } from './memory-fs.mjs';

export function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    // Short waits (readiness polling, the kill grace period) run at once; only minute-long timers (idle) wait for advance().
    setTimeout(fn, ms) { if (ms < 60_000) { setTimeout(fn, 0); return 0; } seq += 1; pending.set(seq, { at: now + ms, fn }); return seq; },
    clearTimeout(id) { pending.delete(id); },
    get pending() { return pending.size; },
    /** Moves time forward, running due timers (and the microtasks they start) in order. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      }
      now = target;
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
  };
}

export function fakeProc({ pid, onKill } = {}) {
  let exit;
  const exited = new Promise((resolve) => { exit = resolve; });
  const proc = {
    pid, exited, killed: false, stderr: '',
    lines() { return { async *[Symbol.asyncIterator]() { await exited; } }; },
    async write() {},
    stderrTail() { return proc.stderr; },
    async kill() { proc.killed = true; onKill?.(); exit(0); },
    die(code = 1) { exit(code); },
  };
  return proc;
}

/**
 * @param {{ files?: Record<string, string>, stats?: Record<string, { size: number, dir: boolean }>, vmStat?: string, readyAfterPolls?: number, psOutput?: string }} [opts]
 */
export function fakeHost(opts = {}) {
  const fs = memoryFs();
  for (const [k, v] of Object.entries(opts.files ?? {})) fs.files.set(k, v);
  const stats = new Map(Object.entries(opts.stats ?? {}));
  fs.stat = async (path) => stats.get(path) ?? null;
  fs.remove = async (path) => { fs.files.delete(path); };
  const host = {
    fs, stats, spawns: [], procs: [], fetches: [], killed: [], pidCounter: 4000,
    swapUsage: opts.swapUsage ?? 'total = 16384.00M  used = 1024.00M  free = 15360.00M  (encrypted)',
    vmStat: opts.vmStat ?? 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000000.\nPages inactive: 1000000.\n',
    readyAfterPolls: opts.readyAfterPolls ?? 1,
    polls: 0,
    spawnImpl: null,
    async spawn(spec) {
      host.spawns.push(spec);
      if (spec.cmd === '/usr/bin/vm_stat') return textProc(host.vmStat);
      if (spec.cmd === '/usr/sbin/sysctl') return textProc(host.swapUsage);
      if (spec.cmd === '/bin/ps') return textProc(opts.psOutput ?? '');
      if (spec.cmd === '/bin/kill') { host.killed.push(spec.args[0]); return textProc(''); }
      if (host.spawnImpl) return host.spawnImpl(spec);
      host.pidCounter += 1;
      const proc = fakeProc({ pid: host.pidCounter });
      host.procs.push(proc);
      return proc;
    },
    async fetch(url) {
      host.fetches.push(String(url));
      if (String(url).endsWith('/v1/models')) {
        host.polls += 1;
        if (host.polls >= host.readyAfterPolls) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      throw new TypeError('connection refused');
    },
  };
  return host;
}

function textProc(text) {
  return { pid: 1, exited: Promise.resolve(0), lines() { return { async *[Symbol.asyncIterator]() { for (const l of text.split('\n')) if (l) yield l; } }; }, write: async () => {}, stderrTail: () => '', kill: async () => {} };
}
