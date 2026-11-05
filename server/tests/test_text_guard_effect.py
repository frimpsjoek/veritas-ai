"""Spec 026 phase 0: the text guard takes effect in the index, not only in the code.

A fixture Zotero library (a real zotero.sqlite and storage/<key>/.zotero-ft-cache files) with one item whose cached
text is its own and one whose cache holds another document, each carrying a sentinel word. After `kb.index()`
the foreign sentinel is in no chunk, FTS row, vector row or Tantivy hit, and comes back through neither `/search`
nor MCP `search_notes`; the guard's version is part of the Zotero stamp, so bumping it re-reads an unchanged
library (R1) and an already indexed foreign text is removed by the next ordinary run (R4). Overrides are honoured
in `documents()` and `item_detail()` (R3), and `audit-text` prints no text (R2).
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from http.server import ThreadingHTTPServer

import numpy as np
import pytest

import abstracts
import http_api
import kb
import pdf_route
import sources
import zotero
from web_app import Refused

try:
    import mcp.server.mcpserver  # noqa: F401
except ImportError:
    # The MCP package is not in every test environment. server.py's tools are thin clients of the HTTP routes, so
    # a stand-in MCPServer whose `tool()` leaves the functions as they are lets them be called as plain functions.
    import sys
    import types

    stub = types.ModuleType("mcp.server.mcpserver")

    class _Stub:
        def __init__(self, *a, **k):
            pass

        def tool(self, *a, **k):
            return lambda fn: fn

    stub.MCPServer = _Stub  # type: ignore[attr-defined]
    sys.modules.setdefault("mcp", types.ModuleType("mcp"))
    sys.modules.setdefault("mcp.server", types.ModuleType("mcp.server"))
    sys.modules["mcp.server.mcpserver"] = stub
import server as mcp_server  # noqa: E402

MINE, FOREIGN = "MINE0001", "FORE0001"
ATT_MINE, ATT_FOREIGN = "ATTMINE1", "ATTFORE1"
MINE_TITLE = "Exciton transport in layered perovskite heterostructures"
FOREIGN_TITLE = "Charge separation at donor acceptor interfaces in organic photovoltaics"
OK_SENTINEL = "okapilantern"  # in the accepted text
FOREIGN_SENTINEL = "zebrafishledger"  # in the foreign text: must never come back from the index
HIGHLIGHT_SENTINEL = "wrongdocquotation"  # the user's highlight on the foreign attachment

SCHEMA = """
CREATE TABLE itemTypes (itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, libraryID INT, key TEXT, dateModified TEXT);
CREATE TABLE deletedItems (itemID INT);
CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT);
CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE itemTags (itemID INT, tagID INT);
CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INT, key TEXT, libraryID INT);
CREATE TABLE collectionItems (collectionID INT, itemID INT);
CREATE TABLE itemNotes (itemID INT, parentItemID INT, note TEXT);
CREATE TABLE itemAttachments (itemID INT, parentItemID INT, contentType TEXT, path TEXT, linkMode INT);
CREATE TABLE itemAnnotations (itemID INT, parentItemID INT, type INT, text TEXT, comment TEXT, color TEXT,
                              pageLabel TEXT, sortIndex TEXT, position TEXT);
INSERT INTO itemTypes VALUES (1, 'journalArticle'), (2, 'attachment'), (3, 'annotation');
INSERT INTO items VALUES (1, 1, 1, 'MINE0001', '2026-01-01 00:00:00'), (2, 2, 1, 'ATTMINE1', '2026-01-01 00:00:00'),
                         (3, 1, 1, 'FORE0001', '2026-01-01 00:00:00'), (4, 2, 1, 'ATTFORE1', '2026-01-01 00:00:00'),
                         (5, 3, 1, 'HIGHFORE', '2026-01-01 00:00:00'), (6, 3, 1, 'HIGHMINE', '2026-01-01 00:00:00');
