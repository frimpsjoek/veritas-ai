#!/usr/bin/env node
// agent-src/dev/radar-replay.mjs. Replays a radar's candidate log (radar-state.js CANDIDATE_LOG, beside its state.json)
// against the verdicts the user gave since, for the shipped ranking and, optionally, another scoring of the same
// logged features, so a new weighting is judged on the same papers.
//   node dev/radar-replay.mjs <radar-candidates.jsonl> [--score alt.mjs] [--radar <id>] [--later-relevant] [--json]
// `alt.mjs` exports `score(features, run)`: `features` is a candidate line's `f` (radar-run.js features), `run` its run's
// header line (rankBar, abstractBar, wholeBar, ...); it returns a number, higher first. Reads the log only; writes nothing.
//
// Relevance: Like and Add are relevant (1), Not relevant is not (0); Read later is left out unless --later-relevant;
// a paper with no verdict is unrated. Metrics use the condensed list (Sakai 2007): unrated papers are taken out of a
// ranking before P@10 and nDCG@10 are computed, and how many were in its top 10 is reported apart.
//   issue      the shipped issue is what the run showed, by its rank; an alternative's is the run's candidates by its
//              score, as many as the run showed
//   P@10       relevant / rated among the first 10 rated of an issue; mean over issues with any rated paper
//   nDCG@10    binary gains, DCG = sum rel_i / log2(i + 1) over the first 10 rated, divided by the same for those
//              rated papers sorted best first
//   rank       a rated paper's place among all its run's candidates by the scoring (1 = top), mean per verdict
//   cut        for papers later liked or added: in how many runs each stage cut them (shipped stages only)
//   seeds      distinct closest seeds among each issue's top 10 (the whole-paper seed where it was read)
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOP = 10;

/** Binary relevance of a verdict: 1, 0, or null when it does not count. @param {string | null | undefined} verdict @param {{ laterRelevant?: boolean }} [opts] */
export function relevance(verdict, opts = {}) {
  if (verdict === 'liked' || verdict === 'added') return 1;
  if (verdict === 'dismissed') return 0;
  if (verdict === 'later' && opts.laterRelevant) return 1;
  return null;
}

/** Precision of the first `k` of a list of gains (0/1); null for an empty list. @param {number[]} gains @param {number} [k] */
export function precisionAt(gains, k = TOP) {
  const top = gains.slice(0, k);
  return top.length ? top.reduce((a, g) => a + g, 0) / top.length : null;
}

/** @param {number[]} gains @param {number} k */
const dcg = (gains, k) => gains.slice(0, k).reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);

/** nDCG of the first `k` of a list of gains; null when nothing in it is relevant. @param {number[]} gains @param {number} [k] */
export function ndcgAt(gains, k = TOP) {
  const ideal = dcg([...gains].sort((a, b) => b - a), k);
  return ideal > 0 ? dcg(gains, k) / ideal : null;
}

const mean = (/** @type {number[]} */ xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);

/** The log's lines by kind; a line that does not parse is counted and skipped. @param {string} text @param {{ radar?: string }} [opts] */
export function parseLog(text, opts = {}) {
  /** @type {any[]} */
  const runs = [], candidates = [], verdicts = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let l;
    try { l = JSON.parse(line); } catch { bad += 1; continue; }
    if (opts.radar && l.radar !== opts.radar) continue;
    if (l.type === 'run') runs.push(l); else if (l.type === 'candidate') candidates.push(l); else if (l.type === 'verdict') verdicts.push(l);
  }
  return { runs, candidates, verdicts, bad };
}

/** A paper's last verdict, found by any of its keys (a preprint and its journal version share one).
 *  @param {any[]} verdicts in the order they were written @returns {(c: { id: string, keys?: string[] }) => string | null} */
export function verdictFinder(verdicts) {
  /** @type {Map<string, { at: number, verdict: string }>} */
  const byKey = new Map();
  verdicts.forEach((v, i) => { for (const k of new Set([v.id, ...(v.keys ?? [])])) byKey.set(k, { at: i, verdict: v.verdict }); });
  return (c) => {
    let best = null;
    for (const k of new Set([c.id, ...(c.keys ?? [])])) { const hit = byKey.get(k); if (hit && (!best || hit.at > best.at)) best = hit; }
    return best?.verdict ?? null;
  };
}

/** The closest seed a candidate was finally judged against. @param {any} c */
const closestSeed = (c) => c.f?.whole?.seed ?? c.f?.seed ?? null;

/**
 * The replay numbers for one scoring. `score` null is the shipped ranking (the logged score and shown rank); a
 * function re-ranks every run's candidates by `score(c.f, run)`.
 * @param {{ runs: any[], candidates: any[], verdicts: any[] }} log
 * @param {((features: any, run: any) => number) | null} score
 * @param {{ laterRelevant?: boolean }} [opts]
 */
