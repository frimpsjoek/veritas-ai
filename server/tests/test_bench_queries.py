"""Benchmark query generator (server/bench_queries.py) against the made-up fixture corpus."""
from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path

import pytest

import bench
import bench_queries as bq

CORPUS = json.loads((Path(__file__).parent / "fixtures" / "bench_corpus.json").read_text())
PAPERS = {f"zotero/{p['key']}": p for p in CORPUS["papers"]}


@pytest.fixture()
def fixture_db(tmp_path, monkeypatch):
    searcher = bench.build_fixture_index(CORPUS, tmp_path, embedder=bench.HashEmbedder(), set_attr=monkeypatch.setattr)
    db = Path(searcher.db.execute("PRAGMA database_list").fetchone()[2])
    searcher.db.close()
    return db


@pytest.fixture()
def generated(fixture_db):
    return bq.generate(fixture_db, seed=3, per_type=6)


def by_type(generated, subtype):
    return [q for q in generated["queries"] if q["subtype"] == subtype]


# ---------------------------------------------------------------- pure helpers

def test_sentences_split_and_normalise():
    text = "First sentence here.  Second one\nruns over a line! Third? (Fourth) starts with a bracket."
    assert bq.sentences(text) == ["First sentence here.", "Second one runs over a line!", "Third?",
                                  "(Fourth) starts with a bracket."]


@pytest.mark.parametrize("sentence", [
    "Lindqvist, A. and Moreau, B. Pre-edge features in transition metal oxides. Invented Phys. Rev. 12, 345 (2015).",
    "Okafor, C. et al. Supercell convergence for core-level spectra.",
    "See https://example.org/data for the files.",
    "Values 1, 2, 3, 4, 5, 6, 7, 8 and 9 were used in 10 runs of 11 steps.",
])
def test_reference_like(sentence):
    assert bq.is_reference_like(sentence)


def test_prose_is_not_reference_like():
    assert not bq.is_reference_like("The polaron hops between neighbouring titanium atoms with a small activation energy.")


def test_strip_title_words():
    title = "Excitons in hexagonal boron nitride from the Bethe-Salpeter equation"
    out = bq.strip_title_words("Bound excitons dominate the optical absorption of hexagonal boron nitride crystals.", title)
    assert out == "Bound dominate the optical absorption of crystals."


def test_entity_tokens_by_kind():
    text = ("We measure the Ti K-edge and X-ray spectra of TiO2 and CsPbBr3 with G0W0 and Hartree-Fock, "
            "following Núñez and Schrödinger; the years 2019-2020 and 4x4x6 grids are not entities.")
    tokens = bq.entity_tokens(text)
    assert {"K-edge", "X-ray", "Hartree-Fock"} <= set(tokens["hyphen"])
    assert "2019-2020" not in tokens["hyphen"]
    assert {"TiO2", "CsPbBr3", "G0W0"} <= set(tokens["formula"])
    assert {"Núñez", "Schrödinger"} <= set(tokens["accent"])


def test_surname():
    assert bq.surname("Søren Ødegård") == "Ødegård"
    assert bq.surname("Lovelace, Ada") == "Lovelace"
    assert bq.surname("Ana María Gómez") == "Gómez"
    assert bq.surname("") == ""


# ---------------------------------------------------------------- generation

def test_every_type_is_generated(generated):
    subtypes = {q["subtype"] for q in generated["queries"]}
    assert subtypes == {"title", "author_year", "doi", "citekey", "abstract", "passage", "entity_hyphen",
                        "entity_formula", "entity_accent", "filtered_collection", "filtered_year",
                        "no_answer_pseudo", "no_answer_words"}
    assert all(1 <= generated["counts"][s] <= 6 for s in subtypes)
    ids = [q["id"] for q in generated["queries"]]
    assert len(ids) == len(set(ids))


def test_generation_is_deterministic(fixture_db):
    a = bq.generate(fixture_db, seed=3, per_type=6)
    b = bq.generate(fixture_db, seed=3, per_type=6)
    c = bq.generate(fixture_db, seed=4, per_type=6)
    assert a["queries"] == b["queries"]
    assert a["queries"] != c["queries"]


