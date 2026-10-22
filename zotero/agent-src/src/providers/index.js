// The one place hosts get their providers from, so adding a provider never touches a host.
import { codexProvider } from './codex.js';
import { claudeProvider } from './claude.js';
import { openaiProvider } from './openai.js';
import { localProvider } from './local.js';

/**
 * @param {import("../platform").Platform} platform
 * @param {{ dataDir: string, home: string, codex?: { binaryPath?: string | null }, claude?: { binaryPath?: string | null },
 *           oss?: { baseUrl: string, apiKey?: string | null },
 *           endpoints?: { name: string, baseUrl: string, key: string | null }[],
 *           local?: { externals?: import("../local/external").ExternalEndpoint[] } }} settings
 * @returns {Map<string, import("../provider").Provider>}
 */
export function createProviders(platform, settings) {
  /** @type {Map<string, import("../provider").Provider>} */
  const providers = new Map([
    ['codex', codexProvider(platform, { binaryPath: settings.codex?.binaryPath ?? null, dataDir: settings.dataDir, home: settings.home })],
    ['claude', claudeProvider(platform, { binaryPath: settings.claude?.binaryPath ?? null, dataDir: settings.dataDir, home: settings.home })],
    // spec 010: "On this Mac". Always registered; it reads its folders / idle time / switches from settings.json live and
    // starts nothing until a local model is asked a question.
    ['local', localProvider(platform, { dataDir: settings.dataDir, home: settings.home, ...(settings.local ?? {}) })],
  ]);
  // "oss:default" is the one open-source endpoint the dev harness configures; the user's own endpoints are
  // `oss:<name>`, kept in step with settings by core.js through syncEndpointProviders.
  if (settings.oss?.baseUrl) providers.set('oss:default', openaiProvider(platform, { baseUrl: settings.oss.baseUrl, apiKey: settings.oss.apiKey ?? null }));
  if (settings.endpoints) syncEndpointProviders(platform, providers, settings.endpoints);
  return providers;
}

/** Providers this module registered from `settings.endpoints`, per registry, with the config each was built from. */
const registered = new WeakMap();

/**
 * spec 016 E2: one `oss:<name>` provider per `settings.endpoints` entry. Idempotent: call it at start and after every
 * settings change. It only ever touches providers it registered itself, so the dev harness's `oss:default` and the three
 * built-in providers are left alone; an entry that was removed or whose address or key changed is replaced.
 * @param {import("../platform").Platform} platform
 * @param {Map<string, import("../provider").Provider>} providers
 * @param {{ name: string, baseUrl: string, key: string | null }[]} endpoints
 */
export function syncEndpointProviders(platform, providers, endpoints) {
  /** @type {Map<string, string>} */
  const mine = registered.get(providers) ?? new Map();
  registered.set(providers, mine);
  const wanted = new Map();
  for (const e of endpoints ?? []) {
    const name = typeof e?.name === 'string' ? e.name.trim() : '';
    const baseUrl = typeof e?.baseUrl === 'string' ? e.baseUrl.trim() : '';
    if (name && baseUrl) wanted.set(`oss:${name}`, { baseUrl, apiKey: e.key || null });
  }
  for (const id of [...mine.keys()]) {
    if (wanted.has(id)) continue;
    void providers.get(id)?.dispose();
    providers.delete(id);
    mine.delete(id);
  }
  for (const [id, cfg] of wanted) {
    const sig = JSON.stringify(cfg);
    if (mine.get(id) === sig) continue;
    void providers.get(id)?.dispose();
    providers.set(id, openaiProvider(platform, { ...cfg, id }));
    mine.set(id, sig);
  }
}
