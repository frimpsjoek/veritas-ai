"""Reading radar server functions (spec 012 R1) against a temp index with a fake, deterministic embedder."""
from __future__ import annotations

import threading
import json
import re
import time
import zlib

import numpy as np
import pytest

import kb
import radar_api


class FakeEmbedder:
    """Hashes words into a 384-dim bag: texts sharing words are close, unrelated texts are near orthogonal."""

    def __call__(self, texts, query=False, batch_size=16):
        out = np.zeros((len(texts), kb.DIM), dtype=np.float32)
        for row, text in zip(out, texts):
            for word in re.findall(r"[a-z]+", text.lower()):
                row[zlib.crc32(word.encode()) % kb.DIM] += 1
            row /= max(np.linalg.norm(row), 1e-9)
        return out


PAPERS = [  # key, title, abstract, collection keys, authors, venue
    ("AAA", "Machine learning potentials for molecules", "neural network potentials predict molecule energies",
     ["CHILD"], ["Ada Lovelace", "Alan Turing"], "J Chem Phys"),
    ("BBB", "Neural network force fields", "learning force fields from quantum chemistry data",
     ["PARENT"], ["Ada Lovelace"], "J Chem Phys"),
    ("CCC", "Sourdough bread fermentation", "wild yeast dough rising bakery flour",
     ["OTHER"], ["Julia Child"], "Cooking Science"),
]


@pytest.fixture()
def searcher(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "data" / "kb.sqlite")
    monkeypatch.setattr(kb, "VAULT", tmp_path / "vault")
    s = kb.Searcher(writer=True)
    s.embed = FakeEmbedder()
    for i, (key, title, abstract, cols, authors, venue) in enumerate(PAPERS, 1):
        meta = {"authors": authors, "year": "2024", "venue": venue, "doi": f"10.1/{key}", "citekey": f"ck{key}",
                "collection_keys": cols}
        s.db.execute("INSERT INTO notes (path, title, folder, source, tags, mtime, size, frontmatter, meta) "
                     "VALUES (?, ?, 'zotero', 'zotero', '', ?, 1, '', ?)",
                     (f"zotero/{key}", title, time.time(), json.dumps(meta)))
        s.db.execute("INSERT INTO chunks (id, path, ord, heading, text) VALUES (?, ?, 0, ?, ?)",
                     (i, f"zotero/{key}", f"{title} > Abstract", abstract))
        s.db.execute("INSERT INTO vecs (id, path, vec) VALUES (?, ?, ?)",
                     (i, f"zotero/{key}", s.embed([f"{title} {abstract}"])[0].astype(np.float16).tobytes()))
    s.db.executemany("INSERT INTO collections VALUES (?, ?, ?)",
                     [("PARENT", "Parent", None), ("CHILD", "Child", "PARENT"), ("OTHER", "Other", None)])
    s.db.execute("INSERT OR REPLACE INTO meta VALUES ('indexed_at', ?)", (str(time.time()),))
    s.db.commit()
    return s


def keys(result):
    return {i["key"] for i in result["items"]}


def test_items_whole_library_and_fields(searcher):
    result = radar_api.items(searcher.db, None)
    assert keys(result) == {"AAA", "BBB", "CCC"}
    a = next(i for i in result["items"] if i["key"] == "AAA")
    assert a == {"key": "AAA", "doi": "10.1/AAA", "title": PAPERS[0][1], "year": "2024", "citekey": "ckAAA",
                 "authors": ["Ada Lovelace", "Alan Turing"], "venue": "J Chem Phys", "abstract": PAPERS[0][2]}


def test_items_scope_includes_descendants(searcher):
    assert keys(radar_api.items(searcher.db, ["PARENT"])) == {"AAA", "BBB"}
    assert keys(radar_api.items(searcher.db, ["CHILD"])) == {"AAA"}
    assert keys(radar_api.items(searcher.db, ["CHILD", "OTHER"])) == {"AAA", "CCC"}


def test_items_hides_private_paths(searcher):
    assert "AAA" not in keys(radar_api.items(searcher.db, None, {"zotero/AAA"}))


