"""Native Zotero WebDAV probes, streaming, authorization, and path/body defenses."""
from __future__ import annotations

import base64
import hashlib
import http.client
import json
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

import http_api
import zotero_storage

TENANT_A = "a" * 64
TENANT_B = "b" * 64
PUBLIC = "https://veritas.trinityscience.org/webdav"
PHONE = {"Host": "veritas.trinityscience.org", "X-Forwarded-Proto": "https"}
PROBE_XML = b"<propfind xmlns='DAV:'><prop><getcontentlength/></prop></propfind>"


@pytest.fixture
def dav_server(tmp_path, monkeypatch):
    config = zotero_storage.PublicConfig(PUBLIC, pool_bytes=500_000, user_bytes=100_000,
                                        pbkdf2_iterations=100)
    store = zotero_storage.StorageService(tmp_path / "users", tmp_path / "storage.sqlite", config)
    monkeypatch.setattr(http_api, "ZOTERO_STORAGE", store, raising=False)
    monkeypatch.setattr(http_api, "ZOTERO_STORAGE_CONFIG", config, raising=False)
    monkeypatch.setattr(http_api, "TOKEN_FILE", tmp_path / "api-token")
    (tmp_path / "api-token").write_text("admin-token")
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    issued = store.issue_credentials(TENANT_A)
    yield server.server_address[1], store, issued
    server.shutdown()
    server.server_close()
    store.close()


def basic(issued):
    raw = f"{issued['username']}:{issued['password']}".encode()
    return {"Authorization": "Basic " + base64.b64encode(raw).decode()}


