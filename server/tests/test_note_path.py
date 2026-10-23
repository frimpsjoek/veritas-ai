"""kb.note_path for citations: chat cites papers as @<citation key> or, without Better BibTeX keys, @<Zotero item key>."""
from __future__ import annotations

import json
import sqlite3

import pytest

import kb


@pytest.fixture()
def index(monkeypatch):
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE notes(path TEXT PRIMARY KEY, source TEXT, meta TEXT)")
    db.executemany("INSERT INTO notes VALUES (?, 'zotero', ?)", [
        ("zotero/GAK94SHA", json.dumps({"citekey": ""})),
        ("zotero/ABCD1234", json.dumps({"citekey": "kontolati2024"})),
    ])
    monkeypatch.setattr(kb, "connect", lambda *a, **k: db)
    return db


def test_a_citation_key_names_its_item(index):
    assert kb.note_path("@kontolati2024") == "zotero/ABCD1234"


def test_a_zotero_item_key_after_at_names_that_item(index):
    assert kb.note_path("@GAK94SHA") == "zotero/GAK94SHA"


@pytest.mark.parametrize("ref", ["@NOTINLIB", "@nokey2020", "@../x"])
def test_unknown_citations_are_not_found(index, ref):
    with pytest.raises(FileNotFoundError):
        kb.note_path(ref)


def test_listed_folder_subfolder_named_zotero_is_a_note(tmp_path, monkeypatch):
    import sources
    notes = tmp_path / "lab"
    (notes / "zotero").mkdir(parents=True)
    (notes / "zotero" / "x.md").write_text("# x\n")
    monkeypatch.setattr(sources, "FILE", tmp_path / "sources.json")
    sources.save([{"name": "lab", "path": str(notes), "enabled": True, "skip": []}])
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "kb.sqlite")
    kb.reload_layout()
    try:
        assert kb.note_path("lab:/zotero/x.md") == "lab:/zotero/x.md"
    finally:
        monkeypatch.undo()
        kb.reload_layout()
