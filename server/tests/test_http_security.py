"""http_api security: other websites get 403, the Mac's own clients pass, the phone needs the token or a cookie."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

import globus_auth
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
    monkeypatch.setattr(http_api, "GLOBUS_AUTH", None)
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
    response_cookies = response.headers.get_all("Set-Cookie") or []
    result = response.status, "\n".join(response_cookies) if response_cookies else None, response.read()
    conn.close()
    return result


def call_full(port, method, path, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    data = json.dumps(body).encode() if body is not None else None
    conn.request(method, path, body=data, headers={"Host": f"127.0.0.1:{port}", **(headers or {})})
    response = conn.getresponse()
    result = response.status, response.getheaders(), response.read()
    conn.close()
    return result


def header(headers, name):
    return [value for key, value in headers if key.lower() == name.lower()]


def cookie_value(cookies, name):
    import re
    match = re.search(rf"(?:^|\n){re.escape(name)}=([^;\n]*)", cookies or "")
    return match.group(1) if match else None


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
    assert cookie_value(cookie, "vg_session") == ""
    admin_cookie = cookie.splitlines()[0]
    session = admin_cookie.split(";")[0].removeprefix("sb_session=")
    assert {"HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=31536000"} <= {
        p.strip() for p in admin_cookie.split(";")
    }, repr(cookie)
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


def test_setup_suggest_needs_the_token_and_refuses_agents(server):
    """Spec 023: it lists folders on this computer, so it is a data route like any other."""
    port, _ = server
    assert call(port, "GET", "/setup/suggest", phone())[0] == 401
    assert call(port, "GET", "/setup/suggest", {"X-KB-Client": "agent"})[0] == 403
    assert call(port, "GET", "/setup/suggest")[0] == 200


class FakeGlobus:
    def __init__(self):
        self.config = globus_auth.Config("client-A", "secret-A", globus_auth.PRODUCTION_CALLBACK)
        self.store = SimpleNamespace(root=Path.cwd())
        self.active = False
        self.used = False
        self.calls = []

    def start(self):
        return "https://auth.globus.org/v2/oauth2/authorize?state=state-value", "binding-value"

    def complete(self, state, code, binding, provider_error=""):
        self.calls.append((state, code, binding, provider_error))
        if self.used:
            raise globus_auth.AuthError(400, "invalid or expired Globus login state")
        self.used = True
        if state != "state-value" or binding != "binding-value":
            raise globus_auth.AuthError(400, "invalid Globus browser binding")
        if provider_error:
            raise globus_auth.AuthError(400, "Globus authorization was denied")
        if not code:
            raise globus_auth.AuthError(400, "missing Globus authorization code")
        self.active = True
        return "globus-session-value"

    def principal(self, raw):
        if not self.active or raw != "globus-session-value":
            return None
        return {"kind": "globus", "tenant": "a" * 64, "name": "A User", "preferred_username": "a@alcf.anl.gov"}

    def inference_status(self, tenant):
        assert tenant == "a" * 64
        return {"connected": True, "needs_reauth": False, "expires_at": 1_800_003_600.0}

    def logout(self, raw):
        assert raw == "globus-session-value"
        self.active = False


def secure_phone(**extra):
    return phone(**{"X-Forwarded-Proto": "https", **extra})


def globus_cookie():
    return {"Cookie": "vg_session=globus-session-value"}


def test_globus_login_callback_me_and_logout(server, monkeypatch, capsys):
    port, _ = server
    fake = FakeGlobus()
    monkeypatch.setattr(http_api, "GLOBUS_AUTH", fake)

    status, headers, body = call_full(port, "GET", "/auth/globus/status", secure_phone())
    assert status == 200 and json.loads(body) == {"enabled": True}
    assert header(headers, "Cache-Control") == ["no-store"]

    status, headers, body = call_full(port, "GET", "/auth/globus/login", secure_phone())
    assert status == 302 and header(headers, "Location") == [
        "https://auth.globus.org/v2/oauth2/authorize?state=state-value"
    ]
    login_cookies = "\n".join(header(headers, "Set-Cookie"))
    assert cookie_value(login_cookies, "vg_login") == "binding-value"
    assert cookie_value(login_cookies, "vg_session") is None
    assert {"HttpOnly", "SameSite=Lax", "Secure", "Path=/auth/globus", "Max-Age=600"} <= {
        part.strip() for part in login_cookies.split(";")
    }
    assert header(headers, "Cache-Control") == ["no-store"]

    callback_headers = secure_phone(**{
        "Origin": "https://auth.globus.org",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Cookie": "vg_login=binding-value",
    })
    status, headers, body = call_full(
        port, "GET", "/auth/globus/callback?code=secret-code&state=state-value", callback_headers,
    )
    assert status == 303 and header(headers, "Location") == ["/app/#/home"]
    cookies = "\n".join(header(headers, "Set-Cookie"))
    assert cookie_value(cookies, "vg_session") == "globus-session-value"
    assert cookie_value(cookies, "vg_login") == ""
    assert cookie_value(cookies, "sb_session") == ""
    session_part = next(value for value in header(headers, "Set-Cookie") if value.startswith("vg_session="))
    assert {"HttpOnly", "SameSite=Strict", "Secure", "Path=/", "Max-Age=43200"} <= {
        part.strip() for part in session_part.split(";")
    }
    assert header(headers, "Cache-Control") == ["no-store"]
    assert header(headers, "Referrer-Policy") == ["no-referrer"]
    assert body == b""
    assert "secret-code" not in body.decode() and "state-value" not in body.decode()
    captured = capsys.readouterr()
    assert "secret-code" not in captured.out + captured.err
    assert "globus-session-value" not in captured.out + captured.err

    # A browser keeps the cross-site Fetch Metadata while following the callback's
    # redirect. The public app landing page must not reject that completed login.
    status, _, body = call_full(port, "GET", "/app/", secure_phone(**{
        "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document",
        **globus_cookie(),
    }))
    assert status in (200, 404)  # this fixture has no web bundle; never reject the navigation
    assert b"requests from other websites are refused" not in body

    for mode, dest in (("no-cors", ""), ("navigate", "iframe")):
        status, _, _ = call_full(port, "GET", "/app/", secure_phone(**{
            "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": mode, "Sec-Fetch-Dest": dest,
        }))
        assert status == 403

    status, headers, body = call_full(port, "GET", "/auth/globus/me", secure_phone(**globus_cookie()))
    assert status == 200 and header(headers, "Cache-Control") == ["no-store"]
    assert json.loads(body) == {
        "kind": "globus", "tenant": "a" * 64, "name": "A User", "preferred_username": "a@alcf.anl.gov",
        "inference": {"connected": True, "needs_reauth": False, "expires_at": 1_800_003_600.0},
    }
    assert call(port, "GET", "/ping", secure_phone(**globus_cookie()))[0] == 200
    assert call(port, "GET", "/web/state", secure_phone(**globus_cookie()))[0] == 200

    status, headers, body = call_full(port, "POST", "/auth/globus/logout", secure_phone(**globus_cookie()), {})
    assert status == 200 and json.loads(body) == {"ok": True}
    cleared = "\n".join(header(headers, "Set-Cookie"))
    assert cookie_value(cleared, "vg_session") == ""
    assert {"HttpOnly", "SameSite=Strict", "Secure", "Path=/", "Max-Age=0"} <= {
        part.strip() for part in cleared.split(";")
    }
    assert call(port, "GET", "/auth/globus/me", secure_phone(**globus_cookie()))[0] == 401


def test_globus_callback_requires_binding_and_top_level_navigation(server, monkeypatch):
    port, _ = server
    fake = FakeGlobus()
    monkeypatch.setattr(http_api, "GLOBUS_AUTH", fake)
    base = secure_phone(**{"Origin": "https://auth.globus.org", "Sec-Fetch-Site": "cross-site"})

    status, cookies, body = call(port, "GET", "/auth/globus/callback?code=code&state=state-value",
                                 {**base, "Sec-Fetch-Mode": "navigate"})
    assert status == 400 and not cookie_value(cookies, "vg_session")
    assert cookie_value(cookies, "vg_login") == ""
    assert b"code" not in body and b"state-value" not in body

    fake.used = False
    calls = len(fake.calls)
    status, _, _ = call(port, "GET", "/auth/globus/callback?code=code&state=state-value",
                        {**base, "Sec-Fetch-Mode": "no-cors", "Cookie": "vg_login=binding-value"})
    assert status == 403 and len(fake.calls) == calls


def test_globus_cookie_is_not_admin_or_a2a(server, monkeypatch):
    port, _ = server
    fake = FakeGlobus()
    fake.active = True
    monkeypatch.setattr(http_api, "GLOBUS_AUTH", fake)
    remote = secure_phone(**globus_cookie())

    assert call(port, "POST", "/a2a", remote, {"jsonrpc": "2.0"})[0] == 401
    assert call(port, "GET", "/agent/reviews", remote)[0] == 403
    assert call(port, "GET", "/agent/routines", remote)[0] == 403
    assert call(port, "GET", "/web/phone-link", remote)[0] == 403
    writes = [
        ("POST", "/sources"), ("POST", "/index"),
        ("POST", "/web/ticket"), ("POST", "/ai-note"), ("POST", "/zotero/add"),
        ("PUT", "/skills/example"), ("PUT", "/digests/example"),
        ("PATCH", "/sources/example"), ("DELETE", "/sources/example"),
    ]
    for method, path in writes:
        assert call(port, method, path, remote, {})[0] == 403, (method, path)

    assert call(port, "GET", "/ping", secure_phone(Cookie="sb_session=globus-session-value"))[0] == 401
    assert call(port, "GET", "/auth/globus/me", secure_phone(Cookie="vg_session=legacy-admin-cookie"))[0] == 401
    status, _, _ = call(port, "POST", "/app/login", secure_phone(), {"token": "secret-token"})
    assert status == 200
    admin_session = http_api.new_session()
    assert call(port, "GET", "/auth/globus/me", secure_phone(Cookie=f"sb_session={admin_session}"))[0] == 401


def test_globus_session_takes_precedence_over_legacy_cookie_and_invalid_session_fails_closed(server, monkeypatch):
    fake = FakeGlobus()
    fake.active = True
    monkeypatch.setattr(http_api, "GLOBUS_AUTH", fake)
    legacy = http_api.new_session()
    both = secure_phone(Cookie=f"sb_session={legacy}; vg_session=globus-session-value")
    assert http_api.principal(both)["kind"] == "globus"
    stale = secure_phone(Cookie=f"sb_session={legacy}; vg_session=revoked")
    assert http_api.principal(stale) is None


def test_globus_capabilities_are_default_deny():
    for path in ("/agent/reviews", "/agent/routines", "/agent/mcp-servers", "/agent/conversations/adopt",
                 "/agent/projects/adopt", "/auth/globus/agent-token", "/web/phone-link", "/setup/suggest", "/duplicates", "/conflicts",
                 "/skills", "/plugins/zotero/latest", "/zotero/xpi", "/sources/output", "/not-a-route"):
        assert not http_api.globus_route_allowed("GET", path), path
    for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
        assert not http_api.globus_route_allowed(method, "/search")
    assert http_api.globus_route_allowed("GET", "/search")
    assert http_api.globus_route_allowed("GET", "/web/state")


def test_missing_globus_config_keeps_legacy_and_a2a_behavior(server):
    port, _ = server
    status, headers, body = call_full(port, "GET", "/auth/globus/status", secure_phone())
    assert status == 200 and json.loads(body) == {"enabled": False}
    assert header(headers, "Cache-Control") == ["no-store"]
    assert call(port, "GET", "/auth/globus/login", secure_phone())[0] == 503
    assert call(port, "GET", "/ping", secure_phone(Authorization="Bearer secret-token"))[0] == 200
    assert call(port, "POST", "/a2a", secure_phone(Authorization="Bearer secret-token"), {})[0] == 401
