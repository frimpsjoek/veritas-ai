// Spec 007 E2: compacted thinking (activity.js). compactActivities is pure -- fed a plain array of AgentEvents,
// no provider or store involved -- so these are the compaction table the plan's E2 section asks for: searches
// only, reads only, mixed, failed call, reasoning only, read_result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactActivities, linesFromLabels } from '../src/activity.js';

function activity(id, phase, kind, label, over = {}) {
  return { type: 'activity', id, phase, kind, label, ...over };
}

test('searches only: "Ran analysis · Conducted N searches", collapsed by default', () => {
  const events = [
    activity('a1', 'start', 'library', 'Searching your papers for "DeepH"'),
    activity('a1', 'end', 'library', 'Searching your papers for "DeepH"', { ok: true }),
    activity('a2', 'start', 'scholarly', 'Searching the literature for "DeepH"'),
    activity('a2', 'end', 'scholarly', 'Searching the literature for "DeepH"', { ok: true }),
    { type: 'done', answer: { text: 'x', citations: [], structured: null, usage: {} } },
  ];
  const lines = compactActivities(events);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].title, 'Ran analysis');
  assert.equal(lines[0].detail, 'Conducted 2 searches');
  assert.equal(lines[0].state, 'done');
  assert.equal(lines[0].items.length, 2);
  assert.equal(lines[0].reasoning, null);
});

test('reads only: "Read sources · N papers"', () => {
  const events = [
    activity('a1', 'start', 'read', 'Reading a source'),
    activity('a1', 'end', 'read', 'Reading a source', { ok: true }),
    activity('a2', 'start', 'read', 'Reading another source'),
    activity('a2', 'end', 'read', 'Reading another source', { ok: true }),
    activity('a3', 'start', 'read', 'Reading a third source'),
    activity('a3', 'end', 'read', 'Reading a third source', { ok: true }),
    { type: 'done', answer: { text: 'x', citations: [], structured: null, usage: {} } },
  ];
  const lines = compactActivities(events);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].title, 'Read sources');
  assert.equal(lines[0].detail, '3 papers');
});

test('mixed: searches + reads adds "· read M sources" to the search line', () => {
  const events = [
    activity('a1', 'start', 'library', 'Searching your papers for "DeepH"'),
    activity('a1', 'end', 'library', 'Searching your papers for "DeepH"', { ok: true }),
    activity('a2', 'start', 'read', 'Reading a source'),
    activity('a2', 'end', 'read', 'Reading a source', { ok: true }),
    { type: 'done', answer: { text: 'x', citations: [], structured: null, usage: {} } },
  ];
  const lines = compactActivities(events);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].title, 'Ran analysis');
  assert.equal(lines[0].detail, 'Conducted 1 search · read 1 source');
});

test('a failed call adds a quiet "N failed" to the detail and still counts toward the summary', () => {
  const events = [
    activity('a1', 'start', 'library', 'Searching your papers for "DeepH"'),
    activity('a1', 'end', 'library', 'Searching your papers for "DeepH"', { ok: false }),
    activity('a2', 'start', 'library', 'Searching your papers for "widgets"'),
    activity('a2', 'end', 'library', 'Searching your papers for "widgets"', { ok: true }),
    { type: 'done', answer: { text: 'x', citations: [], structured: null, usage: {} } },
  ];
  const lines = compactActivities(events);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].detail, 'Conducted 2 searches · 1 failed');
});

test('reasoning only (no tool calls): "Thought it through", reasoning folded grey', () => {
  const events = [
    { type: 'reasoning', delta: 'Considering the best way to answer this. ' },
    { type: 'reasoning', delta: 'Settling on a direct summary.' },
    { type: 'done', answer: { text: 'x', citations: [], structured: null, usage: {} } },
  ];
  const lines = compactActivities(events);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].title, 'Thought it through');
  assert.equal(lines[0].detail, null);
  assert.equal(lines[0].reasoning, 'Considering the best way to answer this. Settling on a direct summary.');
});

