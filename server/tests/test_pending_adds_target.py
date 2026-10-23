"""'+ Add' goes to the default library (phase 2 task 5): the local plugin queue, or an online library's Web API."""
from __future__ import annotations

import pytest

import kb
import pending_adds
import sources
import web_app
import zotero_web


@pytest.fixture
def setup(tmp_path, monkeypatch):
    lib = tmp_path / "Zotero"
    lib.mkdir()
    (lib / "zotero.sqlite").write_bytes(b"")
    monkeypatch.setattr(sources, "FILE", tmp_path / "sources.json")
    monkeypatch.setattr(web_app, "WEB_DIR", tmp_path / "web")
    monkeypatch.setattr(pending_adds, "ZOTERO_URL", "http://127.0.0.1:1")  # Zotero closed: entries stay queued
    sources.save([{"name": "zotero", "path": str(lib), "enabled": True, "skip": []},
                  {"name": "online", "kind": "zotero-web", "user_id": "123", "enabled": True}])
    monkeypatch.setenv("VERITAS_ZOTERO_KEY", "secret")
    created = []

    class FakeClient:
        def __init__(self, user_id, key, opener=None):
            assert (user_id, key) == ("123", "secret")

        def create(self, item):
            created.append(item)
            return f"NEW{len(created):05d}"

    monkeypatch.setattr(zotero_web, "Client", FakeClient)

    def relayout():
        monkeypatch.setattr(kb, "LAYOUT", sources.resolved())

    relayout()
    return created, relayout


PAPER = {"title": "Excitons in dots", "authors": ["Ada Lovelace", "Alan Turing"], "year": 2021,
         "doi": "10.1/abc", "abstract": "We study excitons.", "venue": "J. Chem. Phys."}


def test_add_goes_to_local_queue_by_default(setup):
    created, _ = setup
    [result] = pending_adds.add_papers([PAPER], tag="read-later")
    assert result["status"] == "queued" and created == []
    assert pending_adds.pending()[0]["title"] == "Excitons in dots"


def test_add_goes_to_web_library_when_default(setup):
    created, relayout = setup
    sources.set_default_library("online")
    relayout()
    [result] = pending_adds.add_papers([PAPER], tag="read-later")
    assert result == {"status": "added", "key": "NEW00001", "library": "online"}
    [item] = created
    assert item["itemType"] == "journalArticle" and item["title"] == "Excitons in dots" and item["DOI"] == "10.1/abc"
    assert item["creators"][0] == {"creatorType": "author", "name": "Ada Lovelace"} and item["date"] == "2021"
    assert item["publicationTitle"] == "J. Chem. Phys." and item["tags"] == [{"tag": "read-later"}]
    assert pending_adds.pending() == []  # nothing queued for the local plugin


def test_switched_off_online_default_says_so(setup):
    created, relayout = setup
    sources.set_default_library("online")
    sources.update("online", enabled=False)
    relayout()
    [result] = pending_adds.add_papers([PAPER])
    assert result["status"] == "failed" and "switched off" in result["message"] and created == []
    assert pending_adds.pending() == []
