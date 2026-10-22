// @ts-check
// ui-src/src/settings/models-data.js (spec 016 U3). What the Models section knows and does, with no DOM: the models
// each provider lists, which ones can be picked as a default, and the one settings patch each action writes. The
// widget (models-widget.js) only draws this; node --test covers it with a fake engine.
import { useOneDefault } from '../../../agent/src/settings.js';

/** @typedef {import("../../../agent/src/domain").ModelChoice} ModelChoice */
/** @typedef {import("../../../agent/src/domain").ListedModel} ListedModel */
/** @typedef {import("../../../agent/src/domain").ProviderStatus} ProviderStatus */
/** @typedef {import("../../../agent/src/domain").Effort} Effort */
/** @typedef {import("../../../agent/src/settings").Settings} Settings */

/** The tasks that can have a model of their own, in the order Settings lists them. */
export const TASKS = /** @type {[import("../../../agent/src/domain").Role, string][]} */ ([
  ['chat', 'Chat'], ['ask', 'Quick answer'], ['lead', 'Planning a review'], ['researcher', 'Researching for a review'],
  ['writer', 'Writing a review'], ['extract', 'Reading papers for columns'],
]);

export const CLOUD = ['claude', 'codex'];
const PROVIDER_NAMES = /** @type {Record<string, string>} */ ({ claude: 'Claude Code', codex: 'Codex', local: 'On this Mac' });
export const EFFORT_LABELS = /** @type {Record<string, string>} */ ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' });

/** @param {string} provider */
export const providerName = (provider) => PROVIDER_NAMES[provider] ?? (provider.startsWith('oss:') ? provider.slice(4) : provider);

/** "claude:sonnet": the key a model has in `shownModels` and in the pickers. @param {string} provider @param {string | null} model */
export const modelKey = (provider, model) => `${provider}:${model ?? ''}`;

/** The provider is everything before the first colon, except an endpoint's, which is "oss:<name>"; model ids may
 *  carry colons of their own ("ollama:x"). @param {string} key @returns {{ provider: string, model: string | null }} */
export function parseKey(key) {
  const first = key.indexOf(':');
  const end = key.startsWith('oss:') ? key.indexOf(':', 4) : first;
  const provider = end < 0 ? key : key.slice(0, end);
  return { provider, model: end < 0 ? null : key.slice(end + 1) || null };
}

/** @param {ModelChoice | null | undefined} choice */
export const choiceKey = (choice) => (choice ? modelKey(choice.provider, choice.model) : '');

/** @param {{ provider: string, model: string | null }} parts @param {string} [effort] @returns {ModelChoice} */
export function toChoice({ provider, model }, effort) {
  const choice = /** @type {ModelChoice} */ ({ provider: /** @type {any} */ (provider), model });
  if (effort) choice.effort = /** @type {Effort} */ (effort);
  return choice;
}

/** One state of the section: what the engine said. @typedef {{
 *   settings: Settings, statuses: ProviderStatus[], models: Record<string, ListedModel[]>,
 * }} ModelsState */

/** The providers drawn under Cloud: Claude Code, Codex, then one per saved endpoint. @param {ModelsState} state */
export function cloudProviders(state) {
  return [...CLOUD, ...(state.settings.endpoints ?? []).map((e) => `oss:${e.name}`)];
}

/** @param {ModelsState} state @param {string} provider */
export const statusOf = (state, provider) => state.statuses.find((s) => s.provider === provider) ?? null;

/** What a provider row says: the pill and its one fix. @param {ProviderStatus | null} status @param {string} provider
 *  @returns {{ pill: string, ok: boolean, action: "signIn" | "install" | "retry" | null, note: string }} */
