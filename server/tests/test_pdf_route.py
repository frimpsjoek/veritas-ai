"""GET /zotero/pdf: Zotero storage PDFs, streamed with Range (spec 013 W2)."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

import http_api
import pdf_route
import zotero

PDF = b"%PDF-1.7\n" + bytes(range(256)) * 400  # 102,409 bytes, more than one 64 KB chunk
KEY = "ABCD2345"


@pytest.fixture
def env(tmp_path, monkeypatch):
    root = tmp_path / "Zotero"
    storage = root / "storage"
    (storage / KEY).mkdir(parents=True)
    (storage / KEY / "Paper Ü.pdf").write_bytes(PDF)
    monkeypatch.setattr(zotero, "ZOTERO", root)
    rows = {KEY: (1, "storage:Paper Ü.pdf")}
    monkeypatch.setattr(pdf_route, "attachment_info", lambda key: rows.get(key))
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def get(path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        conn.request("GET", path, headers=headers or {})
        res = conn.getresponse()
        body = res.read()
        conn.close()
        return res, body

    yield get, storage, rows, tmp_path
    server.shutdown()
    server.server_close()


def test_full_get_streams_the_file_with_headers(env):
    res, body = env[0](f"/zotero/pdf?key={KEY}")
    assert res.status == 200 and body == PDF
    assert res.getheader("Content-Type") == "application/pdf"
    assert res.getheader("Accept-Ranges") == "bytes"
    assert res.getheader("Content-Length") == str(len(PDF))
    assert res.getheader("Cache-Control") == "private, max-age=300"
    assert res.getheader("Content-Disposition") == "inline; filename=\"Paper _.pdf\"; filename*=UTF-8''Paper%20%C3%9C.pdf"


@pytest.mark.parametrize("header, first, last", [
    ("bytes=10-19", 10, 19),
    ("bytes=100000-", 100000, len(PDF) - 1),
    ("bytes=-50", len(PDF) - 50, len(PDF) - 1),
    ("bytes=5-999999999", 5, len(PDF) - 1),
])
def test_single_range_returns_206(env, header, first, last):
    res, body = env[0](f"/zotero/pdf?key={KEY}", {"Range": header})
    assert res.status == 206 and body == PDF[first:last + 1]
    assert res.getheader("Content-Range") == f"bytes {first}-{last}/{len(PDF)}"
    assert res.getheader("Content-Length") == str(last - first + 1)


@pytest.mark.parametrize("header", [f"bytes={len(PDF)}-", f"bytes={len(PDF) + 5}-{len(PDF) + 9}", "bytes=20-10", "bytes=-0"])
def test_unsatisfiable_range_is_416(env, header):
    res, _ = env[0](f"/zotero/pdf?key={KEY}", {"Range": header})
    assert res.status == 416 and res.getheader("Content-Range") == f"bytes */{len(PDF)}"


def test_multi_range_falls_back_to_the_whole_file(env):
    res, body = env[0](f"/zotero/pdf?key={KEY}", {"Range": "bytes=0-1,5-6"})
    assert res.status == 200 and body == PDF


@pytest.mark.parametrize("key", ["", "abcd2345", "ABCD234", "ABCD23456", "../ABCD23", "..%2F..%2Fetc", "ABCD234%00", "ABCD%20345"])
def test_bad_keys_are_400(env, key):
    res, _ = env[0](f"/zotero/pdf?key={key}")
    assert res.status == 400


def test_unknown_attachment_is_404(env):
    assert env[0]("/zotero/pdf?key=ZZZZ9999")[0].status == 404


def test_symlink_out_of_storage_is_refused(env):
    get, storage, rows, tmp = env
    (tmp / "secret.pdf").write_bytes(b"%PDF-1.4 secret")
    (storage / "LINK2345").mkdir()
    (storage / "LINK2345" / "x.pdf").symlink_to(tmp / "secret.pdf")
    res, body = get("/zotero/pdf?key=LINK2345")
    assert res.status == 403 and b"secret" not in body


def test_symlinked_folder_out_of_storage_is_refused(env):
    get, storage, rows, tmp = env
    (tmp / "elsewhere").mkdir()
    (tmp / "elsewhere" / "x.pdf").write_bytes(b"%PDF-1.4 secret")
    (storage / "DIRL2345").symlink_to(tmp / "elsewhere")
    res, body = get("/zotero/pdf?key=DIRL2345")
    assert res.status == 403 and b"secret" not in body


def test_non_pdf_is_refused(env):
    get, storage, rows, _ = env
    (storage / "TEXT2345").mkdir()
    (storage / "TEXT2345" / "a.pdf").write_text("not really a pdf")
    (storage / "NOTP2345").mkdir()
    (storage / "NOTP2345" / "a.html").write_text("<html>")
    rows["NOTP2345"] = (1, "storage:a.html")
    assert get("/zotero/pdf?key=TEXT2345")[0].status == 415
    assert get("/zotero/pdf?key=NOTP2345")[0].status == 415


def test_several_files_use_the_one_the_database_names(env):
    get, storage, rows, _ = env
    (storage / "MANY2345").mkdir()
    (storage / "MANY2345" / "a.pdf").write_bytes(b"%PDF-a")
    (storage / "MANY2345" / "b.pdf").write_bytes(b"%PDF-bb")
    assert get("/zotero/pdf?key=MANY2345")[0].status == 404  # ambiguous without a database row
    rows["MANY2345"] = (1, "storage:b.pdf")
    assert get("/zotero/pdf?key=MANY2345")[1] == b"%PDF-bb"


def test_database_path_cannot_escape_the_folder(env):
    get, storage, rows, tmp = env
    (tmp / "secret.pdf").write_bytes(b"%PDF-1.4 secret")
    (storage / "ESCP2345").mkdir()
    rows["ESCP2345"] = (1, "storage:../../secret.pdf")
    res, body = get("/zotero/pdf?key=ESCP2345")
    assert res.status == 404 and b"secret" not in body


@pytest.fixture
def linked(env, monkeypatch):
    _, _, rows, tmp = env
    profiles = tmp / "ZoteroApp"
    (profiles / "Profiles" / "p1.default").mkdir(parents=True)
    (profiles / "Profiles" / "other").mkdir()
    (profiles / "profiles.ini").write_text(
        "[Profile1]\nName=x\nIsRelative=1\nPath=Profiles/other\n\n"
        "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/p1.default\nDefault=1\n")
    base = tmp / "base dir"
    (base / "sub").mkdir(parents=True)
    (profiles / "Profiles" / "p1.default" / "prefs.js").write_text(
        f'user_pref("extensions.zotero.baseAttachmentPath", "{base}");\n')
    monkeypatch.setattr(pdf_route, "PROFILES_DIR", profiles)
    monkeypatch.setattr(pdf_route, "_base_cache", [])
    return base, rows, tmp


def test_relative_linked_file_resolves_under_the_base_directory(env, linked):
    base, rows, _ = linked
    (base / "sub" / "a.PDF").write_bytes(b"%PDF-rel")
    rows["RELA2345"] = (2, "attachments:sub/a.PDF")
    res, body = env[0]("/zotero/pdf?key=RELA2345")
    assert res.status == 200 and body == b"%PDF-rel"


def test_relative_linked_file_cannot_escape_the_base(env, linked):
    base, rows, tmp = linked
    (tmp / "secret.pdf").write_bytes(b"%PDF-1.4 secret")
    rows["ESCB2345"] = (2, "attachments:../secret.pdf")
    res, body = env[0]("/zotero/pdf?key=ESCB2345")
    assert res.status == 403 and b"secret" not in body


def test_absolute_linked_file_is_served(env, linked):
    _, rows, tmp = linked
    (tmp / "abs.pdf").write_bytes(b"%PDF-abs")
    rows["ABSO2345"] = (2, str(tmp / "abs.pdf"))
    assert env[0]("/zotero/pdf?key=ABSO2345")[1] == b"%PDF-abs"


def test_missing_linked_file_says_it_is_not_on_this_mac(env, linked):
    base, rows, tmp = linked
    rows["MISS2345"] = (2, "attachments:gone.pdf")
    rows["MISS3456"] = (2, str(tmp / "gone.pdf"))
    for key in ("MISS2345", "MISS3456"):
        res, body = env[0](f"/zotero/pdf?key={key}")
        assert res.status == 404 and json.loads(body)["error"].startswith("The linked PDF is not on this Mac")


def test_relative_link_without_a_base_pref_is_404(env, linked, monkeypatch):
    _, rows, _ = linked
    monkeypatch.setattr(pdf_route, "PROFILES_DIR", linked[2] / "nowhere")
    rows["NOBA2345"] = (2, "attachments:a.pdf")
    assert env[0]("/zotero/pdf?key=NOBA2345")[0].status == 404


def test_linked_non_pdf_is_415(env, linked):
    base, rows, tmp = linked
    (base / "fake.pdf").write_text("hello")
    (tmp / "doc.docx").write_bytes(b"%PDF-but wrong extension")
    rows["FAKE2345"] = (2, "attachments:fake.pdf")
    rows["DOCX2345"] = (2, str(tmp / "doc.docx"))
    assert env[0]("/zotero/pdf?key=FAKE2345")[0].status == 415
    assert env[0]("/zotero/pdf?key=DOCX2345")[0].status == 415


def test_linked_url_is_404(env):
    env[2]["WEBL2345"] = (3, "https://example.com/a.pdf")
    assert env[0]("/zotero/pdf?key=WEBL2345")[0].status == 404


def test_streaming_does_not_wait_on_the_search_lock(env):
    get = env[0]
    done = []
    with http_api.LOCK:
        t = threading.Thread(target=lambda: done.append(get(f"/zotero/pdf?key={KEY}")[1]))
        t.start()
        t.join(timeout=5)
        assert done == [PDF]


def test_agents_are_refused(env):
    res, body = env[0](f"/zotero/pdf?key={KEY}", {"X-KB-Client": "agent"})
    assert res.status == 403 and PDF[:20] not in body


@pytest.mark.parametrize("header, size, expected", [
    (None, 100, None), ("", 100, None), ("items=0-5", 100, None), ("bytes=0-4", 100, (0, 4)),
    ("bytes=90-", 100, (90, 99)), ("bytes=-10", 100, (90, 99)), ("bytes=-500", 100, (0, 99)),
])
def test_parse_range(header, size, expected):
    assert pdf_route.parse_range(header, size) == expected
