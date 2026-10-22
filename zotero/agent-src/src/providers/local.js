// @ts-check
// agent-src/src/providers/local.js (spec 010). "On this Mac": local models behind the OpenAI-compatible chat path.
// MLX models are started on demand by local/server.js (one at a time); Ollama and LM Studio are used as they are.
// A local model never calls tools: for Chat and Ask the engine fetches the passages first (core.js) and this provider
// only answers from them, with the benchmark's guards (temperature 0, thinking off, 600 tokens, repeat stop).
import { errorMessage } from '../errors.js';
import { readLocalSettings } from '../settings.js';
import { scanModels } from '../local/discover.js';
import { detectExternal, EXTERNAL_ENDPOINTS } from '../local/external.js';
import { createLocalServer, checkMlx, pythonFor } from '../local/server.js';
import { createRepeatGuard } from '../local/guards.js';
import { availableBytes, neededBytes } from '../local/memory.js';
import { openaiProvider, parseSse, applyChunk, createStreamState, buildMessages, wrapAsAnsweredMarkdown } from './openai.js';

export const LOCAL_MAX_TOKENS = 600;
const CATALOG_TTL_MS = 5000;

/** Hides a model's `<think>…</think>` block (a thinking-off template can still emit an empty one) from the streamed text.
 *  Returns what is safe to show for each delta. */
export function createThinkFilter() {
  let buffer = '';
  let mode = 'head'; // head: undecided; think: inside the block; out: pass everything through
  let lead = false; // just left a think block: drop the blank lines that follow it
  return {
    /** @param {string} delta @returns {string} */
    push(delta) {
      if (mode === 'out') {
        if (!lead) return delta;
        const out = delta.replace(/^\s+/, '');
        if (out) lead = false;
        return out;
      }
      buffer += delta;
      if (mode === 'head') {
        const t = buffer.trimStart();
        if ('<think>'.startsWith(t)) return '';
        if (!t.startsWith('<think>')) { mode = 'out'; const out = buffer; buffer = ''; return out; }
        mode = 'think';
      }
      const end = buffer.indexOf('</think>');
      if (end < 0) return '';
      mode = 'out';
      const out = buffer.slice(end + '</think>'.length).replace(/^\s+/, '');
      buffer = '';
      lead = !out;
      return out;
    },
    /** Text still held back when the stream ended (an unfinished tag is dropped; a lone "<th" prefix is real text). @returns {string} */
    flush() {
      if (mode === 'think') return '';
      const out = mode === 'head' ? buffer : '';
      buffer = '';
      return out;
    },
  };
}

/** @param {string} text */
export function stripThink(text) { return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, ''); }

/** @param {string[]} missing scan folders that do not exist @returns {string | null} */
export function driveMessage(missing) {
  const drives = [...new Set(missing.map((p) => /^\/Volumes\/([^/]+)/.exec(p)?.[1]).filter(Boolean))];
  if (!drives.length) return null;
  return `The ${drives.join(' and ')} drive${drives.length > 1 ? 's aren' : ' isn'}'t connected, so ${drives.length > 1 ? 'their' : 'its'} models can't be used.`;
}

const gb = (/** @type {number} */ n) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/**
 * @param {import("../platform").Platform} platform
 * @param {{ dataDir: string, home: string, server?: ReturnType<typeof createLocalServer>, externals?: import("../local/external").ExternalEndpoint[],
 *           catalogTtlMs?: number, timers?: { setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void },
 *           pickPort?: () => Promise<number>, memory?: () => Promise<number | null> }} opts
 * @returns {import("../provider").Provider}
 */
