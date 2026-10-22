// @ts-check
// agent-src/src/local/server.js (spec 010 §3). Owns at most ONE `mlx_lm.server` child per sidecar: started on the first
// local turn, replaced (never doubled) when another model is asked for, stopped after the idle time and on exit.
// Everything host-specific comes through the Platform port and injected timers, so it is tested with a fake spawn.
import { availableBytes as readAvailable, memoryVerdict } from './memory.js';

const PORT_LOW = 8700;
const PORT_HIGH = 8799;
const PID_FILE = 'local-server.json';

/** @typedef {import("../settings").LocalSettings} LocalSettings */
/** @typedef {{ id: string, label: string, path: string, sizeBytes: number | null }} StartModel */

/** An error the turn reports in plain language. @param {string} message @param {import("../domain").AgentErrorKind} [kind] */
function plain(message, kind = 'model_unavailable') { return Object.assign(new Error(message), { kind }); }

/** @param {LocalSettings} local @param {string} home */
export function pythonFor(local, home) { return local.python ?? `${home}/woof-bench/.venv/bin/python`; }

/**
 * Is mlx-lm installed for this python? Looks for site-packages/mlx_lm next to the interpreter's venv; a python outside a
 * venv layout is trusted once it exists. @param {Pick<import("../platform").Platform["fs"], "list" | "stat">} fs @param {string} python
 * @returns {Promise<{ ok: true } | { ok: false, reason: "no_python" | "no_mlx_lm" }>}
 */
export async function checkMlx(fs, python) {
  if (!fs.stat) return { ok: true };
  if (!(await fs.stat(python))) return { ok: false, reason: 'no_python' };
  const root = python.replace(/\/bin\/[^/]+$/, '');
  if (root === python) return { ok: true };
  const libs = (await fs.list(`${root}/lib`)).filter((d) => /^python3/.test(d));
  if (!libs.length) return { ok: true };
  for (const lib of libs) if (await fs.stat(`${root}/lib/${lib}/site-packages/mlx_lm`)) return { ok: true };
  return { ok: false, reason: 'no_mlx_lm' };
}

/**
 * @param {{
 *   platform: Pick<import("../platform").Platform, "spawn" | "fetch" | "fs">,
 *   dataDir: string, home: string,
 *   settings: () => Promise<LocalSettings>,
 *   timers?: { setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void },
 *   pickPort?: () => Promise<number>,
 *   memory?: () => Promise<number | null>,
 *   pollMs?: number, startTimeoutMs?: number, reapWaitMs?: number,
 * }} deps
 */
