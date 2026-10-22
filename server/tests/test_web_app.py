"""The web app's static serving and state file (spec 013 W1)."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

import http_api
import web_app


@pytest.fixture
def web(tmp_path, monkeypatch):
    root = tmp_path / "web"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>Second Brain</title>")
    (root / "app-1a2b3c4d.js").write_text("export {}")
    (root / "app.css").write_text("body{}")
    (root / "icon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    (root / "icon-192.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (root / "manifest.webmanifest").write_text("{}")
    (root / "assets" / "data.json").write_text("{}")
    (root / "state.json").write_text('{"prefs": {"secret": 1}, "files": {}}')
    (root / "sessions.json").write_text('{"abc": "cookie"}')
    (tmp_path / "outside.txt").write_text("outside")
    monkeypatch.setattr(web_app, "WEB_DIR", root)
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def call(method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        data = json.dumps(body).encode() if body is not None and not isinstance(body, bytes) else body
        conn.request(method, path, data, headers or {})
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        return res, raw

    yield call, root
    server.shutdown()
    server.server_close()


def get(web, path, **kw):
    return web[0]("GET", path, **kw)


def test_index_is_served_and_never_cached(web):
    res, body = get(web, "/app/")
    assert res.status == 200 and b"Second Brain" in body
    assert res.getheader("Content-Type") == "text/html; charset=utf-8"
    assert res.getheader("Cache-Control") == "no-cache"


def test_app_without_a_slash_redirects_so_relative_urls_resolve(web):
    res, _ = get(web, "/app")
    assert res.status == 308 and res.getheader("Location") == "/app/"


@pytest.mark.parametrize("path,type_", [
    ("/app/app-1a2b3c4d.js", "text/javascript; charset=utf-8"),
    ("/app/app.css", "text/css; charset=utf-8"),
    ("/app/icon.svg", "image/svg+xml"),
    ("/app/icon-192.png", "image/png"),
    ("/app/manifest.webmanifest", "application/manifest+json"),
    ("/app/assets/data.json", "application/json; charset=utf-8"),
])
def test_content_types(web, path, type_):
    res, _ = get(web, path)
    assert res.status == 200 and res.getheader("Content-Type") == type_


def test_hashed_assets_cache_for_a_year_and_the_rest_revalidate(web):
    assert get(web, "/app/app-1a2b3c4d.js")[0].getheader("Cache-Control") == "max-age=31536000, immutable"
    for name in ("app.css", "icon.svg", "manifest.webmanifest"):
        assert get(web, f"/app/{name}")[0].getheader("Cache-Control") == "no-cache"


@pytest.mark.parametrize("path", [
    "/app/../http_api.py", "/app/%2e%2e/http_api.py", "/app/%2E%2E/outside.txt", "/app/..%2foutside.txt",
    "/app/assets/../../outside.txt", "/app/%252e%252e/outside.txt", "/app/..\\outside.txt", "/app//etc/passwd",
    "/app/%00", "/app/index.html%00.png",
])
def test_traversal_is_a_404(web, path):
    res, body = get(web, path)
    assert res.status == 404 and b"outside" not in body and b"import" not in body


def test_a_symlink_out_of_the_folder_is_not_followed(web, tmp_path):
    _, root = web
    (root / "link.txt").symlink_to(tmp_path / "outside.txt")
    assert get(web, "/app/link.txt")[0].status == 404


def test_missing_file_and_directory_are_404(web):
    assert get(web, "/app/nope.js")[0].status == 404
    assert get(web, "/app/assets")[0].status == 404


def test_server_owned_files_are_not_downloadable(web):
    for name in ("state.json", "sessions.json", "pending-adds.json"):
        assert get(web, f"/app/{name}")[0].status == 404


def test_static_serving_does_not_wait_for_the_search_lock(web):
    with http_api.LOCK:
        assert get(web, "/app/")[0].status == 200


def test_agents_cannot_read_the_app_or_the_state(web):
    for path in ("/app/", "/web/state"):
        assert get(web, path, headers={"X-KB-Client": "agent"})[0].status == 403


def test_state_defaults_to_empty(web):
    _, root = web
    (root / "state.json").unlink()
    res, body = get(web, "/web/state")
    assert res.status == 200 and json.loads(body) == {"prefs": {}, "files": {}}


def test_state_merges_and_null_removes(web):
    call, root = web
    (root / "state.json").unlink()
    assert call("POST", "/web/state", {"prefs": {"a": 1, "b": {"x": 1}}, "files": {"f1": "one"}})[0].status == 200
    res, body = call("POST", "/web/state", {"prefs": {"b": None, "c": [2]}, "files": {"f2": "two"}})
    assert res.status == 200
    assert json.loads(body) == {"prefs": {"a": 1, "c": [2]}, "files": {"f1": "one", "f2": "two"}}
    assert json.loads(get(web, "/web/state")[1]) == json.loads(body)
    assert json.loads(call("POST", "/web/state", {"files": {"f1": None}})[1])["files"] == {"f2": "two"}
    assert not list(root.glob(".state-*")), "no temp file is left behind"


def test_a_corrupt_state_file_reads_as_empty_and_is_replaced_on_save(web):
    call, root = web
    (root / "state.json").write_text("{not json")
    assert json.loads(get(web, "/web/state")[1]) == {"prefs": {}, "files": {}}
    assert call("POST", "/web/state", {"prefs": {"a": 1}})[0].status == 200
    assert json.loads((root / "state.json").read_text())["prefs"] == {"a": 1}


def test_one_file_over_256_kb_is_refused_and_nothing_is_saved(web):
    call, root = web
    (root / "state.json").unlink()
    res, _ = call("POST", "/web/state", {"prefs": {"a": 1}, "files": {"big": "x" * (256 * 1024 + 1)}})
    assert res.status == 413 and not (root / "state.json").exists()
    assert call("POST", "/web/state", {"files": {"edge": "x" * (256 * 1024)}})[0].status == 200


def test_files_over_2_mb_in_total_are_refused(web):
    call, root = web
    (root / "state.json").unlink()
    chunk = "y" * (256 * 1024)
    for i in range(8):
        assert call("POST", "/web/state", {"files": {f"f{i}": chunk}})[0].status == 200
    res, _ = call("POST", "/web/state", {"files": {"one-more": "z"}})
    assert res.status == 413
    assert "one-more" not in json.loads(get(web, "/web/state")[1])["files"]
    assert call("POST", "/web/state", {"files": {"f0": None, "one-more": "z"}})[0].status == 200


def test_bad_bodies_are_400(web):
    call, _ = web
    assert call("POST", "/web/state", {"files": {"a": 5}})[0].status == 400
    assert call("POST", "/web/state", {"prefs": []})[0].status == 400
    assert call("POST", "/web/state", b"{nope")[0].status == 400
    assert call("POST", "/web/state", [1])[0].status == 400


def test_a_huge_body_is_refused_from_its_declared_length(web):
    call, _ = web
    res, _ = call("POST", "/web/state", b"{}", {"Content-Length": str(web_app.MAX_BODY + 1)})
    assert res.status == 413


PHONE = {"X-Forwarded-For": "100.64.0.2", "Tailscale-User-Login": "me@example.com"}


@pytest.fixture
def signed(web, tmp_path, monkeypatch):
    monkeypatch.setattr(http_api, "TOKEN_FILE", tmp_path / "api-token")
    monkeypatch.setattr(http_api, "SESSIONS_FILE", tmp_path / "sessions.json")
    (tmp_path / "api-token").write_text("secret-token\n")
    return web


def test_phone_reaches_the_app_files_without_signing_in(signed):
    call, root = signed
    (root / "login.html").write_text("<!doctype html><title>Sign in</title>")
    for path in ("/app/", "/app/app-1a2b3c4d.js", "/app/login", "/app/manifest.webmanifest"):
        assert call("GET", path, headers=PHONE)[0].status == 200, path
    res, body = call("GET", "/app/login", headers=PHONE)
    assert b"Sign in" in body and res.getheader("Cache-Control") == "no-cache"
    # still private: the server's own files, and every data route
    assert call("GET", "/app/state.json", headers=PHONE)[0].status == 404
    assert call("GET", "/search?q=x", headers=PHONE)[0].status == 401
    assert call("GET", "/web/state", headers=PHONE)[0].status == 401
    assert call("POST", "/web/state", {"prefs": {}}, headers=PHONE)[0].status == 401


def test_phone_gets_data_after_login_and_not_the_phone_link(signed):
    call, _ = signed
    res, _ = call("POST", "/app/login", {"token": "secret-token"}, headers={**PHONE, "X-Forwarded-Proto": "http"})
    cookie = res.getheader("Set-Cookie")
    assert res.status == 200 and "Secure" not in cookie  # plain-http serve port: Safari would drop a Secure cookie
    session = {"Cookie": cookie.split(";")[0], **PHONE}
    assert call("GET", "/web/state", headers=session)[0].status == 200
    # the token is shown on the Mac only: a signed-in phone is refused too
    assert call("GET", "/web/phone-link", headers=session)[0].status == 403
    assert call("GET", "/web/phone-link", headers=PHONE)[0].status == 401


def test_phone_link_is_served_to_the_mac(signed, monkeypatch):
    call, _ = signed
    monkeypatch.setattr(web_app, "phone_link", lambda t, port: {"url": f"https://mac.ts.net/app/login#t={t}"})
    res, body = call("GET", "/web/phone-link")
    assert res.status == 200 and json.loads(body) == {"url": "https://mac.ts.net/app/login#t=secret-token"}


STATUS = {"BackendState": "Running", "Self": {"DNSName": "mac.tail1.ts.net."}}
SERVE = {"TCP": {"27182": {"HTTP": True}, "443": {"HTTPS": True}, "8443": {"HTTPS": True}},
         "Web": {"mac.tail1.ts.net:27182": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:27182"}}},
                 "mac.tail1.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8787"}}},
                 "mac.tail1.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:27182"}}}}}


def fake_tailscale(monkeypatch, status, serve):
    monkeypatch.setattr(web_app, "_tailscale", lambda *args: serve if args[0] == "serve" else status)


def test_phone_link_finds_the_port_that_forwards_here(monkeypatch):
    fake_tailscale(monkeypatch, STATUS, SERVE)
    assert web_app.phone_link("tok") == {"url": "https://mac.tail1.ts.net:8443/app/login#t=tok", "host": "mac.tail1.ts.net", "secure": True}
    only_http = {**SERVE, "Web": {k: v for k, v in SERVE["Web"].items() if not k.endswith(":8443")}}
    fake_tailscale(monkeypatch, STATUS, only_http)
    link = web_app.phone_link("tok")
    assert link["url"] == "http://mac.tail1.ts.net:27182/app/login#t=tok" and link["secure"] is False


def test_phone_link_says_what_is_missing(monkeypatch):
    fake_tailscale(monkeypatch, None, None)
    assert "not installed" in web_app.phone_link("tok")["problem"]
    fake_tailscale(monkeypatch, {"BackendState": "Stopped", "Self": {}}, None)
    assert "not connected" in web_app.phone_link("tok")["problem"]
    fake_tailscale(monkeypatch, STATUS, {})
    missing = web_app.phone_link("tok")
    assert missing["command"] == "tailscale serve --bg --https=8443 http://127.0.0.1:27182" and "url" not in missing


def test_phone_link_points_at_hosted_app_when_set(monkeypatch, tmp_path):
    fake_tailscale(monkeypatch, STATUS, SERVE)
    monkeypatch.setattr(web_app, "APP_URL_FILE", tmp_path / "web-app-url")
    monkeypatch.setenv("VERITAS_WEB_APP_URL", "https://example.org/veritas-ai/")
    link = web_app.phone_link("tok")
    assert link["url"] == "https://example.org/veritas-ai/#server=https%3A%2F%2Fmac.tail1.ts.net%3A8443&t=tok"
    assert link["app_url"] == "https://example.org/veritas-ai/"
    monkeypatch.delenv("VERITAS_WEB_APP_URL")
    (tmp_path / "web-app-url").write_text("https://other.example/app\n")
    assert web_app.phone_link("tok")["url"].startswith("https://other.example/app#server=")