test('reasoning streamed just before a group of activity events belongs to that group', () => {
  const events = [
    { type: 'reasoning', delta: 'I should check the library first.' },
    activity('a1', 'start', 'library', 'Searching your papers for "DeepH"'),
    activity('a1', 'end', 'library', 'Searching your papers for "DeepH"', { ok: true }),
    { type: 'done', answer: { text: 'x', citations: [], structured: null, usage: {} } },
  ];
  const lines = compactActivities(events);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].title, 'Ran analysis');
  assert.equal(lines[0].reasoning, 'I should check the library first.');
});

test('a read_result call folds to "Read context · Referenced "title" Vn" when the result can be resolved', () => {
  const events = [
    activity('a1', 'start', 'result', 'Referenced result R2', { tool: 'read_result', args: { result: 'R2' } }),
    activity('a1', 'end', 'result', 'Referenced result R2', { ok: true, tool: 'read_result', args: { result: 'R2' } }),
    { type: 'done', answer: { text: 'x', citations: [], structured: null, usage: {} } },
  ];
  const resolveResult = (id, version) => (id === 'R2' ? { title: 'Excited-state ML', version: version ?? 3 } : null);
  const lines = compactActivities(events, { resolveResult });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].title, 'Read context');
  assert.equal(lines[0].detail, 'Referenced “Excited-state ML” V3');
});

test('a read_result call falls back to the raw label when the result cannot be resolved', () => {
  const events = [
    activity('a1', 'start', 'result', 'Referenced result R9', { tool: 'read_result', args: { result: 'R9' } }),
    activity('a1', 'end', 'result', 'Referenced result R9', { ok: true, tool: 'read_result', args: { result: 'R9' } }),
    { type: 'done', answer: { text: 'x', citations: [], structured: null, usage: {} } },
  ];
  const lines = compactActivities(events, { resolveResult: () => null });
  assert.equal(lines[0].detail, 'Referenced result R9');
});

test('a running call shows its own current label as the detail, one line only', () => {
  const events = [
    activity('a1', 'start', 'library', 'Searching your papers for "DeepH"'),
  ];
  const lines = compactActivities(events);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].state, 'running');
  assert.equal(lines[0].detail, 'Searching your papers for "DeepH"');
});

test('answer text between two tool groups splits them into two lines', () => {
  const events = [
    activity('a1', 'start', 'library', 'Searching your papers for "DeepH"'),
    activity('a1', 'end', 'library', 'Searching your papers for "DeepH"', { ok: true }),
    { type: 'text', delta: 'Here is what I found so far.' },
    activity('a2', 'start', 'read', 'Reading a source'),
    activity('a2', 'end', 'read', 'Reading a source', { ok: true }),
    { type: 'done', answer: { text: 'x', citations: [], structured: null, usage: {} } },
  ];
  const lines = compactActivities(events);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].title, 'Ran analysis');
  assert.equal(lines[1].title, 'Read sources');
});

test('an engine-authored `line` event passes through unchanged and flushes any pending group', () => {
  const engineLine = { id: 'S2', icon: 'plan', title: 'Planned 5 sub-questions', detail: null, state: 'done', items: [], reasoning: null };
  const events = [
    activity('a1', 'start', 'library', 'Searching your papers for "DeepH"'),
    activity('a1', 'end', 'library', 'Searching your papers for "DeepH"', { ok: true }),
    { type: 'line', line: engineLine },
  ];
  const lines = compactActivities(events);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].title, 'Ran analysis');
  assert.deepEqual(lines[1], engineLine);
});

// ---------- legacy fold ----------

test('an old record with only activities: string[] folds into one "Used N tools" line', () => {
  const lines = linesFromLabels(['Searching your papers for "DeepH"', 'Reading a source']);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].title, 'Used 2 tools');
  assert.equal(lines[0].state, 'done');
  assert.deepEqual(lines[0].items, ['Searching your papers for "DeepH"', 'Reading a source']);
});

test('linesFromLabels of an empty array is empty (a turn with no tool calls stays unfolded)', () => {
  assert.deepEqual(linesFromLabels([]), []);
  assert.deepEqual(linesFromLabels(undefined), []);
});

// ---- live activity feed: entries, counts, sources, hosts ----

