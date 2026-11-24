"""Benchmark runner (server/bench.py): modes, report, compare, and the rule that results stay out of the repo."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

import bench
import bench_queries as bq
import kb

CORPUS = json.loads((Path(__file__).parent / "fixtures" / "bench_corpus.json").read_text())


@pytest.fixture()
def searcher(tmp_path, monkeypatch):
    return bench.build_fixture_index(CORPUS, tmp_path, embedder=bench.HashEmbedder(), set_attr=monkeypatch.setattr)


@pytest.fixture()
def queries(searcher):
    db = Path(searcher.db.execute("PRAGMA database_list").fetchone()[2])
    return bq.generate(db, seed=1, per_type=4)


def test_modes_switch_one_side_off_and_restore(searcher):
    searcher._refresh()
    ids, keywords = searcher.ids, searcher.keywords
    doi = "10.5555/irb.2019.0606"
    with bench.search_mode(searcher, "keyword"):
        assert len(searcher.ids) == 0
        hits = searcher.search(doi, limit=10)
        assert hits and hits[0]["path"] == "zotero/FX06"
    with bench.search_mode(searcher, "vector"):
        assert searcher.keywords.search(["anything"], 10) == []
        assert searcher.search("zzqx vlorp", limit=10) == []  # nonsense: nothing above the vector gate
    assert searcher.ids is ids and searcher.keywords is keywords
    with pytest.raises(ValueError):
        with bench.search_mode(searcher, "both"):
            pass


def test_fused_mode_is_the_shipped_search(searcher):
    searcher._refresh()
    with bench.search_mode(searcher, "fused"):
        a = searcher.search("titanium K-edge core hole", limit=10)
    assert a == searcher.search("titanium K-edge core hole", limit=10)


def test_run_reports_every_group_and_mode(searcher, queries):
    result = bench.run_queries(searcher, queries, modes=("fused", "keyword", "vector"), n_boot=200, seed=0)
    groups = {f"{q['type']}/{q['subtype']}" for q in queries["queries"]}
    for mode in ("fused", "keyword", "vector"):
        table = result["modes"][mode]
        assert groups <= set(table)
        title = table["known_item/title"]
        for metric in ("recall@1", "recall@5", "recall@10", "mrr", "ndcg@10", "distinct@10", "latency_p50_ms",
                       "latency_p95_ms"):
            cell = title[metric]
            assert cell["n"] > 0 and cell["lo"] <= cell["mean"] <= cell["hi"]
        assert "passage_recall@5" in table["passage/passage"]
        assert "passage_recall@5" not in table["known_item/doi"]  # no gold chunk
        assert "empty_rate" in table["no_answer/no_answer_pseudo"]
        assert "recall@1" not in table["no_answer/no_answer_pseudo"]
    assert len(result["per_query"]) == 3 * len(queries["queries"])
    # Keyword search finds a DOI or a copied sentence in this tiny corpus every time.
    kw = result["modes"]["keyword"]
    assert kw["known_item/doi"]["recall@1"]["mean"] == 1.0
    assert kw["passage/passage"]["recall@5"]["mean"] == 1.0
    assert kw["passage/passage"]["passage_recall@5"]["mean"] == 1.0
    # Pseudo-words exist nowhere: keyword search returns nothing for them.
    assert kw["no_answer/no_answer_pseudo"]["empty_rate"]["mean"] == 1.0
    # Citekeys live only in the paper's metadata, which is not indexed (a finding, kept as a query type).
    assert kw["known_item/citekey"]["recall@10"]["mean"] == 0.0
    text = bench.render_table(result)
    assert "known_item/title" in text and "keyword" in text and "R@1" in text


def test_filters_are_passed_to_search(searcher, queries):
    filtered = [q for q in queries["queries"] if q["subtype"] == "filtered_year"][:1]
    seen = []
    real = searcher.search

    def spy(query, limit=8, **kwargs):
        seen.append(kwargs)
        return real(query, limit, **kwargs)

    searcher.search = spy
    bench.run_queries(searcher, {**queries, "queries": filtered}, modes=("fused",), n_boot=10, seed=0)
    assert seen and seen[-1]["year_from"] == filtered[0]["filters"]["year_from"]


def test_compare_prints_paired_deltas(searcher, queries, tmp_path):
    a = bench.run_queries(searcher, queries, modes=("keyword",), n_boot=50, seed=0)
    b = bench.run_queries(searcher, queries, modes=("keyword",), n_boot=50, seed=0)
    (tmp_path / "a.json").write_text(json.dumps(a))
    (tmp_path / "b.json").write_text(json.dumps(b))
    text = bench.compare_files(tmp_path / "a.json", tmp_path / "b.json")
    assert "known_item/title" in text and "paired" in text
    assert "+0.000" in text or " 0.000" in text


def test_out_dir_inside_the_repo_is_refused(tmp_path):
    with pytest.raises(SystemExit):
        bench.check_out_dir(Path(bench.__file__).resolve().parent / "bench-out")
    assert bench.check_out_dir(tmp_path / "out") == tmp_path / "out"


def test_hash_embedder_shape():
    v = bench.HashEmbedder()(["a b c", ""], query=True)
    assert v.shape == (2, kb.DIM) and np.isclose(np.linalg.norm(v[0]), 1.0)


def test_legacy_eval_still_imports():
    import eval as legacy
    assert len(legacy.CASES) == 11 and callable(legacy.main)
