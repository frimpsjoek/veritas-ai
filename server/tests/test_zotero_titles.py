"""Zotero titles with rich-text markup are indexed as plain text, and the title guard still judges by them."""
from __future__ import annotations

import sqlite3

import pytest

import kb
import zotero

HTML_TITLE = "<i>GW</i> 100: Benchmarking <i>G</i><sub>0</sub><i>W</i><sub>0</sub> for Molecular Systems"
PLAIN = "GW 100: Benchmarking G0W0 for Molecular Systems"

SCHEMA = """
CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, libraryID INT, key TEXT, dateModified TEXT);
CREATE TABLE deletedItems (itemID INT);
CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT);
CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE itemTags (itemID INT, tagID INT);
CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, key TEXT);
CREATE TABLE collectionItems (collectionID INT, itemID INT);
CREATE TABLE itemNotes (itemID INT, parentItemID INT, note TEXT);
CREATE TABLE itemAttachments (itemID INT, parentItemID INT, contentType TEXT, path TEXT);
CREATE TABLE itemAnnotations (itemID INT, parentItemID INT, type INT, text TEXT, comment TEXT, color TEXT,
                              pageLabel TEXT, sortIndex TEXT, position TEXT);
INSERT INTO itemTypes VALUES (1, 'journalArticle'), (2, 'attachment');
INSERT INTO items VALUES (1, 1, 1, 'PAPERGW1', '2026-01-01 00:00:00'), (2, 2, 1, 'ATTACHG1', '2026-01-01 00:00:00');
INSERT INTO fields VALUES (1, 'title');
INSERT INTO itemDataValues VALUES (1, ?);
INSERT INTO itemData VALUES (1, 1, 1);
INSERT INTO itemAttachments VALUES (2, 1, 'application/pdf', 'storage:gw.pdf');
"""


@pytest.mark.parametrize("raw, plain", [
    (HTML_TITLE, PLAIN),
    ("Band gaps of CO<sub>2</sub>-reduction catalysts", "Band gaps of CO2-reduction catalysts"),
    ("Spin &amp; charge in <span style=\"font-variant:small-caps;\">Cu</span>  oxides", "Spin & charge in Cu oxides"),
    ("Defects with gap &lt; 2 eV", "Defects with gap < 2 eV"),
    ("The <psi|H|psi> expectation along <110>", "The <psi|H|psi> expectation along <110>"),
    ("  Plain\n title  ", "Plain title"),
])
def test_plain_title(raw, plain):
    assert zotero.plain_title(raw) == plain


def _library(tmp_path, monkeypatch, cached_text: str):
    script = SCHEMA.replace("?", "'" + HTML_TITLE.replace("'", "''") + "'")
    db = sqlite3.connect(tmp_path / "z.sqlite")
    db.executescript(script)
    db.commit()
    db.close()
    (tmp_path / "storage" / "ATTACHG1").mkdir(parents=True)
    (tmp_path / "storage" / "ATTACHG1" / ".zotero-ft-cache").write_text(cached_text)
    monkeypatch.setattr(zotero, "snapshot", lambda *a, **k: sqlite3.connect(tmp_path / "z.sqlite"))
    monkeypatch.setattr(zotero, "ZOTERO", tmp_path)


def test_documents_store_the_plain_title(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, "Unrelated text about cooking pasta. " * 30)
    [doc] = zotero.documents()
    assert doc.title == PLAIN
    assert doc.text.split("\n")[0] == f"# {PLAIN}"


def test_full_text_matching_the_plain_title_is_kept(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, "We benchmark G0W0 quasiparticle energies for molecular systems. " * 10)
    [doc] = zotero.documents()
    assert "## Full text" in doc.text


def test_full_text_of_another_document_is_still_dropped(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, "Unrelated text about cooking pasta. " * 30)
    [doc] = zotero.documents()
    assert "## Full text" not in doc.text and "pasta" not in doc.text


def test_guard_reads_subscripts_as_one_word():
    # G<sub>0</sub>W<sub>0</sub> is the word g0w0, not g, 0, w, 0 (which a text could only miss).
    title = "<i>G</i><sub>0</sub><i>W</i><sub>0</sub> ionization of zeolite clusters"
    assert zotero.text_belongs_to_item(title, "", "G0W0 ionization energies of small molecules.")
    assert not zotero.text_belongs_to_item(title, "", "A recipe for bread and soup. " * 20)


def test_store_note_keeps_zotero_titles_plain(tmp_path, monkeypatch):
    # Online libraries (zotero_web) hand raw titles to kb; the notes row holds the plain one.
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "kb.sqlite")
    db = kb.connect()
    kb.store_note(db, "lab:/zotero/WEBKEY01", HTML_TITLE, "zotero", "zotero", [], [], 1.0, 10, "", {}, "Body.")
    assert db.execute("SELECT title FROM notes").fetchone()[0] == PLAIN
