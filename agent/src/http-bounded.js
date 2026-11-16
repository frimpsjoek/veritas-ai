/** Read at most maxBytes from a fetch Response, cancelling a streaming body at the cap. */
export async function readBoundedText(response, maxBytes) {
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
  const text = await response.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw Object.assign(new Error('HTTP response is too large'), { status: 413 });
  }
  return text;
}