export function createLocalServer(deps) {
  const timers = deps.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
  const sleep = (ms) => new Promise((resolve) => timers.setTimeout(() => resolve(undefined), ms));
  const pollMs = deps.pollMs ?? 500;
  const startTimeoutMs = deps.startTimeoutMs ?? 120_000;
  const memory = deps.memory ?? (() => readAvailable(deps.platform));
  const pidPath = `${deps.dataDir}/${PID_FILE}`;
  const fs = deps.platform.fs;

  /** @type {{ id: string, port: number, baseUrl: string, proc: import("../platform").ChildProcess } | null} */
  let current = null;
  /** @type {string | null} the model being started, for status */
  let loading = null;
  let busy = 0;
  let idleTimer = null;
  let chain = Promise.resolve();
  let disposed = false;

  /** Serializes start/stop so two turns can never race two spawns. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function defaultPickPort() {
    for (let i = 0; i < 25; i += 1) {
      const port = PORT_LOW + Math.floor(Math.random() * (PORT_HIGH - PORT_LOW + 1));
      const taken = await deps.platform.fetch(`http://127.0.0.1:${port}/v1/models`).then(() => true, () => false);
      if (!taken) return port;
    }
    throw plain('No free port was found to open the model on.', 'provider_crashed');
  }
  const pickPort = deps.pickPort ?? defaultPickPort;

  function clearIdle() { if (idleTimer !== null) { timers.clearTimeout(idleTimer); idleTimer = null; } }

  async function armIdle() {
    clearIdle();
    if (!current || busy > 0 || disposed) return;
    const minutes = (await deps.settings()).idleMinutes;
    if (!current || busy > 0) return; // something began while the setting was read
    idleTimer = timers.setTimeout(() => { idleTimer = null; if (busy === 0) void exclusive(async () => { if (busy === 0) await stopNow(); }); }, minutes * 60_000);
  }

  async function stopNow() {
    clearIdle();
    const running = current;
    current = null;
    if (!running) return;
    try { await running.proc.kill(); } catch { /* already gone */ }
    await Promise.race([running.proc.exited.catch(() => 0), sleep(5000)]);
    await fs.remove(pidPath).catch(() => {});
  }

  /** Kills a child a dead sidecar left behind, if its pid still belongs to an mlx_lm.server. */
  async function reapStale() {
    let record = null;
    try { const text = await fs.read(pidPath); record = text ? JSON.parse(text) : null; } catch { /* unreadable: treat as none */ }
    await fs.remove(pidPath).catch(() => {});
    const pid = Number(record?.pid);
    if (!Number.isInteger(pid) || pid <= 1) return;
    try {
      const ps = await deps.platform.spawn({ cmd: '/bin/ps', args: ['-p', String(pid), '-o', 'command='], env: {}, cwd: '/' });
      let command = '';
      for await (const line of ps.lines()) command += line;
      if (!command.includes('mlx_lm.server')) return;
      const kill = await deps.platform.spawn({ cmd: '/bin/kill', args: [String(pid)], env: {}, cwd: '/' });
      await kill.exited;
      // Its memory counts against "free" until it is really gone, and the next step checks free memory.
      const until = Date.now() + (deps.reapWaitMs ?? 3000);
      while (Date.now() < until) {
        const again = await deps.platform.spawn({ cmd: '/bin/ps', args: ['-p', String(pid), '-o', 'command='], env: {}, cwd: '/' });
        let still = '';
        for await (const line of again.lines()) still += line;
        if (!still.includes('mlx_lm.server')) break;
        await sleep(100);
      }
    } catch { /* best effort */ }
  }

  /** @param {StartModel} model @param {AbortSignal | undefined} signal */
  async function start(model, signal) {
    const local = await deps.settings();
    const python = pythonFor(local, deps.home);
    const installed = await checkMlx(fs, python);
    if (!installed.ok) throw plain(installed.reason === 'no_python' ? `The Python for local models wasn't found at ${python}.` : 'Local models need mlx-lm, which isn\'t installed.');
    await reapStale(); // before the memory check: a leftover server's own memory would make this one look too big
    const verdict = memoryVerdict({ label: model.label, modelBytes: model.sizeBytes, availableBytes: await memory() });
    if (!verdict.ok) throw Object.assign(plain(verdict.message), { tooBig: true });

    const port = await pickPort();
    const args = ['-m', 'mlx_lm.server', '--model', model.path, '--host', '127.0.0.1', '--port', String(port),
      '--temp', '0', '--max-tokens', '600', '--chat-template-args', '{"enable_thinking":false}', '--log-level', 'WARNING'];
    const proc = await deps.platform.spawn({ cmd: python, args, env: { PYTHONUNBUFFERED: '1' }, cwd: deps.home || '/' });
    // Nothing reads the server's stdout; drain it so a full pipe can never stall the child.
    void (async () => { try { for await (const _line of proc.lines()) { /* discard */ } } catch { /* closed */ } })();
    if (proc.pid) await fs.writeAtomic(pidPath, JSON.stringify({ pid: proc.pid, model: model.id, port, started: new Date().toISOString() })).catch(() => {});

    let exited = false;
    void proc.exited.then(() => { exited = true; if (current?.proc === proc) current = null; });
    const baseUrl = `http://127.0.0.1:${port}`;
    const give = async (error) => { try { await proc.kill(); } catch { /* gone */ } await fs.remove(pidPath).catch(() => {}); throw error; };
    let waited = 0;
    for (;;) {
      if (signal?.aborted) return give(plain('Interrupted.', 'cancelled'));
      if (exited) {
        const tail = proc.stderrTail().trim().split('\n').slice(-3).join(' ').trim();
        await fs.remove(pidPath).catch(() => {});
        throw plain(`The model stopped while opening${tail ? `: ${tail}` : '.'}`, 'provider_crashed');
      }
      const ok = await deps.platform.fetch(`${baseUrl}/v1/models`).then((r) => r.ok, () => false);
      if (ok) break;
      if (waited >= startTimeoutMs) return give(plain(`${model.label} didn't open within ${Math.round(startTimeoutMs / 1000)} seconds.`, 'timeout'));
      await sleep(pollMs);
      waited += pollMs;
    }
    current = { id: model.id, port, baseUrl, proc };
  }

  return {
    /**
     * Makes sure `model` is up and returns where to talk to it. Stops a different running model first.
     * @param {StartModel} model @param {AbortSignal} [signal]
     * @returns {Promise<{ baseUrl: string }>}
     */
    ensure(model, signal) {
      clearIdle();
      return exclusive(async () => {
        if (disposed) throw plain('The app is closing.', 'cancelled');
        if (current && current.id === model.id) return { baseUrl: `${current.baseUrl}/v1` };
        if (current) await stopNow();
        loading = model.id;
        try { await start(model, signal); } finally { loading = null; }
        return { baseUrl: `${/** @type {NonNullable<typeof current>} */ (current).baseUrl}/v1` };
      });
    },
    /** A turn is using the model: the idle timer must not fire until it ends. */
    begin() { busy += 1; clearIdle(); },
    end() { busy = Math.max(0, busy - 1); void armIdle(); },
    /** @returns {{ state: "stopped" | "loading" | "ready", id: string | null }} */
    state() {
      if (loading) return { state: 'loading', id: loading };
      return current ? { state: 'ready', id: current.id } : { state: 'stopped', id: null };
    },
    stop() { return exclusive(stopNow); },
    async dispose() {
      disposed = true;
      clearIdle();
      // kill() is started synchronously, so this works from a process 'exit' handler too.
      const running = current;
      current = null;
      if (running) { void running.proc.kill(); await Promise.race([running.proc.exited.catch(() => 0), sleep(3000)]); }
      await fs.remove(pidPath).catch(() => {});
    },
  };
}