INSERT INTO fields VALUES (1, 'title'), (2, 'DOI');
INSERT INTO itemDataValues VALUES (1, 'Exciton transport in layered perovskite heterostructures'),
                                  (2, 'Charge separation at donor acceptor interfaces in organic photovoltaics'),
                                  (3, '10.1000/mine.1'), (4, '10.1000/foreign.1');
INSERT INTO itemData VALUES (1, 1, 1), (1, 2, 3), (3, 1, 2), (3, 2, 4);
INSERT INTO creators VALUES (1, 'Ada', 'Lovelace'), (2, 'Grace', 'Hopper');
INSERT INTO creatorTypes VALUES (1, 'author');
INSERT INTO itemCreators VALUES (1, 1, 1, 0), (3, 2, 1, 0);
INSERT INTO itemAttachments VALUES (2, 1, 'application/pdf', 'storage:mine.pdf', 1), (4, 3, 'application/pdf', 'storage:foreign.pdf', 1);
INSERT INTO itemAnnotations VALUES (5, 4, 1, 'wrongdocquotation sentence', 'my comment', '#ffd400', '2', '00001|000010|00079', NULL);
INSERT INTO itemAnnotations VALUES (6, 2, 1, 'a highlight on my own paper', '', '#ffd400', '1', '00000|000010|00079', NULL);
"""
MINE_TEXT = f"Journal of Things. {MINE_TITLE}. Ada Lovelace. doi:10.1000/mine.1 Abstract: {OK_SENTINEL} appears here. " + "More body text. " * 40
FOREIGN_TEXT = f"Private questionnaire. Name, address, {FOREIGN_SENTINEL} and other answers. " * 30  # nothing of FORE0001's in it


@pytest.fixture
def library(tmp_path, monkeypatch):
    """A fixture library, an empty vault layout and a scratch data folder; nothing of the machine's is read."""
    root = tmp_path / "Zotero"
    root.mkdir()
    db = sqlite3.connect(root / "zotero.sqlite")
    db.executescript(SCHEMA)
    db.commit()
    db.close()
    for key, text in ((ATT_MINE, MINE_TEXT), (ATT_FOREIGN, FOREIGN_TEXT)):
        (root / "storage" / key).mkdir(parents=True)
        (root / "storage" / key / ".zotero-ft-cache").write_text(text)
    data = tmp_path / "data"
    monkeypatch.setenv("VERITAS_DATA", str(data))  # overrides file, Tantivy folder
    monkeypatch.setattr(sources, "FILE", data / "sources.json")
    monkeypatch.setattr(sources, "OUTPUT_DEFAULT", tmp_path / "Veritas")
    sources.save([{"name": "zotero", "path": str(root), "enabled": True, "skip": []}])
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(kb, "DB_PATH", data / "kb.sqlite")
    monkeypatch.setattr(kb, "LOCK_FILE", data / "index.lock")
    monkeypatch.setattr(kb, "PROGRESS_FILE", data / "index-progress.json")
    monkeypatch.setattr(kb, "STOP_FILE", data / "index-stop")
    monkeypatch.setattr(kb, "LAYOUT", sources.resolved())
    monkeypatch.setattr(kb, "VAULT", kb.LAYOUT.main)
    monkeypatch.setattr(zotero, "ZOTERO", root)
    monkeypatch.setattr(kb, "index_media", lambda *a, **k: 0)
    monkeypatch.setattr(kb, "code_is_current", lambda: True)
    monkeypatch.setattr("paper_notes.refresh_changed", lambda keys: 0)
    # Vectors without a model: one fixed vector per chunk, so the vecs table is real and a re-store must clear it.
    monkeypatch.setattr(kb, "embed_pending", fake_embed)
    # Each test's library is its own: never reuse the snapshot copies of an earlier test (same tmp root hash).
    zotero.snapshot("index").close()
    zotero.snapshot("reader").close()
    zotero.snapshot("audit").close()
    return root, data


