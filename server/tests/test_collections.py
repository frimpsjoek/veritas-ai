"""Zotero collection tree + collection-key search (spec 008 Z1/Z2).

Checks, against whatever KB_DB / KB_ZOTERO the environment points at:
  - kb.py's `collections` table matches Zotero's own collections table (row count, every key/name/parent).
  - kb.zotero_collections() (the /zotero/collections route) returns the same keys with per-collection counts,
    sorted by name.
  - Searcher._allowed (what /search's collections= param uses) resolves a real parent collection's descendants
    and includes an item filed only in a child collection, while an unrelated collection excludes it.

Run with the .venv python: `.venv/bin/python -m pytest tests/test_collections.py -v`. Point KB_DB at a throwaway
copy (see specs/008-copilot-parity/spec.md) to avoid touching a live server's database.
"""
from __future__ import annotations

import pytest

import kb
import zotero

pytestmark = pytest.mark.skipif(not zotero.available(), reason="no local Zotero library")


@pytest.fixture(scope="module")
def db():
    connection = kb.connect()
    if not connection.execute("SELECT 1 FROM collections LIMIT 1").fetchone():
        pytest.skip("kb.sqlite has no collections rows yet; run `kb.py index` first")
    yield connection
    connection.close()


def test_collections_table_matches_zotero(db):
    live = {c["key"]: c for c in zotero.collection_tree()}
    stored = db.execute("SELECT key, name, parent FROM collections").fetchall()
    assert len(stored) == len(live)
    for key, name, parent in stored:
        assert live[key]["name"] == name
        assert live[key]["parent"] == parent


def test_zotero_collections_route_matches_table(db):
    rows = kb.zotero_collections()
    stored = {key: (name, parent) for key, name, parent in db.execute("SELECT key, name, parent FROM collections")}
    assert {r["key"] for r in rows} == set(stored)
    for r in rows:
        name, parent = stored[r["key"]]
        assert (r["name"], r["parent"]) == (name, parent)
    assert [r["name"] for r in rows] == sorted(r["name"] for r in rows)
    # a known parent/child pair actually exists in this library
    assert any(r["parent"] in stored for r in rows if r["parent"])


def _direct_items(db, key: str) -> list[str]:
    return [p for (p,) in db.execute(
        "SELECT path FROM notes WHERE source='zotero' AND EXISTS "
        "(SELECT 1 FROM json_each(meta, '$.collection_keys') je WHERE je.value=?)", (key,))]


def _find_parent_child_item(db):
    """A real (parent key, child key, item path) where the item is filed only in the child, not the parent."""
    children: dict[str, list[str]] = {}
    for key, _, parent in db.execute("SELECT key, name, parent FROM collections"):
        if parent is not None:
            children.setdefault(parent, []).append(key)
    for parent_key, kids in children.items():
        for child_key in kids:
            for path in _direct_items(db, child_key):
                if path not in _direct_items(db, parent_key):
                    return parent_key, child_key, path
    return None


def test_parent_key_search_includes_child_only_item(db):
    found = _find_parent_child_item(db)
    if not found:
        pytest.skip("no parent/child pair in this library has an item filed only in the child")
    parent_key, child_key, item_path = found
    searcher = kb.Searcher()
    item_keys = {r[0] for r in searcher.db.execute(
        "SELECT je.value FROM notes, json_each(notes.meta, '$.collection_keys') je WHERE notes.path=?", (item_path,))}

    allowed = searcher._allowed(None, None, None, collections=[parent_key])
    assert item_path in allowed, "a parent key's descendants must include an item filed only in a child collection"

    unrelated = next(
        (k for k, _, p in db.execute("SELECT key, name, parent FROM collections") if p is None and k not in item_keys),
        None)
    assert unrelated, "fixture needs an unrelated top-level collection to test exclusion"
    excluded = searcher._allowed(None, None, None, collections=[unrelated])
    assert item_path not in excluded, "an unrelated collection key must not include the item"
