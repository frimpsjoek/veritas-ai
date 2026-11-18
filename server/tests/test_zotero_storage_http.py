"""Personal WebDAV management APIs use only the verified Globus tenant."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

import globus_auth
import http_api
import zotero_storage

TENANT_A = "a" * 64
TENANT_B = "b" * 64
SESSION_A = "session-A"
PUBLIC = "https://veritas.trinityscience.org/webdav"
PHONE = {"Host": "veritas.trinityscience.org", "X-Forwarded-Proto": "https"}


class FakeGlobus:
    def __init__(self, root):
        self.store = SimpleNamespace(root=root)
        self.config = globus_auth.Config("client", "secret", globus_auth.PRODUCTION_CALLBACK)

    def principal(self, raw):
        if raw != SESSION_A:
            return None
        return {"kind": "globus", "tenant": TENANT_A, "name": "User A", "preferred_username": "a@example.org"}


def store_at(tmp_path, **values):
    config = zotero_storage.PublicConfig(PUBLIC, pool_bytes=1_000, user_bytes=500,
                                        pbkdf2_iterations=100, **values)
    return zotero_storage.StorageService(tmp_path / "users", tmp_path / "storage.sqlite", config)


@pytest.fixture
def service(tmp_path):
    store = store_at(tmp_path)
    yield store
    store.close()


@pytest.fixture
def tenant_server(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    monkeypatch.setattr(http_api, "TOKEN_FILE", tmp_path / "api-token")
    monkeypatch.setattr(http_api, "SESSIONS_FILE", tmp_path / "legacy-sessions.json")
    (tmp_path / "api-token").write_text("admin-token")
    monkeypatch.setattr(http_api, "GLOBUS_AUTH", FakeGlobus(tmp_path / "users"))
    monkeypatch.setattr(http_api, "ZOTERO_STORAGE", store, raising=False)
    monkeypatch.setattr(http_api, "ZOTERO_STORAGE_CONFIG", store.config, raising=False)
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1], store
    server.shutdown()
    server.server_close()
    store.close()


def call(port, method, path, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    data = body.encode() if isinstance(body, str) else json.dumps(body).encode() if body is not None else None
    conn.request(method, path, data, headers={**PHONE, **(headers or {})})
    response = conn.getresponse()
    status, all_headers, payload = response.status, response.getheaders(), response.read()
    conn.close()
    return status, all_headers, json.loads(payload or b"null")


def authorized(**extra):
    return {"Cookie": f"vg_session={SESSION_A}", **extra}


def test_public_config_is_canonical_https_and_bounded():
    config = zotero_storage.PublicConfig(PUBLIC)
    parsed = config.require_enabled()
    assert parsed.base == PUBLIC and parsed.host == "veritas.trinityscience.org"
    for bad in (None, "", "http://veritas.trinityscience.org/webdav",
                "https://user:pass@veritas.trinityscience.org/webdav",
                "https://veritas.trinityscience.org/other",
                "https://veritas.trinityscience.org/webdav?x=1",
                "https://veritas.trinityscience.org/webdav#x"):
        with pytest.raises(zotero_storage.StorageDisabled):
            zotero_storage.PublicConfig(bad).require_enabled()
    for bad in (0, -1, True, "1.5", "9" * 21, 2**63):
        with pytest.raises(ValueError):
            zotero_storage.PublicConfig(PUBLIC, user_bytes=bad)
    assert zotero_storage.PublicConfig(PUBLIC, user_bytes=2**63 - 1).user_bytes == 2**63 - 1


def test_disabled_management_status_and_mutations(tenant_server, monkeypatch):
    port, store = tenant_server
    monkeypatch.setattr(http_api, "ZOTERO_STORAGE", None)
    monkeypatch.setattr(http_api, "ZOTERO_STORAGE_CONFIG", zotero_storage.PublicConfig(None))
    status, headers, body = call(port, "GET", "/zotero-storage", authorized())
    assert status == 200 and body["enabled"] is False and "issuer" not in body
    assert dict(headers).get("Cache-Control") == "no-store"
    for method in ("POST", "DELETE"):
        status, _, _ = call(port, method, "/zotero-storage/credentials", authorized(), {})
        assert status == 503
    status, _, _ = call(port, "OPTIONS", "/webdav/someone/zotero/")
    assert status == 404


def test_configured_but_unavailable_storage_is_not_reported_as_unconfigured(tenant_server, monkeypatch):
    # serve() leaves the service unset with a valid endpoint when the ledger is unreadable.
    port, store = tenant_server
    monkeypatch.setattr(http_api, "ZOTERO_STORAGE", None)
    status, _, body = call(port, "GET", "/zotero-storage", authorized())
    assert status == 200 and body["enabled"] is False and body["issued"] is False
    assert body["error"] == "Zotero file storage is unavailable"
    for method in ("POST", "DELETE"):
        assert call(port, method, "/zotero-storage/credentials", authorized(), {})[0] == 503


def test_globus_identity_is_required_and_tenant_header_cannot_spoof(tenant_server):
    port, _ = tenant_server
    for auth, expected in (({}, 401), ({"Authorization": "Bearer admin-token"}, 403),
                           ({"Authorization": "Bearer a2a-token"}, 401)):
        status, _, _ = call(port, "GET", "/zotero-storage", auth)
        assert status == expected
    status, _, body = call(port, "GET", "/zotero-storage", authorized(**{"X-Veritas-Tenant": TENANT_B}))
    assert status == 200 and body["issued"] is False
    status, _, body = call(port, "POST", "/zotero-storage/credentials", authorized(**{"X-Veritas-Tenant": TENANT_B}), {})
    assert status in (200, 201) and body["endpoint"].startswith(PUBLIC + "/")


def test_credentials_are_one_time_and_cross_site_mutations_are_denied(tenant_server):
    port, store = tenant_server
    evil = authorized(**{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"})
    assert call(port, "POST", "/zotero-storage/credentials", evil, {})[0] == 403
    assert store.status(TENANT_A)["issued"] is False
    status, _, issued = call(port, "POST", "/zotero-storage/credentials", authorized(), {})
    assert status in (200, 201)
    assert set(issued) == {"username", "password", "endpoint"}
    assert issued["endpoint"] == f"{PUBLIC}/{issued['username']}"
    assert issued["password"] not in json.dumps(store.status(TENANT_A))
    status, _, rotated = call(port, "POST", "/zotero-storage/credentials", authorized(), {})
    assert status == 200 and rotated["username"] != issued["username"]
    assert store.authenticate(issued["username"], issued["password"]) is None
    assert store.authenticate(rotated["username"], rotated["password"]) == TENANT_A
    assert call(port, "DELETE", "/zotero-storage/credentials", evil)[0] == 403
    assert call(port, "DELETE", "/zotero-storage/credentials", authorized())[0] == 200
    assert store.authenticate(rotated["username"], rotated["password"]) is None


def test_malformed_management_json_is_400_without_mutating_credentials(tenant_server):
    port, store = tenant_server
    for method in ("POST", "DELETE"):
        status, _, body = call(port, method, "/zotero-storage/credentials", authorized(), "{")
        assert status == 400 and body == {"error": "invalid JSON"}
        assert store.status(TENANT_A)["issued"] is False
    status, _, issued = call(port, "POST", "/zotero-storage/credentials", authorized(), {})
    assert status == 201
    status, _, body = call(port, "DELETE", "/zotero-storage/credentials", authorized(), "{")
    assert status == 400 and store.authenticate(issued["username"], issued["password"]) == TENANT_A


def test_plaintext_and_hostile_proxy_headers_cannot_issue_canonical_endpoint(tenant_server):
    port, _ = tenant_server
    for hostile in ({"X-Forwarded-Proto": "http"}, {"Host": "evil.example"},
                    {"X-Forwarded-Proto": "https", "Host": "evil.example"}):
        status, _, _ = call(port, "POST", "/zotero-storage/credentials", authorized(**hostile), {})
        assert status == 403