test('entries carry kind, state, label, detail and source; items stay plain labels', () => {
  const events = [
    activity('a1', 'start', 'library', 'Searching your papers for "DeepH"'),
    activity('a1', 'end', 'library', 'Searching your papers for "DeepH"', { ok: true, detail: '12 papers', count: 12 }),
    activity('a2', 'start', 'read', 'Reading “Deep learning for DFT”'),
    activity('a2', 'end', 'read', 'Reading “Deep learning for DFT”', { ok: true, source: { kind: 'paper', title: 'Deep learning for DFT' } }),
    activity('a3', 'start', 'read', 'Reading a source'),
    activity('a3', 'end', 'read', 'Reading a source', { ok: false }),
    { type: 'done', answer: { text: 'x', citations: [], structured: null, usage: {} } },
  ];
  const [line] = compactActivities(events);
  assert.equal(line.items.length, 3);
  assert.deepEqual(line.entries.map((e) => e.state), ['done', 'done', 'failed']);
  assert.equal(line.entries[0].detail, '12 papers');
  assert.equal(line.entries[1].source.title, 'Deep learning for DFT');
  assert.equal(line.entries[0].kind, 'library');
});

test('a running call is a running entry', () => {
  const [line] = compactActivities([activity('a1', 'start', 'library', 'Searching your papers for "x"')]);
  assert.equal(line.state, 'running');
  assert.equal(line.entries[0].state, 'running');
});

test('web page reads count as pages, papers as sources, and a page fetch is not a search', () => {
  const events = [];
  events.push(activity('s1', 'start', 'library', 'Searching your papers for "x"'), activity('s1', 'end', 'library', 'Searching your papers for "x"', { ok: true }));
  for (let i = 0; i < 3; i++) {
    events.push(activity(`w${i}`, 'start', 'web', 'Reading example.com', { tool: 'WebFetch', args: { url: 'https://www.example.com/a' } }));
    events.push(activity(`w${i}`, 'end', 'web', 'Reading example.com', { ok: true, tool: 'WebFetch', args: { url: 'https://www.example.com/a' }, source: { kind: 'web', title: 'example.com', host: 'example.com' } }));
  }
  events.push(activity('p1', 'start', 'read', 'Reading a source'), activity('p1', 'end', 'read', 'Reading a source', { ok: true, source: { kind: 'paper', title: 'P' } }));
  const [line] = compactActivities(events);
  assert.equal(line.detail, 'Conducted 1 search · read 1 source · read 3 pages');
  assert.equal(line.entries.find((e) => e.id === 'w0').kind, 'read');
  assert.equal(line.entries.find((e) => e.id === 'w0').source.host, 'example.com');
});

test('pages only: "3 pages"', () => {
  const events = [];
  for (let i = 0; i < 3; i++) {
    events.push(activity(`w${i}`, 'start', 'web', 'Reading a.org', { tool: 'WebFetch', args: { url: 'https://a.org/x' } }));
    events.push(activity(`w${i}`, 'end', 'web', 'Reading a.org', { ok: true, tool: 'WebFetch', args: { url: 'https://a.org/x' } }));
  }
  assert.equal(compactActivities(events)[0].detail, '3 pages');
});

test('an old record with only labels still folds and expands to entries derived from the labels', () => {
  const [line] = linesFromLabels(['Searching your papers for "x"', 'Reading EURSWEVT', 'Searching the web for "y"']);
  assert.equal(line.title, 'Used 3 tools');
  assert.deepEqual(line.entries.map((e) => e.kind), ['library', 'read', 'web']);
  assert.ok(line.entries.every((e) => e.state === 'done' && !e.detail));
});

test('pastTense words a finished step in the past and leaves other text alone', async () => {
  const { pastTense } = await import('../src/activity.js');
  assert.equal(pastTense('Searching your papers for "x"'), 'Searched your papers for "x"');
  assert.equal(pastTense('Reading “A title”'), 'Read “A title”');
  assert.equal(pastTense('Finding related sources'), 'Found related sources');
  assert.equal(pastTense('Reading your results'), 'Read your results');
  assert.equal(pastTense('Already searched'), 'Already searched');
});
