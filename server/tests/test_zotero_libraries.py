"""Every enabled Zotero library is read (phase 2 task 3): the default one as zotero/KEY, others as name:/zotero/KEY."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

import http_api
import kb
import sources
import zotero


def library(path):
    path.mkdir(parents=True)
    (path / "zotero.sqlite").write_bytes(b"")
    return path


@pytest.fixture
def libs(tmp_path, monkeypatch):
    main, lab = library(tmp_path / "Zotero"), library(tmp_path / "LabZotero")
    monkeypatch.setattr(sources, "FILE", tmp_path / "data" / "sources.json")
    monkeypatch.setattr(sources, "OUTPUT_DEFAULT", tmp_path / "Veritas")
    sources.save([{"name": "zotero", "path": str(main), "enabled": True, "skip": []},
                  {"name": "lab", "path": str(lab), "enabled": True, "skip": []}])
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "data" / "kb.sqlite")
    monkeypatch.setattr(kb, "embed_pending", lambda *a, **k: 0)
    monkeypatch.setattr(kb, "index_media", lambda *a, **k: 0)
    items = {main: [("SAMEKEY1", "Main paper")], lab: [("SAMEKEY1", "Lab paper"), ("LABONLY2", "Lab only")]}

    def documents():
        return [zotero.ZoteroDoc(k, t, f"{t} text about excitons", [], 1.0, {"collection_keys": []})
                for k, t in items[zotero.root()]]

    monkeypatch.setattr(zotero, "documents", documents)
    monkeypatch.setattr(zotero, "collection_tree", lambda: [])
    monkeypatch.setattr(zotero, "fingerprint", lambda: (zotero.root().stat().st_mtime, 0.0))

    def relayout():
        monkeypatch.setattr(kb, "LAYOUT", sources.resolved())
        monkeypatch.setattr(kb, "VAULT", kb.LAYOUT.main)
        monkeypatch.setattr(zotero, "ZOTERO", kb.LAYOUT.zotero)

    relayout()
    return main, lab, relayout


def rows():
    return {p: t for p, t in kb.connect().execute("SELECT path, title FROM notes WHERE source='zotero'")}


def test_library_switch_is_scoped(tmp_path, monkeypatch):
    monkeypatch.setattr(zotero, "ZOTERO", tmp_path / "a")
    with zotero.library(tmp_path / "b"):
        assert zotero.root() == tmp_path / "b"
    assert zotero.root() == tmp_path / "a"


def test_second_library_is_indexed_with_prefix(libs):
    kb._index(False, False, kb.Progress())
    got = rows()
    assert got["zotero/SAMEKEY1"] == "Main paper"
    assert got["lab:/zotero/LABONLY2"] == "Lab only"
    assert kb.LAYOUT.ignored == []


def test_two_libraries_same_key_are_two_items(libs):
    kb._index(False, False, kb.Progress())
    got = rows()
    assert got["zotero/SAMEKEY1"] == "Main paper" and got["lab:/zotero/SAMEKEY1"] == "Lab paper"
    assert kb.read_note("lab:/zotero/SAMEKEY1")["text"].count("Lab paper") >= 1


def test_switching_a_library_off_removes_its_items(libs):
    main, lab, relayout = libs
    kb._index(False, False, kb.Progress())
    sources.update("lab", enabled=False)
    relayout()
    kb._index(False, False, kb.Progress())
    assert set(rows()) == {"zotero/SAMEKEY1"}


def test_default_library_setting(libs):
    main, lab, relayout = libs
    sources.set_default_library("lab")
    relayout()
    assert kb.LAYOUT.zotero == lab and [f.name for f in kb.LAYOUT.libraries] == ["lab", "zotero"]
    with pytest.raises(sources.SourceError):
        sources.set_default_library("nowhere")


def test_item_route_reads_the_named_library(libs, monkeypatch):
    main, lab, relayout = libs
    monkeypatch.setattr(zotero, "item_detail", lambda key, full_text=False: {"key": key, "library": str(zotero.root())})
    monkeypatch.setattr(kb, "index_running", lambda: False)
    kb._index(False, False, kb.Progress())
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        def get(path):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            conn.request("GET", path)
            res = conn.getresponse()
            out = res.status, json.loads(res.read() or b"null")
            conn.close()
            return out
        status, body = get("/zotero?key=lab:/zotero/SAMEKEY1")
        assert status == 200 and body["library"] == str(lab) and body["key"] == "SAMEKEY1"
        status, body = get("/zotero?key=zotero/SAMEKEY1")
        assert status == 200 and body["library"] == str(main)
    finally:
        server.shutdown()
