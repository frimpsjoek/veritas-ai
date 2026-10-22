#!/usr/bin/env node
// agent-src/src/node/agentd.mjs. The sidecar `kb.py serve` supervises (T3.2's `supervise`). It exposes the whole
// AgentService over HTTP: `ROUTES` below is the one table every request is dispatched from (service.d.ts is the
// contract; adding a method there means adding one row here, not a new branch). `/mcp` is separate: it is the
// JSON-RPC tool face the Codex/Claude processes this same runtime spawns call back into on 127.0.0.1, guarded by
// its own per-session bearer token from tools.js, not by the control-route secret below.
//
// Binds 127.0.0.1 only. Every control route (everything but /mcp) requires `Authorization: Bearer <secret>`,
// where the secret is handed to this process by the Python supervisor (SECOND_BRAIN_AGENTD_SECRET) so it never
// has to be discovered. Never touches the Python process's LOCK/WRITE_LOCK: this process doesn't know they exist.
import http from 'node:http';
import { URL } from 'node:url';
import { createNodePlatform } from './platform.mjs';
import { createHttpLibraryBackend, createHttpNoteSink, createHttpSkillSource } from '../library-http.js';
import { createToolGateway, createMcpHttpHandler } from '../tools.js';
import { createLocalRuntime } from '../core.js';
import { createProviders } from '../providers/index.js';
import { createSettingsStore } from '../settings.js';
import { errorMessage } from '../errors.js';

const LONG_POLL_MS = 25_000;

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, value) {
  const body = JSON.stringify(value ?? null);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

async function collectAsync(iterable, opts = {}) {
  const out = [];
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
  for await (const ev of iterable) {
    out.push(ev);
    if (opts.stopAfterFirstBatch && Date.now() >= deadline) break;
  }
  return out;
}

/** Long-poll for a step's events: waits up to `timeoutMs` for the first event (an empty batch on timeout, so the
 *  client just asks again), then takes whatever else arrives in the next moment, so live cells reach the UI at
 *  once instead of at the end of the wait. Stops at the iterator's end (the step's `end` event). Giving up is done
 *  by aborting the signal handed to `open`, never by abandoning a pending `next()`, which would lose its event.
 *  @param {(signal: AbortSignal) => AsyncIterable<any>} open @param {AbortSignal} outer */
async function pollBatch(open, timeoutMs, outer) {
  const ac = new AbortController();
  if (outer?.aborted) ac.abort();
  outer?.addEventListener('abort', () => ac.abort(), { once: true }); // a loopback caller (tests) passes no signal
  let timer = setTimeout(() => ac.abort(), timeoutMs);
  const out = [];
  try {
    for await (const ev of open(ac.signal)) {
      out.push(ev);
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort(), 120);
    }
  } finally { clearTimeout(timer); }
  return out;
}

/** One row per AgentService method actually reachable over HTTP in P3 (reviews/providers/mcp-servers are stubs
 *  in P1 and simply surface whatever the runtime returns, including its "not implemented" errors). */
