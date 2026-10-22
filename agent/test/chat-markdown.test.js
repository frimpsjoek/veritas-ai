import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatMarkdown } from '../src/chat-markdown.js';
import { conversationStore } from '../src/store.js';
import { memoryFs } from './support/memory-fs.mjs';

const ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const meta = { type: 'meta', id: ID, mode: 'chat', title: 'Band gaps: GW vs DFT?', created: '2026-10-22T09:00:00Z' };
const user = { type: 'user', text: 'What does GW add?', attachments: [], web: 'off', at: '2026-10-22T09:00:01Z' };
const assistant = {
  type: 'assistant',
  answer: { text: 'Quasiparticle corrections [[Hedin 1965]].', citations: [], structured: null, usage: {} },
  model: { provider: 'claude', model: null }, activities: [], at: '2026-10-22T09:00:05Z',
};

test('chatMarkdown: name is date, sanitised title and a short id; text has frontmatter and turns', () => {
  const md = chatMarkdown([meta, user, assistant]);
  assert.ok(md);
  assert.match(md.name, /^2026-10-22 Band gaps GW vs DFT \([0-9A-Z]{8}\)\.md$/);
  assert.ok(!/[/\\:*?"<>|]/.test(md.name));
  assert.match(md.text, /^---\n/);
  assert.match(md.text, new RegExp(`\nid: ${ID}\n`));
  assert.match(md.text, /\ncreated: 2026-10-22T09:00:00Z\n/);
  assert.match(md.text, /\nupdated: 2026-10-22T09:00:05Z\n/);
  assert.match(md.text, /\ntype: chat\n/);
  assert.match(md.text, /\n# Band gaps: GW vs DFT\?\n/);
  assert.match(md.text, /## You\n\nWhat does GW add\?\n/);
  assert.match(md.text, /## Veritas\n\nQuasiparticle corrections \[\[Hedin 1965\]\]\.\n/); // citations kept as written
});

test('chatMarkdown: no meta record, no file', () => {
  assert.equal(chatMarkdown([user]), null);
});

test('chat mirror: one file per chat with frontmatter and turns', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats', { mirrorDir: '/notes/chats' });
  await store.append(ID, meta);
  await store.append(ID, user);
  await store.append(ID, assistant);
  const files = await fs.list('/notes/chats');
  assert.equal(files.length, 1);
  const text = await fs.read(`/notes/chats/${files[0]}`);
  assert.match(text, /type: chat/);
  assert.match(text, /## You\n\nWhat does GW add\?/);
  assert.match(text, /## Veritas\n\nQuasiparticle corrections/);
  assert.equal(await fs.read(`/data/chats/${ID}.jsonl`) !== null, true); // the JSONL stays the working store
});

test('chat mirror: a rename keeps one file', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats', { mirrorDir: '/notes/chats' });
  await store.append(ID, meta);
  await store.append(ID, user);
  await store.append(ID, { type: 'rename', title: 'Why GW', at: '2026-10-22T10:00:00Z' });
  const files = await fs.list('/notes/chats');
  assert.equal(files.length, 1);
  assert.match(files[0], /^2026-10-22 Why GW \(/);
  assert.match(await fs.read(`/notes/chats/${files[0]}`), /\n# Why GW\n/);
});

test('chat mirror: two chats with the same title and second keep two files', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats', { mirrorDir: '/notes/chats' });
  const other = `${ID.slice(0, 10)}ZZZZZZZZZZZZZZZZ`;
  await store.append(ID, meta);
  await store.append(other, { ...meta, id: other });
  assert.equal((await fs.list('/notes/chats')).length, 2);
});

test('chat mirror: remove deletes the file', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats', { mirrorDir: '/notes/chats' });
  await store.append(ID, meta);
  await store.append(ID, user);
  await store.remove(ID);
  assert.deepEqual(await fs.list('/notes/chats'), []);
});

test('chat mirror: no mirrorDir writes nothing', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats');
  await store.append(ID, meta);
  await store.append(ID, user);
  assert.deepEqual([...fs.files.keys()], [`/data/chats/${ID}.jsonl`]);
});

test('chat mirror: a failing notes folder never fails the chat', async () => {
  const fs = memoryFs();
  const broken = { ...fs, async writeAtomic(path, text) { if (path.startsWith('/notes')) throw new Error('read-only'); return fs.writeAtomic(path, text); } };
  const store = conversationStore(broken, '/data/chats', { mirrorDir: '/notes/chats' });
  await store.append(ID, meta);
  assert.equal((await store.load(ID)).length, 1);
});

test('chatMarkdown: a crafted created date or id cannot leave the chats folder', () => {
  const md = chatMarkdown([{ ...meta, created: '../../../../tmp/x', id: 'AAAA/../../evil' }, user]);
  assert.ok(md);
  assert.ok(!md.name.includes('/') && !md.name.includes('\\') && !md.name.includes('..'), md.name);
  assert.match(md.name, /^undated /);
});
