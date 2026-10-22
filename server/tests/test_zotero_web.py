"""Zotero online library connector (phase 2 task 4): items read through the Zotero Web API, no network in tests."""
from __future__ import annotations

import io
import json
import urllib.error
from urllib.parse import parse_qs, urlparse

import pytest

import kb
import sources
import zotero_web


class FakeApi:
    """Answers the Web API routes the client uses, from a dict of items, with a library version."""

    def __init__(self, items, version=7, fail=None):
        self.items, self.version, self.fail, self.calls, self.posted = items, version, fail, [], []

    def __call__(self, request, timeout=30):
        url = urlparse(request.full_url)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        self.calls.append((request.get_method(), url.path, q, dict(request.header_items())))
        if self.fail:
            raise urllib.error.HTTPError(request.full_url, self.fail, "nope", {}, io.BytesIO(b"denied"))
        headers = {"Last-Modified-Version": str(self.version), "Total-Results": str(len(self.items))}
        if request.get_method() == "POST":
            self.posted.append(json.loads(request.data))
            return Response({"successful": {"0": {"key": "NEWKEY12"}}, "failed": {}}, headers)
        if url.path.endswith("/fulltext"):
            return Response({"content": "Full text of the attachment."}, headers)
        start, limit = int(q.get("start", 0)), int(q.get("limit", 100))
        return Response(self.items[start:start + limit], headers)


class Response(io.BytesIO):
    def __init__(self, body, headers):
        super().__init__(json.dumps(body).encode())
        self.headers = headers

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def item(key, title, **data):
    return {"key": key, "version": 5, "data": {"key": key, "itemType": data.pop("itemType", "journalArticle"),
                                                 "title": title, **data}}


ITEMS = [
    item("PAPERAAA", "Quasiparticle band gaps", creators=[{"firstName": "Ada", "lastName": "Lovelace"}],
         date="2021-03-01", DOI="10.1/x", abstractNote="GW corrections to DFT gaps."),
    item("NOTEAAAA", "", itemType="note", parentItem="PAPERAAA", note="<p>My note on <b>GW</b>.</p>"),
    item("PDFAAAAA", "PDF", itemType="attachment", parentItem="PAPERAAA", contentType="application/pdf"),
    item("PAPERBBB", "Excitons in quantum dots", date="2020"),
]


def test_items_paged_and_versioned():
    api = FakeApi(ITEMS)
    client = zotero_web.Client("123", "secret", opener=api)
    got, version = client.items(page=2)
    assert [i["key"] for i in got] == [i["key"] for i in ITEMS] and version == 7
    assert [c[2]["start"] for c in api.calls] == ["0", "2"]
    assert all(c[3]["Zotero-api-key"] == "secret" and c[1] == "/users/123/items" for c in api.calls)


def test_documents_from_items():
    entry = {"name": "online", "kind": "zotero-web", "user_id": "123"}
    docs = zotero_web.documents(entry, zotero_web.Client("123", "k", opener=FakeApi(ITEMS)))
    by_path = {d.path: d for d in docs}
    assert set(by_path) == {"online:/zotero/PAPERAAA", "online:/zotero/PAPERBBB"}
    a = by_path["online:/zotero/PAPERAAA"]
    assert a.title == "Quasiparticle band gaps"
    assert "Ada Lovelace" in a.text and "GW corrections" in a.text and "My note on GW." in a.text
    assert a.meta["doi"] == "10.1/x" and a.meta["year"] == "2021" and a.meta["library"] == "online"


@pytest.fixture
def account(tmp_path, monkeypatch):
    monkeypatch.setattr(sources, "FILE", tmp_path / "data" / "sources.json")
    monkeypatch.setattr(sources, "OUTPUT_DEFAULT", tmp_path / "Veritas")
    sources.save([{"name": "online", "kind": "zotero-web", "user_id": "123", "enabled": True}])
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "data" / "kb.sqlite")
    monkeypatch.setattr(kb, "embed_pending", lambda *a, **k: 0)
    monkeypatch.setattr(kb, "index_media", lambda *a, **k: 0)
    monkeypatch.setattr(kb, "index_zotero", lambda *a, **k: 0)
    monkeypatch.setenv("VERITAS_ZOTERO_KEY", "secret")
    monkeypatch.setattr(kb, "LAYOUT", sources.resolved())
    monkeypatch.setattr(kb, "VAULT", kb.LAYOUT.main)
    return monkeypatch


