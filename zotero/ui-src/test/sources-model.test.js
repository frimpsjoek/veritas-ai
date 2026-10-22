import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourcesModel, chipWrite, shortNumber } from '../src/settings/sources-model.js';
import { ROWS } from '../src/settings/settings-schema.js';
import { defaultSettings } from '../../agent-src/src/settings.js';

const status = {
  chunks: 1100, indexed_at: '2026-10-14 21:14', running: false, indexing: { label: 'Up to date' },
  coverage: [
    { source: 'zotero', documents: 30, chunks: 600 },
    { source: 'ai_notes', documents: 50, chunks: 300 },
    { source: 'personal', documents: 5, chunks: 20 },
    { source: 'Clippings', documents: 4, chunks: 40 },
    { source: 'youtube', documents: 1, chunks: 10 },
    { source: 'image', documents: 20, chunks: 90 },
    { source: 'pdf', documents: 2, chunks: 40 },
    { source: '_media_read', documents: 99, chunks: 99 },
  ],
};
const report = (name, over = {}) => ({
  config: { name, enabled: true, transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: {}, trustUnmarked: true }, state: 'connected', error: null,
  tools: [{ name: 'search', description: '', verdict: 'exposed' }, { name: 'write', description: '', verdict: 'hidden_writes' }], ...over,
});
const radar = (id, status = 'active') => ({ id, name: `Radar ${id}`, kind: 'radar', status, radar: { sources: [{}, {}, {}] } });
const group = (view, id) => view.groups.find((g) => g.id === id);
const chip = (view, id) => view.groups.flatMap((g) => g.chips).find((c) => c.id === id);

test('three groups in order, under plain headings', () => {
  const view = sourcesModel(status, defaultSettings(), [], []);
  assert.deepEqual(view.groups.map((g) => g.label), ['Your library', 'Look further', 'Keeping watch']);
});

test('the library groups /status labels into four chips; bookkeeping rows are left out', () => {
  const lib = group(sourcesModel(status, defaultSettings(), [], []), 'library');
  assert.deepEqual(lib.chips.map((c) => [c.id, c.documents, c.passages]),
    [['papers', 30, 600], ['notes', 55, 320], ['clippings', 5, 50], ['media', 22, 130]]);
  assert.equal(lib.ring.kind, 'share');
  assert.equal(lib.ring.total, 1100);
  assert.equal(lib.ring.center, '100%');
});

test('only papers and notes are switches; clippings and images follow notes as status', () => {
  const settings = { ...defaultSettings(), sources: { papers: true, notes: false, scholarly: true } };
  const view = sourcesModel(status, settings, [], []);
  assert.deepEqual(group(view, 'library').chips.map((c) => [c.id, c.kind, c.on]),
    [['papers', 'toggle', true], ['notes', 'toggle', false], ['clippings', 'status', false], ['media', 'status', false]]);
  assert.equal(chipWrite(chip(view, 'clippings'), { settings, mcpReport: [] }), null, 'a status chip writes nothing');
  assert.equal(group(view, 'library').ring.center, `${Math.round(600 / 1100 * 100)}%`, 'the ring lights only what is searched');
});

test('a switch writes only its own key, so a stale copy of the others can not undo them', () => {
  const settings = defaultSettings();
  const view = sourcesModel(status, settings, [], []);
  assert.deepEqual(chipWrite(chip(view, 'notes'), { settings, mcpReport: [] }), { kind: 'engine', patch: { sources: { notes: false } } });
  assert.deepEqual(chipWrite(chip(view, 'scholarly'), { settings: null, mcpReport: [] }), { kind: 'engine', patch: { sources: { scholarly: false } } });
});

test('the web chip is a plain on/off switch on sources.web; its detail names the mode Research picked, and Research off reads Always', () => {
  for (const [research, label] of [['off', 'Always'], ['cached', 'When it helps'], ['live', 'Always']]) {
    for (const saved of [false, true]) {
      const settings = { ...defaultSettings(), webSearchDefault: research, sources: { papers: true, notes: true, scholarly: true, web: saved } };
      const web = chip(sourcesModel(null, settings, null), 'web');
      assert.equal(web.kind, 'toggle');
      assert.equal(web.detail, label, `Research ${research}`);
      assert.equal(web.on, saved, 'Research does not decide on or off');
      assert.deepEqual(chipWrite(web, { settings, mcpReport: null }), { kind: 'engine', patch: { sources: { web: !saved } } }, 'writes only sources.web, never webSearchDefault');
    }
  }
  assert.equal(chip(sourcesModel(null, { ...defaultSettings(), webSearchDefault: 'cached' }, null), 'web').on, false, 'never chosen: off even over Research cached');
});

test('scholarly asks for an OpenAlex key when there is none, and says when the limit is reached', () => {
  assert.equal(chip(sourcesModel(null, defaultSettings(), null), 'scholarly').tone, 'warn');
  const keyed = { ...defaultSettings(), openalex: { apiKey: 'k', limitUntil: null } };
  assert.equal(chip(sourcesModel(null, keyed, null), 'scholarly').tone, 'ok');
  const limited = { ...defaultSettings(), openalex: { apiKey: null, limitUntil: '2026-10-14T22:00:00Z' } };
  assert.equal(chip(sourcesModel(null, limited, null), 'scholarly').detail, 'OpenAlex limit reached');
});

