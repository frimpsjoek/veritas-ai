/** Read at most maxBytes from a fetch Response, cancelling a streaming body at the cap. */
export async function readBoundedText(response, maxBytes) {
  const declaredBytes = Number(response.headers?.get?.('content-length') ?? 0);
  if (declaredBytes > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* already closed or aborted */ }
    throw Object.assign(new Error('HTTP response is too large'), { status: 413 });
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          try { await reader.cancel(); } catch { /* already closed or aborted */ }
          throw Object.assign(new Error('HTTP response is too large'), { status: 413 });
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      reader.releaseLock?.();
    }
  }
  // Without a streaming reader there is no bounded fallback: response.text()/arrayBuffer()
  // would buffer the complete body before we could enforce the cap, even with a length header.
  throw Object.assign(new Error('A streaming response body is required for bounded reads'), { status: 503 });
}