export function routes() {
  return [
    // agent-host.js's serverRuntime() (Zotero) polls this every PING_EVERY_MS to decide whether the server's
    // runtime is reachable at all, before it ever calls anything else; Obsidian has no equivalent poll (its
    // agent-api.ts always routes through the server, with no local fallback to switch away from).
    { method: 'GET', path: '/ping', call: async () => ({ ok: true }) },
    { method: 'GET', path: '/conversations', call: (svc) => svc.conversations.list() },
    { method: 'GET', path: '/conversations/load', call: (svc, { id }) => svc.conversations.load(id) },
    { method: 'POST', path: '/conversations', call: (svc, { mode, project }) => svc.conversations.create(mode, project ? { project } : undefined) },
    { method: 'POST', path: '/conversations/rename', call: (svc, { id, title }) => svc.conversations.rename(id, title) },
    { method: 'POST', path: '/conversations/seen', call: async (svc, { id }) => { await svc.conversations.markSeen(id); return { ok: true }; } },
    { method: 'DELETE', path: '/conversations', call: (svc, { id }) => svc.conversations.remove(id) },
    { method: 'POST', path: '/conversations/cancel', call: async (svc, { id }) => { await svc.conversations.cancel(id); return { ok: true }; } },
    { method: 'GET', path: '/conversations/cursor', call: (svc, { id }) => svc.conversations.cursor(id) },
    { method: 'POST', path: '/conversations/adopt', call: (svc, { files }) => svc.conversations.adopt(files ?? []) },

    // /conversations/send starts (or continues) a turn and returns once it's done; the UI gets incremental
    // updates from /events, which replays the same event log this call writes to (eventlog.js).
    {
      method: 'POST',
      path: '/conversations/send',
      call: (svc, { id, text, attachments, web, scope, sources, on, skills }, ctx) => collectAsync(
        svc.conversations.send(id, { text, attachments, web, scope, sources, on, skills }, { signal: ctx.signal }),
      ),
    },
    // Long-poll resume: `after` replays buffered events, then waits for new ones until the turn ends or
    // LONG_POLL_MS elapses, per service.d.ts's `send(..., { after })` contract (core.js: an `after` request
    // skips straight to eventlog.subscribe without touching `text`).
    {
      method: 'GET',
      path: '/events',
      // pollBatch, not collectAsync: this must answer as soon as the first event arrives (plus a moment for its
      // neighbours). collectAsync only stopped when an event arrived AFTER the deadline, so every chat's steps and
      // text reached Obsidian in ~25 s lumps (found 2026-09-29 with a real turn timed over HTTP).
      call: (svc, { id, after }, ctx) => pollBatch(
        (signal) => svc.conversations.send(id, { text: '' }, { after: Number(after ?? 0), signal }), LONG_POLL_MS, ctx.signal,
      ),
    },

    { method: 'POST', path: '/ask', call: (svc, { question, web, scope, sources }, ctx) => collectAsync(svc.ask(question, { web, scope, sources, signal: ctx.signal })) },

    { method: 'GET', path: '/reviews', call: (svc) => svc.reviews.list() },
    { method: 'POST', path: '/reviews/estimate', call: (svc, body) => svc.reviews.estimate(body) },
    { method: 'POST', path: '/reviews', call: (svc, body) => svc.reviews.start(body) },
    // Long-poll, same shape and the same `after` resume contract as /events above, just over reviews.watch.
    {
      method: 'GET',
      path: '/reviews/events',
      call: (svc, { id, after }, ctx) => pollBatch(
        (signal) => svc.reviews.watch(id, { after: Number(after ?? 0), signal }), LONG_POLL_MS, ctx.signal,
      ),
    },
    { method: 'POST', path: '/reviews/approve', call: (svc, { id, plan }) => svc.reviews.approvePlan(id, plan) },
    { method: 'POST', path: '/reviews/answer', call: (svc, { id, answers }) => svc.reviews.answer(id, answers) },
    { method: 'POST', path: '/reviews/screened', call: (svc, { id, overrides }) => svc.reviews.screened(id, overrides ?? []) },
    { method: 'POST', path: '/reviews/resume', call: (svc, { id }) => svc.reviews.resume(id) },
    { method: 'POST', path: '/reviews/cancel', call: (svc, { id }) => svc.reviews.cancel(id) },
    { method: 'POST', path: '/reviews/export', call: (svc, { id, format }) => svc.reviews.export(id, format) },

    { method: 'GET', path: '/providers', call: (svc) => svc.providers.status() },
    { method: 'GET', path: '/providers/models', call: (svc, { provider }) => svc.providers.models(provider) },
    { method: 'GET', path: '/providers/roles', call: (svc) => svc.providers.roles() },
    { method: 'POST', path: '/providers/roles', call: (svc, { role, choice }) => svc.providers.setRole(role, choice) },
    { method: 'POST', path: '/providers/sign-in', call: (svc, { provider, signInMethod }) => svc.providers.signIn(provider, signInMethod) },
    { method: 'POST', path: '/providers/sign-out', call: (svc, { provider }) => svc.providers.signOut(provider) },

    // spec 007 E1: sessions have no streaming events of their own yet (columns/screen's live `sessions.run` is
    // E4); view/read/put/restore/current are plain request/response, like the routes above them.
    { method: 'GET', path: '/sessions/view', call: (svc, { id }) => svc.sessions.view(id) },
    { method: 'GET', path: '/sessions/read', call: (svc, { id, result, version }) => svc.sessions.read(id, { id: result, version: version != null ? Number(version) : undefined }) },
    { method: 'POST', path: '/sessions/put', call: (svc, { id, input, draft }) => svc.sessions.put(id, input, draft) },
    { method: 'POST', path: '/sessions/restore', call: (svc, { id, ref }) => svc.sessions.restore(id, ref) },
    { method: 'POST', path: '/sessions/current', call: (svc, { id, ref }) => svc.sessions.setCurrent(id, ref) },
    // spec 007 E4: a columns step. `run` returns once the step record is written; `events` is a long-poll like
    // /events (a batch of `{ seq, ...StepEvent }` per call, resumed with `after`), ending its batch at the `end` event.
    { method: 'POST', path: '/sessions/run', call: (svc, { id, input }) => svc.sessions.run(id, input) },
    { method: 'POST', path: '/sessions/estimate', call: (svc, { id, input }) => svc.sessions.estimate(id, input) },
    { method: 'POST', path: '/sessions/cancel', call: (svc, { id, step }) => svc.sessions.cancel(id, step) },
    {
      method: 'GET',
      path: '/sessions/events',
      call: async (svc, { id, step, after }, ctx) => (await pollBatch(
        (signal) => svc.sessions.events(id, step, Number(after ?? 0), signal), LONG_POLL_MS, ctx.signal,
      )).map(({ seq, data }) => ({ ...data, seq })),
    },

    { method: 'GET', path: '/skills', call: (svc) => svc.skills.list() },
    { method: 'GET', path: '/skills/get', call: (svc, { name }) => svc.skills.get(name) },
    { method: 'POST', path: '/skills/put', call: (svc, { name, text }) => svc.skills.put(name, text) },
    { method: 'DELETE', path: '/skills', call: (svc, { name }) => svc.skills.remove(name) },
    { method: 'POST', path: '/skills/draft', call: (svc, { description }) => svc.skills.draft(description) },

    { method: 'GET', path: '/routines', call: (svc) => svc.routines.list() },
    { method: 'POST', path: '/routines', call: (svc, body) => svc.routines.create(body) },
    { method: 'POST', path: '/routines/update', call: (svc, { id, patch }) => svc.routines.update(id, patch ?? {}) },
    { method: 'POST', path: '/routines/run', call: (svc, { id }) => svc.routines.runNow(id) },
    { method: 'POST', path: '/routines/pause', call: (svc, { id }) => svc.routines.pause(id) },
    { method: 'POST', path: '/routines/resume', call: (svc, { id }) => svc.routines.resume(id) },
    { method: 'POST', path: '/routines/archive', call: (svc, { id }) => svc.routines.archive(id) },
    { method: 'POST', path: '/routines/adopt', call: (svc, { records }) => svc.routines.adopt(records ?? []) },

    { method: 'GET', path: '/projects', call: (svc) => svc.projects.list() },
    { method: 'POST', path: '/projects', call: (svc, { name }) => svc.projects.create(name) },
    { method: 'POST', path: '/projects/rename', call: (svc, { id, name }) => svc.projects.rename(id, name) },
    { method: 'DELETE', path: '/projects', call: async (svc, { id }) => { await svc.projects.remove(id); return { ok: true }; } },
    { method: 'POST', path: '/projects/assign', call: async (svc, { kind, id, project }) => { await svc.projects.assign({ kind, id }, project ?? null); return { ok: true }; } },
    { method: 'POST', path: '/projects/adopt', call: (svc, { records }) => svc.projects.adopt(records ?? []) },

    { method: 'POST', path: '/radar/profile', call: (svc, { scope }) => svc.radar.profile(scope) },
    { method: 'POST', path: '/radar/check', call: (svc, { input }) => svc.radar.checkSource(input) },
    { method: 'POST', path: '/radar/my-papers', call: (svc, input) => svc.radar.myPapers(input) },
    { method: 'POST', path: '/radar/prepare-seeds', call: (svc, { seeds }) => svc.radar.prepareSeeds(seeds) },
    { method: 'POST', path: '/radar/forget', call: (svc, { routineId, text }) => svc.radar.forgetTopic(routineId, text) },
    { method: 'POST', path: '/radar/verdicts', call: (svc, { routineId }) => svc.radar.verdicts(routineId) },
    { method: 'POST', path: '/radar/feedback', call: (svc, { routineId, paperKey, verdict }) => svc.radar.feedback(routineId, paperKey, verdict) },
    { method: 'POST', path: '/scholarly/search', call: (svc, { query, perSource }) => svc.scholarly.search(query, perSource) },
    { method: 'GET', path: '/mcp-servers', call: (svc) => svc.mcp.list() },
    { method: 'POST', path: '/mcp-servers', call: (svc, body) => svc.mcp.save(body) },
    { method: 'DELETE', path: '/mcp-servers', call: (svc, { name }) => svc.mcp.remove(name) },

    { method: 'GET', path: '/settings', call: (svc) => svc.settings.get() },
    { method: 'POST', path: '/settings', call: (svc, body) => svc.settings.update(body) },
  ];
}