def _score(searcher, **extra):
    body = {"scope": {"collections": ["PARENT"]}, "positives": [], "negatives": [],
            "items": [{"id": "on", "text": "neural network potentials for molecule energies"},
                      {"id": "off", "text": "wild yeast sourdough bakery"}], **extra}
    return radar_api.score(searcher, body, threading.Lock())["scores"]


def test_scores_rank_matching_text_first(searcher):
    scores = _score(searcher)
    assert scores["on"]["similarity"] > scores["off"]["similarity"] + 0.2
    assert scores["on"]["negative"] == 0.0


def test_scope_changes_the_centroid(searcher):
    scores = _score(searcher, scope={"collections": ["OTHER"]})
    assert scores["off"]["similarity"] > scores["on"]["similarity"]


def test_positives_shift_similarity(searcher):
    base = _score(searcher)["off"]["similarity"]
    shifted = _score(searcher, positives=["wild yeast sourdough bakery flour"])["off"]["similarity"]
    assert shifted > base + 0.05


def test_negatives_give_negative_score(searcher):
    scores = _score(searcher, negatives=["sourdough bakery yeast"])
    assert scores["off"]["negative"] > 0.8
    assert scores["on"]["negative"] < 0.3


def test_score_caps_items(searcher):
    with pytest.raises(ValueError):
        radar_api.score(searcher, {"items": [{"id": str(i), "text": "x"} for i in range(501)]}, threading.Lock())
    big = radar_api.score(searcher, {"items": [{"id": str(i), "text": "molecule"} for i in range(500)]}, threading.Lock())
    assert len(big["scores"]) == 500


def test_profile_is_scope_specific(searcher):
    chem = radar_api.profile(searcher.db, ["PARENT"])
    food = radar_api.profile(searcher.db, ["OTHER"])
    chem_terms = {t["text"] for t in chem["topics"]}
    food_terms = {t["text"] for t in food["topics"]}
    assert any("network" in t for t in chem_terms)
    assert any("sourdough" in t for t in food_terms)
    assert not any("sourdough" in t or "bakery" in t for t in chem_terms)
    assert all(" " in t for t in chem_terms | food_terms), "topics are phrases, not single words"
    assert all(0 < t["weight"] <= 1 for t in chem["topics"]) and max(t["weight"] for t in chem["topics"]) == 1
    assert chem["authors"][0] == {"name": "Ada Lovelace", "count": 2}
    assert chem["journals"] == [{"name": "J Chem Phys", "count": 2}]


@pytest.fixture()
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "VAULT", tmp_path / "vault")
    (tmp_path / "vault").mkdir()
    return tmp_path / "vault"


def test_digest_written_atomically(vault):
    result = radar_api.put_digest("2026-10-11 Daily (radar)", "# hi\n")
    target = vault / "Second Brain" / "Digests" / "2026-10-11 Daily (radar).md"
    assert target.read_text() == "# hi\n" and result["path"].endswith("(radar).md")
    radar_api.put_digest("2026-10-11 Daily (radar)", "# again\n")
    assert target.read_text() == "# again\n"
    assert [p.name for p in target.parent.iterdir()] == [target.name]  # no temp file left behind


@pytest.mark.parametrize("name", ["../evil", "a/b", "..", "", "x" * 121, " lead", "a\\b", "..%2f"])
def test_digest_rejects_bad_names(vault, name):
    with pytest.raises(radar_api.BadName):
        radar_api.put_digest(name, "x")
    assert not list(vault.rglob("*.md"))


def test_digest_rejects_oversize(vault):
    with pytest.raises(radar_api.TooLarge):
        radar_api.put_digest("big", "x" * (512 * 1024 + 1))