def fake_embed(db, verbose=True, batch=256, progress=None):
    rows = db.execute("SELECT c.id, c.path FROM chunks c WHERE c.id NOT IN (SELECT id FROM vecs)").fetchall()
    vec = np.zeros(kb.DIM, dtype=np.float16).tobytes()
    db.executemany("INSERT OR REPLACE INTO vecs VALUES (?,?,?)", [(cid, path, vec) for cid, path in rows])
    kb.stamp(db, "vectors_at")
    db.commit()
    return len(rows)


def full_text_chunks(path: str) -> int:
    return kb.connect().execute("SELECT count(*) FROM chunks WHERE path=? AND heading LIKE '%Full text%'", (path,)).fetchone()[0]


def where_is(sentinel: str) -> dict:
    """Every store the sentinel could sit in: chunks, FTS, vectors (by path of a chunk holding it), Tantivy."""
    db = kb.connect()
    chunk_paths = [r[0] for r in db.execute("SELECT DISTINCT path FROM chunks WHERE text LIKE ?", (f"%{sentinel}%",))]
    fts = db.execute("SELECT count(*) FROM chunks_fts WHERE chunks_fts MATCH ?", (f'"{sentinel}"',)).fetchone()[0]
    vecs = sum(db.execute("SELECT count(*) FROM vecs WHERE path=?", (p,)).fetchone()[0] for p in chunk_paths)
    return {"chunks": chunk_paths, "fts": fts, "vecs": vecs}


def make_searcher():
    searcher = kb.Searcher(writer=True)
    searcher.embed = lambda texts, query=False: np.zeros((len(texts), kb.DIM), dtype=np.float32)
    return searcher


def tantivy_hits(searcher, query: str) -> list[str]:
    searcher.checked_at = 0.0  # the refresh is otherwise cached for a minute; the sync itself is what is tested
    searcher._refresh()
    assert searcher.keywords.usable(), "the Tantivy index must be in use, or this tests only SQLite"
    return [p for p in (r["path"] for r in searcher.search(query, limit=10))]


def test_guard_version_is_part_of_the_stamp_and_an_older_stamp_rereads(library, monkeypatch):
    calls = []
    real = zotero.documents
    monkeypatch.setattr(zotero, "documents", lambda: calls.append(1) or real())
    assert kb.index(verbose=False)["zotero_changed"] == 2 and len(calls) == 1
    stored = kb.connect().execute("SELECT value FROM meta WHERE key='zotero_fingerprint'").fetchone()[0]
    assert json.loads(stored)[2] == zotero.TEXT_GUARD_VERSION
    kb.index(verbose=False)
    assert len(calls) == 1  # unchanged files, same guard: the Zotero stage is skipped
    # A stamp an older server wrote, in the shape kb.py used before this field existed (no version in it).
    old = json.dumps([zotero.fingerprint(), abstracts.stamp()])
    db = kb.connect()
    db.execute("UPDATE meta SET value=? WHERE key='zotero_fingerprint'", (old,))
    db.commit()
    kb.index(verbose=False)
    assert len(calls) == 2, "a stamp without the guard version must trigger a re-read"
    monkeypatch.setattr(zotero, "TEXT_GUARD_VERSION", zotero.TEXT_GUARD_VERSION + 1)
    kb.index(verbose=False)
    assert len(calls) == 3, "a bumped guard version must trigger a re-read of an unchanged library"
    kb.index(verbose=False)
    assert len(calls) == 3


