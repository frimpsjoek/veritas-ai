// @ts-check
// agent-src/src/openalex.js. OpenAlex refuses keyless requests past a shared free daily budget (HTTP 429, resets at
// midnight UTC). Every engine call to api.openalex.org goes through `openAlexFetch`, which adds the user's free key,
// turns a 429 into one plain sentence, and remembers the block so a run does not keep spending requests on a wall.

const HOST = 'api.openalex.org';

/** Next 00:00 UTC after `now`. @param {number} now */
const nextMidnightUtc = (now) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

/** @param {number} ms */
export const localTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export class OpenAlexLimit extends Error {
  /** @param {number} retryAfter seconds @param {number} resetsAt epoch ms */
  constructor(retryAfter, resetsAt) {
    super(`OpenAlex's free daily limit is used up (resets ${localTime(resetsAt)}). Add your free OpenAlex API key in Settings.`);
    this.name = 'OpenAlexLimit';
    this.retryAfter = retryAfter;
    this.resetsAt = resetsAt;
  }
}

/**
 * @param {typeof fetch} fetchFn
 * @param {() => Promise<string | null | undefined> | string | null | undefined} getKey read on every call, so a key saved in Settings applies at once
 * @param {{ now?: () => number }} [opts]
 * @returns {typeof fetch & { limitUntil(): number | null }}
 */
export function openAlexFetch(fetchFn, getKey, opts = {}) {
  const now = opts.now ?? Date.now;
  /** @type {{ until: number, keyed: boolean, error: OpenAlexLimit } | null} */
  let block = null;
  /** @type {any} */
  const wrapped = async (/** @type {any} */ input, /** @type {any} */ init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    let url;
    try { url = new URL(href); } catch { return fetchFn(input, init); }
    if (url.host !== HOST) return fetchFn(input, init);

    const key = (await getKey())?.trim() || null;
    // A saved key can lift a block that was hit keyless, so only a block hit with the same kind of request holds.
    if (block && now() >= block.until) block = null;
    if (block && block.keyed === Boolean(key)) throw block.error;
    block = null;
    if (key) url.searchParams.set('api_key', key);
    const response = await fetchFn(url.href, init);
    if (response.status !== 429) return response;

    const retry = Number(response.headers?.get?.('retry-after'));
    const resetsAt = Number.isFinite(retry) && retry > 0 ? now() + retry * 1000 : nextMidnightUtc(now());
    const error = new OpenAlexLimit(Math.max(0, Math.round((resetsAt - now()) / 1000)), resetsAt);
    block = { until: resetsAt, keyed: Boolean(key), error };
    throw error;
  };
  wrapped.limitUntil = () => (block && now() < block.until ? block.until : null);
  return wrapped;
}
