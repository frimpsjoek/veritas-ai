// Stands in for an OpenAI-compatible `/v1/chat/completions` + `/v1/models` server. Rather than a real HTTP
// listener, this fakes the `fetch` platform.js hands the provider: the provider only ever calls `.ok`,
// `.status`, `.text()`, `.json()` and `.body.getReader()`, so a scripted in-memory Response is enough and keeps
// the tests fast and non-flaky (no port, no real sockets).

function sseBody(chunks) {
  const encoder = new TextEncoder();
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'];
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= lines.length) return { done: true, value: undefined };
          const value = encoder.encode(lines[i]);
          i += 1;
          return { done: false, value };
        },
      };
    },
  };
}

/** `steps` is an array consumed in call order. Each step is one of:
 *    { chunks: [...] }              -> 200 SSE stream of the given chat-completions chunks
 *    { status, text }               -> a non-2xx response
 *    { models: [...] }              -> a GET /models 200 JSON response
 */
export function scriptedFetch(steps) {
  const calls = [];
  let i = 0;
  async function fetchFn(url, opts = {}) {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    if (i >= steps.length) throw new Error(`scriptedFetch: no step left for call ${i} (${url})`);
    const step = steps[i];
    i += 1;
    if (step.models) return { ok: true, status: 200, json: async () => ({ data: step.models.map((id) => ({ id })) }) };
    if (step.status && step.status >= 300) return { ok: false, status: step.status, text: async () => step.text ?? '' };
    return { ok: true, status: 200, body: sseBody(step.chunks ?? []) };
  }
  fetchFn.calls = calls;
  return fetchFn;
}
