"""Save a page's PDF to Zotero from Browse (spec 027 G3): the `attach` queue entry and its routes."""
from __future__ import annotations

import hashlib
import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

import http_api
import pending_adds
import web_app
from tests.test_pending_adds import env  # noqa: F401  (fixture: Zotero closed, a fake one on demand)

PDF = b"%PDF-1.7 x"
DOI = "10.1021/a.b"
URL = "https://pubs.acs.org/doi/pdf/10.1021/a.b"


@pytest.fixture(autouse=True)
def local_library(monkeypatch):
    monkeypatch.setattr(pending_adds, "default_account", lambda: None)


def _queue():
    return json.loads(pending_adds._path().read_text())


def test_a_pdf_is_kept_and_queued(env):
    result = pending_adds.attach_pdf(PDF, DOI, "T", URL)
    assert result["status"] == "queued"
    [entry] = _queue()
    assert entry["kind"] == "attach" and entry["id"] == result["id"]
    assert entry["md5"] == hashlib.md5(PDF).hexdigest()
    assert entry["doi"] == DOI and entry["title"] == "T" and entry["url"] == URL
    assert (pending_adds.inbox() / entry["file"]).read_bytes() == PDF
    assert pending_adds.inbox() == web_app.WEB_DIR.parent / "pdf-inbox"


def test_a_body_that_is_not_a_pdf_is_refused(env):
    result = pending_adds.attach_pdf(b"<html>sign in", DOI, "T", URL)
    assert result == {"status": "failed", "message": "The site sent a page, not the PDF (sign in first?)"}
    assert not pending_adds._path().exists()
    assert not pending_adds.inbox().exists() or not any(pending_adds.inbox().iterdir())


def test_an_online_default_library_says_local_only(env, monkeypatch):
    monkeypatch.setattr(pending_adds, "default_account", lambda: object())
    result = pending_adds.attach_pdf(PDF, DOI, "T", URL)
    assert result == {"status": "failed", "message": "Saving PDFs works with a local Zotero library for now"}
    assert not pending_adds._path().exists()


def test_a_paper_needs_a_doi_or_a_title(env):
    assert pending_adds.attach_pdf(PDF, "", " ", URL)["status"] == "failed"


def test_done_removes_the_file(env):
    entry_id = pending_adds.attach_pdf(PDF, DOI, "T", URL)["id"]
    path = pending_adds.inbox() / _queue()[0]["file"]
    pending_adds.done([entry_id])
    assert not path.exists() and _queue() == []


def test_a_failed_attach_removes_its_file(env):
    entry_id = pending_adds.attach_pdf(PDF, DOI, "T", URL)["id"]
    path = pending_adds.inbox() / _queue()[0]["file"]
    for _ in range(pending_adds.MAX_ATTEMPTS - 1):
        pending_adds.attempt(entry_id, "x")
    assert path.exists()
    assert pending_adds.attempt(entry_id, "x")["failed"] is True
    assert not path.exists()


def test_saving_the_same_pdf_twice_queues_it_once(env):
    first = pending_adds.attach_pdf(PDF, DOI, "T", URL)
    second = pending_adds.attach_pdf(PDF, DOI, "T", URL)
    assert first["id"] == second["id"] and len(_queue()) == 1 and len(list(pending_adds.inbox().iterdir())) == 1


def test_the_plugin_reports_already(env, monkeypatch):
    monkeypatch.setattr(pending_adds, "apply_now", lambda ids: {i: {"id": i, "ok": True, "key": "K", "already": True} for i in ids})
    result = pending_adds.attach_pdf(PDF, DOI, "T", URL)
    assert result == {"status": "added", "already": True, "key": "K", "id": result["id"]}


def test_a_running_zotero_is_asked_at_once(env):
    env()
    result = pending_adds.attach_pdf(PDF, DOI, "T", URL)
    assert result["status"] == "added" and result["key"] == "KEY" + result["id"][:4]


@pytest.fixture
def raw_api(env):
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def call(method, path, body=b"", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        conn.request(method, path, body if method == "POST" else None, headers or {})
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, raw, res.getheader("Content-Type")
    yield call
    server.shutdown()
    server.server_close()


def test_routes(raw_api):
    query = "/zotero/attach-pdf?doi=10.1021%2Fa.b&title=T&url=" + "https%3A%2F%2Fpubs.acs.org%2Fdoi%2Fpdf%2F10.1021%2Fa.b"
    status, raw, _ = raw_api("POST", query, PDF, {"Content-Type": "application/pdf"})
    assert status == 200, raw
    result = json.loads(raw)
    assert result["status"] == "queued"
    status, raw, kind = raw_api("GET", f"/zotero/pending-adds/file?id={result['id']}")
    assert status == 200 and raw == PDF and kind == "application/pdf"
    assert raw_api("GET", "/zotero/pending-adds/file?id=0123456789abcdef")[0] == 404
    assert raw_api("GET", "/zotero/pending-adds/file?id=../pending-adds.json")[0] == 404


def test_a_body_over_200_mb_is_refused_unread(raw_api):
    status, raw, _ = raw_api("POST", "/zotero/attach-pdf?doi=10.1%2Fx&title=T&url=u", b"",
                             {"Content-Type": "application/pdf", "Content-Length": str(201 * 1024 * 1024)})
    assert status == 413, raw


def test_a_website_is_refused(raw_api):
    headers = {"Sec-Fetch-Site": "cross-site", "Content-Type": "application/pdf"}
    assert raw_api("POST", "/zotero/attach-pdf?doi=10.1%2Fx&title=T&url=u", PDF, headers)[0] == 403
    assert raw_api("GET", "/zotero/pending-adds/file?id=x", b"", {"Sec-Fetch-Site": "cross-site"})[0] == 403
    assert "/zotero/attach-pdf" not in http_api.AGENT_ROUTES and "/zotero/pending-adds/file" not in http_api.AGENT_ROUTES


def test_a_kept_pdf_is_not_a_public_file_of_the_web_app(raw_api):
    result = pending_adds.attach_pdf(PDF, DOI, "T", URL)
    name = json.loads(pending_adds._path().read_text())[0]["file"]
    assert web_app.WEB_DIR not in (pending_adds.inbox() / name).parents
    assert raw_api("GET", f"/app/pdf-inbox/{name}")[0] == 404
    assert raw_api("GET", f"/zotero/pending-adds/file?id={result['id']}")[1] == PDF