export function localProvider(platform, opts) {
  const settings = () => readLocalSettings(platform.fs, opts.dataDir);
  const server = opts.server ?? createLocalServer({ platform, dataDir: opts.dataDir, home: opts.home, settings, timers: opts.timers, pickPort: opts.pickPort, memory: opts.memory });
  const externals = opts.externals ?? EXTERNAL_ENDPOINTS;
  const ttl = opts.catalogTtlMs ?? CATALOG_TTL_MS;
  /** @type {{ at: number, value: Awaited<ReturnType<typeof buildCatalog>> } | null} */
  let cached = null;

  async function buildCatalog() {
    const local = await settings();
    const [scan, found, mlx] = await Promise.all([
      scanModels({ fs: platform.fs, dirs: local.scanDirs, home: opts.home }),
      local.external ? detectExternal(platform.fetch, externals) : Promise.resolve([]),
      checkMlx(platform.fs, pythonFor(local, opts.home)),
    ]);
    /** @type {(import("../domain").LocalModel & { path?: string, baseUrl?: string, served?: string, unavailable: string | null })[]} */
    const models = scan.models.map((m) => ({
      id: m.id, label: m.label, isDefault: m.isDefault, source: m.source, sizeBytes: m.sizeBytes, note: m.note, path: m.path,
      unavailable: mlx.ok ? null : 'Needs mlx-lm, which isn\'t installed.',
    }));
    for (const { endpoint, models: names } of found) {
      for (const name of names) {
        models.push({ id: `${endpoint.source}:${name}`, label: name, isDefault: false, source: endpoint.source, sizeBytes: null, note: `Served by ${endpoint.label}. Not tested on your library.`, baseUrl: endpoint.baseUrl, served: name, unavailable: null });
      }
    }
    if (!models.some((m) => m.isDefault)) {
      const first = models.find((m) => !m.unavailable);
      if (first) first.isDefault = true;
    }
    return { models, missing: scan.missing, mlx, external: found.map((f) => f.endpoint.label) };
  }

  async function catalog() {
    if (cached && Date.now() - cached.at < ttl) return cached.value;
    const value = await buildCatalog();
    cached = { at: Date.now(), value };
    return value;
  }

  /** @param {string | null | undefined} id @param {Awaited<ReturnType<typeof catalog>>} cat */
  /** "Underdog Woof 4B 1.1" -> "underdog woof": the label without its size and version. @param {{ label: string }} m */
  const family = (m) => m.label.toLowerCase().replace(/\b\d+(\.\d+)?b\b.*$/, '').trim();

  function pick(id, cat) {
    const usable = cat.models.filter((m) => !m.unavailable);
    return (id ? usable.find((m) => m.id === id) : usable.find((m) => m.isDefault) ?? usable[0]) ?? null;
  }

  /** @param {import("../domain").ProviderStatus["state"]} state @param {string} detail @param {string | null} [installHelp] @returns {import("../domain").ProviderStatus} */
  const base = (state, detail, installHelp = null) => ({ provider: 'local', state, version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp, detail });

  return {
    id: 'local',
    caps: { nativeWebSearch: false, nativeStructuredOutput: false, tools: false, roles: ['chat', 'ask'] },

    async status() {
      const cat = await catalog();
      const drive = driveMessage(cat.missing);
      const running = server.state();
      if (running.state === 'loading') {
        const m = cat.models.find((x) => x.id === running.id);
        return base('loading', `Opening ${m?.label ?? 'the model'}...`);
      }
      const usable = cat.models.filter((m) => !m.unavailable);
      if (!usable.length) {
        if (cat.models.length && !cat.mlx.ok) {
          const python = pythonFor(await settings(), opts.home);
          return base('missing', 'Local models need mlx-lm, which isn\'t installed.', cat.mlx.reason === 'no_python' ? `The Python for local models wasn't found at ${python}.` : `Install it with: ${python.replace(/python$/, 'pip')} install mlx-lm`);
        }
        if (drive) return base('unreachable', `${drive} Other servers on this Mac still work.`);
        return base('missing', 'No local models found.', 'Put an MLX chat model in a folder under /Volumes/Content/models, or start Ollama or LM Studio.');
      }
      const loaded = running.id ? cat.models.find((m) => m.id === running.id) : null;
      const parts = [`${usable.length} model${usable.length === 1 ? '' : 's'} found.`];
      if (loaded) parts.push(`${loaded.label} is loaded.`);
      if (drive) parts.push(`${drive} Other servers on this Mac still work.`);
      if (!cat.mlx.ok) parts.push('Disk models need mlx-lm, which isn\'t installed.');
      return base('ready', parts.join(' '));
    },

    async models() {
      const cat = await catalog();
      // Read fresh each time the menu opens: a model with no room is not offered at all (the loaded one always is).
      const free = await (opts.memory ?? (() => availableBytes(platform)))();
      const loaded = server.state().id;
      const noRoom = (/** @type {{ id: string, source: string, sizeBytes: number | null }} */ m) => m.source === 'mlx' && m.id !== loaded && free != null && m.sizeBytes != null && neededBytes(m.sizeBytes) > free;
      return cat.models.map(({ id, label, isDefault, source, sizeBytes, note, unavailable }) => {
        const blocked = unavailable ?? (noRoom({ id, source, sizeBytes }) ? `Free memory first: it needs about ${gb(neededBytes(/** @type {number} */ (sizeBytes)))}, about ${gb(/** @type {number} */ (free))} is free.` : null);
        return { id, label, isDefault, source, sizeBytes, note: blocked ?? note, unavailable: blocked };
      });
    },

    async signIn() { return { done: this.status() }; },
    async signOut() {},

    async *turn(req, signal) {
      const cat = await catalog();
      const model = pick(req.model?.model, cat);
      if (!model) {
        const drive = driveMessage(cat.missing);
        yield { type: 'failed', error: { kind: 'model_unavailable', message: req.model?.model ? `The model ${req.model.model} isn't available right now.${drive ? ` ${drive}` : ''}` : `No local model is available.${drive ? ` ${drive}` : ''}` } };
        return;
      }
      const isMlx = model.source === 'mlx';
      let baseUrl = model.baseUrl ?? '';
      let served = model.served ?? model.id;
      if (isMlx) {
        if (server.state().id !== model.id) yield { type: 'notice', kind: 'loading', text: `Opening ${model.label}... the first answer takes a little longer.` };
        server.begin();
      }
      try {
        if (isMlx) {
          // The chosen model first; when there is no room for it, the next smaller local model that fits (same family first).
          const smaller = cat.models
            .filter((m) => !m.unavailable && m.source === 'mlx' && m.id !== model.id && m.sizeBytes != null && model.sizeBytes != null && m.sizeBytes < model.sizeBytes)
            .sort((a, b) => Number(family(b) === family(model)) - Number(family(a) === family(model)) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
          let opened = null;
          let firstError = null;
          for (const m of [model, ...smaller]) {
            try {
              baseUrl = (await server.ensure({ id: m.id, label: m.label, path: /** @type {string} */ (m.path), sizeBytes: m.sizeBytes }, signal)).baseUrl;
              served = /** @type {string} */ (m.path);
              opened = m;
              break;
            } catch (error) {
              firstError ??= error;
              if (!(/** @type {any} */ (error)?.tooBig)) break;
            }
          }
          if (!opened) {
            const error = /** @type {any} */ (firstError);
            const kind = error && typeof error === 'object' && 'kind' in error ? error.kind : 'provider_crashed';
            const smallest = smaller.at(-1);
            const advice = error?.tooBig ? `${smallest ? ` ${smallest.label} doesn't fit either.` : ''} Or choose a cloud model for Chat in Settings.` : '';
            yield { type: 'failed', error: { kind, message: `${errorMessage(error)}${advice}` } };
            return;
          }
          if (opened !== model) yield { type: 'notice', kind: 'loading', text: `There isn't room for ${model.label} right now, so ${opened.label} is answering.` };
        }
        // Report roles (Advanced switch) keep their tools: the plain OpenAI-compatible loop against the same server.
        if ((req.tools.specs ?? []).length) {
          yield* openaiProvider(platform, { baseUrl, apiKey: null }).turn({ ...req, model: { ...req.model, model: served } }, signal);
          return;
        }
        yield* guardedTurn({ platform, baseUrl, served, req, signal, schema: req.outputSchema });
      } finally {
        if (isMlx) server.end();
      }
    },

    async dispose() { await server.dispose(); },
  };
}

/** The guarded stream: one completion, no tools, the benchmark's limits.
 *  @param {{ platform: import("../platform").Platform, baseUrl: string, served: string, req: import("../provider").TurnRequest, signal: AbortSignal, schema: object | null }} args
 *  @returns {AsyncGenerator<import("../provider").ProviderEvent>} */
async function* guardedTurn({ platform, baseUrl, served, req, signal, schema }) {
  const inner = new AbortController();
  const forward = () => inner.abort();
  if (signal.aborted) inner.abort(); else signal.addEventListener('abort', forward, { once: true });
  try {
    const body = {
      model: served, messages: buildMessages(req), stream: true, stream_options: { include_usage: true },
      temperature: 0, max_tokens: LOCAL_MAX_TOKENS, chat_template_kwargs: { enable_thinking: false },
    };
    let res;
    try {
      res = await platform.fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: inner.signal });
    } catch (error) {
      yield { type: 'failed', error: { kind: signal.aborted ? 'cancelled' : 'provider_crashed', message: signal.aborted ? 'Interrupted.' : `The local model didn't answer: ${errorMessage(error)}` } };
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      yield { type: 'failed', error: { kind: 'provider_crashed', message: text || `The local model returned ${res.status}.` } };
      return;
    }

    const state = createStreamState();
    const guard = createRepeatGuard();
    const think = createThinkFilter();
    let repeated = false;
    try {
      for await (const chunk of parseSse(/** @type {any} */ (res.body))) {
        const events = applyChunk(state, chunk);
        for (const ev of events) {
          if (ev.type !== 'text') continue;
          const shown = think.push(ev.delta);
          if (!shown) continue;
          if (guard.push(shown)) { repeated = true; break; }
          yield { type: 'text', delta: shown };
        }
        if (repeated || signal.aborted) break;
      }
    } catch (error) {
      if (!signal.aborted && !repeated) {
        yield { type: 'failed', error: { kind: 'provider_crashed', message: `The local model stopped answering: ${errorMessage(error)}` } };
        return;
      }
    }
    if (repeated) inner.abort();
    if (signal.aborted) { yield { type: 'failed', error: { kind: 'cancelled', message: 'Interrupted.' } }; return; }
    const tail = repeated ? '' : think.flush();
    if (tail && !guard.push(tail)) yield { type: 'text', delta: tail };

    /** @type {string[]} */
    const notes = [];
    if (repeated) notes.push('Stopped a repeating answer.');
    else if (state.finishReason === 'length') notes.push('Short answer: stopped at the length limit.');
    for (const text of notes) yield { type: 'notice', kind: 'local_guard', text };

    let text = (repeated ? guard.text() : stripThink(state.text)).trim();
    if (!text) { yield { type: 'failed', error: { kind: 'bad_output', message: 'The local model gave no answer. Try asking again.' } }; return; }
    if (schema) text = wrapAsAnsweredMarkdown(schema, text) ?? text;
    yield { type: 'final', text, json: null, usage: { inputTokens: state.usage?.prompt_tokens, outputTokens: state.usage?.completion_tokens }, notes };
  } finally {
    signal.removeEventListener('abort', forward);
  }
}
