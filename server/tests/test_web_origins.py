"""Allowed web-app origins (phase 3 task 1): a listed origin gets CORS and must send the token; others stay refused."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

import http_api
import kb
import web_origins

APP = "https://app.example.org"


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(web_origins, "FILE", tmp_path / "web-origins.json")
    monkeypatch.delenv("VERITAS_WEB_ORIGINS", raising=False)
    web_origins.add(APP)
    monkeypatch.setattr(http_api, "TOKEN_FILE", tmp_path / "api-token")
    (tmp_path / "api-token").write_text("tok")
    monkeypatch.setattr(kb, "index_running", lambda: False)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def call(method, path, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=5)
        conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers or {})
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, {k.lower(): v for k, v in res.getheaders()}, raw

    yield call
    srv.shutdown()


def test_unlisted_origin_still_refused(server):
    status, headers, _ = server("GET", "/ping", {"Origin": "https://evil.example", "Authorization": "Bearer tok"})
    assert status == 403 and "access-control-allow-origin" not in headers


def test_allowed_origin_with_token_gets_cors_headers(server):
    status, headers, body = server("GET", "/ping", {"Origin": APP, "Authorization": "Bearer tok"})
    assert status == 200 and json.loads(body) == {"ok": True}
    assert headers["access-control-allow-origin"] == APP and "Origin" in headers["vary"]


def test_allowed_origin_still_needs_token_on_loopback(server):
    status, headers, _ = server("GET", "/ping", {"Origin": APP})
    assert status == 401 and headers["access-control-allow-origin"] == APP  # the page can read the 401
    status, _, _ = server("GET", "/ping", {"Origin": APP, "Authorization": "Bearer wrong"})
    assert status == 401


def test_preflight_answers_allowed_origin_only(server):
    status, headers, _ = server("OPTIONS", "/search", {
        "Origin": APP, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization",
        "Access-Control-Request-Private-Network": "true"})
    assert status == 204
    assert headers["access-control-allow-origin"] == APP
    assert "Authorization" in headers["access-control-allow-headers"]
    assert "PATCH" in headers["access-control-allow-methods"]
    assert headers["access-control-allow-private-network"] == "true"
    status, headers, _ = server("OPTIONS", "/search", {"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert status == 403 and "access-control-allow-origin" not in headers


def test_origins_from_env_and_file(tmp_path, monkeypatch):
    monkeypatch.setattr(web_origins, "FILE", tmp_path / "o.json")
    monkeypatch.setenv("VERITAS_WEB_ORIGINS", "http://127.0.0.1:8765, https://x.example/")
    web_origins.add("https://Y.example:8443/app/")
    assert web_origins.allowed() == {"http://127.0.0.1:8765", "https://x.example", "https://y.example:8443"}
    web_origins.remove("https://y.example:8443")
    assert web_origins.allowed() == {"http://127.0.0.1:8765", "https://x.example"}
    with pytest.raises(ValueError):
        web_origins.add("not an origin")


def test_cli_adds_and_lists(tmp_path, monkeypatch, capsys):
    import sys
    monkeypatch.setattr(web_origins, "FILE", tmp_path / "o.json")
    monkeypatch.delenv("VERITAS_WEB_ORIGINS", raising=False)
    monkeypatch.setattr(sys, "argv", ["kb.py", "web-origins", "add", "http://127.0.0.1:8765/"])
    kb.main()
    assert capsys.readouterr().out.strip() == "http://127.0.0.1:8765"