def test_rejected_text_is_absent_from_every_store_and_every_search_path(library, monkeypatch):
    kb.index(verbose=False)
    assert full_text_chunks(f"zotero/{MINE}") > 0 and full_text_chunks(f"zotero/{FOREIGN}") == 0
    ok, bad = where_is(OK_SENTINEL), where_is(FOREIGN_SENTINEL)
    assert ok["chunks"] == [f"zotero/{MINE}"] and ok["fts"] > 0 and ok["vecs"] > 0
    assert bad == {"chunks": [], "fts": 0, "vecs": 0}
    searcher = make_searcher()
    assert tantivy_hits(searcher, OK_SENTINEL) == [f"zotero/{MINE}"]
    assert tantivy_hits(searcher, FOREIGN_SENTINEL) == []
    # /search as the agent client, and MCP search_notes, which is a client of /search.
    monkeypatch.setattr(http_api, "searcher", lambda: searcher)
    monkeypatch.setattr(http_api, "TOKEN_FILE", library[1] / "api-token")
    srv = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        monkeypatch.setattr(mcp_server, "BASE", f"http://127.0.0.1:{srv.server_address[1]}")
        found = mcp_server.search_notes(OK_SENTINEL)
        assert [h["path"] for h in found] == [f"zotero/{MINE}"]
        assert mcp_server.search_notes(FOREIGN_SENTINEL) == []
        assert mcp_server.search_notes(HIGHLIGHT_SENTINEL) == []
        page = mcp_server.read_note(f"zotero/{FOREIGN}")
        assert FOREIGN_SENTINEL not in page["text"] and HIGHLIGHT_SENTINEL not in page["text"]
    finally:
        srv.shutdown()
        srv.server_close()


def test_an_already_indexed_foreign_text_is_removed_by_the_next_run_after_a_guard_bump(library, monkeypatch):
    """Before: an older guard let the text in. After: the bump re-reads; chunks, FTS, vectors and Tantivy drop it
    on the ordinary sync, not a rebuild (the spec's open question)."""
    real_judge = zotero.judge_text
    monkeypatch.setattr(zotero, "judge_text", lambda *a, **k: zotero.TextDecision(True, "old-guard"))
    kb.index(verbose=False)
    before = where_is(FOREIGN_SENTINEL)
    assert before["chunks"] == [f"zotero/{FOREIGN}"] and before["fts"] > 0 and before["vecs"] > 0
    searcher = make_searcher()
    assert tantivy_hits(searcher, FOREIGN_SENTINEL) == [f"zotero/{FOREIGN}"]
    assert tantivy_hits(searcher, HIGHLIGHT_SENTINEL) == [f"zotero/{FOREIGN}"]
    mine_ids = {r[0] for r in kb.connect().execute("SELECT id FROM chunks WHERE path=?", (f"zotero/{MINE}",))}

    monkeypatch.setattr(zotero, "judge_text", real_judge)
    monkeypatch.setattr(zotero, "TEXT_GUARD_VERSION", zotero.TEXT_GUARD_VERSION + 1)
    result = kb.index(verbose=False)
    assert result["zotero_changed"] == 1, "only the item whose text changed is re-stored (N1)"
    assert where_is(FOREIGN_SENTINEL) == {"chunks": [], "fts": 0, "vecs": 0}
    assert where_is(HIGHLIGHT_SENTINEL) == {"chunks": [], "fts": 0, "vecs": 0}
    assert {r[0] for r in kb.connect().execute("SELECT id FROM chunks WHERE path=?", (f"zotero/{MINE}",))} == mine_ids
    assert tantivy_hits(searcher, FOREIGN_SENTINEL) == [], "Tantivy must drop the chunk on sync after the re-store"
    assert tantivy_hits(searcher, OK_SENTINEL) == [f"zotero/{MINE}"]


def test_highlights_and_has_full_text_follow_the_decision(library):
    docs = {d.key: d for d in zotero.documents()}
    assert OK_SENTINEL in docs[MINE].text and "## Highlights" in docs[MINE].text
    assert FOREIGN_SENTINEL not in docs[FOREIGN].text and HIGHLIGHT_SENTINEL not in docs[FOREIGN].text
    assert "## Highlights" not in docs[FOREIGN].text and "## Full text" not in docs[FOREIGN].text
    [mine] = zotero.item_detail(MINE, full_text=True)["attachments"]
    assert mine["has_full_text"] and OK_SENTINEL in mine["full_text"] and len(mine["highlights"]) == 1
    [foreign] = zotero.item_detail(FOREIGN, full_text=True)["attachments"]
    assert not foreign["has_full_text"] and "full_text" not in foreign and foreign["full_text_mismatch"]
    assert foreign["highlights"] == [] and foreign["highlights_hidden"] == 1 and foreign["text_guard"] == "foreign"
    [foreign] = zotero.item_detail(FOREIGN)["attachments"]  # without full_text=1 the claim is still judged
    assert not foreign["has_full_text"] and foreign["highlights"] == []


