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
