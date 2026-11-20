import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showJump } from '../src/chat/scroll-follow.js';

test('"Jump to latest" shows only when scrolled up in a chat that has turns', () => {
  assert.equal(showJump({ paused: true, turns: 2 }), true);
  assert.equal(showJump({ paused: false, turns: 2 }), false);
  assert.equal(showJump({ paused: true, turns: 0 }), false, 'an empty chat has nothing to jump to');
});
