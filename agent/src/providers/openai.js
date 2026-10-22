// @ts-check
// agent-src/src/providers/openai.js
// The OpenAI-compatible chat-completions provider. Unlike codex.js/claude.js, this endpoint has no agent loop
// of its own (tools.d.ts: "Open-source chat endpoints have no agent loop, so our core must run the tool loop
// and call tools itself"), so this file owns the tool loop: it calls req.tools.call() in-process instead of
// going over MCP, and re-posts the conversation on every step until the model stops asking for tools.
import { errorMessage } from '../errors.js';

const MAX_STEPS = 8;

/** @typedef {{ id: string, name: string, arguments: string }} ToolCall */
/** @typedef {{ prompt_tokens?: number, completion_tokens?: number }} WireUsage */
/** @typedef {{ text: string, toolCalls: ToolCall[], finishReason: string | null, usage: WireUsage | null }} StreamState */
/**
 * One chat-completions message, the shapes this loop sends.
 * @typedef {{ role: "system" | "user", content: string }
 *   | { role: "assistant", content: string | null, tool_calls?: { id: string, type: "function", function: { name: string, arguments: string } }[] }
 *   | { role: "tool", tool_call_id: string, content: string }} ChatMessage
 */

/** @param {string} name @returns {import("../domain").ActivityKind} */
function toolKind(name) {
  if (name === 'search_library') return 'library';
  if (name === 'read_source') return 'read';
  if (name === 'related_sources') return 'library';
  if (name === 'search_scholarly') return 'scholarly';
  if (name === 'web_search') return 'web';
  if (name === 'read_result') return 'result';
  return 'mcp';
}

function activityLabel(name, args) {
  const q = args?.query ?? args?.q ?? '';
  switch (name) {
    case 'search_library': return `Searching your papers for "${q}"`;
    case 'read_source': return `Reading ${args?.note ?? args?.citekey ?? 'a source'}`;
    case 'related_sources': return `Finding sources related to ${args?.note ?? args?.citekey ?? ''}`;
    case 'search_scholarly': return `Searching the literature for "${q}"`;
    case 'web_search': return `Searching the web for "${q}"`;
    // Fallback label; activity.js's compactActivities resolves "Referenced "title" Vn" from `tool`/`args`
    // carried on the event (spec 007 §1.5), using the turn's own session manifest.
    case 'read_result': return `Referenced result ${args?.result ?? ''}`;
    default: return `Using ${name}`;
  }
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Pure: true for a schema shaped like ASK_SCHEMA (core.js), the only contract this fallback knows how to wrap
 *  a plain-text answer into. A schema this doesn't recognize (a future P5 review schema, say) is left alone: a
 *  wrong-shaped wrapper would just trade one bad_output for another, less honest one. */
export function looksLikeStatusMarkdownSchema(schema) {
  return !!schema?.properties?.markdown && !!schema.properties.status?.enum?.includes('answered');
}

/** Pure: a small local model often can't hold the `{status, markdown}` JSON contract even after one repair
 *  nudge (T2.3's real-run finding against Woof-4B: a present-topic answer came back as free-form markdown and
 *  failed validation, even though the model had genuinely done the work and found real citations). Rather than
 *  fail a turn that actually answered, wrap its plain text as a valid answer, so citations still validate
 *  against it; the caller is responsible for saying plainly that this happened. Returns null when `text` is
 *  blank (nothing to wrap) or the schema isn't recognized. */
export function wrapAsAnsweredMarkdown(schema, text) {
  if (!looksLikeStatusMarkdownSchema(schema) || !text?.trim()) return null;
  return JSON.stringify({ status: 'answered', markdown: text });
}

/** Pure: the request body for one chat-completions call. Exported for the repair-turn and unit tests. */
export function buildChatRequest({ model, messages, tools, outputSchema, withResponseFormat }) {
  // max_tokens: some OpenAI-compatible servers (mlx_lm.server observed) default far lower than a full answer
  // needs, truncating mid-sentence with no error; found on the T2.3 real-run checkpoint against Woof-4B.
  const body = { model, messages, stream: true, stream_options: { include_usage: true }, temperature: 0, max_tokens: 4096 };
  if (tools.length) body.tools = tools;
  if (outputSchema && withResponseFormat) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema: outputSchema, strict: true } };
  }
  return body;
}

/** Pure: maps ToolSession.specs (tools.d.ts) to the chat-completions `tools` array. */
export function toOpenAiTools(specs) {
  return specs.map((s) => ({ type: 'function', function: { name: s.name, description: s.description, parameters: s.inputSchema } }));
}

