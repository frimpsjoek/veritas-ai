"""Retrieval benchmark: labelled queries (bench_queries.py) run through the search the HTTP route uses.

    python bench.py all      --db data/kb.sqlite --out DIR [--label baseline] [--per-type 200] [--seed 0]
    python bench.py generate --db data/kb.sqlite --out DIR            # DIR/queries.json only
    python bench.py run      --db data/kb.sqlite --queries DIR/queries.json --out DIR --label after
    python bench.py compare  DIR/results-baseline.json DIR/results-after.json
    python bench.py fixture  --out DIR                                # the made-up test corpus, no model needed

The index is never touched: it is copied (SQLite backup from a read-only connection) to DIR/work and the Tantivy
keyword index is built there. Query and result files hold library text, so DIR must be outside this repository.

Modes, all through kb.Searcher.search (GET /search): `fused` as shipped; `keyword`, the same call with the vector
matrix hidden; `vector`, the same call with the keyword index returning nothing. The switch lives here (see
search_mode) until kb.py has a mode argument.

Per query group and mode: paper-level recall@1/5/10, MRR, nDCG@10, passage recall@5 (a returned passage of a gold
chunk in the top 5, where the query has one), distinct papers in the top 10, p50/p95 latency, each with a 95%
bootstrap interval over queries; for no-answer queries, the share that return nothing. A query's gold papers are
interchangeable answers (copies of one paper, or every paper an author-year names), so one hit is enough and
nDCG@10 = 1/log2(rank+1) of the first hit. These are sentence-copy queries: a regression floor for exact recall,
not a measure of paraphrase understanding (bench_queries.py says more).
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import json
import math
import os
import re
import sqlite3
import sys
import time
import zlib
from pathlib import Path

import numpy as np

import bench_queries
import kb

REPO = Path(__file__).resolve().parent.parent
MODES = ("fused", "keyword", "vector")


# ---------------------------------------------------------------- metrics

def first_hit_rank(ranked: list[str], gold: set[str]) -> int | None:
    """1-based rank of the first result that is a gold answer, None if none is."""
    for i, path in enumerate(ranked, 1):
        if path in gold:
            return i
    return None


def answer_paths(hits: list[dict], gold: set[str]) -> list[str]:
    """One path per result; a result standing for several copies of a paper (its "duplicates") counts as the
    gold copy when any of them is gold."""
    out = []
    for hit in hits:
        dup = sorted(gold & set(hit.get("duplicates") or []))
        out.append(hit["path"] if hit["path"] in gold or not dup else dup[0])
    return out


def recall_at(rank: int | None, k: int) -> float:
    return 1.0 if rank is not None and rank <= k else 0.0


def reciprocal_rank(rank: int | None) -> float:
    return 1.0 / rank if rank else 0.0


def ndcg_at(rank: int | None, k: int) -> float:
    """nDCG@k with one answer needed (IDCG = 1): 1/log2(rank + 1) for the first hit inside the cut-off."""
    return 1.0 / math.log2(rank + 1) if rank is not None and rank <= k else 0.0


def percentile(values, q: float) -> float | None:
    """Linear-interpolation percentile (numpy's default), None for no values."""
    return float(np.percentile(np.asarray(values, dtype=float), q)) if len(values) else None


def bootstrap_ci(values, stat=None, n_boot: int = 1000, seed: int = 0, alpha: float = 0.05):
    """Percentile bootstrap interval of `stat` (default: the mean) over resampled queries."""
    if len(values) == 0:
        return (None, None)
    v = np.asarray(values, dtype=float)
    idx = np.random.default_rng(seed).integers(0, len(v), size=(n_boot, len(v)))
    stats = v[idx].mean(axis=1) if stat is None else np.array([stat(v[i]) for i in idx])
    lo, hi = np.percentile(stats, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return (float(lo), float(hi))


def summary(values, stat=None, n_boot: int = 1000, seed: int = 0) -> dict:
    values = [v for v in values if v is not None]
    if not values:
        return {"mean": None, "lo": None, "hi": None, "n": 0}
    mean = float(np.mean(values)) if stat is None else float(stat(np.asarray(values, dtype=float)))
    lo, hi = bootstrap_ci(values, stat, n_boot, seed)
    mean, lo, hi = round(mean, 6), round(lo, 6), round(hi, 6)
    return {"mean": mean, "lo": min(lo, mean), "hi": max(hi, mean), "n": len(values)}


def paired_delta(a, b, n_boot: int = 1000, seed: int = 0) -> dict:
    """Mean of b - a over the same queries, with a bootstrap interval of that mean."""
    d = np.asarray(b, dtype=float) - np.asarray(a, dtype=float)
    lo, hi = bootstrap_ci(d, None, n_boot, seed)
    return {"delta": float(d.mean()) if len(d) else None, "lo": lo, "hi": hi, "n": len(d)}


def _paper_key(hit: dict) -> str:
    meta = hit.get("zotero") or {}
    if hit["path"].split("/", 1)[0].endswith("zotero") or meta:
        doi = (meta.get("doi") or "").strip().lower()
        return "doi:" + doi if doi else "title:" + " ".join(re.findall(r"\w+", (hit.get("title") or "").lower()))
    return "path:" + hit["path"]


def distinct_papers(results: list[dict], k: int) -> int:
    """Different papers in the top k: copies of one paper (same DOI, else same title) count once; notes by path."""
    return len({_paper_key(h) for h in results[:k]})


def passage_hit(results: list[dict], gold_papers: set[str], gold_texts: list[str], k: int) -> bool:
    """A top-k result from a gold paper returned a passage cut from a gold chunk (search returns snippets, not
    chunk ids, so a snippet inside the chunk's text is the match)."""
    for hit in results[:k]:
        if hit["path"] not in gold_papers:
            continue
        for passage in hit.get("passages", []):
            s = (passage.get("snippet") or "").strip("…").strip()
            if s and any(s in text for text in gold_texts):
                return True
    return False


# ---------------------------------------------------------------- modes

class _NoKeywords:
    """Stands in for the Tantivy index in vector-only mode: usable (so the FTS5 fallback stays off), finds nothing."""

    def usable(self) -> bool:
        return True

    def search(self, *_args, **_kwargs) -> list[int]:
        return []

    def sync(self, _db) -> int:
        return 0


@contextlib.contextmanager
def search_mode(searcher: kb.Searcher, mode: str):
    """Runs kb.Searcher.search with one side switched off. Workaround until kb.py takes a mode argument: keyword
    mode hides the vector matrix (search skips the meaning side when no vectors are loaded); vector mode swaps in
    a keyword index that returns nothing. The index must not change while a mode is on (a reload would see the
    hidden state)."""
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}, not {mode!r}")
    if mode == "fused":
        yield
        return
    if mode == "keyword":
        saved = searcher.ids
        searcher.ids = np.zeros(0, dtype=np.int64)
        try:
            yield
        finally:
            searcher.ids = saved
    else:
        saved = searcher.keywords
        searcher.keywords = _NoKeywords()
        try:
            yield
        finally:
            searcher.keywords = saved


# ---------------------------------------------------------------- indexes

class HashEmbedder:
    """Deterministic stand-in for the embedding model (tests and the fixture run): words hashed into a 384-dim
    bag, so texts sharing words are close. Never downloads or loads a model."""
    mlx = None

    def __call__(self, texts, query: bool = False, batch_size: int = 16) -> np.ndarray:
        out = np.zeros((len(texts), kb.DIM), dtype=np.float32)
        for row, text in zip(out, texts):
            for word in re.findall(r"\w+", text.lower()):
                row[zlib.crc32(word.encode()) % kb.DIM] += 1
            row /= max(np.linalg.norm(row), 1e-9)
        return out


def _point_kb_at(home: Path, set_attr=setattr) -> None:
    if os.environ.get("VERITAS_DATA"):
        sys.exit("bench: unset VERITAS_DATA; the benchmark keeps its working copy under --out")
    set_attr(kb, "HOME", Path(home))
    set_attr(kb, "DB_PATH", Path(home) / "data" / "kb.sqlite")


def fixture_text(paper: dict) -> str:
    """A made-up paper as Zotero documents are written (zotero.documents): title, byline, abstract, full text."""
    byline = ", ".join(paper["authors"][:6]) + (" et al." if len(paper["authors"]) > 6 else "")
    parts = [f"# {paper['title']}", " · ".join(p for p in (byline, paper["year"], paper["venue"], paper["doi"]) if p),
             "## Abstract", paper["abstract"]]
    if paper["body"]:
        parts += ["## Full text", "\n\n".join(paper["body"] + ["References"] + paper["references"])]
    return "\n\n".join(parts)


def build_fixture_index(corpus: dict, home: Path, embedder=None, set_attr=setattr) -> kb.Searcher:
    """An index of the fixture corpus in `home`/data, vectors from `embedder` (default HashEmbedder)."""
    _point_kb_at(home, set_attr)
    embedder = embedder or HashEmbedder()
    searcher = kb.Searcher(writer=True)
    db = searcher.db
    now = time.time()
    for paper in corpus["papers"]:
        text = fixture_text(paper)
        meta = {"authors": paper["authors"], "year": paper["year"], "venue": paper["venue"], "doi": paper["doi"],
                "url": "", "citekey": paper["citekey"], "type": "journalArticle",
                "collection_keys": paper["collections"], "collections": []}
        kb.store_note(db, f"zotero/{paper['key']}", paper["title"], "zotero", "zotero", [], [], now, len(text), "",
                      meta, text)
    db.executemany("INSERT OR REPLACE INTO collections VALUES (?, ?, ?)",
                   [(c["key"], c["name"], c["parent"]) for c in corpus["collections"]])
    rows = db.execute("SELECT c.id, n.title, c.heading, c.text, c.path FROM chunks c JOIN notes n ON n.path=c.path "
                      "WHERE c.id NOT IN (SELECT id FROM vecs)").fetchall()
    vectors = embedder([kb._embed_text(t, h, x) for _, t, h, x, _ in rows]).astype(np.float16)
    db.executemany("INSERT OR REPLACE INTO vecs VALUES (?, ?, ?)",
                   [(r[0], r[4], v.tobytes()) for r, v in zip(rows, vectors)])
    kb.stamp(db, "indexed_at")
    kb.stamp(db, "vectors_at")
    db.commit()
    searcher.embed = embedder
    return searcher


def open_copy(db_path: Path, work: Path, embedder=None, set_attr=setattr) -> kb.Searcher:
    """A searcher over a private copy of `db_path` in `work`/data; the source is only ever opened read-only. The
    copy is reused while the source's size and mtime are unchanged."""
    db_path = Path(db_path).resolve()
    target = Path(work) / "data" / "kb.sqlite"
    stamp_file = target.parent / "copied-from.json"
    source = {"path": str(db_path), "size": db_path.stat().st_size, "mtime": db_path.stat().st_mtime}
    fresh = target.exists() and stamp_file.exists() and json.loads(stamp_file.read_text()) == source
    if not fresh:
        target.parent.mkdir(parents=True, exist_ok=True)
        for old in target.parent.glob("kb.sqlite*"):
            old.unlink()
        src = bench_queries.connect_readonly(db_path)
        dst = sqlite3.connect(target)
        src.backup(dst)
        dst.close()
        src.close()
        stamp_file.write_text(json.dumps(source))
    _point_kb_at(work, set_attr)
    searcher = kb.Searcher(writer=True)  # writes only the copy's own Tantivy folder, work/data/tantivy
    if embedder is not None:
        searcher.embed = embedder
    return searcher


# ---------------------------------------------------------------- running

def _filters(q: dict) -> dict:
    f = q.get("filters") or {}
    out = {}
    if f.get("collections"):
        out["collections"] = list(f["collections"])
    for key in ("year_from", "year_to"):
        if f.get(key) is not None:
            out[key] = int(f[key])
    return out


def _gold_texts(db: sqlite3.Connection, queries: list[dict]) -> dict[int, str]:
    ids = sorted({cid for q in queries for cid in q.get("gold_chunks") or []})
    out: dict[int, str] = {}
    for i in range(0, len(ids), 900):
        part = ids[i:i + 900]
        out.update(db.execute(f"SELECT id, text FROM chunks WHERE id IN ({','.join('?' * len(part))})", part))
    return out


def query_values(rec: dict) -> dict[str, float | None]:
    """Per-query metric values from one run record (what the summaries and paired deltas average)."""
    if rec["type"] == "no_answer":
        return {"empty_rate": float(rec["n_results"] == 0), "mean_results": float(rec["n_results"]),
                "distinct@10": float(rec["distinct"]), "latency_ms": rec["latency_ms"]}
    rank = rec["rank"]
    out = {"recall@1": recall_at(rank, 1), "recall@5": recall_at(rank, 5), "recall@10": recall_at(rank, 10),
           "mrr": reciprocal_rank(rank), "ndcg@10": ndcg_at(rank, 10), "distinct@10": float(rec["distinct"]),
           "latency_ms": rec["latency_ms"]}
    if rec["passage_hit"] is not None:
        out["passage_recall@5"] = float(rec["passage_hit"])
    return out


def aggregate(per_query: list[dict], n_boot: int = 1000, seed: int = 0) -> dict:
    groups: dict[tuple[str, str], list[dict]] = {}
    for rec in per_query:
        groups.setdefault((rec["mode"], f"{rec['type']}/{rec['subtype']}"), []).append(rec)
        if rec["type"] != "no_answer":
            groups.setdefault((rec["mode"], "all/answerable"), []).append(rec)
    out: dict[str, dict] = {}
    for (mode, group), recs in sorted(groups.items()):
        values = [query_values(r) for r in recs]
        cell: dict[str, dict] = {}
        names = [m for m in values[0] if m != "latency_ms"] + [m for v in values for m in v if m not in values[0]]
        for name in dict.fromkeys(names):
            cell_seed = seed + zlib.crc32(f"{mode}/{group}/{name}".encode()) % 100000
            cell[name] = summary([v.get(name) for v in values], None, n_boot, cell_seed)
        lat = [v["latency_ms"] for v in values]
        for q in (50, 95):
            cell[f"latency_p{q}_ms"] = summary(lat, lambda a, q=q: percentile(a, q), n_boot, seed + q)
        out.setdefault(mode, {})[group] = cell
    return out


def run_queries(searcher: kb.Searcher, queries: dict, modes=MODES, limit: int = 10, n_boot: int = 1000,
                seed: int = 0, label: str = "", progress: bool = False) -> dict:
    searcher._refresh()
    items = queries["queries"]
    gold_texts = _gold_texts(searcher.db, items)
    per_query: list[dict] = []
    for mode in modes:
        with search_mode(searcher, mode):
            searcher.search("warm up the model and caches", limit)
            started = time.time()
            for n, q in enumerate(items, 1):
                searcher._query_vectors.clear()  # every query pays for its own embedding, as a new one would
                t0 = time.perf_counter()
                hits = searcher.search(q["query"], limit, **_filters(q))
                ms = (time.perf_counter() - t0) * 1000
                gold = set(q["gold_papers"])
                texts = [gold_texts[c] for c in q.get("gold_chunks") or [] if c in gold_texts]
                per_query.append({
                    "id": q["id"], "mode": mode, "type": q["type"], "subtype": q["subtype"],
                    "rank": first_hit_rank(answer_paths(hits, gold), gold) if gold else None,
                    "n_results": len(hits), "distinct": distinct_papers(hits, 10), "latency_ms": round(ms, 3),
                    "passage_hit": passage_hit(hits, gold, texts, 5) if texts else None,
                    "top": [h["path"] for h in hits]})
                if progress and n % 200 == 0:
                    print(f"  {mode}: {n}/{len(items)} ({time.time() - started:.0f} s)", file=sys.stderr, flush=True)
    return {"version": 1, "label": label, "created": _dt.datetime.now().isoformat(timespec="seconds"),
            "git": _git_head(), "code": _code_fingerprint(), "queries_seed": queries.get("seed"), "queries_counts": queries.get("counts"),
            "index": queries.get("index"),
            "settings": {"modes": list(modes), "limit": limit, "n_boot": n_boot, "seed": seed,
                         "vector_gate": kb.VECTOR_GATE,
                         "embedder": type(searcher.embed).__name__ if searcher.embed is not None else None},
            "modes": aggregate(per_query, n_boot, seed), "per_query": per_query}


def _code_fingerprint() -> dict[str, str]:
    """Hashes of the search code actually run: the commit alone misses uncommitted edits."""
    import hashlib
    here = Path(__file__).resolve().parent
    return {name: hashlib.sha256((here / name).read_bytes()).hexdigest()[:12]
            for name in ("kb.py", "keyword_index.py", "zotero.py", "bench.py", "bench_queries.py") if (here / name).exists()}


def _git_head() -> str | None:
    """The checked-out commit, read from .git without running git."""
    try:
        head = (REPO / ".git" / "HEAD").read_text().strip()
        if head.startswith("ref: "):
            ref = REPO / ".git" / head[5:]
            if ref.exists():
                return ref.read_text().strip()
            packed = (REPO / ".git" / "packed-refs").read_text()
            return next((line.split()[0] for line in packed.splitlines() if line.endswith(head[5:])), None)
        return head
    except OSError:
        return None


# ---------------------------------------------------------------- reports

def _fmt(cell: dict | None, digits: int = 2) -> str:
    if not cell or cell.get("mean") is None:
        return "-"
    half = (cell["hi"] - cell["lo"]) / 2
    return f"{cell['mean']:.{digits}f}±{half:.{digits}f}"


def render_table(result: dict) -> str:
    cols = [("R@1", "recall@1"), ("R@5", "recall@5"), ("R@10", "recall@10"), ("MRR", "mrr"), ("nDCG", "ndcg@10"),
            ("pasR@5", "passage_recall@5"), ("dist", "distinct@10")]
    lines = [f"retrieval benchmark {result.get('label') or ''}  (git {(result.get('git') or '?')[:9]}, "
             f"embedder {result['settings'].get('embedder')}, gate {result['settings'].get('vector_gate')}; "
             "mean±half 95% CI)"]
    for mode, table in result["modes"].items():
        lines.append("")
        lines.append(f"[{mode}]")
        head = f"{'group':30s} {'n':>4s} " + " ".join(f"{c:>10s}" for c, _ in cols) + f" {'p50ms':>8s} {'p95ms':>8s}"
        lines.append(head)
        answerable = [g for g in table if not g.startswith("no_answer")]
        answerable.sort(key=lambda g: (g == "all/answerable", g))
        for group in answerable:
            cell = table[group]
            n = cell["recall@1"]["n"]
            lines.append(f"{group:30s} {n:4d} " + " ".join(f"{_fmt(cell.get(k)):>10s}" for _, k in cols)
                         + f" {_fmt(cell['latency_p50_ms'], 1):>8s} {_fmt(cell['latency_p95_ms'], 1):>8s}")
        for group in [g for g in table if g.startswith("no_answer")]:
            cell = table[group]
            lines.append(f"{group:30s} {cell['empty_rate']['n']:4d}  empty {_fmt(cell['empty_rate'])}"
                         f"  mean results {_fmt(cell['mean_results'], 1)}"
                         f"  p50 {_fmt(cell['latency_p50_ms'], 0)} ms")
    return "\n".join(lines)


COMPARE_METRICS = ("recall@1", "recall@10", "mrr", "ndcg@10", "passage_recall@5", "empty_rate", "latency_ms")


def compare(a: dict, b: dict, n_boot: int = 1000, seed: int = 0) -> str:
    """B minus A per mode, group and metric. Paired over queries when both runs used the same query ids, so the
    interval is for the change itself, not two separate intervals."""
    index_a = {(r["mode"], r["id"]): r for r in a["per_query"]}
    index_b = {(r["mode"], r["id"]): r for r in b["per_query"]}
    shared = index_a.keys() & index_b.keys()
    paired = bool(shared) and len(shared) == len(index_a) == len(index_b)
    lines = [f"compare {a.get('label') or 'A'} ({(a.get('git') or '?')[:9]}) -> {b.get('label') or 'B'} "
             f"({(b.get('git') or '?')[:9]}): "
             + (f"paired on {len(shared)} query runs" if paired else
                f"unpaired: the query sets differ ({len(shared)} shared runs); deltas of group means only")]
    for mode in [m for m in a["modes"] if m in b["modes"]]:
        lines += ["", f"[{mode}]", f"{'group':30s} {'metric':18s} {'A':>8s} {'B':>8s} {'B-A':>8s}  95% CI"]
        groups = [g for g in a["modes"][mode] if g in b["modes"][mode]]
        for group in groups:
            def recs(index):
                return {rid: r for (m, rid), r in index.items() if m == mode and
                        (f"{r['type']}/{r['subtype']}" == group or (group == "all/answerable" and r["type"] != "no_answer"))}
            ra, rb = recs(index_a), recs(index_b)
            ids = sorted(ra.keys() & rb.keys())
            for metric in COMPARE_METRICS:
                va = [query_values(ra[i]).get(metric) for i in ids]
                vb = [query_values(rb[i]).get(metric) for i in ids]
                pairs = [(x, y) for x, y in zip(va, vb) if x is not None and y is not None]
                if not pairs:
                    continue
                xa, xb = [p[0] for p in pairs], [p[1] for p in pairs]
                digits = 1 if metric == "latency_ms" else 3
                if paired:
                    d = paired_delta(xa, xb, n_boot, seed)
                    ci = f"[{d['lo']:+.{digits}f}, {d['hi']:+.{digits}f}]"
                    delta = d["delta"]
                else:
                    delta, ci = float(np.mean(xb) - np.mean(xa)), ""
                lines.append(f"{group:30s} {metric:18s} {np.mean(xa):8.{digits}f} {np.mean(xb):8.{digits}f} "
                             f"{delta:+8.{digits}f}  {ci}")
    return "\n".join(lines)


def compare_files(a: Path, b: Path) -> str:
    return compare(json.loads(Path(a).read_text()), json.loads(Path(b).read_text()))


def check_out_dir(path: Path) -> Path:
    """Query and result files hold library text: never inside the (public) repository."""
    resolved = Path(path).expanduser().resolve()
    if resolved == REPO or REPO in resolved.parents:
        raise SystemExit(f"bench: --out {path} is inside the repository; write benchmark files outside it")
    return Path(path).expanduser()


# ---------------------------------------------------------------- command line

def _write_run(result: dict, out: Path) -> None:
    name = f"results-{result['label'] or 'run'}"
    (out / f"{name}.json").write_text(json.dumps(result, ensure_ascii=False, indent=1))
    table = render_table(result)
    (out / f"{name}.txt").write_text(table + "\n")
    print(table)
    print(f"\nwrote {out / (name + '.json')}", file=sys.stderr)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("generate", "run", "all", "fixture"):
        p = sub.add_parser(name)
        p.add_argument("--out", required=True, type=Path, help="folder for queries/results (outside the repo)")
        if name != "fixture":
            p.add_argument("--db", type=Path, default=kb.DB_PATH, help="index to read (read-only)")
        if name in ("generate", "all", "fixture"):
            p.add_argument("--seed", type=int, default=0)
            p.add_argument("--per-type", type=int, default=200)
        if name in ("run", "all", "fixture"):
            p.add_argument("--label", default="baseline")
            p.add_argument("--modes", default=",".join(MODES))
            p.add_argument("--n-boot", type=int, default=1000)
            p.add_argument("--limit", type=int, default=10)
        if name in ("run", "all"):
            p.add_argument("--work", type=Path, help="working copy of the index (default OUT/work)")
            p.add_argument("--hash-embedder", action="store_true",
                           help="use the hash stand-in instead of the model (only meaningful for an index built with it)")
        if name == "run":
            p.add_argument("--queries", type=Path, required=True)
    c = sub.add_parser("compare")
    c.add_argument("a", type=Path)
    c.add_argument("b", type=Path)
    args = parser.parse_args(argv)

    if args.command == "compare":
        print(compare_files(args.a, args.b))
        return
    out = check_out_dir(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if args.command == "fixture":
        corpus = json.loads((Path(__file__).parent / "tests" / "fixtures" / "bench_corpus.json").read_text())
        searcher = build_fixture_index(corpus, out / "fixture-index")
        db = kb.DB_PATH
    else:
        db = args.db
    if args.command in ("generate", "all", "fixture"):
        queries = bench_queries.generate(db, seed=args.seed, per_type=args.per_type)
        (out / "queries.json").write_text(json.dumps(queries, ensure_ascii=False, indent=1))
        print(f"wrote {out / 'queries.json'}: {sum(queries['counts'].values())} queries "
              + ", ".join(f"{k} {v}" for k, v in queries["counts"].items()), file=sys.stderr)
        if args.command == "generate":
            return
    else:
        queries = json.loads(args.queries.read_text())
    modes = tuple(m.strip() for m in args.modes.split(",") if m.strip())
    if args.command != "fixture":
        searcher = open_copy(db, args.work or out / "work", HashEmbedder() if args.hash_embedder else None)
    result = run_queries(searcher, queries, modes, args.limit, args.n_boot, label=args.label, progress=True)
    _write_run(result, out)


if __name__ == "__main__":
    main()