@pytest.fixture()
def api(searcher, vault, tmp_path, monkeypatch):
    import http.client
    import threading
    from http.server import ThreadingHTTPServer

    import http_api

    token_file = tmp_path / "api-token"
    token_file.write_text("sekret")
    monkeypatch.setattr(http_api, "TOKEN_FILE", token_file)
    monkeypatch.setattr(http_api, "SEARCHER", searcher)
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def call(method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
        conn.request(method, path, json.dumps(body).encode() if body is not None else None,
                     {"X-KB-Client": "agent", **(headers or {})})
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, json.loads(raw)

    yield call
    server.shutdown()
    server.server_close()


def test_routes_reachable_by_agents(api, vault):
    status, got = api("GET", "/zotero/items?collections=CHILD")
    assert status == 200 and [i["key"] for i in got["items"]] == ["AAA"]
    status, got = api("POST", "/radar/score", {"scope": {"collections": None}, "items": [{"id": "x", "text": "molecule"}]})
    assert status == 200 and set(got["scores"]["x"]) == {"similarity", "negative"}
    status, got = api("POST", "/radar/profile", {"scope": {"collections": ["OTHER"]}})
    assert status == 200 and got["journals"] == [{"name": "Cooking Science", "count": 1}]
    assert api("POST", "/radar/score", {"items": [{"id": str(i), "text": "x"} for i in range(501)]})[0] == 400
    assert api("PUT", "/digests/Day%201", {"text": "ok"})[0] == 200
    assert (vault / "Second Brain" / "Digests" / "Day 1.md").read_text() == "ok"
    assert api("PUT", "/digests/..%2Fescape", {"text": "x"})[0] == 400
    assert api("PUT", "/digests/big", {"text": "x" * 600_000})[0] == 413
    assert api("PUT", "/skills/Demo", {"text": "x"})[0] == 403  # agents still cannot write skills


def test_items_slim_drops_abstracts_and_long_author_lists(searcher):
    full = {i["key"]: i for i in radar_api.items(searcher.db, None)["items"]}
    slim = radar_api.items(searcher.db, None, slim=True)["items"]
    assert slim and all("abstract" not in i and len(i["authors"]) <= 3 for i in slim)
    assert {i["key"] for i in slim} == set(full)
    assert all(i["title"] == full[i["key"]]["title"] and i["doi"] == full[i["key"]]["doi"] for i in slim)


# ---------------------------------------------------------------- seeds (spec 021)

def test_seed_scores_name_the_closest_seed(searcher):
    scores = _score(searcher, seeds={"keys": ["AAA", "CCC"]})
    assert scores["on"]["seed_best"] == "zotero/AAA" and scores["off"]["seed_best"] == "zotero/CCC"
    assert scores["on"]["seed_max"] > 0.5 and scores["off"]["seed_max"] > 0.5
    only_aaa = _score(searcher, seeds={"keys": ["AAA"]})
    assert only_aaa["off"]["seed_max"] < 0.3, "one close seed is what counts, not the library average"


def test_seeds_from_a_collection_and_from_text(searcher):
    scores = _score(searcher, seeds={"collections": ["OTHER"], "texts": [{"title": "My paper", "text": "neural network potentials molecule"}]})
    assert scores["off"]["seed_best"] == "zotero/CCC"
    assert scores["on"]["seed_best"] == "text:My paper"
    assert "seed_max" not in _score(searcher)["on"], "no seeds: the old answer, unchanged"


def test_fulltext_reads_whole_papers_once_and_compares_them(searcher, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(radar_api, "ARXIV_SPACING", 0.0)
    monkeypatch.setattr(radar_api.media, "pdf_text", lambda path, max_pages=300, ocr=True: "## Page 1\n\n" + "neural network potentials molecule energies " * 30)
    fetch = lambda arxiv: calls.append(arxiv) or b"%PDF fake"  # noqa: E731
    body = {"seeds": {"keys": ["AAA", "CCC"]}, "items": [{"id": "p1", "arxiv": "2410.01234v2"}, {"id": "p2", "arxiv": "not-an-id"}]}
    cache = tmp_path / "ft.sqlite"
    result = radar_api.fulltext(searcher, body, threading.Lock(), cache_path=cache, fetch=fetch)["scores"]
    assert result["p1"]["seed_best"] == "zotero/AAA" and result["p1"]["seed_max"] > 0.5 and result["p1"]["chars"] > 100
    assert result["p2"] == {"error": "not an arXiv paper"}
    radar_api.fulltext(searcher, body, threading.Lock(), cache_path=cache, fetch=fetch)
    assert calls == ["2410.01234"], "the second run reads the cache, not arXiv"


def test_fulltext_keeps_going_when_one_pdf_fails(searcher, tmp_path, monkeypatch):
    monkeypatch.setattr(radar_api, "ARXIV_SPACING", 0.0)
    def fetch(arxiv):
        raise OSError("HTTP 404")
    result = radar_api.fulltext(searcher, {"seeds": {"keys": ["AAA"]}, "items": [{"id": "x", "arxiv": "2410.00001"}]},
                                threading.Lock(), cache_path=tmp_path / "ft.sqlite", fetch=fetch)["scores"]
    assert result["x"]["error"].startswith("OSError")


def test_arxiv_requests_are_spaced(monkeypatch):
    monkeypatch.setattr(radar_api, "ARXIV_SPACING", 0.2)
    radar_api._arxiv_last[0] = 0.0
    started = time.monotonic()
    for _ in range(3):
        radar_api.fetch_arxiv_pdf("2410.00001", fetch=lambda a: b"x")
    assert time.monotonic() - started >= 0.4


def test_calibration_separates_related_from_unrelated(searcher, tmp_path, monkeypatch):
    unrelated = [{"title": "Galaxy rotation curves", "abstract": "dark matter halo stars spiral galaxy"},
                 {"title": "Medieval trade routes", "abstract": "merchants silk caravans markets history"}]
    result = radar_api.calibrate(searcher, {"seeds": {"keys": ["AAA", "BBB", "CCC"]}, "unrelated": unrelated}, threading.Lock(),
                                 cache_path=tmp_path / "ft.sqlite")
    a = result["abstract"]
    assert result["seeds"] == 3 and a["n_related"] == 3 and a["n_unrelated"] == 2
    assert a["unrelated"]["p95"] < a["threshold"], a
    assert result["full"] is None, "no unrelated arXiv ids given: no whole-paper threshold"
    with pytest.raises(ValueError):
        radar_api.calibrate(searcher, {"seeds": {"keys": ["AAA"]}}, threading.Lock())


def test_profile_from_seeds_only(searcher):
    topics = [t["text"] for t in radar_api.profile(searcher.db, None, keys=["CCC"])["topics"]]
    assert topics and all("sourdough" in t or "bread" in t or "fermentation" in t for t in topics), topics


def test_a_seed_close_to_everything_stops_winning_by_default():
    matrix = np.array([[1.0, 0.0], [0.6, 0.8]], dtype=np.float32)  # seed "hub" sits between everything
    labels = ["zotero/SPECIFIC", "zotero/HUB"]
    paper = np.array([0.8, 0.6], dtype=np.float32)  # specific 0.80, hub 0.96
    assert radar_api._closest(matrix, labels, paper)[1] == "zotero/HUB"
    margin, label, raw = radar_api._closest(matrix, labels, radar_api._unit(paper), np.array([0.2, 0.6], dtype=np.float32))
    assert label == "zotero/SPECIFIC" and abs(raw - 0.8) < 1e-5 and abs(margin - 0.6) < 1e-5, "the margin decides, the similarity is shown"
    base = radar_api._baseline({"baseline": {"labels": labels, "abstract": [0.2, 0.6]}}, labels, "abstract")
    assert radar_api._closest(matrix, labels, paper, base)[1] == "zotero/SPECIFIC"
    assert radar_api._baseline({}, labels, "abstract") is None


def test_calibration_with_the_field_sets_baselines_and_keeps_its_closest_tenth(searcher, tmp_path):
    field = [{"title": f"Force field paper {i}", "abstract": "neural network force fields molecules energies " + "x" * i} for i in range(20)]
    unrelated = [{"title": "Medieval trade routes", "abstract": "merchants silk caravans markets history"}]
    result = radar_api.calibrate(searcher, {"seeds": {"keys": ["AAA", "BBB", "CCC"]}, "unrelated": unrelated, "field": field},
                                 threading.Lock(), cache_path=tmp_path / "ft.sqlite")
    base = result["baseline"]
    assert base["labels"] == ["zotero/AAA", "zotero/BBB", "zotero/CCC"]
    assert base["abstract"][0] > base["abstract"][2], "the field is chemistry, so the bread seed has the lowest baseline"
    a = result["abstract"]
    assert "field_cut" in a and a["threshold"] >= a["field_cut"]
    assert result["field"]["abstracts"] == 20
