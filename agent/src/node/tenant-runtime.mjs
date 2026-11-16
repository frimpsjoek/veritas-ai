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
 * Bounded pool with single-flight construction and active-request-safe idle eviction.
 * The factory is injectable so lifecycle tests need no network or real provider subprocesses.
 */
export function createTenantPool(deps) {
  const clock = deps.clock ?? Date.now;
  const idleMs = deps.idleMs ?? 30 * 60_000;
  const maxRuntimes = deps.maxRuntimes ?? 16;
  const build = deps.buildRuntime ?? ((tenant) => createTenantRuntime({ ...deps, tenant }));
  const records = new Map();
  const inProgress = new Map();

  function lease(record) {
    record.active += 1;
    record.lastUsed = clock();
    let released = false;
    return {
      service: record.service,
      mcpHandler: record.mcpHandler,
      release() {
        if (released) return;
        released = true;
        record.active = Math.max(0, record.active - 1);
        record.lastUsed = clock();
      },
    };
  }

  async function disposeRecord(tenant, record) {
    // A previous candidate may have been reacquired while an older tenant's
    // disposal was awaited. Never dispose that active/replaced runtime.
    if (records.get(tenant) !== record || record.active !== 0) return;
    records.delete(tenant);
    const disposing = Promise.resolve(record.service.dispose()).finally(() => {
      if (inProgress.get(tenant) === disposing) inProgress.delete(tenant);
    });
    inProgress.set(tenant, disposing);
    return disposing;
  }

  async function evictIdle(forceOne = false) {
    const candidates = [...records.entries()]
      .filter(([, record]) => record.active === 0 && (forceOne || clock() - record.lastUsed >= idleMs))
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [tenant, record] of candidates) await disposeRecord(tenant, record);
  }

  function construct(tenant) {
    // Publish same-tenant single-flight intent before the first eviction await.
    const creating = Promise.resolve().then(async () => {
      // This construct already occupies one inProgress slot; the cap applies to the other residents.
      const occupied = () => records.size + inProgress.size - 1;
      if (occupied() >= maxRuntimes) {
        const idle = [...records.entries()].filter(([, record]) => record.active === 0)
          .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
        if (idle) await disposeRecord(...idle);
      }
      if (occupied() >= maxRuntimes) {
        throw tenantError(503, 'too many active Veritas workspaces; try again later');
      }
      const record = await build(tenant);
      records.set(tenant, { ...record, active: 0, lastUsed: clock() });
      return records.get(tenant);
    }).finally(() => {
      if (inProgress.get(tenant) === creating) inProgress.delete(tenant);
    });
    inProgress.set(tenant, creating);
    return creating;
  }

  async function acquire(rawTenant) {
    const tenant = validTenant(rawTenant);
    const existing = records.get(tenant);
    if (existing) return lease(existing);
    if (inProgress.has(tenant)) {
      const record = await inProgress.get(tenant);
      if (record?.service) return lease(record);
      return acquire(tenant); // an eviction settled: build a fresh runtime instead of leasing the disposed one
    }
    const record = await construct(tenant);
    return lease(record);
  }

  const timer = setInterval(() => { void evictIdle().catch(() => {}); }, deps.sweepMs ?? 60_000);
  timer.unref?.();
  return {
    acquire,
    async acquireExisting(rawTenant) {
      const tenant = validTenant(rawTenant);
      const record = records.get(tenant);
      if (!record) throw tenantError(404, 'unknown or inactive tenant');
      return lease(record);
    },
    evictIdle,
    /** Release all resources after in-flight construction settles. Caller drains active leases first. */
    async dispose() {
      clearInterval(timer);
      await Promise.allSettled([...inProgress.values()]);
      await Promise.allSettled([...records.values()].map((record) => record.service.dispose()));
      records.clear();
      inProgress.clear();
    },
  };
}
