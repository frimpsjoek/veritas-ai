// dev/radar-replay.mjs: the metrics, checked against values worked out by hand, on a made-up candidate log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { precisionAt, ndcgAt, relevance, parseLog, verdictFinder, replay } from '../dev/radar-replay.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} != ${b}`);

test('precision and nDCG at 10 by hand', () => {
  close(precisionAt([1, 0, 1]), 2 / 3);
  assert.equal(precisionAt([]), null);
  close(precisionAt([1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1]), 0.5, 'only the first 10 count');
  // DCG = 1/log2(2) + 0 + 1/log2(4) = 1.5; ideal = 1 + 1/log2(3) = 1.6309298
  close(ndcgAt([1, 0, 1]), 1.5 / (1 + 1 / Math.log2(3)));
  close(ndcgAt([0, 1]), 1 / Math.log2(3));
  close(ndcgAt([1, 1]), 1);
  assert.equal(ndcgAt([0, 0]), null, 'nothing relevant: undefined, not zero');
  assert.equal(ndcgAt([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), 0, 'a relevant paper past the 10th counts for nothing, but sets the ideal');
});

test('verdicts: Like and Add relevant, Not relevant not, Read later and none left out', () => {
  assert.deepEqual(['liked', 'added', 'dismissed', 'later', 'shown', null].map((v) => relevance(v)), [1, 1, 0, null, null, null]);
  assert.equal(relevance('later', { laterRelevant: true }), 1);
  const find = verdictFinder([{ id: 'doi:10.1/b', verdict: 'liked' }, { id: 'arxiv:2611.1', keys: ['arxiv:2611.1', 'doi:10.1/b'], verdict: 'dismissed' }]);
  assert.equal(find({ id: 'doi:10.1/b' }), 'dismissed', 'the last verdict wins, matched by any key');
  assert.equal(find({ id: 'title:other' }), null);
});

/** Two runs. R1 showed a, b, c; d was past the bars but not picked; e fell under the abstract bar, then R2 showed it
 *  (as its journal version, sharing a key) and it was liked. b was liked, then dismissed. f was never rated. */
const line = (o) => JSON.stringify({ type: 'candidate', at: o.run, radar: 'r1', keys: [o.id], ...o });
const LOG = [
  JSON.stringify({ type: 'run', at: 'R1', run: 'R1', radar: 'r1', rankBar: 0.1 }),
  line({ run: 'R1', id: 'doi:a', title: 'A', score: 0.3, stage: 'shown', rank: 1, f: { sim: 0.1, seed: 'S1' } }),
  line({ run: 'R1', id: 'doi:b', title: 'B', score: 0.2, stage: 'shown', rank: 2, f: { sim: 0.9, seed: 'S2' } }),
  line({ run: 'R1', id: 'doi:c', title: 'C', score: 0.1, stage: 'shown', rank: 3, f: { sim: 0.5, seed: 'S9', whole: { seed: 'S1' } } }),
  line({ run: 'R1', id: 'doi:d', title: 'D', score: 0.05, stage: 'not picked', f: { sim: 0.7, seed: 'S3' } }),
  line({ run: 'R1', id: 'arxiv:e', keys: ['arxiv:e', 'title:e paper'], title: 'E', score: -0.1, stage: 'abstract bar', f: { sim: 0.8, seed: 'S2' } }),
  JSON.stringify({ type: 'run', at: 'R2', run: 'R2', radar: 'r1' }),
  line({ run: 'R2', id: 'doi:e', keys: ['doi:e', 'arxiv:e'], title: 'E', score: 0.2, stage: 'shown', rank: 1, f: { sim: 0.2, seed: 'S2' } }),
  line({ run: 'R2', id: 'doi:f', title: 'F', score: 0.1, stage: 'shown', rank: 2, f: { sim: 0.9, seed: 'S4' } }),
  JSON.stringify({ type: 'verdict', at: 'V', radar: 'r1', id: 'doi:a', verdict: 'liked' }),
  JSON.stringify({ type: 'verdict', at: 'V', radar: 'r1', id: 'doi:b', verdict: 'liked' }),
  JSON.stringify({ type: 'verdict', at: 'V', radar: 'r1', id: 'doi:b', verdict: 'dismissed' }),
  JSON.stringify({ type: 'verdict', at: 'V', radar: 'r1', id: 'doi:c', verdict: 'added' }),
  JSON.stringify({ type: 'verdict', at: 'V', radar: 'r1', id: 'doi:e', keys: ['doi:e', 'arxiv:e'], verdict: 'liked' }),
  JSON.stringify({ type: 'run', at: 'X', run: 'X', radar: 'another radar' }),
  '{ torn',
].join('\n');

test('the shipped issues of a made-up log', () => {
  const log = parseLog(LOG, { radar: 'r1' });
  assert.deepEqual([log.runs.length, log.candidates.length, log.verdicts.length, log.bad], [2, 7, 5, 1]);
  const r = replay(log, null);
  assert.equal(r.issues, 2);
  assert.equal(r.ratedIssues, 2);
  assert.equal(r.unratedInTop10, 1, 'f');
  // R1 [1,0,1]: P 2/3, nDCG 0.919721; R2 [1] after f is taken out: 1, 1
  close(r.precisionAt10, (2 / 3 + 1) / 2);
  close(r.ndcgAt10, (1.5 / (1 + 1 / Math.log2(3)) + 1) / 2);
  // by score within the run: R1 a1 b2 c3 d4 e5, R2 e1 f2 -> liked/added a1 c3 e5 e1, dismissed b2
  close(r.meanRankLiked, 2.5);
  close(r.meanRankDismissed, 2);
  assert.deepEqual(r.likedCutAt, { 'abstract bar': 1 }, 'e, before R2 showed it');
  assert.deepEqual(r.seedsInTop10, { mean: 2, min: 2, max: 2 }, 'R1 S1 S2 S1 (c was read whole against S1); R2 S2 S4');
});

test('an alternative scoring is replayed on the same features: its issue is its top as many as the run showed', () => {
  const r = replay(parseLog(LOG, { radar: 'r1' }), (f) => f.sim);
  // R1 by sim: b .9, e .8, d .7, c .5, a .1 -> issue b e d -> condensed [0, 1]: P 1/2, nDCG 1/log2(3); d unrated
  // R2 by sim: f .9, e .2 -> condensed [1]: P 1, nDCG 1; f unrated
  close(r.precisionAt10, 0.75);
  close(r.ndcgAt10, (1 / Math.log2(3) + 1) / 2);
  assert.equal(r.unratedInTop10, 2);
  close(r.meanRankLiked, (2 + 4 + 5 + 2) / 4);
  close(r.meanRankDismissed, 1);
  assert.deepEqual(r.seedsInTop10, { mean: 2, min: 2, max: 2 }, 'R1 S2 S2 S3; R2 S4 S2');
  assert.equal(r.likedCutAt, undefined, 'stages belong to the shipped run');
});

test('the script prints both scorings from a log file and an alternative module', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-'));
  await writeFile(join(dir, 'log.jsonl'), LOG);
  await writeFile(join(dir, 'alt.mjs'), 'export const score = (f) => f.sim;\n');
  const script = fileURLToPath(new URL('../dev/radar-replay.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, join(dir, 'log.jsonl'), '--score', join(dir, 'alt.mjs'), '--radar', 'r1', '--json']);
  const rows = JSON.parse(stdout);
  close(rows.shipped.precisionAt10, (2 / 3 + 1) / 2);
  close(rows[join(dir, 'alt.mjs')].precisionAt10, 0.75);
});