def paths():
    return {r[0] for r in kb.connect().execute("SELECT path FROM notes WHERE source='zotero'")}


def test_account_listed_and_indexed(account):
    api = FakeApi(ITEMS)
    account.setattr(zotero_web, "OPENER", api)
    assert [a.name for a in kb.LAYOUT.accounts] == ["online"]
    kb._index(False, False, kb.Progress())
    assert paths() == {"online:/zotero/PAPERAAA", "online:/zotero/PAPERBBB"}
    calls = len(api.calls)
    kb._index(False, False, kb.Progress())  # same library version: one cheap version check, no re-read
    assert len(api.calls) == calls + 1


def test_web_error_keeps_existing_items(account):
    account.setattr(zotero_web, "OPENER", FakeApi(ITEMS))
    kb._index(False, False, kb.Progress())
    for status in (403, 429, 500):
        account.setattr(zotero_web, "OPENER", FakeApi([], version=8, fail=status))
        result = kb._index(False, False, kb.Progress())
        assert paths() == {"online:/zotero/PAPERAAA", "online:/zotero/PAPERBBB"}
        assert result["zotero_web_errors"] and str(status) in result["zotero_web_errors"][0]


def test_create_item_posts_json():
    api = FakeApi([])
    key = zotero_web.Client("123", "secret", opener=api).create({"itemType": "journalArticle", "title": "New"})
    assert key == "NEWKEY12"
    method, path, _, headers = api.calls[0]
    assert method == "POST" and path == "/users/123/items" and api.posted == [[{"itemType": "journalArticle", "title": "New"}]]
    assert headers.get("Zotero-write-token")


def test_add_account_route_entry(tmp_path, monkeypatch):
    monkeypatch.setattr(sources, "FILE", tmp_path / "sources.json")
    stored = {}
    monkeypatch.setattr(zotero_web, "store_key", lambda user_id, key: stored.update({user_id: key}))
    entry = sources.add_account("zotero-web", "123", key="secret")
    assert entry == {"name": "zotero-online", "kind": "zotero-web", "user_id": "123", "enabled": True}
    assert stored == {"123": "secret"} and sources.load()[-1] == entry
    assert "secret" not in sources.FILE.read_text()  # the key never lands in sources.json
    with pytest.raises(sources.SourceError):
        sources.add_account("zotero-web", "not a number")


def test_add_account_route(tmp_path, monkeypatch):
    import http.client
    import threading
    from http.server import ThreadingHTTPServer

    import http_api
    monkeypatch.setattr(sources, "FILE", tmp_path / "sources.json")
    monkeypatch.setattr(zotero_web, "store_key", lambda user_id, key: None)
    monkeypatch.setattr(http_api, "start_indexing", lambda reread: None)
    monkeypatch.setattr(kb, "index_running", lambda: False)
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        conn.request("POST", "/sources", json.dumps({"kind": "zotero-web", "user_id": "123", "key": "k"}),
                     {"Content-Type": "application/json"})
        res = conn.getresponse()
        body = json.loads(res.read())
        assert res.status == 201 and body["name"] == "zotero-online" and body["kind"] == "zotero-web"
        conn.request("POST", "/sources", json.dumps({"kind": "zotero-web", "user_id": "abc"}), {"Content-Type": "application/json"})
        res = conn.getresponse()
        res.read()
        assert res.status == 400
    finally:
        server.shutdown()
        monkeypatch.undo()
        kb.reload_layout()


def test_sources_report_lists_accounts(account):
    report = kb.sources_report()
    [row] = [r for r in report["folders"] if r["kind"] == "zotero-web"]
    assert row["name"] == "online" and row["role"] == "online" and row["path"] is None
