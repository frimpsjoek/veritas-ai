// @ts-check
// ALCF Inference Gateway: fixed OpenAI-compatible clusters and one canonical discovery endpoint.
// User credentials are supplied per runtime, evaluated per request, and never included in catalog/status state.
import { openaiProvider } from './openai.js';
import { readBoundedText } from '../http-bounded.js';

export const ALCF_DISCOVERY_URL = 'https://inference-api.alcf.anl.gov/resource_server/list-endpoints';
export const ALCF_ENDPOINTS = Object.freeze({
  'oss:alcf-sophia': 'https://inference-api.alcf.anl.gov/resource_server/sophia/vllm/v1',
  'oss:alcf-metis': 'https://inference-api.alcf.anl.gov/resource_server/metis/api/v1',
  'oss:alcf-minerva': 'https://inference-api.alcf.anl.gov/resource_server/minerva/api/v1',
  'oss:alcf-tara': 'https://inference-api.alcf.anl.gov/resource_server/tara/api/v1',
});
const DISCOVERY_MAX_BYTES = 2 * 1024 * 1024;
const DISCOVERY_CACHE_MS = 60_000;

/** Reject every destination except the exact approved ALCF HTTPS URLs. */
export function assertAlcfUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid ALCF URL'); }
  const normalized = url.href.replace(/\/$/, '');
  if (url.protocol !== 'https:' || url.hostname !== 'inference-api.alcf.anl.gov' || url.host !== url.hostname
      || url.username || url.password || url.search || url.hash
      || ![ALCF_DISCOVERY_URL, ...Object.values(ALCF_ENDPOINTS)].includes(normalized)) {
    throw new Error('not an approved ALCF URL');
  }
  return raw;
}

/** The models for exactly the cluster/framework selected by an approved base URL, or null if shape is unknown. */
export function modelsFromCatalog(body, rawBaseUrl) {
  const baseUrl = assertAlcfUrl(rawBaseUrl).replace(/\/$/, '');
  const segments = new URL(baseUrl).pathname.split('/').filter(Boolean);
  const clusters = body && !Array.isArray(body.clusters) ? body.clusters : null;
  const spec = typeof clusters?.[segments[1]]?.frameworks?.[segments[2]] === 'object'
    ? clusters[segments[1]].frameworks[segments[2]] : null;
  if (!spec || Array.isArray(spec) || !Array.isArray(spec.models)) return null;
  const models = [];
  for (const value of spec.models) {
    if (typeof value === 'string' && value.trim() && !models.includes(value.trim())) models.push(value.trim());
  }
  return models;
}

function discoveryError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Share one catalog operation at a time. A forced refresh never joins ordinary work: it waits for that operation,
 * then re-enters so simultaneous forced callers coalesce on the refresh. Promise identity guards the cleanup.
 * @param {(force?: boolean) => Promise<any>} fetchOne
 * @param {{ clock?: () => number }} [opts]
 * @returns {(force?: boolean) => Promise<any>}
 */
export function createCatalogLoader(fetchOne, opts = {}) {
  const clock = opts.clock ?? Date.now;
  let cache = { at: 0, value: null };
  /** @type {Promise<any> | null} */
  let pending = null;
  let pendingForced = false;

  return async function catalog(force = false) {
    if (!force && cache.value !== null && clock() - cache.at < DISCOVERY_CACHE_MS) return cache.value;
    if (pending) {
      if (!force || pendingForced) return pending;
      const ordinary = pending;
      await ordinary.catch(() => {});
      return catalog(force);
    }
    pendingForced = force;
    const request = fetchOne(force).then((value) => {
      cache = { at: clock(), value };
      return value;
    });
    pending = request;
    try { return await request; }
    finally {
      if (pending === request) {
        pending = null;
        pendingForced = false;
      }
    }
  };
}

/**
 * @param {import("../platform").Platform} platform
 * @param {{ accessToken: (force?: boolean) => Promise<string>, discoveryTimeoutMs?: number, clock?: () => number }} opts
 * @returns {Map<string, import("../provider").Provider>}
 */
export function createAlcfProviders(platform, opts) {
  const timeoutMs = opts.discoveryTimeoutMs ?? 30_000;
  const clock = opts.clock ?? Date.now;

  async function fetchCatalog(force = false) {
    assertAlcfUrl(ALCF_DISCOVERY_URL);
    const token = await opts.accessToken(force);
    if (!token) throw discoveryError(401, 'ALCF Inference sign-in required');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await platform.fetch(ALCF_DISCOVERY_URL, {
        headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) {
        try { await response.body?.cancel?.(); } catch { /* the rejected response is already settled */ }
        throw discoveryError(response.status, `ALCF model discovery returned HTTP ${response.status}`);
      }
      const text = await readBoundedText(response, DISCOVERY_MAX_BYTES);
      try { return JSON.parse(text); } catch { throw discoveryError(502, 'ALCF model discovery returned invalid JSON'); }
    } catch (error) {
      const failure = /** @type {any} */ (error);
      if (failure?.name === 'AbortError' || String(failure?.message).includes('aborted')) {
        throw discoveryError(504, 'ALCF model discovery timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const catalog = createCatalogLoader(fetchCatalog, { clock });

  /** @type {Map<string, import("../provider").Provider>} */
  const providers = new Map();
  for (const [id, baseUrl] of Object.entries(ALCF_ENDPOINTS)) {
    assertAlcfUrl(baseUrl);
    const upstream = openaiProvider(platform, {
      id: /** @type {any} */ (id), baseUrl, redirectError: true,
      apiKey: async (force = false) => opts.accessToken(force),
    });
    const modelsFor = async (force) => {
      const models = modelsFromCatalog(await catalog(force), baseUrl);
      if (models === null) throw discoveryError(502, 'ALCF model discovery has an unexpected shape');
      return models.map((model) => ({
        id: model, label: model, hint: null, efforts: [], source: /** @type {const} */ ('provider'), isDefault: false,
      }));
    };
    const getModels = async () => {
      try { return await modelsFor(false); }
      catch (error) {
        const status = /** @type {any} */ (error)?.status;
        if (status === 401 || status === 403) return modelsFor(true);
        throw error;
      }
    };
    providers.set(id, {
      ...upstream,
      async status() {
        try {
          await getModels();
          return {
            provider: /** @type {any} */ (id), state: /** @type {const} */ ('ready'), version: null,
            account: { kind: /** @type {const} */ ('none'), label: `ALCF ${id.slice('oss:alcf-'.length)}`, plan: null },
            usage: null, installHelp: null,
          };
        } catch (error) {
          const status = /** @type {any} */ (error)?.status;
          const signedOut = status === 401 || status === 403;
          return {
            provider: /** @type {any} */ (id), state: /** @type {any} */ (signedOut ? 'signed_out' : 'unreachable'),
            version: null, account: { kind: /** @type {const} */ ('none'), label: null, plan: null }, usage: null,
            installHelp: null, detail: signedOut ? 'ALCF authorization was rejected' : 'ALCF discovery is unavailable',
          };
        }
      },
      async models() {
        try { return await getModels(); } catch { return []; }
      },
    });
  }
  return providers;
}
