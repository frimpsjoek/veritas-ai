// Per-Globus-tenant interactive agent runtimes. Identity comes only from the Python sidecar proxy.
import { createSecretStore } from '../secrets.js';
import { createSettingsStore } from '../settings.js';
import { createLocalRuntime } from '../core.js';
import { createAlcfProviders } from '../providers/alcf.js';
import { createHttpLibraryBackend } from '../library-http.js';
import { createFolderSkillSource } from '../skills.js';
import { createToolGateway, createMcpHttpHandler } from '../tools.js';
import { readBoundedText } from '../http-bounded.js';

const TENANT = /^[0-9a-f]{64}$/;
const TOKEN_MAX_BYTES = 16_384;

function tenantError(status, message) {
  return Object.assign(new Error(message), { status });
}

function validTenant(value) {
  if (typeof value !== 'string' || !TENANT.test(value)) throw tenantError(400, 'invalid tenant');
  return value;
}

function safeName(value, fallback) {
  const tail = String(value ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? fallback;
  const clean = tail.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '').slice(0, 120);
  return clean || fallback;
}

/** Fetch this tenant's freshly refreshed ALCF token from the Python broker for one operation. */
export function createAlcfCredentialClient(platform, { kbBaseUrl, agentSecret, tenant }) {
  const request = async (force = false) => {
    const url = new URL('/auth/globus/agent-token', kbBaseUrl);
    if (force) url.searchParams.set('refresh', '1');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await platform.fetch(url, {
        headers: { authorization: `Bearer ${agentSecret}`, 'x-veritas-tenant': tenant },
        redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) {
        try { await response.body?.cancel?.(); } catch { /* the rejected response is already settled */ }
        throw tenantError(response.status, 'ALCF credential delivery was rejected');
      }
      const text = await readBoundedText(response, TOKEN_MAX_BYTES);
      let value;
      try { value = JSON.parse(text); } catch { throw tenantError(502, 'ALCF credential response is invalid'); }
      if (typeof value?.access_token !== 'string' || !value.access_token
          || typeof value.expires_at !== 'number' || !Number.isFinite(value.expires_at)) {
        throw tenantError(502, 'ALCF credential response is invalid');
      }
      return value.access_token;
    } finally {
      clearTimeout(timer);
    }
  };
  /** @type {Promise<string> | null} */
  let forced = null;
  return async (force = false) => {
    if (forced) return forced;
    if (!force) return request(false);
    forced = request(true).finally(() => { forced = null; });
    return forced;
  };
}

/** Build one tenant's complete settings/provider/store graph; no legacy CLI accounts are included. */
export async function createTenantRuntime(deps) {
  const tenant = validTenant(deps.tenant);
  const { platform } = deps;
  const dataDir = `${deps.tenantRoot}/${tenant}/agent`;
  const secrets = createSecretStore(platform, dataDir, { keychain: false });
  const settingsStore = createSettingsStore(platform.fs, dataDir, { secrets });
  const saved = await settingsStore.get();
  // Persisted MCP/custom endpoints are host-trust capabilities, not tenant data.
  // Remove them before either the gateway or provider registry is constructed.
  if ((saved.endpoints?.length ?? 0) || (saved.mcp?.length ?? 0)) {
    await settingsStore.update({ endpoints: [], mcp: [] });
  }

  const httpLibrary = createHttpLibraryBackend(platform.fetch, { baseUrl: deps.kbBaseUrl });
  const privateLibrary = {
    ...httpLibrary,
    async writeDigest(file, text) {
      const name = safeName(file, 'digest.md');
      const filename = name.endsWith('.md') ? name : `${name}.md`;
      await platform.fs.writeAtomic(`${dataDir}/digests/${filename}`, text, { private: true });
    },
  };
  const gatewaySettings = {
    scholarly: ['openalex', 'arxiv', 'crossref', 'europepmc'],
    mcpUrl: `http://127.0.0.1:${deps.port}/mcp/${tenant}`,
    spawn: async () => { throw tenantError(403, 'subprocess MCP is administrator-only'); },
    mcp: [],
  };
  const providers = createAlcfProviders(platform, {
    accessToken: createAlcfCredentialClient(platform, { kbBaseUrl: deps.kbBaseUrl, agentSecret: deps.agentSecret, tenant }),
  });
  const gateway = await createToolGateway(platform.fetch, privateLibrary, gatewaySettings);
  const notes = {
    async publish({ reviewId, title, markdown }) {
      const filename = `${safeName(reviewId || title, 'report')}.md`;
      await platform.fs.writeAtomic(`${dataDir}/published/${filename}`, markdown, { private: true });
      return { path: `private/published/${filename}` };
    },
  };
  try {
    const service = await createLocalRuntime({
      platform,
      library: privateLibrary,
      notes,
      skills: createFolderSkillSource(platform.fs, `${dataDir}/skills`),
      secrets,
      dataDir,
      providers,
      gateway,
      routines: { isOwner: () => false },
    });
    return { service, providers, gateway, notes, library: privateLibrary, mcpHandler: createMcpHttpHandler(gateway) };
  } catch (error) {
    await gateway.dispose().catch(() => {});
    throw error;
  }
}

