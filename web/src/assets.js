// @ts-check
// web/src/assets.js. Server files the page cannot attach a header to (Phase 3 Task 4). On the server's own origin the
// cookie goes along by itself, so plain paths work. From another origin only `Authorization: Bearer` signs in, so an
// <img> gets a blob URL from a fetch with the token, PDF.js gets the bytes, and a file opened in a tab or a frame
// gets a single-use ticket in its URL (POST /web/ticket); the long-lived token never goes into a URL.

/** @typedef {{ url(path: string): Promise<string>, bytes(path: string): Promise<ArrayBuffer>, frame(route: string, query: Record<string, string>): Promise<string>, revokeAll(): void, readonly sameOrigin: boolean }} Assets */

/** @param {Response} response */
async function failure(response) {
  let message = `HTTP ${response.status}`;
  try {
    const text = await response.text();
    message = text.trim() || message;
    try { message = String(JSON.parse(text).error ?? message); } catch { /* plain text */ }
  } catch { /* no body */ }
  return Object.assign(new Error(message), { status: response.status });
}

/**
 * @param {{ base: string, token?: string | null, fetch?: typeof fetch, URL?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> }} o
 *   `base`: the server's origin; `token`: set when that is not the page's own origin.
 * @returns {Assets}
 */
export function createAssets(o) {
  const base = o.base.replace(/\/+$/, '');
  const token = o.token ?? null;
  const doFetch = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const urls = o.URL ?? globalThis.URL;
  /** @type {Record<string, string>} */
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  /** Blob URLs handed out since the last revokeAll, by path. @type {Map<string, Promise<string>>} */
  let made = new Map();
  /** @type {Set<string>} */
  let live = new Set();

  /** @param {string} path */
  async function get(path) {
    const response = await doFetch(`${base}${path}`, { headers: auth });
    if (!response.ok) throw await failure(response);
    return response;
  }

  return {
    sameOrigin: !token,
    url(path) {
      if (!token || !path.startsWith('/')) return Promise.resolve(path);
      let found = made.get(path);
      if (!found) {
        const into = live;
        found = get(path).then((r) => r.blob()).then((blob) => {
          const url = urls.createObjectURL(blob);
          into.add(url);
          // closed while this was loading: the URL is not kept past its view
          if (into !== live) { urls.revokeObjectURL(url); into.delete(url); }
          return url;
        });
        const mine = made;
        found.catch(() => { mine.delete(path); });
        made.set(path, found);
      }
      return found;
    },
    async bytes(path) {
      return (await get(path)).arrayBuffer();
    },
    async frame(route, query) {
      const plain = `${base}${route}?${new URLSearchParams(query)}`;
      if (!token) return plain;
      const response = await doFetch(`${base}/web/ticket`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ route, query }),
      });
      if (!response.ok) throw await failure(response);
      const { ticket } = await response.json();
      return `${plain}&${new URLSearchParams({ ticket: String(ticket) })}`;
    },
    revokeAll() {
      for (const url of live) urls.revokeObjectURL(url);
      live = new Set();
      made = new Map();
    },
  };
}
