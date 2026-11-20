"""Retrieval benchmark metrics (server/bench.py): exact values worked out by hand."""
from __future__ import annotations

import math

import pytest

import bench


def test_first_hit_rank_is_one_based_and_takes_any_gold():
    ranked = ["zotero/A", "zotero/B", "zotero/C", "zotero/D"]
    assert bench.first_hit_rank(ranked, {"zotero/C"}) == 3
    assert bench.first_hit_rank(ranked, {"zotero/D", "zotero/B"}) == 2  # interchangeable answers: the first counts
    assert bench.first_hit_rank(ranked, {"zotero/X"}) is None
    assert bench.first_hit_rank([], {"zotero/A"}) is None


def test_recall_at_k():
    assert bench.recall_at(1, 1) == 1.0
    assert bench.recall_at(5, 5) == 1.0
    assert bench.recall_at(6, 5) == 0.0
    assert bench.recall_at(None, 10) == 0.0


def test_reciprocal_rank():
    assert bench.reciprocal_rank(1) == 1.0
    assert bench.reciprocal_rank(4) == 0.25
    assert bench.reciprocal_rank(None) == 0.0


def test_ndcg_one_answer_needed():
    # One relevant answer (IDCG = 1): nDCG@k = 1/log2(rank + 1) inside the cut-off, else 0.
    assert bench.ndcg_at(1, 10) == 1.0
    assert bench.ndcg_at(3, 10) == pytest.approx(0.5)  # 1/log2(4)
    assert bench.ndcg_at(2, 10) == pytest.approx(1 / math.log2(3))  # 0.6309...
    assert bench.ndcg_at(10, 10) == pytest.approx(1 / math.log2(11))
    assert bench.ndcg_at(11, 10) == 0.0
    assert bench.ndcg_at(None, 10) == 0.0


def test_mean_metrics_over_a_hand_set():
    ranks = [1, 3, None, 2]
    assert sum(bench.recall_at(r, 1) for r in ranks) / 4 == 0.25
    assert sum(bench.recall_at(r, 5) for r in ranks) / 4 == 0.75
    assert sum(bench.reciprocal_rank(r) for r in ranks) / 4 == pytest.approx((1 + 1 / 3 + 0 + 1 / 2) / 4)  # 0.458333


def test_percentile_linear():
    values = [10.0, 20.0, 30.0, 40.0, 50.0]
    assert bench.percentile(values, 50) == 30.0
    assert bench.percentile(values, 95) == pytest.approx(48.0)  # 40 + 0.8 * 10
    assert bench.percentile([], 50) is None


def test_bootstrap_constant_sample_has_zero_width():
    assert bench.bootstrap_ci([0.5] * 20, seed=1) == (0.5, 0.5)


def test_bootstrap_is_seeded_and_brackets_the_mean():
    values = [0, 1, 1, 0, 1, 1, 1, 0, 1, 0] * 3
    lo, hi = bench.bootstrap_ci(values, seed=7)
    assert (lo, hi) == bench.bootstrap_ci(values, seed=7)
    assert lo < 0.6 < hi
    assert 0.3 < lo and hi < 0.9


def test_bootstrap_of_a_percentile():
    lo, hi = bench.bootstrap_ci([1.0, 2.0, 3.0, 4.0, 100.0], stat=lambda v: bench.percentile(v, 50), seed=0)
    assert 1.0 <= lo <= 3.0 <= hi <= 100.0


def test_bootstrap_empty_sample():
    assert bench.bootstrap_ci([], seed=0) == (None, None)


def test_summary_fields():
    s = bench.summary([1.0, 0.0, 1.0, 1.0], seed=0)
    assert s["mean"] == 0.75 and s["n"] == 4 and s["lo"] <= 0.75 <= s["hi"]


def test_paired_delta():
    a = [0.0, 0.0, 1.0, 1.0]
    b = [1.0, 0.0, 1.0, 1.0]
    d = bench.paired_delta(a, b, seed=0)
    assert d["delta"] == 0.25
    assert d["lo"] <= 0.25 <= d["hi"] and d["lo"] >= 0.0


def _result(path, title, doi="", passages=()):
    return {"path": path, "title": title, "zotero": {"doi": doi} if doi else None,
            "passages": [{"heading": "h", "snippet": s} for s in passages]}


def test_distinct_papers_merges_copies():
    results = [_result("zotero/A", "Same Paper", "10.1/x"), _result("zotero/B", "Same paper!", "10.1/X"),
               _result("zotero/C", "Other"), _result("personal/n.md", "Same Paper")]
    # A and B share a DOI; C is another paper; the personal note is its own item (notes are never merged by title)
    assert bench.distinct_papers(results, 10) == 3
    assert bench.distinct_papers(results, 1) == 1


def test_passage_hit_matches_snippet_inside_gold_chunk():
    gold_text = "Alpha beta gamma. " * 40
    snippet = "…" + gold_text[60:480].strip() + "…"
    results = [_result("zotero/A", "t", passages=["unrelated text"]),
               _result("zotero/B", "t", passages=["other", snippet])]
    assert bench.passage_hit(results, {"zotero/B"}, [gold_text], 5) is True
    assert bench.passage_hit(results, {"zotero/A"}, [gold_text], 5) is False  # right text, wrong paper
    assert bench.passage_hit(results, {"zotero/B"}, [gold_text], 1) is False  # outside the top 1
    assert bench.passage_hit(results, {"zotero/B"}, [], 5) is False


def test_answer_paths_counts_a_listed_duplicate():
    hits = [{"path": "zotero/A"}, {"path": "zotero/B", "duplicates": ["zotero/C"]}]
    assert bench.answer_paths(hits, {"zotero/C"}) == ["zotero/A", "zotero/C"]
    assert bench.first_hit_rank(bench.answer_paths(hits, {"zotero/C"}), {"zotero/C"}) == 2
    assert bench.answer_paths(hits, {"zotero/B"}) == ["zotero/A", "zotero/B"]