/**
 * Bounded pool with single-flight construction and request/work-safe idle eviction.
 * The factory is injectable so lifecycle tests need no network or real provider subprocesses.
 */
export function createTenantPool(deps) {
  const clock = deps.clock ?? Date.now;
  const idleMs = deps.idleMs ?? 30 * 60_000;
  const maxRuntimes = deps.maxRuntimes ?? 16;
  const build = deps.buildRuntime ?? ((tenant) => createTenantRuntime({ ...deps, tenant }));
  const entries = new Map();
  let closed = false;
  let shutdown;

  function lease(entry) {
    let released = false;
    return {
      service: entry.runtime.service,
      mcpHandler: entry.runtime.mcpHandler,
      release() {
        if (released) return;
        released = true;
        entry.claims -= 1;
        entry.lastUsed = clock();
      },
    };
  }

  function idle(entry) {
    return entry.state === 'ready' && entry.claims === 0 && !entry.runtime.service.hasActiveWork?.();
  }

  function disposeEntry(tenant, entry) {
    entry.state = 'disposing';
    entry.promise = Promise.resolve().then(() => entry.runtime.service.dispose()).then(() => {
      entries.delete(tenant);
    });
    // A failed disposal retains its tombstone and capacity: the resources may still be live.
    return entry.promise;
  }

  async function evictIdle(forceOne = false) {
    const candidates = [...entries.entries()]
      .filter(([, entry]) => idle(entry) && (forceOne || clock() - entry.lastUsed >= idleMs))
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [tenant, entry] of candidates) {
      // Earlier disposal yielded: recheck both claims and work, and the idle deadline.
      if (!closed && entries.get(tenant) === entry && idle(entry)
          && (forceOne || clock() - entry.lastUsed >= idleMs)) await disposeEntry(tenant, entry);
    }
  }

  function checkOpen() {
    if (closed) throw tenantError(503, 'tenant pool is shutting down');
  }

  function reserve(entry) {
    checkOpen();
    // Waiting entries own no runtime yet. Construction, ready services, and disposal
    // all consume a slot, including failed disposals. Reserve without yielding.
    const occupied = [...entries.values()].filter((e) => e.state !== 'waiting').length;
    if (occupied < maxRuntimes) {
      entry.state = 'constructing';
      return null;
    }
    const candidate = [...entries.entries()].filter(([, e]) => idle(e))
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
    if (!candidate) throw tenantError(503, 'too many active Veritas workspaces; try again later');
    return disposeEntry(...candidate);
  }

  async function acquire(rawTenant) {
    const tenant = validTenant(rawTenant);
    checkOpen();
    let entry = entries.get(tenant);
    if (entry?.state === 'disposing') {
      await entry.promise;
      return acquire(tenant);
    }
    if (!entry) {
      entry = { state: 'waiting', claims: 0, lastUsed: clock(), runtime: null, promise: null };
      let eviction = reserve(entry);
      entries.set(tenant, entry);
      const creating = entry;
      creating.promise = Promise.resolve().then(async () => {
        while (eviction) {
          await eviction;
          eviction = reserve(creating); // capacity may have changed while disposal ran
        }
        checkOpen();
        creating.runtime = await build(tenant);
        creating.state = 'ready';
      }).catch((error) => {
        entries.delete(tenant);
        throw error;
      });
    }
    // Each caller claims synchronously, before construction can publish or any await.
    entry.claims += 1;
    entry.lastUsed = clock();
    try {
      await entry.promise;
      checkOpen();
      return lease(entry);
    } catch (error) {
      entry.claims -= 1;
      throw error;
    }
  }

  const timer = setInterval(() => { void evictIdle().catch(() => {}); }, deps.sweepMs ?? 60_000);
  timer.unref?.();
  return {
    acquire,
    async acquireExisting(rawTenant) {
      const tenant = validTenant(rawTenant);
      checkOpen();
      const entry = entries.get(tenant);
      if (entry?.state !== 'ready') throw tenantError(404, 'unknown or inactive tenant');
      entry.claims += 1;
      entry.lastUsed = clock();
      return lease(entry);
    },
    evictIdle,
    /** Release all resources after in-flight construction settles. Caller drains active leases first. */
    dispose() {
      if (shutdown) return shutdown;
      closed = true;
      clearInterval(timer);
      shutdown = (async () => {
        await Promise.allSettled([...entries.values()].map((entry) => entry.promise));
        const results = await Promise.allSettled([...entries.entries()].map(([tenant, entry]) =>
          entry.state === 'disposing' ? entry.promise : disposeEntry(tenant, entry)));
        const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, 'tenant runtime disposal failed');
      })();
      return shutdown;
    },
  };
}
