import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSmallTalk } from '../src/local/retrieve.js';

test('greetings, thanks and "what can you do" are small talk', () => {
  for (const t of ['hi', 'Hi!', 'hello there', 'Good morning', 'thanks so much', 'thank you', 'ok', 'what can you do?', 'How are you doing?']) assert.equal(isSmallTalk(t), true, t);
});

test('questions about papers, and anything with an attachment, are not', () => {
  for (const t of ['hi, what does Smith say about sleep?', 'help me find papers on quantum dots', 'explain paper', 'thanks, now summarize the second one', '']) assert.equal(isSmallTalk(t), false, t);
  assert.equal(isSmallTalk('hi\n\nThe user attached: [@smith2020]'), false);
});