export function providerState(status, provider) {
  if (!status) return provider.startsWith('oss:') ? { pill: 'Ready', ok: true, action: null, note: '' } : { pill: 'Not installed', ok: false, action: 'install', note: '' };
  switch (status.state) {
    case 'ready': return { pill: 'Ready', ok: true, action: null, note: status.account?.label ? `Signed in as ${status.account.label}${status.account.plan ? ` · ${status.account.plan}` : ''}` : (status.detail ?? '') };
    case 'signed_out': return { pill: 'Signed out', ok: false, action: 'signIn', note: '' };
    case 'missing': return { pill: 'Not installed', ok: false, action: 'install', note: status.installHelp ?? '' };
    case 'loading': return { pill: 'Checking', ok: false, action: null, note: '' };
    default: return { pill: provider.startsWith('oss:') ? "Can't reach it" : 'Not reachable', ok: false, action: 'retry', note: status.detail ?? '' };
  }
}

/** The models a provider shows a checkbox for. Empty unless it is ready. @param {ModelsState} state @param {string} provider */
export function listModels(state, provider) {
  const status = statusOf(state, provider);
  if (status && status.state !== 'ready') return [];
  return state.models[provider] ?? [];
}

/** @param {ListedModel} m @returns {m is import("../../../agent/src/domain").ProviderModel} */
const isProviderModel = (m) => 'efforts' in m;

/** @param {ModelsState} state @param {string} provider @param {string | null} model @returns {Effort[]} */
export function effortsFor(state, provider, model) {
  const found = (state.models[provider] ?? []).find((m) => m.id === model);
  return found && isProviderModel(found) ? found.efforts : [];
}

/** The choices for a model select: every model of a ready cloud provider, "Provider · Model". `value` is the key.
 *  The current choice is kept in the list even if its provider is not ready, so the select never lies about it.
 *  @param {ModelsState} state @param {ModelChoice | null | undefined} current @returns {{ value: string, label: string }[]} */
export function pickableModels(state, current) {
  /** @type {{ value: string, label: string }[]} */
  const out = [];
  for (const provider of cloudProviders(state)) {
    for (const m of listModels(state, provider)) out.push({ value: modelKey(provider, m.id), label: `${providerName(provider)} · ${m.label}` });
  }
  const now = choiceKey(current);
  if (current && now && !out.some((o) => o.value === now)) out.push({ value: now, label: `${providerName(current.provider)} · ${current.model ?? 'its default'}` });
  return out;
}

/** What a model's checkbox row shows: id, label, the one grey hint, whether it is ticked. @param {ModelsState} state @param {string} provider */
export function checklist(state, provider) {
  const shown = new Set(state.settings.shownModels ?? []);
  return listModels(state, provider).map((m) => ({
    id: m.id, label: m.label, hint: ('hint' in m ? m.hint : null) ?? '', on: shown.has(modelKey(provider, m.id)),
  }));
}

/** The models the Answer-with menu lists under Cloud: the ticked ones, in the order of `shownModels`, with the label the
 *  provider gave them (or the bare id for one typed in that the provider does not list). Pure on settings plus the
 *  lists, so the menu and this section agree. @param {string[]} shown @param {Record<string, ListedModel[]>} models
 *  @returns {{ key: string, provider: string, model: string, label: string }[]} */
export function shownList(shown, models) {
  return shown.map((key) => {
    const { provider, model } = parseKey(key);
    const found = (models[provider] ?? []).find((m) => m.id === model);
    return { key, provider, model: model ?? '', label: found?.label ?? model ?? key };
  }).filter((r) => r.model);
}

/** Loads and writes. `ai` is the engine (host.ai()): settings.get/update and providers.status/models/signIn. */
export class ModelsStore {
  /** @param {any} ai */
  constructor(ai) {
    this.ai = ai;
    /** @type {ModelsState} */
    this.state = { settings: /** @type {any} */ ({ roles: {}, endpoints: [], shownModels: [], addedModels: [], defaultModel: null }), statuses: [], models: {} };
  }

  /** Reads settings, provider states and every cloud provider's models. A provider whose list fails shows none. */
  async load() {
    const [settings, statuses] = await Promise.all([this.ai.settings.get(), this.ai.providers.status().catch(() => [])]);
    this.state = { settings, statuses, models: {} };
    await Promise.all(cloudProviders(this.state).map(async (provider) => {
      const status = statusOf(this.state, provider);
      if (status && status.state !== 'ready') return;
      this.state.models[provider] = await this.ai.providers.models(provider).catch(() => []);
    }));
    return this.state;
  }

