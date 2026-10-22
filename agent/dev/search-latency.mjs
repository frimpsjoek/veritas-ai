#!/usr/bin/env node
// Success criterion 7 / the search latency requirement: time /search the way the agent's search_library tool
// calls it (X-KB-Client: agent, limit 8), one request at a time, and print p50 / p95 / max.
//
//   node dev/search-latency.mjs [--base http://127.0.0.1:27182] [--label idle] [--json]
//
// The queries are generic research topics, not library content. Every request's wall time is measured on the
// client over loopback, so it includes the local HTTP round trip on top of the server's own search time.
const QUERIES = [
  'protein folding', 'graph neural networks', 'density functional theory band gap', 'sleep and memory',
  'transformer attention', 'climate model uncertainty', 'CRISPR off-target effects', 'battery cathode materials',
  'reinforcement learning from human feedback', 'vector database similarity search', 'molecular dynamics force fields',
  'working memory capacity', 'photosynthesis efficiency', 'quantum error correction', 'gut microbiome',
  'retrieval augmented generation', 'perovskite solar cells', 'causal inference', 'protein language models',
  'diffusion models for images', 'spaced repetition', 'catalyst design', 'ocean acidification', 'federated learning',
  'embedding models', 'machine learning interatomic potentials', 'attention deficit focus', 'semiconductor defects',
  'mixture of experts', 'bayesian optimization', 'enzyme kinetics', 'knowledge graphs', 'superconductivity',
  'contrastive learning', 'drug discovery screening', 'polymer electrolytes', 'habit formation', 'uncertainty quantification',
  'phonon transport', 'large language model evaluation', 'single cell sequencing', 'active learning', 'thin film growth',
  'note taking methods', 'electrochemical impedance', 'code generation benchmarks', 'magnetic materials',
  'literature review methods', 'time series forecasting', 'hydrogen storage',
];

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const base = opt('base', 'http://127.0.0.1:27182');
const label = opt('label', 'run');

function percentile(sorted, p) {
  // Nearest-rank: the smallest value with at least p% of samples at or below it. No interpolation, no trimming.
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const samples = [];
let failures = 0;
const startedAt = new Date().toISOString();
for (const q of QUERIES) {
  const url = `${base}/search?q=${encodeURIComponent(q)}&limit=8`;
  const t0 = performance.now();
  const res = await fetch(url, { headers: { 'X-KB-Client': 'agent' } }).catch(() => null);
  if (res) await res.arrayBuffer();
  const ms = performance.now() - t0;
  if (!res || !res.ok) failures += 1;
  samples.push({ q, ms: Math.round(ms * 10) / 10, status: res?.status ?? 0 });
}
const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
const summary = {
  label, startedAt, finishedAt: new Date().toISOString(), n: samples.length, failures,
  p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1), min: sorted[0],
};
if (args.includes('--json')) console.log(JSON.stringify({ ...summary, samples }));
else console.log(`${label}: n=${summary.n} failures=${failures} p50=${summary.p50}ms p95=${summary.p95}ms min=${summary.min}ms max=${summary.max}ms (${startedAt} .. ${summary.finishedAt})`);