/**
 * @param {import("../service").AgentService} service
 * @param {{ secret: string, mcpHandler: (req: { headers: Record<string,string>, body: string }) => Promise<{status:number, body:string}> }} opts
 */
export function createAgentd(service, opts) {
  const table = routes();

  function authorized(req) {
    const auth = req.headers.authorization ?? '';
    return auth === `Bearer ${opts.secret}`;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const query = Object.fromEntries(url.searchParams);
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : v ?? '';

    if (url.pathname === '/mcp') {
      const body = await readBody(req);
      const out = await opts.mcpHandler({ headers, body });
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(out.body);
      return;
    }

    if (!authorized(req)) { json(res, 401, { error: 'unauthorized' }); return; }

    const row = table.find((r) => r.method === req.method && r.path === url.pathname);
    if (!row) { json(res, 404, { error: 'not found' }); return; }

    const bodyText = await readBody(req);
    const bodyArgs = bodyText ? tryParse(bodyText) ?? {} : {};
    const args = { ...query, ...bodyArgs };
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      const result = await row.call(service, args, { signal: controller.signal });
      json(res, 200, result === undefined ? null : result);
    } catch (error) {
      json(res, 500, { error: errorMessage(error) });
    }
  });

  return {
    server,
    routes: table,
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const address = server.address(); // an AddressInfo after a TCP listen; a string only for pipes
          resolve(address && typeof address !== 'string' ? address.port : port);
        });
      });
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };

  const dataDir = flag('data', `${process.env.HOME}/obsidian-kb/data/agent`);
  const kbBaseUrl = flag('kb', 'http://127.0.0.1:27182');
  const requestedPort = Number(flag('port', '0'));
  const secret = process.env.SECOND_BRAIN_AGENTD_SECRET;
  if (!secret) { console.error('SECOND_BRAIN_AGENTD_SECRET is required (set by the Python supervisor)'); process.exit(1); }

  const platform = createNodePlatform({ homeDir: process.env.HOME ?? '' });
  const library = createHttpLibraryBackend(platform.fetch, { baseUrl: kbBaseUrl, token: process.env.SECOND_BRAIN_KB_TOKEN ?? null });
  // T6.2: the one persisted settings.json under `dataDir` (settings.js) is what createLocalRuntime's own
  // internal store reads and writes from here on; this one read just seeds the gateway's McpHub with whatever
  // servers were already saved, so they're connected on this very startup, not just the next one.
  const saved = await createSettingsStore(platform.fs, dataDir).get();
  const gatewaySettings = { scholarly: ['openalex', 'arxiv', 'crossref', 'europepmc'], mcpUrl: /** @type {string | undefined} */ (undefined), spawn: platform.spawn, mcp: saved.mcp };
  const gateway = await createToolGateway(platform.fetch, library, gatewaySettings);
  const providers = createProviders(platform, { dataDir, home: process.env.HOME ?? '', codex: { binaryPath: process.env.CODEX_BINARY ?? null } });
  const notes = createHttpNoteSink(platform.fetch, { baseUrl: kbBaseUrl });
  // No getRoleModel override: it now defaults (core.js) to the same settings.json, read live on every turn, so
  // providers.setRole takes effect on the very next message with no restart (criterion 10).
  const skills = createHttpSkillSource(platform.fetch, { baseUrl: kbBaseUrl });
  const service = await createLocalRuntime({ platform, library, notes, skills, dataDir, providers, gateway });

  const agentd = createAgentd(service, { secret, mcpHandler: createMcpHttpHandler(gateway) });
  gatewaySettings.mcpUrl = `http://127.0.0.1:${await agentd.listen(requestedPort)}/mcp`;
  const port = new URL(gatewaySettings.mcpUrl).port;

  const status = { port: Number(port), pid: process.pid };
  console.log(JSON.stringify(status)); // supervise() reads this as its first stdout line
  await platform.fs.writeAtomic(`${dataDir}/agentd.json`, JSON.stringify(status, null, 2));

  const stop = async () => { await agentd.close(); await service.dispose(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // A server killed with -9 (or by macOS when memory runs out) can't stop its sidecar, and the orphan would keep
  // ticking routines next to the replacement server's own sidecar. Leave once the parent that started us is gone.
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) void stop(); }, 5000).unref();
  // spec 010: whatever way the sidecar ends, a model it started on this Mac must not outlive it. dispose() sends the kill
  // synchronously, so it still lands from an 'exit' handler (a hard kill -9 is covered by the pid file, reaped on the next start).
  process.on('exit', () => { void providers.get('local')?.dispose(); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