  /** @param {import("../../../agent/src/settings").SettingsPatch} patch */
  async write(patch) {
    this.state.settings = await this.ai.settings.update(patch);
    return this.state.settings;
  }

  /** The one Default model: also clears every task already set to it, so those read "Same as default".
   *  @param {string} value a model key, or "" for automatic @param {string} [effort] */
  saveDefault(value, effort) {
    if (!value) return this.write({ defaultModel: null });
    return this.write(useOneDefault(this.state.settings, toChoice(parseKey(value), effort)));
  }

  /** @param {import("../../../agent/src/domain").Role} role @param {string} value a model key, or "" for "Same as default" @param {string} [effort] */
  saveTask(role, value, effort) {
    return this.write({ roles: { [role]: value ? toChoice(parseKey(value), effort) : null } });
  }

  /** @param {string} provider @param {string} id @param {boolean} on */
  tick(provider, id, on) {
    const key = modelKey(provider, id);
    const rest = (this.state.settings.shownModels ?? []).filter((k) => k !== key);
    return this.write({ shownModels: on ? [...rest, key] : rest });
  }

  /** "Add a model ID": remembers it, shows it in the list and ticks it. @param {string} provider @param {string} raw */
  async addModelId(provider, raw) {
    const id = raw.trim();
    if (!id) return null;
    const have = this.state.settings.addedModels ?? [];
    const key = modelKey(provider, id);
    await this.write({
      addedModels: have.some((a) => a.provider === provider && a.id === id) ? have : [...have, { provider: /** @type {any} */ (provider), id }],
      shownModels: [...(this.state.settings.shownModels ?? []).filter((k) => k !== key), key],
    });
    this.state.models[provider] = await this.ai.providers.models(provider).catch(() => this.state.models[provider] ?? []);
    return id;
  }

  /** Saves (or replaces by name) an OpenAI-compatible endpoint. @param {{ name: string, baseUrl: string, key: string | null }} endpoint */
  async saveEndpoint(endpoint) {
    const name = endpoint.name.trim();
    const entry = { name, baseUrl: endpoint.baseUrl.trim(), key: endpoint.key?.trim() || null };
    const rest = (this.state.settings.endpoints ?? []).filter((e) => e.name !== name);
    await this.write({ endpoints: [...rest, entry] });
    return entry;
  }

  /** @param {string} name */
  async removeEndpoint(name) {
    const provider = `oss:${name}`;
    await this.write({
      endpoints: (this.state.settings.endpoints ?? []).filter((e) => e.name !== name),
      shownModels: (this.state.settings.shownModels ?? []).filter((k) => !k.startsWith(`${provider}:`)),
    });
    delete this.state.models[provider];
  }

  /** The endpoint's own model list (the engine reads `{baseUrl}/models`). The endpoint must be saved first.
   *  @param {string} name @returns {Promise<ListedModel[]>} */
  async fetchEndpointModels(name) {
    const list = await this.ai.providers.models(`oss:${name}`);
    this.state.models[`oss:${name}`] = list;
    return list;
  }

  /** @param {string} provider */
  async signIn(provider) { return this.ai.providers.signIn(provider, 'browser'); }
}

/** The address a person typed, with the scheme added when they left it off. @param {string} raw */
export function normalizeAddress(raw) {
  const text = raw.trim().replace(/\/+$/, '');
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text : `http://${text}`;
}

/** Why a draft endpoint cannot be saved yet, or null. @param {{ name: string, baseUrl: string }} draft @param {string[]} existing */
export function endpointProblem(draft, existing) {
  const name = draft.name.trim();
  if (!name) return 'Give it a name.';
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'Use letters, numbers, dots or dashes in the name.';
  if (existing.includes(name)) return 'There is already a service with that name.';
  if (!draft.baseUrl.trim()) return 'Enter its address.';
  return null;
}