/** Pure: folds one parsed SSE data chunk into the running state, returning the events it produced.
 *  @param {StreamState} state @returns {import("../provider").ProviderEvent[]} */
export function applyChunk(state, chunk) {
  /** @type {import("../provider").ProviderEvent[]} */
  const events = [];
  if (chunk.usage) state.usage = chunk.usage;
  const choice = chunk.choices?.[0];
  if (!choice) return events;
  const delta = choice.delta ?? {};
  if (delta.content) {
    state.text += delta.content;
    events.push({ type: 'text', delta: delta.content });
  }
  // Some OpenAI-compatible endpoints (DeepSeek-style reasoners, vLLM reasoning servers) stream a parallel
  // `reasoning_content` field alongside `content` (spec 007 §3.1). An endpoint that never sends it emits none.
  if (delta.reasoning_content) {
    events.push({ type: 'reasoning', delta: delta.reasoning_content });
  }
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const i = tc.index ?? 0;
      if (!state.toolCalls[i]) state.toolCalls[i] = { id: tc.id ?? `call_${i}`, name: '', arguments: '' };
      if (tc.id) state.toolCalls[i].id = tc.id;
      if (tc.function?.name) state.toolCalls[i].name += tc.function.name;
      if (tc.function?.arguments) state.toolCalls[i].arguments += tc.function.arguments;
    }
  }
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  return events;
}

/** @returns {StreamState} */
export function createStreamState() {
  return { text: '', toolCalls: [], finishReason: null, usage: null };
}

/** Parses an OpenAI-compatible `text/event-stream` body into JSON chunks, stopping at `data: [DONE]`. */
export async function* parseSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      const chunk = tryParseJson(data);
      if (chunk) yield chunk;
    }
  }
}

/** Pure: builds the chat-completions message array from a TurnRunner request (provider.d.ts's HistoryMessage[]).
 *  @param {{ instructions?: string, history?: import("../provider").HistoryMessage[], input: string }} req
 *  @returns {ChatMessage[]} */
export function buildMessages(req) {
  /** @type {ChatMessage[]} */
  const messages = [];
  if (req.instructions) messages.push({ role: 'system', content: req.instructions });
  for (const h of req.history ?? []) messages.push({ role: h.role, content: h.text });
  messages.push({ role: 'user', content: req.input });
  return messages;
}

/**
 * @param {import("../platform").Platform} platform
 * @param {{ id?: import("../domain").ProviderId, baseUrl: string, apiKey: string | null, webBackend?: { kind: "exa" | "tavily" | "searxng", url: string, key: string | null } | null }} settings
 * @returns {import("../provider").Provider}
 */
