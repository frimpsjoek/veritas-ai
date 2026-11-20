// Spec 028 R7: opening a session that had news tells the engine (conversations.markSeen) and then the host
// (newsChanged), so a count kept outside the chat (the web rail's Home badge) reads again. ChatView's own markSeen,
// run on a bare object with the real prototype against a fake engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatView } from '../src/chat/chat.js';

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

function viewWith(conversations) {
  const order = [];
  const view = Object.assign(Object.create(ChatView.prototype), {
    host: { ai: async () => ({ conversations }), newsChanged: () => order.push('newsChanged'), logError: (e) => order.push(`error:${e.message}`) },
    recent: [{ id: 's1', news: { papers: 3, at: '2026-11-17T00:00:00.000Z' } }],
    root: { querySelectorAll: () => [] },
    newsById: new Map([['s1', 3]]),
  });
  return { view, order };
}

test('opening a session with news tells the engine, then the host once the engine has it', async () => {
  const { view, order } = viewWith({ markSeen: async (id) => { await flush(); order.push(`markSeen:${id}`); } });
  view.markSeen('s1');
  assert.equal(view.recent[0].news, undefined);
  assert.equal(view.newsById.has('s1'), false);
  await flush();
  await flush();
  assert.deepEqual(order, ['markSeen:s1', 'newsChanged']);
});

test('an older server without markSeen, or one that refused it: the host is not told', async () => {
  const old = viewWith({});
  old.view.markSeen('s1');
  await flush();
  assert.deepEqual(old.order, []);
  const refused = viewWith({ markSeen: async () => { throw new Error('nope'); } });
  refused.view.markSeen('s1');
  await flush();
  assert.deepEqual(refused.order, ['error:nope']);
});
