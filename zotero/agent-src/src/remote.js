// @ts-check
// agent-src/src/remote.js. An AgentService that is an HTTP client of the sidecar (agentd.mjs, T3.1), reached
// either directly (Zotero when the server runs) or through the Python server's /agent/* forward (Obsidian
// always; Zotero when the server runs). `transport` is the only host-specific piece: Obsidian gives it
// `requestUrl` for `request` and a long-poll loop for `stream`; Zotero gives it `Zotero.HTTP`. This file knows
// nothing about either — it only knows the sidecar's route shapes (the same ones agentd.mjs's ROUTES table
// serves), which is what keeps it host-agnostic and testable with an in-memory transport.
//
// `transport.stream(path, after, signal)` is a raw, protocol-agnostic event feed: it keeps yielding
// `{ seq, data }` pairs for as long as the caller keeps asking (an SSE reader on desktop, a repeating long-poll
// on the phone), with no idea what "the turn is over" means. Recognizing a `done`/`failed` event and stopping
// is domain knowledge, so it lives here, not in the transport: this file's `for await` loops just `break`,
// which is the async-iterator protocol's own way of telling the generator to stop (its `return()` runs).

/** @param {Record<string, string | number | null | undefined>} params */
function qs(params) {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '');
  return entries.length ? `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}` : '';
}

/** A signal that reads as aborted when `outer` is, or once `stop.aborted` is set. A plain object, not an AbortController:
 *  Zotero's chrome scope has none. @param {AbortSignal | undefined} outer @param {{ aborted: boolean }} stop @returns {AbortSignal} */
function chain(outer, stop) {
  return /** @type {any} */ ({
    get aborted() { return stop.aborted || Boolean(outer?.aborted); },
    addEventListener: (/** @type {any[]} */ ...args) => /** @type {any} */ (outer)?.addEventListener(...args),
    removeEventListener: (/** @type {any[]} */ ...args) => /** @type {any} */ (outer)?.removeEventListener(...args),
  });
}

const TERMINAL = new Set(['done', 'failed']);
const REVIEW_TERMINAL = new Set(['done', 'stopped', 'awaiting_approval', 'awaiting_answer', 'awaiting_review']);

/** @param {{ request(method: "GET"|"POST"|"DELETE", path: string, body?: unknown): Promise<unknown>,
 *            stream(path: string, after: number, signal?: AbortSignal): AsyncIterable<{ seq: number, data: unknown }> }} transport
 * @returns {import("./service").AgentService} */
