"""kb.py Searcher.search / _allowed: exclude_source (spec 005 unit A1).

Builds a tiny fixture index (two notes, one Zotero-sourced, one personal, sharing a keyword) in a temp DB and
temp Tantivy directory, and checks that `source=zotero` returns only the Zotero note and `exclude_source=zotero`
returns everything except it.
"""
from __future__ import annotations

import time

import pytest

import kb


@pytest.fixture()
def fixture_searcher(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "data" / "kb.sqlite")
    searcher = kb.Searcher(writer=True)
    now = time.time()
    searcher.db.execute(
        "INSERT INTO notes (path, title, folder, source, tags, mtime, size, frontmatter, meta) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("zotero/ABC123", "A paper about sleep", "zotero", "zotero", "", now, 100, "", None),
    )
    searcher.db.execute(
        "INSERT INTO notes (path, title, folder, source, tags, mtime, size, frontmatter, meta) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("personal/sleep-notes.md", "My sleep notes", "personal", "personal", "", now, 100, "", None),
    )
    searcher.db.execute(
        "INSERT INTO chunks (id, path, ord, heading, text) VALUES (1, ?, 0, NULL, ?)",
        ("zotero/ABC123", "This paper studies sleep deprivation in adults over several weeks."),
    )
    searcher.db.execute(
        "INSERT INTO chunks (id, path, ord, heading, text) VALUES (2, ?, 0, NULL, ?)",
        ("personal/sleep-notes.md", "My own notes on sleep habits and sleep tracking."),
    )
    searcher.db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('indexed_at', ?)", (str(now),))
    searcher.db.commit()
    return searcher


def test_source_zotero_returns_only_zotero(fixture_searcher):
    hits = fixture_searcher.search("sleep", limit=20, source="zotero")
    assert hits
    assert all(h["path"].startswith("zotero/") for h in hits)


def test_exclude_source_zotero_returns_no_zotero(fixture_searcher):
    hits = fixture_searcher.search("sleep", limit=20, exclude_source="zotero")
    assert hits
    assert all(not h["path"].startswith("zotero/") for h in hits)


def test_exclude_source_comma_list(fixture_searcher):
    # exclude_source accepts a comma list; excluding both sources leaves nothing.
    hits = fixture_searcher.search("sleep", limit=20, exclude_source="zotero,personal")
    assert hits == []


def test_allowed_none_when_no_filters(fixture_searcher):
    assert fixture_searcher._allowed(None, None, None) is None


def test_allowed_exclude_source_set(fixture_searcher):
    allowed = fixture_searcher._allowed(None, None, None, exclude_source="zotero")
    assert allowed == {"personal/sleep-notes.md"}


def _add_paper(searcher, key, year, text):
    import json
    searcher.db.execute(
        "INSERT INTO notes (path, title, folder, source, tags, mtime, size, frontmatter, meta) "
        "VALUES (?, ?, 'zotero', 'zotero', '', ?, 100, '', ?)",
        (f"zotero/{key}", f"Paper {key}", time.time(), json.dumps({"year": year})),
    )
    searcher.db.execute(
        "INSERT INTO chunks (id, path, ord, heading, text) VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM chunks), ?, 0, NULL, ?)",
        (f"zotero/{key}", text),
    )
    searcher.db.commit()


def test_year_range_keeps_only_papers_inside_it(fixture_searcher):
    # Year metadata may be a number or a string; a note with no year metadata never matches a year filter.
    _add_paper(fixture_searcher, "OLD", 2015, "sleep studies from long ago")
    _add_paper(fixture_searcher, "NEW", "2022", "sleep studies from recently")
    paths = lambda **kw: {h["path"] for h in fixture_searcher.search("sleep", limit=20, **kw)}
    assert paths(year_from=2020) == {"zotero/NEW"}
    assert paths(year_to=2016) == {"zotero/OLD"}
    assert paths(year_from=2010, year_to=2025) == {"zotero/OLD", "zotero/NEW"}
    assert "personal/sleep-notes.md" in paths()
    assert paths(year_from=1900) == {"zotero/OLD", "zotero/NEW"}


def _add_item(searcher, key, title, meta, text):
    import json
    searcher.db.execute(
        "INSERT INTO notes (path, title, folder, source, tags, mtime, size, frontmatter, meta) "
        "VALUES (?, ?, 'zotero', 'zotero', '', ?, 100, '', ?)",
        (f"zotero/{key}", title, time.time(), json.dumps(meta)),
    )
    searcher.db.execute(
        "INSERT INTO chunks (id, path, ord, heading, text) VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM chunks), ?, 0, NULL, ?)",
        (f"zotero/{key}", text),
    )
    searcher.db.commit()


def test_items_sharing_a_doi_are_one_result_listing_the_others(fixture_searcher):
    import json
    _add_item(fixture_searcher, "DUPA", "Sleep spindles", {"doi": "10.1000/xyz1"}, "sleep spindles sleep spindles sleep")
    _add_item(fixture_searcher, "DUPB", "Sleep spindles (copy)", {"doi": "10.1000/other"}, "sleep spindles in a copy")
    before = [h["path"] for h in fixture_searcher.search("sleep spindles", limit=20) if h["path"] in ("zotero/DUPA", "zotero/DUPB")]
    fixture_searcher.db.execute("UPDATE notes SET meta=? WHERE path='zotero/DUPB'", (json.dumps({"doi": "10.1000/XYZ1"}),))
    fixture_searcher.db.commit()
    hits = fixture_searcher.search("sleep spindles", limit=20)
    paths = [h["path"] for h in hits]
    best, other = before
    assert best in paths and other not in paths
    hit = next(h for h in hits if h["path"] == best)
    assert hit["duplicates"] == [other]
    assert set(hit) == {"path", "title", "source", "tags", "modified", "score", "passages", "zotero", "duplicates"}


def test_items_without_doi_collapse_on_title_and_year(fixture_searcher):
    _add_item(fixture_searcher, "T1", "Sleep and memory.", {"year": "2020"}, "sleep consolidates memory in adults")
    _add_item(fixture_searcher, "T2", "Sleep, and Memory", {"year": 2020}, "sleep and memory, another copy of the paper")
    _add_item(fixture_searcher, "T3", "Sleep and memory", {"year": "2011"}, "sleep and memory in an older paper")
    hits = {h["path"]: h for h in fixture_searcher.search("sleep memory", limit=20)}
    kept = [p for p in ("zotero/T1", "zotero/T2") if p in hits]
    assert len(kept) == 1
    assert hits[kept[0]]["duplicates"] == [({"zotero/T1", "zotero/T2"} - set(kept)).pop()]
    assert "zotero/T3" in hits and "duplicates" not in hits["zotero/T3"]


def test_results_without_duplicates_keep_their_shape(fixture_searcher):
    for hit in fixture_searcher.search("sleep", limit=20):
        assert "duplicates" not in hit


def test_a_personal_note_is_never_collapsed_into_a_paper(fixture_searcher):
    _add_item(fixture_searcher, "MYSLEEP", "My sleep notes", {}, "sleep notes from a paper with the same title")
    paths = {h["path"] for h in fixture_searcher.search("sleep notes", limit=20)}
    assert {"zotero/MYSLEEP", "personal/sleep-notes.md"} <= paths