export function openaiProvider(platform, settings) {
  const id = /** @type {import("../domain").ProviderId} */ (settings.id ?? 'oss:default');
  const headers = { 'content-type': 'application/json', ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) };

  async function post(body, signal) {
    return platform.fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), signal,
    });
  }

  return {
    id,
    caps: { nativeWebSearch: false, nativeStructuredOutput: false },

    /** @returns {Promise<import("../domain").ProviderStatus>} */
    async status() {
      try {
        const res = await platform.fetch(`${settings.baseUrl.replace(/\/$/, '')}/models`, { headers });
        if (!res.ok) return { provider: id, state: 'unreachable', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: 'The endpoint is not reachable. Check the base URL and that the server is running.' };
        return { provider: id, state: 'ready', version: null, account: { kind: 'none', label: settings.baseUrl, plan: null }, usage: null, installHelp: null };
      } catch {
        return { provider: id, state: 'unreachable', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: 'The endpoint is not reachable. Check the base URL and that the server is running.' };
      }
    },

    async models() {
      try {
        const res = await platform.fetch(`${settings.baseUrl.replace(/\/$/, '')}/models`, { headers });
        if (!res.ok) return [];
        const body = await res.json();
        return (body.data ?? []).map((m) => ({ id: m.id, label: m.id, hint: null, efforts: [], source: /** @type {const} */ ('provider'), isDefault: false }));
      } catch {
        return [];
      }
    },

    async signIn() { throw new Error('OpenAI-compatible endpoints authenticate with an API key in settings, not a sign-in flow.'); },
    async signOut() {},

    async *turn(req, signal) {
      const messages = buildMessages(req);
      const tools = toOpenAiTools(req.tools.specs ?? []);

      /** Runs one non-streamed-into-events completion with tools disabled, so a model that won't stop calling
       *  tools (or that ignored the schema) is forced to answer from whatever it already found. Used both when
       *  the step cap is reached and when the JSON-shape repair turn below still doesn't produce valid JSON. */
      async function forceFinalAnswer(nudge) {
        messages.push({ role: 'user', content: nudge });
        const res = await post(buildChatRequest({ model: req.model?.model, messages, tools: [], outputSchema: null, withResponseFormat: false }), signal);
        if (!res.ok) return null;
        const state = createStreamState();
        for await (const chunk of parseSse(res.body)) applyChunk(state, chunk);
        return state.text;
      }

      /** Applies the JSON-shape repair turn, then the plain-markdown fallback (wrapAsAnsweredMarkdown) if the
       *  repair still didn't produce valid JSON, and yields the turn's final event.
       *  @param {string} text @param {import("../provider").Usage} usage
       *  @returns {AsyncGenerator<import("../provider").ProviderEvent>} */
      async function* finalize(text, usage) {
        if (req.outputSchema && tryParseJson(text.trim()) === undefined) {
          messages.push({ role: 'assistant', content: text });
          let repaired;
          try {
            repaired = await forceFinalAnswer(`Return only JSON matching this schema, no other text: ${JSON.stringify(req.outputSchema)}`);
          } catch {
            // Handled below the same as a repair turn that ran but still didn't produce valid JSON.
          }
          if (repaired != null && tryParseJson(repaired.trim()) !== undefined) {
            text = repaired;
          } else {
            const wrapped = wrapAsAnsweredMarkdown(req.outputSchema, repaired ?? text);
            if (wrapped) {
              yield { type: 'notice', kind: 'format_fallback', text: 'local model answered without the expected format' };
              text = wrapped;
            }
            // Otherwise falls through with `text` as-is; TurnRunner's own bad_output check reports it, honestly,
            // as unresolved (an empty answer, or a schema this fallback doesn't recognize).
          }
        }
        yield { type: 'final', text, json: null, usage };
      }

      for (let step = 0; step < MAX_STEPS; step += 1) {
        let res;
        try {
          res = await post(buildChatRequest({ model: req.model?.model, messages, tools, outputSchema: req.outputSchema, withResponseFormat: !!req.outputSchema }), signal);
          if (!res.ok && req.outputSchema && res.status === 400) {
            // Many OpenAI-compatible servers 400 on an unrecognized response_format; retry once without it.
            res = await post(buildChatRequest({ model: req.model?.model, messages, tools, outputSchema: req.outputSchema, withResponseFormat: false }), signal);
          }
        } catch (error) {
          yield { type: 'failed', error: { kind: signal.aborted ? 'cancelled' : 'provider_crashed', message: signal.aborted ? 'Interrupted.' : errorMessage(error) } };
          return;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          yield { type: 'failed', error: { kind: res.status === 401 ? 'signed_out' : 'provider_crashed', message: text || `The endpoint returned ${res.status}.` } };
          return;
        }

        const state = createStreamState();
        for await (const chunk of parseSse(res.body)) {
          for (const ev of applyChunk(state, chunk)) yield ev;
          if (signal.aborted) break;
        }
        if (signal.aborted) {
          yield { type: 'failed', error: { kind: 'cancelled', message: 'Interrupted.' } };
          return;
        }

        if (state.finishReason === 'tool_calls' && state.toolCalls.length) {
          if (step === MAX_STEPS - 1) {
            // Out of allowed tool-call steps. Rather than fail the turn (a loop-design gap, not just a model
            // limit: the model may already have everything it needs), force one tools-off answer from what
            // was already found, so the turn always ends in a final answer.
            const forced = await forceFinalAnswer('You have used all your tool calls. Stop calling tools and answer now, in the required format, using only what you already found.');
            yield* finalize(forced ?? state.text, { inputTokens: state.usage?.prompt_tokens, outputTokens: state.usage?.completion_tokens });
            return;
          }
          messages.push({ role: 'assistant', content: state.text || null, tool_calls: state.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) });
          for (const tc of state.toolCalls) {
            const args = tryParseJson(tc.arguments) ?? {};
            yield { type: 'activity', id: tc.id, phase: 'start', kind: toolKind(tc.name), label: activityLabel(tc.name, args), tool: tc.name, args };
            const result = await req.tools.call(tc.name, args, signal);
            yield { type: 'activity', id: tc.id, phase: 'end', kind: toolKind(tc.name), label: activityLabel(tc.name, args), ok: result.ok, tool: tc.name, args };
            messages.push({ role: 'tool', tool_call_id: tc.id, content: result.text });
          }
          continue;
        }

        yield* finalize(state.text, { inputTokens: state.usage?.prompt_tokens, outputTokens: state.usage?.completion_tokens });
        return;
      }
    },

    async dispose() {},
  };
}
