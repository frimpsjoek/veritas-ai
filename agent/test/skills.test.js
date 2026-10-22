// Spec 011 U3 (engine): reading, hashing and capping skills; the store over a source; skills in chat turns, reports
// and the folder source. Invented content only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  sha256, parseSkill, skillFile, renderSkillBlock, skillSection, createSkillStore, createFolderSkillSource, BUILTIN_SKILLS,
  draftFromOutput, SKILL_CAP, validName,
} from '../src/skills.js';
import { leadPrompt, researcherPrompt, writerPrompt2, candidatesPrompt } from '../src/prompts.js';
import { createLocalRuntime } from '../src/core.js';
import { createToolGateway } from '../src/tools.js';
import { createHttpSkillSource } from '../src/library-http.js';
import { memoryFs } from './support/memory-fs.mjs';

const FILE = '---\nname: Demo\ndescription: A demo skill.\n---\n\nAlways answer in two bullets.\n';

test('sha256 matches node:crypto, including multi-block and non-ASCII text', () => {
  for (const text of ['', 'abc', 'é€'.repeat(40), 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(5000)]) {
    assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
  }
});

test('parseSkill reads name, description and body; the hash is of the whole file', () => {
  const s = parseSkill(FILE, 'Demo');
  assert.deepEqual({ ok: s.ok, name: s.name, description: s.description, body: s.body }, { ok: true, name: 'Demo', description: 'A demo skill.', body: 'Always answer in two bullets.' });
  assert.equal(s.hash, sha256(FILE));
  assert.equal(parseSkill(FILE.replace(/\n/g, '\r\n'), 'Demo').ok, true);
});

test('malformed files are refused whole, each with its reason', () => {
  const warn = (text, folder = 'Demo') => parseSkill(text, folder).warning;
  assert.match(warn('just text'), /no front matter/);
  assert.match(warn('---\ndescription: d\n---\nbody'), /no name/);
  assert.match(warn('---\nname: Demo\n---\nbody'), /no description/);
  assert.match(warn('---\nname: Demo\ndescription: d\n---\n\n'), /no instructions/);
  assert.match(warn(FILE, 'Other'), /does not match its folder/);
  assert.match(warn(null), /too large/);
});

test('renderSkillBlock cuts at the cap and says so; short skills carry no notice', () => {
  const short = renderSkillBlock({ name: 'S', body: 'be brief' });
  assert.equal(short.cut, false); assert.equal(short.notice, null); assert.match(short.text, /be brief/);
  const long = renderSkillBlock({ name: 'S', body: 'a'.repeat(SKILL_CAP + 500) });
  assert.equal(long.cut, true); assert.match(long.notice, /6,000 characters/);
  assert.ok(!long.text.includes('a'.repeat(SKILL_CAP + 1)));
  assert.match(long.text, /cannot give you tools/);
});

test('names: one folder name, no separators', () => {
  for (const ok of ['Demo', 'General Review', 'a.b-c_d']) assert.equal(validName(ok), true, ok);
  for (const bad of ['', '..', 'a/b', 'a\\b', '.x', 'x.', 'a..b', 'x'.repeat(65)]) assert.equal(validName(bad), false, bad);
});

function memorySource(files = {}) {
  const calls = [];
  return {
    files, calls,
    async list() { return Object.entries(files).map(([name, text]) => ({ name, text, size: text?.length ?? 99999, oversize: text == null })); },
    async get(name) { return name in files ? { name, text: files[name], oversize: files[name] == null } : null; },
    async put(name, text) { calls.push(['put', name]); files[name] = text; },
    async remove(name) { calls.push(['remove', name]); delete files[name]; },
  };
}

