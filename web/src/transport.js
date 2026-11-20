// @ts-check
// ui-src/src/web/transport.js. The browser's side of agent-src/src/remote.js: `request` is a fetch to the server's
// /agent forward, `stream` repeats GET /agent/events?after= (the sidecar holds each call open for up to 25 s), the
// same shape obsidian-plugin/src/agent-api.ts gives Obsidian.

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;
const RESTART_WAIT_MS = 8000; // 1 + 2 + 4 + 8 s of retries
/** A plain server call with no answer by then fails, so a view shows its error instead of "Loading…" for ever (a server
 *  that hangs, a connection the network dropped without saying). Generous: the whole library is a 4 MB reply, and the
 *  server's own outside fetches give up sooner. The agent forward has none: an answer or a held poll takes longer. */
export const CALL_TIMEOUT_MS = 60_000;

/** @param {Response} response */
async function failure(response) {
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body?.error) message = String(body.error);
  } catch { /* not JSON; the status says enough */ }
  return Object.assign(new Error(message), { status: response.status });
}

/** `token`: a server on another origin (the app hosted elsewhere) gets `Authorization: Bearer`; the server's own /app/
 *  passes none and signs in with its cookie. `timeoutMs`: each call's limit unless it names its own (0: none).
 *  @param {string} base @param {{ fetch?: typeof fetch, token?: string | null, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>, onReachable?: (up: boolean) => void, onUnauthorized?: () => void, timeoutMs?: number }} [env] */
export function createFetchApi(base, env = {}) {
  const doFetch = env.fetch ?? ((input, init) => globalThis.fetch(input, init));
  /** @type {Record<string, string>} */
  const auth = env.token ? { Authorization: `Bearer ${env.token}` } : {};
  /** @template T @param {string} path @param {"GET"|"POST"|"DELETE"|"PUT"|"PATCH"} [method] @param {unknown} [body] @param {AbortSignal} [signal]
   *  @param {number} [timeoutMs] @returns {Promise<T>} */
  async function call(path, method = 'GET', body, signal, timeoutMs = env.timeoutMs ?? CALL_TIMEOUT_MS) {
    // the caller's signal and the timeout abort one fetch; which of them fired decides the error
    const limit = timeoutMs > 0 ? new AbortController() : null;
    const follow = () => limit?.abort();
    if (signal?.aborted) follow(); else signal?.addEventListener?.('abort', follow, { once: true });
    const timer = limit ? setTimeout(() => limit.abort(), timeoutMs) : null;
    const used = limit?.signal ?? signal;
    const timedOut = () => Boolean(limit?.signal.aborted) && !signal?.aborted;
    const tooLong = () => Object.assign(new Error(`The server took more than ${Math.round(timeoutMs / 1000)} s to answer`), { timeout: true });
    try {
      let response;
      try {
        response = await doFetch(`${base}${path}`, {
          method,
          ...(body !== undefined ? { headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : env.token ? { headers: auth } : {}),
          ...(used ? { signal: used } : {}),
        });
      } catch (error) {
        if (!signal?.aborted) env.onReachable?.(false);
        throw timedOut() ? tooLong() : error;
      }
      env.onReachable?.(true);
      if (response.status === 401) env.onUnauthorized?.();
      if (!response.ok) throw await failure(response);
      let text;
      try { text = await response.text(); } catch (error) { throw timedOut() ? tooLong() : error; } // the body can stall too
      return /** @type {T} */ (text ? JSON.parse(text) : null);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', follow);
    }
  }
  return { call };
}

/** @param {ReturnType<typeof createFetchApi>} api @param {{ sleep?: (ms: number) => Promise<void> }} [env] */
export function createWebTransport(api, env = {}) {
  const sleep = env.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return {
    /** @param {"GET"|"POST"|"DELETE"} method @param {string} path @param {unknown} [body] */
    async request(method, path, body) {
      // 503 is the server's own answer while the sidecar restarts (an update, a crash): the call never reached it, so
      // sending it again is safe. A turn sent in that moment waits about 15 s instead of failing.
      for (let wait = MIN_BACKOFF_MS; ; wait *= 2) {
        try {
          return await api.call(`/agent${path}`, method, body, undefined, 0);
        } catch (error) {
          if (/** @type {any} */ (error)?.status !== 503 || wait > RESTART_WAIT_MS) throw error;
          await sleep(wait);
        }
      }
    },

    /** @param {string} path @param {number} after @param {AbortSignal} [signal] */
    async *stream(path, after, signal) {
      let cursor = after;
      let backoff = 0;
      while (!signal?.aborted) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener?.('abort', abort, { once: true });
        /** @type {{ seq: number }[]} */
        let batch;
        try {
          batch = await api.call(`/agent${path}${path.includes('?') ? '&' : '?'}after=${cursor}`, 'GET', undefined, controller.signal, 0);
          backoff = 0;
        } catch {
          if (signal?.aborted) return;
          backoff = Math.min(backoff ? backoff * 2 : MIN_BACKOFF_MS, MAX_BACKOFF_MS); // a sidecar restart or a dropped connection
          await sleep(backoff);
          continue;
        } finally {
          signal?.removeEventListener?.('abort', abort);
        }
        for (const event of batch ?? []) {
          cursor = event.seq;
          yield { seq: event.seq, data: event };
        }
      }
    },
  };
}