def write_overrides(data, mapping):
    data.mkdir(exist_ok=True)
    (data / "text_overrides.json").write_text(json.dumps(mapping))


def test_override_foreign_rejects_in_documents(library):
    write_overrides(library[1], {ATT_MINE: "foreign"})
    doc = {d.key: d for d in zotero.documents()}[MINE]
    assert OK_SENTINEL not in doc.text and "## Highlights" not in doc.text


def test_override_mine_accepts_in_documents(library):
    write_overrides(library[1], {ATT_FOREIGN: "mine"})
    doc = {d.key: d for d in zotero.documents()}[FOREIGN]
    assert FOREIGN_SENTINEL in doc.text and HIGHLIGHT_SENTINEL in doc.text


def test_override_foreign_rejects_in_item_detail(library):
    write_overrides(library[1], {ATT_MINE: "foreign"})
    [mine] = zotero.item_detail(MINE, full_text=True)["attachments"]
    assert not mine["has_full_text"] and "full_text" not in mine and mine["text_guard"] == "override:foreign"


def test_override_mine_accepts_in_item_detail(library):
    write_overrides(library[1], {ATT_FOREIGN: "mine"})
    [foreign] = zotero.item_detail(FOREIGN, full_text=True)["attachments"]
    assert foreign["has_full_text"] and FOREIGN_SENTINEL in foreign["full_text"] and len(foreign["highlights"]) == 1


def test_a_malformed_overrides_file_does_not_stop_the_index_or_admit_text(library):
    (library[1]).mkdir(exist_ok=True)
    (library[1] / "text_overrides.json").write_text("{broken")
    assert kb.index(verbose=False)["zotero_changed"] == 2
    assert where_is(FOREIGN_SENTINEL)["chunks"] == [] and where_is(OK_SENTINEL)["chunks"] == [f"zotero/{MINE}"]


def test_pdf_route_refuses_the_file_of_a_foreign_attachment(library):
    with pytest.raises(Refused) as refused:
        pdf_route.resolve(ATT_FOREIGN)
    assert refused.value.status == 403 and FOREIGN_SENTINEL not in refused.value.message
    write_overrides(library[1], {ATT_FOREIGN: "mine"})
    with pytest.raises(Refused) as refused:
        pdf_route.resolve(ATT_FOREIGN)  # past the guard; there is no file in the fixture, so a 404 follows
    assert refused.value.status == 404
    with pytest.raises(Refused) as refused:
        pdf_route.resolve(ATT_MINE)
    assert refused.value.status == 404


def test_audit_text_lists_decisions_and_prints_no_text(library, capsys):
    kb.audit_text_cli()
    out, err = capsys.readouterr()
    lines = out.splitlines()
    assert len(lines) == 2 and all(len(line) < 200 for line in lines)
    assert any(line.startswith(f"{FOREIGN} {ATT_FOREIGN} foreign foreign ") for line in lines)
    assert any(line.startswith(f"{MINE} {ATT_MINE} mine doi ") for line in lines)
    for sentinel in (OK_SENTINEL, FOREIGN_SENTINEL, HIGHLIGHT_SENTINEL, "questionnaire", "Questionnaire"):
        assert sentinel not in out + err
    assert "foreign=1" in err and "mine=1" in err
    kb.audit_text_cli(only="foreign")
    assert capsys.readouterr().out.count("\n") == 1


def test_zotero_status_reports_no_full_text_for_the_rejected_item(library, monkeypatch):
    kb.index(verbose=False)
    monkeypatch.setattr(http_api, "_zotero_status", {"at": 0.0})
    status = http_api.zotero_status()["items"]
    assert status[MINE]["full_text"] is True and status[FOREIGN]["full_text"] is False
    time.sleep(0)  # the status is derived from chunks, so it follows the index with no claim of its own
