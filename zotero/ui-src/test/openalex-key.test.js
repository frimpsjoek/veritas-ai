import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAlexStatus } from '../src/chat/openalex-key.js';

const NOW = new Date('2026-10-11T10:00:00Z');
test('status: shared limit, key saved, or the limit with its reset time', () => {
  assert.equal(openAlexStatus(null, NOW), 'Using the shared free limit');
  assert.equal(openAlexStatus({ apiKey: null, limitUntil: null }, NOW), 'Using the shared free limit');
  assert.equal(openAlexStatus({ apiKey: 'k', limitUntil: null }, NOW), 'Key saved');
  assert.match(openAlexStatus({ apiKey: null, limitUntil: '2026-10-11T12:00:00Z' }, NOW), /^Limit reached until \d{1,2}:\d{2}/);
  assert.equal(openAlexStatus({ apiKey: 'k', limitUntil: '2026-10-11T09:00:00Z' }, NOW), 'Key saved', 'a passed reset time is ignored');
});
