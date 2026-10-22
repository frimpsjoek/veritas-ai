"""Single-use tickets (phase 3 task 2): an iframe or image of the hosted web app cannot send the token in a header."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode

import pytest

import http_api
import kb
import tickets
import web_origins

APP = "https://app.example.org"
CROSS = {"Sec-Fetch-Site": "cross-site"}  # what a browser sends for an iframe from another site


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(web_origins, "FILE", tmp_path / "web-origins.json")
    web_origins.add(APP)
    monkeypatch.setattr(http_api, "TOKEN_FILE", tmp_path / "api-token")
    (tmp_path / "api-token").write_text("tok")
    monkeypatch.setattr(kb, "index_running", lambda: False)
    monkeypatch.setattr(http_api.web_page, "page", lambda url, **k: {"kind": "reader", "url": url, "html": "<p>ok</p>"}, raising=False)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def call(method, path, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=5)
        conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers or {})
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res.status, raw

    yield call
    srv.shutdown()


def issue(server, route="/ping", query=None):
    status, raw = server("POST", "/web/ticket", {"Origin": APP, "Authorization": "Bearer tok", "Content-Type": "application/json"},
                         {"route": route, "query": query or {}})
    assert status == 200, raw
    body = json.loads(raw)
    assert body["expires_in"] == 120
    return body["ticket"]


def test_ticket_opens_its_route_once(server, monkeypatch):
    monkeypatch.setattr(tickets, "ROUTES", tickets.ROUTES | {"/ping"})
    t = issue(server, "/ping")
    assert server("GET", f"/ping?ticket={t}", CROSS)[0] == 200


def test_ticket_is_single_use(server, monkeypatch):
    monkeypatch.setattr(tickets, "ROUTES", tickets.ROUTES | {"/ping"})
    t = issue(server, "/ping")
    assert server("GET", f"/ping?ticket={t}", CROSS)[0] == 200
    assert server("GET", f"/ping?ticket={t}", CROSS)[0] == 403


def test_ticket_bound_to_route_and_query(server, monkeypatch):
    monkeypatch.setattr(tickets, "ROUTES", tickets.ROUTES | {"/ping", "/status"})
    t = issue(server, "/ping", {"a": "1"})
    assert server("GET", f"/status?{urlencode({'a': '1', 'ticket': t})}", CROSS)[0] == 403
    t = issue(server, "/ping", {"a": "1"})
    assert server("GET", f"/ping?{urlencode({'a': '2', 'ticket': t})}", CROSS)[0] == 403


def test_ticket_expires(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(tickets.time, "monotonic", lambda: clock[0])
    t = tickets.issue("/web/page", {"url": "https://x.org"})
    clock[0] += 121
    assert not tickets.redeem(t, "/web/page", {"url": "https://x.org"})


def test_ticket_route_needs_auth(server):
    status, _ = server("POST", "/web/ticket", {"Origin": APP, "Content-Type": "application/json"}, {"route": "/web/page", "query": {}})
    assert status == 401
    status, raw = server("POST", "/web/ticket", {"Origin": APP, "Authorization": "Bearer tok", "Content-Type": "application/json"},
                         {"route": "/search", "query": {}})
    assert status == 400  # only routes a frame or image needs
