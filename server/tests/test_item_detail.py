"""The reading view's item detail carries each highlight's position, so the web reader can draw it (spec 014 G3)."""
from __future__ import annotations

import json
import sqlite3

import zotero

SCHEMA = """
CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, libraryID INT, key TEXT);
CREATE TABLE deletedItems (itemID INT);
CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT);
CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE itemTags (itemID INT, tagID INT);
CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT);
CREATE TABLE collectionItems (collectionID INT, itemID INT);
CREATE TABLE itemNotes (itemID INT, parentItemID INT, note TEXT);
CREATE TABLE itemAttachments (itemID INT, parentItemID INT, contentType TEXT, path TEXT);
CREATE TABLE itemAnnotations (itemID INT, parentItemID INT, type INT, text TEXT, comment TEXT, color TEXT,
                              pageLabel TEXT, sortIndex TEXT, position TEXT);
INSERT INTO itemTypes VALUES (1, 'journalArticle'), (2, 'attachment'), (3, 'annotation');
INSERT INTO items VALUES (1, 1, 1, 'PAPER234'), (2, 2, 1, 'ATTACH23'), (3, 3, 1, 'HIGHL234'), (4, 3, 1, 'BROKEN23');
INSERT INTO fields VALUES (1, 'title');
INSERT INTO itemDataValues VALUES (1, 'Voles');
INSERT INTO itemData VALUES (1, 1, 1);
INSERT INTO itemAttachments VALUES (2, 1, 'application/pdf', 'storage:v.pdf');
"""
POSITION = {"pageIndex": 2, "rects": [[72.0, 700.5, 300.0, 712.0]]}


def test_highlights_carry_their_position_and_sort_index(tmp_path, monkeypatch):
    db = sqlite3.connect(tmp_path / "z.sqlite")
    db.executescript(SCHEMA)
    db.execute("INSERT INTO itemAnnotations VALUES (3, 2, 1, 'Voles cache seeds.', '', '#ffd400', '3', '00002|000010|00079', ?)",
               (json.dumps(POSITION),))
    db.execute("INSERT INTO itemAnnotations VALUES (4, 2, 1, 'No position.', '', '#ff6666', '4', '00003|000000|00000', 'not json')")
    db.commit()
    monkeypatch.setattr(zotero, "snapshot", lambda *a, **k: sqlite3.connect(tmp_path / "z.sqlite"))
    monkeypatch.setattr(zotero, "ZOTERO", tmp_path)
    [attachment] = zotero.item_detail("PAPER234")["attachments"]
    first, second = attachment["highlights"]
    assert first["position"] == POSITION and first["sort_index"] == "00002|000010|00079" and first["key"] == "HIGHL234"
    assert second["position"] is None and second["text"] == "No position."