export function createRemoteRuntime(transport) {
  /** @param {string} path @param {number} after @param {AbortSignal} [signal] */
  async function* streamEvents(path, after, signal) {
    for await (const { seq, data } of transport.stream(path, after, signal)) {
      const event = { .../** @type {any} */ (data), seq };
      yield event;
      if (TERMINAL.has(event.type)) return; // the turn (or one-shot ask) is over; stop polling/reading
    }
  }

  return {
    where: 'server',

    conversations: {
      list: () => /** @type {any} */ (transport.request('GET', '/conversations')),
      load: (id) => /** @type {any} */ (transport.request('GET', `/conversations/load${qs({ id })}`)),
      async create(mode, opts) {
        const result = /** @type {{ id: string }} */ (await transport.request('POST', '/conversations', { mode, ...(opts?.project ? { project: opts.project } : {}) }));
        return /** @type {any} */ (result?.id ?? result);
      },
      async rename(id, title) { await transport.request('POST', '/conversations/rename', { id, title }); },
      async markSeen(id) { await transport.request('POST', '/conversations/seen', { id }); },
      async remove(id) { await transport.request('DELETE', '/conversations', { id }); },
      async cancel(id) { await transport.request('POST', '/conversations/cancel', { id }); },
      cursor: (id) => /** @type {any} */ (transport.request('GET', `/conversations/cursor${qs({ id })}`)),
      adopt: (files) => /** @type {any} */ (transport.request('POST', '/conversations/adopt', { files })),

      async *send(id, input, opts = {}) {
        let after = opts.after ?? 0;
        const stopped = { refused: /** @type {{ error: unknown, busy?: boolean } | null} */ (null) };
        const stop = { aborted: false };
        const signal = chain(opts.signal, stop);
        if (opts.after == null) {
          // Stop: the stream only reads events; the turn runs inside the request that started it, which a client cannot
          // close (a timeout, or never). So Stop asks the server to cancel it.
          opts.signal?.addEventListener('abort', () => { transport.request('POST', '/conversations/cancel', { id }).catch(() => {}); }, { once: true });
          // The server keeps a finished turn's events for a few minutes, so reading /events from 0 would replay the
          // last turn (its failure, its answer) under this question. Read from where the log stands now instead. An
          // older server without the route keeps the old behaviour (from 0).
          const here = /** @type {{ seq: number, inFlight: boolean } | null} */ (
            await transport.request('GET', `/conversations/cursor${qs({ id })}`).catch(() => null));
          if (here?.inFlight) {
            yield { type: 'failed', seq: here.seq + 1, error: { kind: 'busy', message: 'An answer is still coming in this chat. Wait for it to finish, or press Stop.' } };
            return;
          }
          after = here?.seq ?? 0;
          // Fire the turn but don't wait on its (blocking, full-array) response: the client learns about the
          // same events, as they happen, from /events below, which is also its reconnect path.
          transport.request('POST', '/conversations/send', {
            id, text: input.text, attachments: input.attachments, web: input.web, scope: input.scope, sources: input.sources, on: input.on, skills: input.skills,
          }).catch(async (error) => {
            // A turn that was never started (the server said no) would leave /events waiting for ever. A request that
            // merely timed out while the turn runs on is not that: the log has moved or a turn is in flight.
            const now = /** @type {{ seq: number, inFlight: boolean } | null} */ (
              await transport.request('GET', `/conversations/cursor${qs({ id })}`).catch(() => null));
            const busy = /already running/.test(String(/** @type {any} */ (error)?.message ?? ''));
            if (busy) { stopped.refused = { error: new Error('An answer is still coming in this chat. Wait for it to finish, or press Stop.'), busy: true }; stop.aborted = true; return; }
            if (now && !now.inFlight && now.seq === after) { stopped.refused = { error }; stop.aborted = true; }
          });
        }
        yield* streamEvents(`/events${qs({ id })}`, after, signal);
        const refused = stopped.refused;
        if (refused && !opts.signal?.aborted) {
          yield { type: 'failed', seq: after + 1, error: { kind: refused.busy ? 'busy' : 'provider_crashed', message: String(/** @type {any} */ (refused.error)?.message ?? refused.error) } };
        }
      },
    },

    async *ask(question, opts = {}) {
      const result = /** @type {any[]} */ (await transport.request('POST', '/ask', { question, web: opts.web, scope: opts.scope, sources: opts.sources }));
      for (const event of result) {
        yield event;
        if (opts.signal?.aborted) return;
      }
    },

    reviews: {
      estimate: (req) => /** @type {any} */ (transport.request('POST', '/reviews/estimate', req)),
      start: async (req) => /** @type {any} */ ((await transport.request('POST', '/reviews', req))),
      /** Not streamEvents: a ReviewProgress has no `type`, so "terminal" is a status.state check, not the
       *  done/failed AgentEvent check every other stream in this file uses. */
      async *watch(id, opts = {}) {
        for await (const { seq, data } of transport.stream(`/reviews/events${qs({ id })}`, opts.after ?? 0, opts.signal)) {
          const progress = { .../** @type {any} */ (data), seq };
          yield progress;
          if (REVIEW_TERMINAL.has(progress.status?.state)) return;
        }
      },
      approvePlan: async (id, plan) => { await transport.request('POST', '/reviews/approve', { id, plan }); },
      answer: async (id, answers) => { await transport.request('POST', '/reviews/answer', { id, answers }); },
      screened: async (id, overrides) => { await transport.request('POST', '/reviews/screened', { id, overrides }); },
      resume: async (id) => { await transport.request('POST', '/reviews/resume', { id }); },
      cancel: async (id) => { await transport.request('POST', '/reviews/cancel', { id }); },
      list: () => /** @type {any} */ (transport.request('GET', '/reviews')),
      export: (id, format) => /** @type {any} */ (transport.request('POST', '/reviews/export', { id, format })),
    },

    sessions: {
      view: (id) => /** @type {any} */ (transport.request('GET', `/sessions/view${qs({ id })}`)),
      read: (id, ref) => /** @type {any} */ (transport.request('GET', `/sessions/read${qs({ id, result: ref.id, version: ref.version })}`)),
      put: (id, input, draft) => /** @type {any} */ (transport.request('POST', '/sessions/put', { id, input, draft })),
      restore: (id, ref) => /** @type {any} */ (transport.request('POST', '/sessions/restore', { id, ref })),
      setCurrent: async (id, ref) => { await transport.request('POST', '/sessions/current', { id, ref }); },
      run: (id, input) => /** @type {any} */ (transport.request('POST', '/sessions/run', { id, input })),
      estimate: (id, input) => /** @type {any} */ (transport.request('POST', '/sessions/estimate', { id, input })),
      cancel: async (id, step) => { await transport.request('POST', '/sessions/cancel', { id, step }); },
      /** Follows a step from `after` until its `end` event (the transport feed itself never ends). */
      async *events(id, step, after, signal) {
        for await (const { seq, data } of transport.stream(`/sessions/events${qs({ id, step })}`, after, signal)) {
          const { seq: _seq, ...event } = /** @type {any} */ (data);
          yield { seq, data: event };
          if (event.type === 'end') return;
        }
      },
    },

    providers: {
      status: () => /** @type {any} */ (transport.request('GET', '/providers')),
      models: (provider) => /** @type {any} */ (transport.request('GET', `/providers/models${qs({ provider })}`)),
      async signIn(provider, method) {
        const result = /** @type {any} */ (await transport.request('POST', '/providers/sign-in', { provider, signInMethod: method }));
        return { ...result, done: Promise.resolve(result?.status) };
      },
      signOut: async (provider) => { await transport.request('POST', '/providers/sign-out', { provider }); },
      roles: () => /** @type {any} */ (transport.request('GET', '/providers/roles')),
      setRole: async (role, choice) => { await transport.request('POST', '/providers/roles', { role, choice }); },
    },

    skills: {
      list: () => /** @type {any} */ (transport.request('GET', '/skills')),
      get: (name) => /** @type {any} */ (transport.request('GET', `/skills/get${qs({ name })}`)),
      put: (name, text) => /** @type {any} */ (transport.request('POST', '/skills/put', { name, text })),
      remove: async (name) => { await transport.request('DELETE', '/skills', { name }); },
      draft: (description) => /** @type {any} */ (transport.request('POST', '/skills/draft', { description })),
    },

    projects: {
      list: () => /** @type {any} */ (transport.request('GET', '/projects')),
      create: (name) => /** @type {any} */ (transport.request('POST', '/projects', { name })),
      rename: (id, name) => /** @type {any} */ (transport.request('POST', '/projects/rename', { id, name })),
      async remove(id) { await transport.request('DELETE', '/projects', { id }); },
      async assign(target, project) { await transport.request('POST', '/projects/assign', { kind: target.kind, id: target.id, project: project ?? null }); },
      adopt: (records) => /** @type {any} */ (transport.request('POST', '/projects/adopt', { records })),
    },

    routines: {
      list: () => /** @type {any} */ (transport.request('GET', '/routines')),
      create: (draft) => /** @type {any} */ (transport.request('POST', '/routines', draft)),
      update: (id, patch) => /** @type {any} */ (transport.request('POST', '/routines/update', { id, patch })),
      runNow: (id) => /** @type {any} */ (transport.request('POST', '/routines/run', { id })),
      pause: (id) => /** @type {any} */ (transport.request('POST', '/routines/pause', { id })),
      resume: (id) => /** @type {any} */ (transport.request('POST', '/routines/resume', { id })),
      archive: (id) => /** @type {any} */ (transport.request('POST', '/routines/archive', { id })),
      adopt: (records) => /** @type {any} */ (transport.request('POST', '/routines/adopt', { records })),
    },

    radar: {
      profile: (scope) => /** @type {any} */ (transport.request('POST', '/radar/profile', { scope })),
      checkSource: (input) => /** @type {any} */ (transport.request('POST', '/radar/check', { input })),
      myPapers: (input) => /** @type {any} */ (transport.request('POST', '/radar/my-papers', input)),
      prepareSeeds: (seeds) => /** @type {any} */ (transport.request('POST', '/radar/prepare-seeds', { seeds })),
      forgetTopic: (routineId, text) => /** @type {any} */ (transport.request('POST', '/radar/forget', { routineId, text })),
      verdicts: (routineId) => /** @type {any} */ (transport.request('POST', '/radar/verdicts', { routineId })),
      feedback: (routineId, paperKey, verdict) => /** @type {any} */ (transport.request('POST', '/radar/feedback', { routineId, paperKey, verdict })),
    },

    scholarly: {
      search: (query, perSource) => /** @type {any} */ (transport.request('POST', '/scholarly/search', { query, perSource })),
    },

    mcp: {
      list: () => /** @type {any} */ (transport.request('GET', '/mcp-servers')),
      save: (config) => /** @type {any} */ (transport.request('POST', '/mcp-servers', config)),
      remove: async (name) => { await transport.request('DELETE', '/mcp-servers', { name }); },
    },

    settings: {
      get: () => /** @type {any} */ (transport.request('GET', '/settings')),
      update: (patch) => /** @type {any} */ (transport.request('POST', '/settings', patch)),
    },
  };
}
