"""setup_suggest: what a new user could add, found on a fake home (spec 023 G1)."""
from __future__ import annotations

import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

import setup_suggest
import sources


def zotero_db(folder: Path) -> None:
    folder.mkdir(parents=True)
    db = sqlite3.connect(folder / "zotero.sqlite")
    db.executescript("""
        CREATE TABLE itemTypes(itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
        CREATE TABLE libraries(libraryID INTEGER PRIMARY KEY, type TEXT);
        CREATE TABLE items(itemID INTEGER PRIMARY KEY, itemTypeID INT, libraryID INT);
        INSERT INTO libraries VALUES (1, 'user'), (2, 'feed');
        CREATE TABLE deletedItems(itemID INT);
        INSERT INTO itemTypes VALUES (1, 'journalArticle'), (2, 'attachment'), (3, 'note'), (4, 'annotation'), (5, 'book');
        INSERT INTO items VALUES (1, 1, 1), (2, 1, 1), (3, 5, 1), (4, 2, 1), (5, 3, 1), (6, 4, 1), (7, 1, 1), (8, 1, 2);
        INSERT INTO deletedItems VALUES (7);
    """)
    db.commit()
    db.close()


@pytest.fixture()
def home(tmp_path, monkeypatch):
    zotero_db(tmp_path / "Zotero")
    vault = tmp_path / "Documents" / "Research" / "Notes"
    (vault / ".obsidian").mkdir(parents=True)
    for i in range(3):
        (vault / f"n{i}.md").write_text("note")
    papers = tmp_path / "Documents" / "Papers"
    papers.mkdir(parents=True)
    for i in range(6):
        (papers / f"p{i}.pdf").write_bytes(b"%PDF-1.4")
    few = tmp_path / "Downloads"
    few.mkdir()
    for i in range(3):
        (few / f"d{i}.pdf").write_bytes(b"%PDF-1.4")
    hidden = tmp_path / "Documents" / ".cache"
    hidden.mkdir()
    for i in range(9):
        (hidden / f"h{i}.pdf").write_bytes(b"%PDF-1.4")
    lib = tmp_path / "Library" / "Docs"
    lib.mkdir(parents=True)
    for i in range(9):
        (lib / f"l{i}.pdf").write_bytes(b"%PDF-1.4")
    monkeypatch.setattr(sources, "discover_zotero", lambda prefs=None: tmp_path / "Zotero")
    monkeypatch.setattr(sources, "folders", lambda: [SimpleNamespace(path=papers)])
    monkeypatch.setattr(sources, "resolved", lambda: SimpleNamespace(main=tmp_path / "Documents" / "Veritas"))
    return tmp_path


def test_finds_zotero_vaults_and_pdf_folders(home):
    out = setup_suggest.suggest(home)
    assert out["zotero"]["path"] == str(home / "Zotero")
    assert out["zotero"]["count"] == 3, "journal articles and books, not attachments, notes, annotations, RSS feed items or the trash"
    assert [v["path"] for v in out["vaults"]] == [str(home / "Documents" / "Research" / "Notes")]
    assert out["vaults"][0]["count"] == 3
    assert [p["path"] for p in out["pdf_folders"]] == [str(home / "Documents" / "Papers")], \
        "3 PDFs is too few; hidden folders and Library are skipped"
    assert out["pdf_folders"][0] == {**out["pdf_folders"][0], "count": 6, "listed": True}


def test_no_zotero_and_an_empty_home(tmp_path, monkeypatch):
    monkeypatch.setattr(sources, "discover_zotero", lambda prefs=None: None)
    monkeypatch.setattr(sources, "folders", lambda: [])
    monkeypatch.setattr(sources, "resolved", lambda: SimpleNamespace(main=tmp_path / "Documents" / "Veritas"))
    assert setup_suggest.suggest(tmp_path) == {"zotero": None, "vaults": [], "pdf_folders": []}


def test_display_shortens_the_home_folder():
    assert setup_suggest.display(Path.home() / "Zotero") == "~/Zotero"
    assert setup_suggest.display(Path("/Volumes/x")) == "/Volumes/x"
