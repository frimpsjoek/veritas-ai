import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICONS } from '../src/icons.js';

const REQUIRED = ['chat', 'ask', 'find', 'report', 'send', 'stop', 'paper', 'note', 'scholarly', 'web', 'related', 'duplicate', 'status'];

test('every required icon name has a path starting with M (spec 005 §3: paper, note, scholarly, web, related, duplicate, status)', () => {
  for (const name of REQUIRED) {
    assert.ok(ICONS[name], `missing icon: ${name}`);
    assert.match(ICONS[name], /^M/, `icon "${name}" should start with an SVG path moveto`);
  }
});

test('the chat-mode icons are unchanged from content/chat.js ChatView.ICONS', () => {
  assert.equal(ICONS.chat, 'M2.75 4.25a1.5 1.5 0 0 1 1.5-1.5h7.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7.5L4.75 13v-2.25h-.5a1.5 1.5 0 0 1-1.5-1.5z');
  assert.equal(ICONS.send, 'M8 12.75V3.5 M4.25 7.25 8 3.5l3.75 3.75');
});