test('an outside server is a switch over its own enabled flag; one that fails is shown but not counted', () => {
  const reports = [report('Pubmed Mock'), report('Trials Mock', { state: 'failed', error: 'timed out', tools: [] }), report('Off Mock', { config: { ...report('x').config, name: 'Off Mock', enabled: false }, state: 'disabled', tools: [] })];
  const view = sourcesModel(null, defaultSettings(), reports);
  assert.deepEqual(['mcp:Pubmed Mock', 'mcp:Trials Mock', 'mcp:Off Mock'].map((id) => [chip(view, id).on, chip(view, id).tone, chip(view, id).detail]),
    [[true, 'ok', '1 tool'], [true, 'bad', "Couldn't connect"], [false, 'off', 'Off']]);
  assert.equal(chip(view, 'mcp:Trials Mock').hint, 'timed out');
  const further = group(view, 'further');
  assert.equal(further.ring.kind, 'count');
  assert.equal(further.ring.on, 2, 'scholarly and Pubmed Mock; web is off, Trials Mock fails, Off Mock is off');
  const write = chipWrite(chip(view, 'mcp:Pubmed Mock'), { settings: defaultSettings(), mcpReport: reports });
  assert.equal(write.kind, 'mcp');
  assert.equal(write.config.enabled, false);
  assert.equal(write.config.trustUnmarked, true, 'trust is kept');
  assert.equal(chipWrite(chip(view, 'mcp:Off Mock'), { settings: defaultSettings(), mcpReport: reports }).config.enabled, true);
});

test('keeping watch lists radars, paused ones off; other routines and archived radars are not chips', () => {
  const routines = [radar('r1'), radar('r2', 'paused'), radar('r3', 'archived'), { id: 'w1', name: 'Watch', kind: 'watch', status: 'active' }, { broken: true, id: 'b', file: 'b.json', name: 'b', problem: 'x' }];
  const view = sourcesModel(null, defaultSettings(), null, routines);
  const watch = group(view, 'watch');
  assert.deepEqual(watch.chips.map((c) => [c.id, c.on, c.detail]), [['radar:r1', true, '3 feeds'], ['radar:r2', false, 'Paused']]);
  assert.deepEqual(chipWrite(watch.chips[0], { settings: {}, mcpReport: null }), { kind: 'routine', id: 'r1', action: 'pause' });
  assert.deepEqual(chipWrite(watch.chips[1], { settings: {}, mcpReport: null }), { kind: 'routine', id: 'r2', action: 'resume' });
  const empty = group(sourcesModel(null, defaultSettings(), null, []), 'watch');
  assert.equal(empty.ring, null);
  assert.equal(empty.empty, 'Nothing watched yet.');
});

test('without the server the library has no ring and says so; papers still switch', () => {
  const view = sourcesModel(null, defaultSettings(), null);
  const lib = group(view, 'library');
  assert.equal(lib.ring, null);
  assert.equal(chip(view, 'papers').kind, 'toggle');
  assert.equal(chip(view, 'notes').detail, 'Server not running');
  assert.match(view.footer, /isn't reachable/);
});

test('while the reads are on their way there are no false errors, counts or empty lists', () => {
  const view = sourcesModel(null, defaultSettings(), null, null, true);
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /Server not running|isn't reachable|Nothing watched|Couldn't check/);
  assert.deepEqual(group(view, 'library').chips.map((c) => c.id), ['papers', 'notes'], 'status items wait for the counts');
  assert.equal(view.footer, '');
  assert.equal(group(view, 'watch').empty, undefined);
});

test('a failed outside-sources read says so, apart from there being none set up', () => {
  assert.equal(group(sourcesModel(status, defaultSettings(), null), 'further').problem, "Couldn't check outside sources.");
  assert.equal(group(sourcesModel(status, defaultSettings(), []), 'further').problem, undefined);
});

test('the footer says when the index was updated, how big it is, and whether it is running', () => {
  assert.equal(sourcesModel(status, defaultSettings(), null).footer, 'Search index updated 2026-10-14 21:14 · 1,100 passages · Up to date');
  assert.equal(shortNumber(337094), '337k');
});

test('the menu keeps keys, trust, feeds and index status; the radar feeds item is web only', () => {
  const view = sourcesModel(null, defaultSettings(), null);
  assert.deepEqual(view.menu.map((m) => m.id), ['outsideServers', 'openalexKey', 'radarFeeds', 'indexStatus']);
  assert.deepEqual(view.menu.find((m) => m.id === 'radarFeeds').hosts, ['web']);
});

test('the Sources section hosts the chips row in every app', () => {
  const row = ROWS.find((r) => r.id === 'sources.chips');
  assert.equal(row.custom, 'sourcesChips');
  assert.deepEqual(row.hosts, ['zotero', 'obsidian', 'web']);
  assert.equal(ROWS.filter((r) => r.section === 'sources')[0].id, 'sources.chips', 'the chips come first');
});
