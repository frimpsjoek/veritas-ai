import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crypto as shimCrypto } from '../src/gecko/shims.js';

// Found by the real type check: the Zotero bundle's crypto shim called Zotero.getMainWindow().crypto, which
// throws when no main window is open (startup, or every window closed on macOS), while the AbortController and
// DOMException shims beside it already fell back to the hidden window. A tool session token is minted with it.
test('gecko crypto shim: with no global crypto and no main window, the hidden window supplies getRandomValues', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const hiddenCrypto = { getRandomValues: (array) => array.fill(7) };
  globalThis.Zotero = { getMainWindow: () => null, debug() {} };
  globalThis.Services = { appShell: { hiddenDOMWindow: { crypto: hiddenCrypto } }, env: { exists: () => false, get: () => '' } };
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    assert.deepEqual([...shimCrypto.getRandomValues(new Uint8Array(3))], [7, 7, 7]);
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor);
    delete globalThis.Zotero;
    delete globalThis.Services;
  }
});