export function replay(log, score, opts = {}) {
  const verdictOf = verdictFinder(log.verdicts);
  const runById = new Map(log.runs.map((r) => [r.run, r]));
  /** @type {Map<string, any[]>} */
  const byRun = new Map();
  for (const c of log.candidates) { if (!byRun.has(c.run)) byRun.set(c.run, []); byRun.get(c.run)?.push(c); }
  const p10 = [], ndcg = [], seeds = [];
  let unratedTop = 0, issues = 0, ratedIssues = 0;
  /** @type {Record<string, number[]>} */
  const ranks = { liked: [], dismissed: [] };
  for (const [run, list] of byRun) {
    const header = runById.get(run) ?? {};
    const value = (/** @type {any} */ c) => (score ? Number(score(c.f, header)) : c.score ?? 0);
    const ordered = [...list].sort((a, b) => value(b) - value(a) || (b.score ?? 0) - (a.score ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    ordered.forEach((c, i) => {
      const rel = relevance(verdictOf(c), opts);
      if (rel === 1) ranks.liked.push(i + 1); else if (rel === 0) ranks.dismissed.push(i + 1);
    });
    const shownCount = list.filter((c) => c.stage === 'shown').length;
    const issue = score ? ordered.slice(0, shownCount) : list.filter((c) => c.stage === 'shown').sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    if (!issue.length) continue;
    issues += 1;
    const top = issue.slice(0, TOP);
    unratedTop += top.filter((c) => relevance(verdictOf(c), opts) == null).length;
    seeds.push(new Set(top.map(closestSeed).filter(Boolean)).size);
    const gains = /** @type {number[]} */ (issue.map((c) => relevance(verdictOf(c), opts)).filter((g) => g != null));
    if (!gains.length) continue;
    ratedIssues += 1;
    p10.push(/** @type {number} */ (precisionAt(gains)));
    const n = ndcgAt(gains);
    ndcg.push(n ?? 0);
  }
  /** @type {Record<string, number>} */
  const cut = {};
  if (!score) {
    for (const c of log.candidates) if (relevance(verdictOf(c), { laterRelevant: false }) === 1 && c.stage !== 'shown') cut[c.stage] = (cut[c.stage] ?? 0) + 1;
  }
  return {
    issues, ratedIssues, unratedInTop10: unratedTop,
    precisionAt10: mean(p10), ndcgAt10: mean(ndcg),
    meanRankLiked: mean(ranks.liked), meanRankDismissed: mean(ranks.dismissed), liked: ranks.liked.length, dismissed: ranks.dismissed.length,
    seedsInTop10: { mean: mean(seeds), min: seeds.length ? Math.min(...seeds) : null, max: seeds.length ? Math.max(...seeds) : null },
    ...(score ? {} : { likedCutAt: cut }),
  };
}

/** The report as text. @param {Record<string, any>} rows name -> replay() result @param {{ candidates: any[], verdicts: any[], runs: any[], bad: number }} log */
export function formatReport(rows, log) {
  const f = (/** @type {number | null} */ x, d = 3) => (x == null ? '-' : x.toFixed(d));
  const out = [`${log.runs.length} runs, ${log.candidates.length} candidate lines, ${log.verdicts.length} verdict lines${log.bad ? `, ${log.bad} unreadable lines` : ''}`];
  for (const [name, r] of Object.entries(rows)) {
    out.push('', `${name}:`,
      `  issues ${r.issues} (${r.ratedIssues} with a rated paper); unrated papers in the top 10s: ${r.unratedInTop10}`,
      `  P@10 ${f(r.precisionAt10)}   nDCG@10 ${f(r.ndcgAt10)}`,
      `  mean rank among the run's candidates: liked/added ${f(r.meanRankLiked, 1)} (n=${r.liked}), dismissed ${f(r.meanRankDismissed, 1)} (n=${r.dismissed})`,
      `  distinct closest seeds in an issue's top 10: mean ${f(r.seedsInTop10.mean, 2)}, min ${r.seedsInTop10.min ?? '-'}, max ${r.seedsInTop10.max ?? '-'}`);
    if (r.likedCutAt) out.push(`  liked/added papers cut before being shown, by stage (one per run): ${Object.entries(r.likedCutAt).map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}`);
  }
  return out.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = (/** @type {string} */ name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--score', '--radar'].includes(args[i - 1])));
  if (!file) { console.error('usage: node dev/radar-replay.mjs <radar-candidates.jsonl> [--score alt.mjs] [--radar <id>] [--later-relevant] [--json]'); process.exit(1); }
  const opts = { laterRelevant: args.includes('--later-relevant') };
  const log = parseLog(await readFile(file, 'utf8'), { radar: flag('radar') });
  /** @type {Record<string, any>} */
  const rows = { shipped: replay(log, null, opts) };
  const alt = flag('score');
  if (alt) {
    const mod = await import(pathToFileURL(resolve(alt)).href);
    if (typeof mod.score !== 'function') { console.error(`${alt} does not export score(features, run)`); process.exit(1); }
    rows[alt] = replay(log, mod.score, opts);
  }
  console.log(args.includes('--json') ? JSON.stringify(rows, null, 2) : formatReport(rows, log));
}