def test_title_fragments(generated):
    for q in by_type(generated, "title"):
        words = q["query"].split()
        assert 4 <= len(words) <= 6
        gold_title = PAPERS[q["gold_papers"][0]]["title"]
        assert q["query"] in " ".join(gold_title.split())
        for path in q["gold_papers"]:  # every paper whose title holds the fragment is an acceptable answer
            assert q["query"].lower() in PAPERS[path]["title"].lower()


def test_doi_and_copies(generated):
    for q in by_type(generated, "doi"):
        doi = q["query"]
        assert set(q["gold_papers"]) == {p for p, v in PAPERS.items() if v["doi"].lower() == doi.lower()}
    copies = [q for q in generated["queries"] if "zotero/FX09" in q["gold_papers"] and q["type"] == "known_item"
              and q["subtype"] in ("doi", "title")]
    for q in copies:
        assert "zotero/FX10" in q["gold_papers"]  # the same paper filed twice: either copy answers it


def test_author_year_gold_is_every_match(generated):
    for q in by_type(generated, "author_year"):
        name, year = q["query"].rsplit(" ", 1)
        expect = {p for p, v in PAPERS.items() if v["authors"] and bq.surname(v["authors"][0]) == name and v["year"] == year}
        assert set(q["gold_papers"]) == expect


def test_citekeys(generated):
    for q in by_type(generated, "citekey"):
        assert PAPERS[q["gold_papers"][0]]["citekey"] == q["query"]
        assert set(q["gold_papers"]) == {p for p, v in PAPERS.items()
                                        if v["doi"] and v["doi"] == PAPERS[q["gold_papers"][0]]["doi"]} | {q["gold_papers"][0]}


def test_abstract_sentences_lose_title_words(generated):
    for q in by_type(generated, "abstract"):
        paper = PAPERS[q["gold_papers"][0]]
        title_words = {w.lower() for w in re.findall(r"[\w-]+", paper["title"]) if len(w) > 2} - bq.STOPWORDS
        assert not {w.lower() for w in re.findall(r"[\w-]+", q["query"])} & title_words
        assert len(q["query"].split()) >= 6
        assert q["source_sentence"] in " ".join(paper["abstract"].split())


def test_passages_have_gold_chunks(generated, fixture_db):
    import sqlite3
    db = sqlite3.connect(f"file:{fixture_db}?mode=ro", uri=True)
    for q in by_type(generated, "passage"):
        assert q["gold_chunks"]
        assert not bq.is_reference_like(q["query"])
        for cid in q["gold_chunks"]:
            path, text = db.execute("SELECT path, text FROM chunks WHERE id=?", (cid,)).fetchone()
            assert path in q["gold_papers"]
            assert q["query"] in " ".join(text.split())


def test_entity_queries_hold_their_token(generated):
    for kind in ("hyphen", "formula", "accent"):
        for q in by_type(generated, f"entity_{kind}"):
            assert q["token"] in q["query"].split() or q["token"] in q["query"]
            assert q["token"] in bq.entity_tokens(q["query"])[kind]
            assert 5 <= len(q["query"].split()) <= 8


def test_filtered_queries_satisfy_their_filter(generated):
    for q in by_type(generated, "filtered_collection"):
        (key,) = q["filters"]["collections"]
        assert key in PAPERS[q["gold_papers"][0]]["collections"]
    for q in by_type(generated, "filtered_year"):
        f = q["filters"]
        assert f["year_to"] - f["year_from"] == 2
        for path in q["gold_papers"]:
            assert f["year_from"] <= int(PAPERS[path]["year"]) <= f["year_to"]


def test_no_answer_words_are_not_in_the_corpus(generated):
    corpus_words = set()
    for p in CORPUS["papers"]:
        corpus_words |= {w.lower() for w in re.findall(r"\w+", json.dumps(p, ensure_ascii=False))}
    for q in generated["queries"]:
        if q["type"] == "no_answer":
            assert q["gold_papers"] == []
            assert not {w.lower() for w in q["query"].split()} & corpus_words


def test_reads_a_read_only_index(fixture_db):
    for name in os.listdir(fixture_db.parent):
        if name.startswith("kb.sqlite-"):
            os.remove(fixture_db.parent / name)
    before = fixture_db.read_bytes()
    fixture_db.chmod(stat.S_IRUSR)
    try:
        out = bq.generate(fixture_db, seed=0, per_type=2)
    finally:
        fixture_db.chmod(stat.S_IRUSR | stat.S_IWUSR)
    assert out["queries"]
    assert fixture_db.read_bytes() == before
