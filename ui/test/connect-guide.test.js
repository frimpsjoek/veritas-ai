// @ts-check
// Keys as the UI sees them, and connection errors in plain words (server spec 020 G2, G3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyLine, keyState, plainError } from '../src/settings/connect-guide.js';
import { openAlexStatus } from '../src/chat/openalex-key.js';

test('a saved key shows only that it is saved and its last four characters', () => {
  assert.deepEqual(keyState({ set: true, last4: 'a1b2' }), { set: true, last4: 'a1b2' });
  assert.equal(keyState(null), null);
  assert.equal(keyLine({ set: true, last4: 'a1b2' }), 'Key saved (•••• a1b2)');
  assert.equal(keyLine({ set: true, last4: '' }), 'Key saved');
  assert.equal(keyLine(''), '');
  assert.equal(openAlexStatus({ apiKey: { set: true, last4: '9f3e' } }), 'Key saved (•••• 9f3e)');
  assert.equal(openAlexStatus({ apiKey: null }), 'Using the shared free limit');
});

test('connection errors read as what to do', () => {
  assert.match(plainError('HTTP 401 Unauthorized'), /^The key was refused/);
  assert.match(plainError('getaddrinfo ENOTFOUND mcp.exa.ai'), /^Couldn't reach it/);
  assert.match(plainError('spawn npx ENOENT'), /Node \(npx\) or uv \(uvx\)/);
  assert.equal(plainError('something odd'), "Couldn't connect: something odd");
});