def call(port, method, path, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    if isinstance(body, str):
        body = body.encode()
    conn.request(method, path, body=body, headers={**PHONE, **(headers or {})})
    response = conn.getresponse()
    status, all_headers, payload = response.status, response.getheaders(), response.read()
    conn.close()
    return status, dict(all_headers), payload


def raw_status(port, method, path, headers, body=b""):
    """Send bytes without http.client repairing or constraining malformed framing."""
    lines = [f"{method} {path} HTTP/1.1\r\n".encode()]
    for name, value in headers.items():
        lines.append(name.encode() + b": " + (value.encode("utf-8") if isinstance(value, str) else value) + b"\r\n")
    request = b"".join(lines) + b"\r\n" + body
    with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
        connection.sendall(request)
        connection.shutdown(socket.SHUT_WR)
        response = b""
        while True:
            block = connection.recv(65536)
            if not block:
                break
            response += block
    return int(response.split(b" ", 2)[1])


def test_zotero_upstream_verification_sequence(dav_server):
    port, store, issued = dav_server
    root = f"/webdav/{issued['username']}/zotero/"
    status, headers, body = call(port, "OPTIONS", root)
    assert status == 204 and headers["DAV"] == "1, 2" and not body
    status, headers, body = call(port, "PROPFIND", root, {**basic(issued), "Depth": "0",
                                                          "Content-Type": "text/xml; charset=utf-8"}, PROBE_XML)
    assert status == 207 and b"multistatus" in body and b"getcontentlength" in body
    test_file = root + "zotero-test-file.prop"
    assert call(port, "PUT", test_file, basic(issued), b" ")[0] == 201
    assert call(port, "GET", test_file, basic(issued))[:3:2] == (200, b" ")
    assert call(port, "GET", root + "nonexistent.prop", basic(issued))[0] == 404
    assert call(port, "DELETE", test_file, basic(issued))[0] == 204
    assert call(port, "GET", test_file, basic(issued))[0] == 404
    assert call(port, "MKCOL", root, basic(issued))[0] == 405


def test_zip_stream_replace_head_and_depth_one_listing(dav_server):
    port, store, issued = dav_server
    url = f"/webdav/{issued['username']}/zotero/PAPER001.zip"
    payload = b"\x00\x01research" * 9_000  # 90,000 bytes: multi-chunk, leaving replacement headroom
    assert call(port, "PUT", url, {**basic(issued), "Content-Type": "application/zip"}, payload)[0] == 201
    status, headers, data = call(port, "HEAD", url, basic(issued))
    assert status == 200 and not data and headers["Content-Length"] == str(len(payload))
    assert headers["ETag"] == f'"{hashlib.sha256(payload).hexdigest()}"'
    assert headers["Cache-Control"] == "private, no-store"
    status, headers, data = call(port, "GET", url, basic(issued))
    assert status == 200 and data == payload and headers["Content-Type"] == "application/zip"
    status, _, document = call(port, "PROPFIND", url, {**basic(issued), "Depth": "0"}, PROBE_XML)
    assert status == 207 and f"<D:getcontentlength>{len(payload)}</D:getcontentlength>".encode() in document
    assert b"<D:collection" not in document
    status, _, document = call(port, "PROPFIND", url.rsplit("/", 1)[0] + "/",
                               {**basic(issued), "Depth": "1"}, PROBE_XML)
    assert status == 207 and b"PAPER001.zip" in document
    replacement = b"new immutable version"
    assert call(port, "PUT", url, basic(issued), replacement)[0] == 204
    assert call(port, "GET", url, basic(issued))[2] == replacement


def test_basic_auth_is_route_scoped_and_bound_to_url_username(dav_server):
    port, store, issued = dav_server
    root = f"/webdav/{issued['username']}/zotero/"
    status, headers, _ = call(port, "GET", root + "PAPER001.prop")
    assert status == 401 and headers["WWW-Authenticate"] == 'Basic realm="Veritas Zotero"'
    other = store.issue_credentials(TENANT_B)
    for method, body in (("PROPFIND", PROBE_XML), ("GET", None), ("HEAD", None),
                         ("PUT", b"x"), ("DELETE", None), ("MKCOL", None)):
        extra = {"Depth": "0"} if method == "PROPFIND" else {}
        assert call(port, method, root + "PAPER001.prop" if method != "MKCOL" else root,
                    {**basic(other), **extra}, body)[0] == 401, method
    assert call(port, "GET", "/zotero-storage", basic(issued))[0] == 401
    assert call(port, "GET", root + "PAPER001.prop", {"Authorization": "Bearer admin-token"})[0] == 401
    assert call(port, "OPTIONS", "/webdav/not-a-real-user/zotero/")[0] == 204


def test_native_rejects_foreign_and_untrusted_transport(dav_server):
    port, _, issued = dav_server
    path = f"/webdav/{issued['username']}/zotero/PAPER001.prop"
    for headers in ({"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"},
                    {"X-Forwarded-Proto": "http"}, {"Host": "evil.example"}):
        assert call(port, "PUT", path, {**basic(issued), **headers}, b"x")[0] == 403
    config = zotero_storage.PublicConfig(PUBLIC)
    assert not zotero_storage.trusted_transport(PHONE, "8.8.8.8", config)


@pytest.mark.parametrize("headers,expected", [
    ({}, 411), ({"Content-Length": "-1"}, 400), ({"Content-Length": "1.5"}, 400),
    ({"Content-Length": "１"}, 400), ({"Content-Length": "9" * 20}, 413),
    ({"Transfer-Encoding": "chunked"}, 501),
])
def test_invalid_upload_body_framing_is_refused(dav_server, headers, expected):
    port, _, issued = dav_server
    path = f"/webdav/{issued['username']}/zotero/PAPER001.prop"
    body = b"" if not headers or "Transfer-Encoding" in headers else b"x"
    assert raw_status(port, "PUT", path, {**PHONE, **basic(issued), **headers}, body) == expected


@pytest.mark.parametrize("name", ["../a.prop", "a/b.prop", ".hidden.prop", "a.txt", "a%2fb.prop",
                                  "%252e%252e%252fa.prop", "a%5cb.prop", "a%00.prop", "lastsync"])
def test_resource_paths_cannot_escape_or_create_markers(dav_server, name):
    port, _, issued = dav_server
    path = f"/webdav/{issued['username']}/zotero/{name}"
    assert call(port, "PUT", path, basic(issued), b"bad")[0] == 404


def test_quota_and_xml_limits(dav_server):
    port, _, issued = dav_server
    root = f"/webdav/{issued['username']}/zotero/"
    assert call(port, "PUT", root + "TOOBIG001.zip", basic(issued), b"x" * 100_001)[0] == 507
    for depth, body, expected in (("infinity", None, 403), ("2", None, 400),
                                  ("0", b"<!DOCTYPE x><propfind/>", 400),
                                  ("0", b"<not-xml", 400)):
        status, _, _ = call(port, "PROPFIND", root, {**basic(issued), "Depth": depth}, body)
        assert status == expected
    # Explicitly oversize framing is refused before the XML stream is read.
    assert call(port, "PROPFIND", root, {**basic(issued), "Depth": "0",
                                         "Content-Length": str(64 * 1024 + 1)}, b"")[0] == 413


def test_short_socket_body_rolls_back_reservation(dav_server):
    port, store, issued = dav_server
    path = f"/webdav/{issued['username']}/zotero/PAPER001.prop"
    status = raw_status(port, "PUT", path, {**PHONE, **basic(issued), "Content-Length": "5"}, b"abc")
    assert status == 400 and store.pool_used() == 0


def test_idle_authenticated_upload_times_out_and_releases(tmp_path, monkeypatch):
    config = zotero_storage.PublicConfig(PUBLIC, pool_bytes=1_000, user_bytes=500,
                                        read_timeout_seconds=0.05, pbkdf2_iterations=100)
    store = zotero_storage.StorageService(tmp_path / "users", tmp_path / "storage.sqlite", config)
    monkeypatch.setattr(http_api, "ZOTERO_STORAGE", store, raising=False)
    monkeypatch.setattr(http_api, "ZOTERO_STORAGE_CONFIG", config, raising=False)
    issued = store.issue_credentials(TENANT_A)
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        path = f"/webdav/{issued['username']}/zotero/PAPER001.prop"
        headers = {**PHONE, **basic(issued), "Content-Length": "4"}
        request = f"PUT {path} HTTP/1.1\r\n".encode()
        request += b"".join(name.encode() + b": " + value.encode() + b"\r\n"
                             for name, value in headers.items()) + b"\r\n"
        with socket.create_connection(("127.0.0.1", server.server_address[1]), timeout=5) as connection:
            connection.sendall(request)  # declare bytes, then leave the authenticated upload idle
            response = connection.recv(4096)
        assert b" 408 " in response and store.pool_used() == 0
    finally:
        server.shutdown()
        server.server_close()
        store.close()


def test_verifier_admission_rejects_excess_work_promptly(dav_server, monkeypatch):
    port, store, issued = dav_server
    condition = threading.Condition()
    release = threading.Event()
    entered = 0

    def blocked_authenticate(username, password):
        nonlocal entered
        with condition:
            entered += 1
            condition.notify_all()
        assert release.wait(5)
        return None

    monkeypatch.setattr(store, "authenticate", blocked_authenticate)
    path = f"/webdav/{issued['username']}/zotero/PAPER001.prop"
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = [pool.submit(call, port, "GET", path, basic(issued)) for _ in range(4)]
        with condition:
            assert condition.wait_for(lambda: entered == 4, timeout=5)
        assert call(port, "GET", path, basic(issued))[0] == 429
        release.set()
        assert all(future.result(timeout=5)[0] == 401 for future in pending)


def test_rotation_only_affects_new_authentication(dav_server):
    port, store, issued = dav_server
    path = f"/webdav/{issued['username']}/zotero/PAPER001.prop"
    headers = {**PHONE, **basic(issued), "Content-Length": "4"}
    request = f"PUT {path} HTTP/1.1\r\n".encode()
    request += b"".join(name.encode() + b": " + value.encode() + b"\r\n"
                         for name, value in headers.items()) + b"\r\n"
    with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
        connection.sendall(request + b"x")
        deadline = time.time() + 5
        while store.pool_used() == 0 and time.time() < deadline:
            time.sleep(0.01)
        assert store.pool_used() == 4  # the old credential has authenticated and reserved its upload
        replacement = store.issue_credentials(TENANT_A)
        connection.sendall(b"abc")
        connection.shutdown(socket.SHUT_WR)
        response = b""
        while True:
            block = connection.recv(4096)
            if not block:
                break
            response += block
    assert b" 201 " in response
    assert call(port, "GET", path, basic(issued))[0] == 401
    new_path = f"/webdav/{replacement['username']}/zotero/PAPER001.prop"
    status, _, data = call(port, "GET", new_path, basic(replacement))
    assert status == 200 and data == b"xabc"
    store.revoke_credentials(TENANT_A)
    assert call(port, "GET", new_path, basic(replacement))[0] == 401