test('the store lists yours first, broken ones with a warning, starters after; yours replaces a starter of the same name', async () => {
  const mine = skillFile({ name: 'General Review', description: 'My take.', body: 'Mine.' });
  const store = createSkillStore(memorySource({ Demo: FILE, 'General Review': mine, Broken: 'no front matter', Huge: null, '../evil': FILE }));
  const list = await store.list();
  const by = Object.fromEntries(list.map((s) => [s.name, s]));
  assert.equal(by.Demo.source, 'user'); assert.equal(by.Demo.warning, null);
  assert.equal(by.Broken.warning.length > 0, true); assert.match(by.Huge.warning, /too large/);
  assert.equal(by['General Review'].source, 'user'); assert.equal(by['General Review'].description, 'My take.');
  assert.ok(!('../evil' in by));
  for (const b of BUILTIN_SKILLS.filter((x) => x.name !== 'General Review')) assert.equal(by[b.name].source, 'builtin');
  assert.equal(BUILTIN_SKILLS.length, 5);
  assert.deepEqual(list.slice(0, 4).map((s) => s.source), ['user', 'user', 'user', 'user']);
});

test('put refuses what could not be used; remove goes to the source; resolve throws for missing or broken', async () => {
  const src = memorySource({ Broken: 'nope' });
  const store = createSkillStore(src);
  await assert.rejects(() => store.put('Demo', 'no front matter'), /front matter/);
  await assert.rejects(() => store.put('../x', FILE), /slashes/);
  await assert.rejects(() => store.put('Other', FILE), /does not match/);
  assert.deepEqual(src.calls, []);
  const saved = await store.put('Demo', FILE);
  assert.equal(saved.hash, sha256(FILE));
  await store.remove('Demo');
  assert.deepEqual(src.calls, [['put', 'Demo'], ['remove', 'Demo']]);
  await assert.rejects(() => store.resolve(['Nope']), /no skill called/);
  await assert.rejects(() => store.resolve(['Broken']), /can't be used/);
  const [one] = await store.resolve(['1-Page Overview', '1-Page Overview']);
  assert.equal(one.name, '1-Page Overview'); assert.match(one.block, /one-page overview/);
});

test('starters are generic and fit under the cap', () => {
  for (const b of BUILTIN_SKILLS) {
    assert.ok(b.body.length < SKILL_CAP, b.name);
    assert.equal(parseSkill(b.text, b.name).ok, true, b.name);
  }
  assert.deepEqual(BUILTIN_SKILLS.map((b) => b.name), ['General Review', '1-Page Overview', 'Research Gap Analysis', 'Compare Options Across Items', 'Reproducibility Review']);
});

test('the skill section is in the lead, researcher, candidates and writer prompts, and absent without skills', () => {
  const base = { question: 'q', scope: { kind: 'library' }, sources: ['papers'], years: { from: null, to: null }, depth: 'quick' };
  const withSkill = { ...base, skills: [{ name: 'S', hash: 'h', block: 'SKILL-BLOCK-TEXT' }] };
  const sq = { id: 'a', question: 'sq', strategy: 'st', sources: ['papers'] };
  const table = { columns: [], rows: [], cells: {} };
  const counts = { candidates: 0, included: 0, excluded: 0, extracted: 0 };
  for (const make of [(r) => leadPrompt(r, 3), (r) => researcherPrompt(r, sq), (r) => candidatesPrompt(r, sq, 5), (r) => writerPrompt2(r, table, counts)]) {
    assert.match(make(withSkill), /SKILL-BLOCK-TEXT/);
    assert.ok(!make(base).includes('Skill'), 'no skill, no section');
  }
  assert.equal(skillSection(base), '');
});

test('draftFromOutput makes a safe name and a valid SKILL.md; an empty draft is refused', () => {
  const d = draftFromOutput({ name: '../My: Skill!!', description: 'When to use.', instructions: 'Do things.' });
  assert.equal(d.name, 'My Skill');
  assert.equal(parseSkill(d.text, d.name).ok, true);
  assert.throws(() => draftFromOutput({ name: 'x', description: 'd', instructions: ' ' }), /empty/);
  assert.equal(draftFromOutput({ name: '///', description: '', instructions: 'x' }).name, 'New skill');
});

test('the folder source round-trips, trashes instead of deleting, and flags oversize', async () => {
  const fs = memoryFs();
  const src = createFolderSkillSource(fs, '/data/skills');
  await src.put('Demo', FILE);
  assert.equal((await src.get('Demo')).text, FILE);
  assert.deepEqual((await src.list()).map((r) => r.name), ['Demo']);
  await src.remove('Demo');
  assert.equal(await src.get('Demo'), null);
  const trashed = (await fs.list('/data/skills/.trash'))[0];
  assert.match(trashed, /^Demo-/);
  assert.equal(await fs.read(`/data/skills/.trash/${trashed}/SKILL.md`), FILE);
  await src.put('Big', 'x'.repeat(70_000));
  assert.equal((await src.get('Big')).oversize, true);
});

test('the HTTP source speaks the server routes, encodes names and reports the server error', async () => {
  const seen = [];
  const fetchFn = async (url, init = {}) => {
    seen.push([init.method ?? 'GET', new URL(url).pathname + new URL(url).search, init.body]);
    if (new URL(url).pathname.endsWith('/Missing')) return { ok: false, status: 404, json: async () => ({}) };
    if (init.method === 'PUT' && String(init.body).includes('TOOBIG')) return { ok: false, status: 413, json: async () => ({ error: 'a skill is at most 64 KB' }) };
    return { ok: true, status: 200, json: async () => [] };
  };
  const src = createHttpSkillSource(fetchFn, { baseUrl: 'http://127.0.0.1:9' });
  await src.list(); await src.put('General Review', FILE); await src.remove('General Review');
  assert.equal(await src.get('Missing'), null);
  await assert.rejects(() => src.put('x', 'TOOBIG'), /at most 64 KB/);
  assert.deepEqual(seen.slice(0, 3).map((s) => s.slice(0, 2)), [['GET', '/skills'], ['PUT', '/skills/General%20Review'], ['DELETE', '/skills/General%20Review']]);
});

// ---------- the runtime ----------

async function runtime(source) {
  const fs = memoryFs();
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const gateway = await createToolGateway(fetch, library, {});
  const turns = [];
  const provider = {
    id: 'fake', caps: {}, async status() { return null; }, async models() { return []; },
    async *turn(req) { turns.push({ instructions: req.instructions, input: req.input, specs: req.tools.specs.map((s) => s.name) }); yield { type: 'final', text: 'ok', json: null, usage: {} }; },
    async dispose() {},
  };
  const ai = await createLocalRuntime({ platform: { fs }, library, notes: null, skills: source, dataDir: '/data', providers: new Map([['fake', provider]]), gateway, getRoleModel: async () => ({ provider: 'fake', model: null }) });
  return { ai, turns };
}
const events = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };

