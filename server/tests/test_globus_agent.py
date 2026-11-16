"""Tenant forwarding, private web state, and sidecar-only ALCF credential delivery."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

import agent_api
import globus_auth
import http_api
import web_app

TENANT_A = "a" * 64
TENANT_B = "b" * 64
PHONE = {"Host": "veritas.trinityscience.org", "X-Forwarded-Proto": "https"}
SESSION_A = "session-A"
SESSION_B = "session-B"
SIDECAR_SECRET = "sidecar-secret"


class TenantGlobus:
    def __init__(self, root: Path):
        self.config = globus_auth.Config("client-A", "secret-A", globus_auth.PRODUCTION_CALLBACK)
        self.store = SimpleNamespace(root=root)
        self.calls = []
        self.tokens = {TENANT_A: "access-A", TENANT_B: "access-B"}

    def principal(self, raw):
        tenant = {SESSION_A: TENANT_A, SESSION_B: TENANT_B}.get(raw)
        if not tenant:
            return None
        return {"kind": "globus", "tenant": tenant, "name": "User", "preferred_username": "u@alcf.anl.gov"}

    def inference_credential(self, tenant, force=False):
        self.calls.append((tenant, force))
        if tenant not in self.tokens:
            raise globus_auth.AuthError(401, "ALCF Inference sign-in is required")
        return {"access_token": self.tokens[tenant], "expires_at": 1234}

    def inference_status(self, tenant):
        return {"connected": True, "needs_reauth": False, "expires_at": 1234}

    def logout(self, raw):
        raise AssertionError("not used")


class SidecarEcho(BaseHTTPRequestHandler):
    def _echo(self):
        body = json.dumps({
            "method": self.command,
            "path": self.path,
            "tenant": self.headers.get("X-Veritas-Tenant"),
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _echo
    do_POST = _echo

    def log_message(self, *args):
        pass


@pytest.fixture
def tenant_server(tmp_path, monkeypatch):
    monkeypatch.setattr(http_api, "TOKEN_FILE", tmp_path / "api-token")
    monkeypatch.setattr(http_api, "SESSIONS_FILE", tmp_path / "legacy-sessions.json")
    monkeypatch.setattr(web_app, "WEB_DIR", tmp_path / "shared-web")
    (tmp_path / "api-token").write_text("admin-token")
    manager = TenantGlobus(tmp_path / "users")
    for tenant in (TENANT_A, TENANT_B):
        (tmp_path / "users" / tenant).mkdir(parents=True, mode=0o700)
    echo = ThreadingHTTPServer(("127.0.0.1", 0), SidecarEcho)
    threading.Thread(target=echo.serve_forever, daemon=True).start()
    sidecar = agent_api.Sidecar(node=Path("node"), secret=SIDECAR_SECRET, port=echo.server_address[1])
    monkeypatch.setattr(http_api, "AGENT_SIDECAR", sidecar)
    monkeypatch.setattr(http_api, "GLOBUS_AUTH", manager)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1], manager, sidecar, tmp_path
    srv.shutdown()
    srv.server_close()
    echo.shutdown()
    echo.server_close()


def call(port, method, path, headers=None, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    payload = json.dumps(body).encode() if body is not None else None
    conn.request(method, path, body=payload, headers={**PHONE, **(headers or {})})
    response = conn.getresponse()
    status, all_headers, data = response.status, response.getheaders(), response.read()
    conn.close()
    return status, all_headers, data


def value(headers, name):
    values = [v for k, v in headers if k.lower() == name.lower()]
    return values[0] if values else None


def cookie(session, spoof=None):
    return {"Cookie": f"vg_session={session}", **({"X-Veritas-Tenant": spoof} if spoof else {})}


def json_call(*args, **kwargs):
    status, headers, body = call(*args, **kwargs)
    return status, headers, json.loads(body)


def test_verified_cookie_selects_tenant_and_external_spoof_is_ignored(tenant_server):
    port, _, _, _ = tenant_server
    status, _, body = json_call(port, "GET", "/agent/conversations", cookie(SESSION_A, TENANT_B))
    assert status == 200 and body == {"method": "GET", "path": "/conversations", "tenant": TENANT_A}

    status, _, body = json_call(port, "GET", "/agent/conversations", cookie(SESSION_B))
    assert status == 200 and body["tenant"] == TENANT_B

    status, _, body = json_call(port, "GET", "/agent/conversations", {"X-Veritas-Tenant": TENANT_A})
    assert status == 401  # anonymous input never selects a runtime

    status, _, body = json_call(port, "GET", "/agent/conversations", {
        "Authorization": "Bearer admin-token", "X-Veritas-Tenant": TENANT_B,
    })
    assert status == 200 and body["tenant"] is None


def test_globus_interactive_routes_and_background_denials(tenant_server):
    port, _, _, _ = tenant_server
    for path in ("/agent/conversations", "/agent/providers", "/agent/settings", "/agent/projects", "/agent/skills"):
        assert call(port, "GET", path, cookie(SESSION_A))[0] == 200, path
    for method, path in (("POST", "/agent/reviews"), ("GET", "/agent/reviews"),
                         ("POST", "/agent/routines"), ("GET", "/agent/routines")):
        assert call(port, method, path, cookie(SESSION_A), {})[0] == 403, (method, path)
    assert not http_api.globus_route_allowed("GET", "/auth/globus/agent-token")
    assert "/auth/globus/agent-token" not in json.dumps(http_api.a2a_api.agent_card())


def test_tenant_cannot_configure_host_execution_or_custom_endpoints(tenant_server):
    port, _, _, _ = tenant_server
    attacks = [
        ("/agent/mcp-servers", {"name": "evil", "transport": "stdio", "command": "/bin/sh", "args": ["-c", "id"]}),
        ("/agent/mcp-servers", {"name": "evil", "transport": "http", "url": "http://127.0.0.1:27182"}),
    ]
    for path, body in attacks:
        status, _, _ = call(port, "POST", path, cookie(SESSION_A), body)
        assert status == 403, (path, body)


def test_identity_is_resolved_once_and_never_falls_back_to_legacy(tenant_server, monkeypatch):
    port, _, _, _ = tenant_server
    original = http_api.principal
    calls = 0
    def revoke(headers):
        nonlocal calls
        calls += 1
        first = original(headers)
        return first if calls == 1 else None
    monkeypatch.setattr(http_api, "principal", revoke)
    status, _, body = json_call(port, "GET", "/agent/conversations", cookie(SESSION_A))
    assert status == 200 and body["tenant"] == TENANT_A
    calls = 0
    assert call(port, "GET", "/web/state", cookie(SESSION_A))[0] == 200


def test_tenant_responses_are_not_storable(tenant_server):
    port, _, _, _ = tenant_server
    status, headers, _ = call(port, "GET", "/agent/conversations", cookie(SESSION_A))
    assert status == 200 and value(headers, "Cache-Control") == "no-store"
    status, headers, _ = call(port, "GET", "/web/state", cookie(SESSION_A))
    assert status == 200 and value(headers, "Cache-Control") == "no-store"


def test_web_state_is_private_per_tenant(tenant_server):
    port, _, _, _ = tenant_server
    assert call(port, "POST", "/web/state", cookie(SESSION_A), {"files": {"private.txt": "A"}})[0] == 200
    assert call(port, "POST", "/web/state", cookie(SESSION_B), {"files": {"other.txt": "B"}})[0] == 200

    status, _, state_a = json_call(port, "GET", "/web/state", cookie(SESSION_A))
    assert status == 200 and state_a["files"] == {"private.txt": "A"}
    _, _, state_b = json_call(port, "GET", "/web/state", cookie(SESSION_B))
    assert state_b["files"] == {"other.txt": "B"}
    assert web_app.read_state()["files"] == {}


def test_agent_token_requires_current_sidecar_secret_and_valid_tenant(tenant_server, capsys):
    port, manager, sidecar, _ = tenant_server
    auth = {"Authorization": f"Bearer {SIDECAR_SECRET}", "X-Veritas-Tenant": TENANT_A}
    status, headers, data = call(port, "GET", "/auth/globus/agent-token?refresh=1", auth)
    assert status == 200 and json.loads(data) == {"access_token": "access-A", "expires_at": 1234}
    assert value(headers, "Cache-Control") == "no-store"
    assert value(headers, "Pragma") == "no-cache"
    assert manager.calls == [(TENANT_A, True)]

    for headers in (
        {"X-Veritas-Tenant": TENANT_A},
        {"Authorization": "Bearer wrong", "X-Veritas-Tenant": TENANT_A},
        {"Authorization": "Bearer admin-token", "X-Veritas-Tenant": TENANT_A},
        {"Authorization": f"Bearer {SIDECAR_SECRET}", "X-Veritas-Tenant": "not-a-tenant"},
    ):
        assert call(port, "GET", "/auth/globus/agent-token", headers)[0] in (401, 403)

    sidecar.secret = "replacement-secret"
    assert call(port, "GET", "/auth/globus/agent-token", auth)[0] == 403
    captured = capsys.readouterr()
    for sentinel in ("access-A", "access-B", "admin-token", SIDECAR_SECRET, SESSION_A):
        assert sentinel not in captured.out + captured.err


def test_agent_token_error_is_safe(tenant_server, capsys):
    port, manager, _, _ = tenant_server
    def fail(tenant, force=False):
        raise globus_auth.AuthError(502, "ALCF Inference refresh failed")
    manager.inference_credential = fail
    status, _, body = call(port, "GET", "/auth/globus/agent-token", {
        "Authorization": f"Bearer {SIDECAR_SECRET}", "X-Veritas-Tenant": TENANT_A,
    })
    assert status == 502 and json.loads(body) == {"error": "ALCF Inference refresh failed"}
    captured = capsys.readouterr()
    assert "access-A" not in captured.out + captured.err
    assert "access-A" not in body.decode()
