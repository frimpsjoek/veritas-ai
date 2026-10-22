"""http_api security: other websites get 403, the Mac's own clients pass, the phone needs the token or a cookie."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

import http_api

LOCAL = {"Host": "127.0.0.1:27182"}
PHONE = {"Host": "mac.tail1234.ts.net", "X-Forwarded-For": "100.64.0.2", "Tailscale-User-Login": "me@example.com"}


@pytest.mark.parametrize("headers, expected", [
    ({**LOCAL}, "local"),
    ({"Host": "localhost:27182"}, "local"),
    ({**LOCAL, "X-KB-Client": "agent"}, "local"),
    ({**LOCAL, "Sec-Fetch-Site": "cross-site"}, "foreign"),
    ({**LOCAL, "Sec-Fetch-Site": "same-site", "Origin": "http://127.0.0.1:9999"}, "foreign"),
    ({**LOCAL, "Origin": "https://evil.example"}, "foreign"),
    ({**LOCAL, "Origin": "http://localhost:27182"}, "foreign"),
    ({**LOCAL, "Origin": "http://127.0.0.1:27182", "Sec-Fetch-Site": "same-origin"}, "local"),
    ({**LOCAL, "Sec-Fetch-Site": "none"}, "local"),
    ({**LOCAL, "Origin": "null"}, "local"),
    ({**LOCAL, "Origin": "app://obsidian.md"}, "local"),
    ({"Host": "rebind.evil.example:27182", "Origin": "http://rebind.evil.example:27182"}, "foreign"),
    ({"Host": "rebind.evil.example:27182"}, "proxied"),
    ({**PHONE}, "proxied"),
    ({**PHONE, "Authorization": "Bearer x"}, "proxied"),
    ({**PHONE, "Cookie": "sb_session=abc"}, "proxied"),
    ({**PHONE, "Origin": "https://mac.tail1234.ts.net", "Sec-Fetch-Site": "same-origin"}, "proxied"),
    ({**PHONE, "Origin": "http://mac.tail1234.ts.net"}, "proxied"),  # same tailnet host, either scheme
    ({**PHONE, "Origin": "http://other.tail1234.ts.net"}, "foreign"),
    ({**PHONE, "Origin": "https://evil.example", "Authorization": "Bearer x"}, "foreign"),
    ({"host": "127.0.0.1:27182", "sec-fetch-site": "cross-site"}, "foreign"),
    ({"Host": "127.0.0.1:27182", "X-Forwarded-Proto": "https"}, "proxied"),
])
def test_request_class(headers, expected):
    assert http_api.request_class(headers) == expected


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(http_api, "TOKEN_FILE", tmp_path / "api-token")
    monkeypatch.setattr(http_api, "SESSIONS_FILE", tmp_path / "web" / "sessions.json")
    (tmp_path / "api-token").write_text("secret-token\n")

    def no_search():
        raise AssertionError("a refused request reached the searcher")

    monkeypatch.setattr(http_api, "searcher", no_search)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1], tmp_path
    srv.shutdown()
    srv.server_close()


def call(port, method, path, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    data = json.dumps(body).encode() if body is not None else None
    conn.request(method, path, body=data, headers={"Host": f"127.0.0.1:{port}", **(headers or {})})
    response = conn.getresponse()
    result = response.status, response.getheader("Set-Cookie"), response.read()
    conn.close()
    return result


def phone(**extra):
    return {**PHONE, **extra}


def test_other_websites_are_refused(server):
    port, _ = server
    evil = {"Origin": "https://evil.example"}
    assert call(port, "POST", "/index", evil, {})[0] == 403
    assert call(port, "PUT", "/skills/x", evil, {"text": "x"})[0] == 403
    assert call(port, "POST", "/agent/conversations", evil, {})[0] == 403
    assert call(port, "GET", "/search?q=x", {"Sec-Fetch-Site": "cross-site"})[0] == 403
    assert call(port, "GET", "/ping", {"Sec-Fetch-Site": "same-site"})[0] == 403


def test_local_clients_pass(server):
    port, _ = server
    assert call(port, "GET", "/ping")[0] == 200
    assert call(port, "GET", "/ping", {"X-KB-Client": "agent"})[0] == 200
    own = {"Origin": f"http://127.0.0.1:{port}", "Sec-Fetch-Site": "same-origin"}
    assert call(port, "GET", "/ping", own)[0] == 200


def test_proxied_needs_token_or_cookie(server):
    port, tmp = server
    assert call(port, "GET", "/ping", phone())[0] == 401
    assert call(port, "GET", "/ping", phone(Authorization="Bearer wrong"))[0] == 401
    assert call(port, "GET", "/ping", phone(Authorization="Bearer secret-token"))[0] == 200

    status, cookie, _ = call(port, "POST", "/app/login", phone(), {"token": "wrong"})
    assert (status, cookie) == (401, None)
    assert not (tmp / "web" / "sessions.json").exists()

    status, cookie, _ = call(port, "POST", "/app/login", phone(), {"token": "secret-token"})
    assert status == 200
    session = cookie.split(";")[0].removeprefix("sb_session=")
    assert {"HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=31536000"} <= {p.strip() for p in cookie.split(";")}
    # Secure only when the proxy says https: an http serve port without X-Forwarded-Proto must still keep the cookie
    assert ("Secure" in cookie) == (phone().get("X-Forwarded-Proto") == "https")
    stored = (tmp / "web" / "sessions.json").read_text()
    assert session not in stored and len(json.loads(stored)) == 1

    assert call(port, "GET", "/ping", phone(Cookie=f"sb_session={session}"))[0] == 200
    assert call(port, "GET", "/ping", phone(Cookie="sb_session=forged"))[0] == 401
    assert call(port, "POST", "/app/login", {"Origin": "https://evil.example"}, {"token": "secret-token"})[0] == 403


def test_plain_http_serve_port_keeps_its_own_origin(server):
    port, _ = server
    http_phone = phone(**{"X-Forwarded-Proto": "http", "Host": "mac.tail1234.ts.net:27182"})
    assert http_api.request_class({**http_phone, "Origin": "http://mac.tail1234.ts.net:27182"}) == "proxied"
    assert http_api.request_class({**http_phone, "Origin": "https://mac.tail1234.ts.net:27182"}) == "proxied"
    assert http_api.request_class({**http_phone, "Origin": "http://evil.example"}) == "foreign"
    status, cookie, _ = call(port, "POST", "/app/login", http_phone, {"token": "secret-token"})
    assert status == 200 and "Secure" not in cookie and "HttpOnly" in cookie


def test_app_files_are_public_to_the_phone_but_data_is_not(server):
    port, _ = server
    assert call(port, "GET", "/app/", phone())[0] in (200, 404)  # no bundle in this fixture; never 401
    assert call(port, "GET", "/app/login", phone())[0] in (200, 404)
    assert call(port, "GET", "/search?q=x", phone())[0] == 401
    assert call(port, "POST", "/app/x", phone(), {})[0] == 401


def test_https_proxy_gets_a_secure_cookie(server):
    port, _ = server
    status, cookie, _ = call(port, "POST", "/app/login", phone(**{"X-Forwarded-Proto": "https"}), {"token": "secret-token"})
    assert status == 200 and "Secure" in cookie


def test_the_link_panel_routes_need_the_token_and_refuse_agents_and_private_links(server):
    """Spec 022: /web/page and /web/pdf fetch other sites for the user, so they are data routes like any other."""
    port, _ = server
    for path in ("/web/page?url=https%3A%2F%2Fexample.org%2F", "/web/pdf?url=https%3A%2F%2Fexample.org%2Fp.pdf"):
        assert call(port, "GET", path, phone())[0] == 401
        assert call(port, "GET", path, {"X-KB-Client": "agent"})[0] == 403
    status, _, body = call(port, "GET", "/web/page?url=http%3A%2F%2F127.0.0.1%3A1%2Fstatus")
    assert status == 200 and json.loads(body)["mode"] == "blocked"
    assert call(port, "GET", "/web/pdf?url=http%3A%2F%2Flocalhost%2Fx.pdf")[0] == 400