test('a chat turn with a skill carries its text, records name on the user turn and hash on the reply, and adds no tool', async () => {
  const { ai, turns } = await runtime(memorySource({ Demo: FILE }));
  const plain = await ai.conversations.create('chat');
  await events(ai.conversations.send(plain, { text: 'hi' }));
  const id = await ai.conversations.create('chat');
  await events(ai.conversations.send(id, { text: 'hi', skills: ['Demo'] }));
  assert.match(turns[1].instructions, /Always answer in two bullets\./);
  assert.ok(!turns[0].instructions.includes('two bullets'));
  assert.deepEqual(turns[1].specs, turns[0].specs, 'a skill never changes the tools');
  const records = await ai.conversations.load(id);
  assert.deepEqual(records.find((r) => r.type === 'user').skills, ['Demo']);
  assert.deepEqual(records.find((r) => r.type === 'assistant').skills, [{ name: 'Demo', hash: sha256(FILE) }]);
  assert.equal(records.find((r) => r.type === 'user').text, 'hi');
  const old = await ai.conversations.load(plain);
  assert.ok(!('skills' in old.find((r) => r.type === 'user')));
});

test('an oversize skill is cut with a notice; a missing or broken skill stops the turn before anything runs', async () => {
  const big = skillFile({ name: 'Big', description: 'd', body: 'z'.repeat(SKILL_CAP + 100) });
  const { ai, turns } = await runtime(memorySource({ Big: big, Bad: 'nothing here' }));
  const id = await ai.conversations.create('chat');
  const done = (await events(ai.conversations.send(id, { text: 'q', skills: ['Big'] }))).find((e) => e.type === 'done');
  assert.match(done.notice, /6,000 characters/);
  assert.ok(!turns[0].instructions.includes('z'.repeat(SKILL_CAP + 1)));
  const before = turns.length;
  const failed = (await events(ai.conversations.send(id, { text: 'q2', skills: ['Bad'] }))).find((e) => e.type === 'failed');
  assert.match(failed.error.message, /can't be used/);
  const gone = (await events(ai.conversations.send(id, { text: 'q3', skills: ['Nope'] }))).find((e) => e.type === 'failed');
  assert.match(gone.error.message, /no skill called/);
  assert.equal(turns.length, before);
  assert.ok(!(await ai.conversations.load(id)).some((r) => r.type === 'user' && ['q2', 'q3'].includes(r.text)));
});

test('skills.draft makes one tool-less turn and saves nothing', async () => {
  const src = memorySource({});
  const fs = memoryFs();
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const gateway = await createToolGateway(fetch, library, {});
  const seen = [];
  const provider = {
    id: 'fake', caps: {}, async status() { return null; }, async models() { return []; },
    async *turn(req) { seen.push(req); yield { type: 'final', text: '', json: { name: 'Tiny Tips', description: 'For tips.', instructions: 'Give three tips.' }, usage: {} }; },
    async dispose() {},
  };
  const ai = await createLocalRuntime({ platform: { fs }, library, notes: null, skills: src, dataDir: '/data', providers: new Map([['fake', provider]]), gateway, getRoleModel: async () => ({ provider: 'fake', model: null }) });
  const out = await ai.skills.draft('a skill that gives tips');
  assert.equal(out.name, 'Tiny Tips'); assert.equal(parseSkill(out.text, 'Tiny Tips').ok, true);
  assert.equal(seen.length, 1); assert.match(seen[0].input, /gives tips/);
  assert.deepEqual(src.calls, []);
  await assert.rejects(() => ai.skills.draft('  '), /what the skill is for/);
});

test('skills go through agentd and the remote runtime: list, put, get, remove, draft, and a send carries `skills`', async () => {
  const { createAgentd } = await import('../src/node/agentd.mjs');
  const { createRemoteRuntime } = await import('../src/remote.js');
  const { ai, turns } = await runtime(memorySource({ Demo: FILE }));
  const agentd = createAgentd(ai, { secret: 's', mcpHandler: async () => ({ status: 200, body: '{}' }) });
  const base = `http://127.0.0.1:${await agentd.listen(0)}`;
  const transport = {
    async request(method, path, body) {
      const res = await fetch(base + path, { method, headers: { authorization: 'Bearer s', 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      return json;
    },
    async *stream() {},
  };
  try {
    const remote = createRemoteRuntime(transport);
    assert.ok((await remote.skills.list()).some((s) => s.name === 'Demo'));
    assert.equal((await remote.skills.get('Demo')).body, 'Always answer in two bullets.');
    assert.equal(await remote.skills.get('Missing Skill'), null);
    const saved = await remote.skills.put('Other', FILE.replace('Demo', 'Other'));
    assert.equal(saved.hash, sha256(FILE.replace('Demo', 'Other')));
    await assert.rejects(() => remote.skills.put('Other', 'junk'), /front matter/);
    await remote.skills.remove('Other');
    assert.equal(await remote.skills.get('Other'), null);
    const id = await ai.conversations.create('chat');
    await transport.request('POST', '/conversations/send', { id, text: 'hello', skills: ['Demo'] });
    assert.match(turns.at(-1).instructions, /two bullets/);
  } finally {
    await agentd.close();
  }
});
