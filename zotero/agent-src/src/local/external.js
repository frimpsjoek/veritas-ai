// @ts-check
// agent-src/src/local/external.js (spec 010 §2). Looks for servers already running on this Mac that speak the
// OpenAI-compatible API (Ollama, LM Studio) and lists their models. Nothing is started; an absent server is just absent.

/** @typedef {{ source: "ollama" | "lmstudio", label: string, baseUrl: string }} ExternalEndpoint */

/** @type {ExternalEndpoint[]} */
export const EXTERNAL_ENDPOINTS = [
  { source: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { source: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
];

// Chat models only: the same kind of names the disk scan drops.
const NOT_CHAT = /embed|rerank|whisper|asr|tts|bert|clip/i;

/**
 * @param {typeof fetch} fetchFn @param {ExternalEndpoint[]} [endpoints] @param {number} [timeoutMs]
 * @returns {Promise<{ endpoint: ExternalEndpoint, models: string[] }[]>} only the servers that answered
 */
export async function detectExternal(fetchFn, endpoints = EXTERNAL_ENDPOINTS, timeoutMs = 800) {
  const probes = endpoints.map(async (endpoint) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${endpoint.baseUrl}/models`, { signal: controller.signal });
      if (!res.ok) return null;
      const body = await res.json();
      const models = (Array.isArray(body?.data) ? body.data : []).map((m) => String(m?.id ?? '')).filter((id) => id && !NOT_CHAT.test(id));
      return { endpoint, models };
    } catch { return null; } finally { clearTimeout(timer); }
  });
  return (await Promise.all(probes)).filter((r) => r !== null);
}
