// The quiet usage line under the depth slider: provider's own window reading with its age; nothing when unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageLine } from '../src/chat/usage-line.js';

const now = Date.parse('2026-10-10T12:00:00Z');
const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
const rl = (provider, percentUsed, windowMinutes, minutesAgo) => ({ provider, state: 'ready', usage: { kind: 'rate_limit', percentUsed, windowMinutes, at: at(minutesAgo) } });

test('shows percent, window and age for the chosen provider only', () => {
  const statuses = [rl('codex', 42, 300, 3), rl('claude', 7, 300, 1)];
  assert.equal(usageLine(statuses, 'codex', now), 'Codex: 42% of 5-hour window · 3 minutes ago');
  assert.equal(usageLine(statuses, 'claude', now), 'Claude: 7% of 5-hour window · 1 minute ago');
});
test('rounds, and names a non-hour window in minutes', () => {
  assert.equal(usageLine([rl('codex', 41.6, 90, 0)], 'codex', now), 'Codex: 42% of 90-minute window · just now');
});
test('nothing when unknown', () => {
  assert.equal(usageLine([{ provider: 'codex', state: 'ready', usage: null }], 'codex', now), '');
  assert.equal(usageLine([{ provider: 'local', state: 'ready', usage: { kind: 'cost', usdToday: 1 } }], 'local', now), '');
  assert.equal(usageLine([], 'codex', now), '');
  assert.equal(usageLine(undefined, 'codex', now), '');
  assert.equal(usageLine([rl('codex', 5, 300, 1)], undefined, now), '');
});
