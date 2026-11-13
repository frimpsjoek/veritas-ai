"""A2A discovery and the dedicated-credential JSON-RPC bridge to the existing Ask runtime."""
from __future__ import annotations

import concurrent.futures
import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

import a2a_api
import agent_api
import http_api


PROXIED = {"Host": "veritas.trinityscience.org", "X-Forwarded-Proto": "https"}
AUTH = {"Authorization": "Bearer a2a-secret"}


def request(*, method="message/send", parts=None, context=None):
    message = {
        "role": "user",
        "kind": "message",
        "messageId": "message-1",
        "parts": parts if parts is not None else [{"kind": "text", "text": "Summarize my quantum computing notes", "metadata": {"source": "trinity"}}],
        "metadata": {"sender": "hub-test"},
    }
    if context is not None:
        message["contextId"] = context
    return {"jsonrpc": "2.0", "id": "request-1", "method": method, "params": {"message": message}, "metadata": {"trace": "allowed"}}


def call(port, method, path, headers=None, body=None, *, local=False):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    data = json.dumps(body).encode() if body is not None else None
    base = {"Host": f"127.0.0.1:{port}"} if local else PROXIED
    request_headers = {**base, **(headers or {})}
    if data is not None:
        request_headers["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=request_headers)
    response = conn.getresponse()
    result = response.status, response.getheader("Set-Cookie"), response.read()
    conn.close()
    return result


def call_raw(port, raw):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("POST", "/a2a", body=raw.encode(), headers={**PROXIED, **AUTH, "Content-Type": "application/json"})
    response = conn.getresponse()
    data = response.read()
    status = response.status
    conn.close()
    assert status == 200
    return data


@pytest.fixture
def seen():
    return []


@pytest.fixture
def server(tmp_path, monkeypatch, seen):
    monkeypatch.setattr(http_api, "TOKEN_FILE", tmp_path / "api-token")
    monkeypatch.setattr(http_api, "SESSIONS_FILE", tmp_path / "web" / "sessions.json")
    monkeypatch.setattr(a2a_api, "TOKEN_FILE", tmp_path / "a2a-token")
    (tmp_path / "api-token").write_text("browser-secret\n")
    (tmp_path / "a2a-token").write_text("a2a-secret\n")

    def fake_ask(_sidecar, question):
        seen.append(question)
        return [{"type": "done", "answer": {"structured": {"markdown": "Grounded answer"}, "text": "ignored"}}]

    monkeypatch.setattr(http_api, "AGENT_SIDECAR", object())
    monkeypatch.setattr(agent_api, "ask", fake_ask)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1], tmp_path
    srv.shutdown()
    srv.server_close()


def test_public_card_has_no_credential(server):
    port, _ = server
    status, _, raw = call(port, "GET", "/.well-known/agent-card.json")
    card = json.loads(raw)
    assert status == 200
    assert card["protocolVersion"] == "0.3.0"
    assert card["url"] == "/a2a"
    assert card["preferredTransport"] == "JSONRPC"
    assert card["capabilities"]["streaming"] is False
    assert card["security"] == [{"veritasBearer": []}]
    assert card["skills"]
    assert card["x-trinity"]["id"] == "veritas"
    assert "a2a-secret" not in raw.decode()
    assert "browser-secret" not in raw.decode()


def test_foreign_origin_cannot_read_the_public_card(server):
    port, _ = server
    status, _, _ = call(port, "GET", "/.well-known/agent-card.json", {"Origin": "https://evil.example"})
    assert status == 403


def test_only_the_dedicated_a2a_token_authenticates(server):
    port, _ = server
    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "Bearer browser-secret"}, {"Cookie": "sb_session=forged"}):
        status, _, _ = call(port, "POST", "/a2a", headers, request())
        assert status == 401
    status, _, raw = call(port, "POST", "/a2a", {"Authorization": "bearer a2a-secret"}, request())
    assert status == 200
    assert json.loads(raw)["result"]["parts"] == [{"kind": "text", "text": "Grounded answer"}]


def test_loopback_has_no_implicit_a2a_auth_and_valid_browser_cookie_does_not_help(server):
    port, _ = server
    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "Bearer browser-secret"}, {"Cookie": "sb_session=anything"}):
        status, _, _ = call(port, "POST", "/a2a", headers, request(), local=True)
        assert status == 401
    status, cookie, _ = call(port, "POST", "/app/login", {"Authorization": "Bearer browser-secret"}, {"token": "browser-secret"})
    assert status == 200
    status, _, _ = call(port, "POST", "/a2a", {"Cookie": cookie.split(";")[0]}, request())
    assert status == 401


def test_a_missing_credential_file_fails_closed_without_recreation(server):
    port, tmp_path = server
    (tmp_path / "a2a-token").unlink()
    status, _, _ = call(port, "POST", "/a2a", AUTH, request())
    assert status == 401
    assert not (tmp_path / "a2a-token").exists()


def test_message_send_accepts_the_trinity_wire_shape_and_joins_text_parts(server, seen):
    port, _ = server
    payload = request(context="room-7", parts=[{"kind": "text", "text": "first"}, {"kind": "text", "text": "second", "metadata": {"ignored": True}}])
    status, _, raw = call(port, "POST", "/a2a", AUTH, payload)
    body = json.loads(raw)
    assert status == 200 and body["jsonrpc"] == "2.0" and body["id"] == "request-1"
    assert body["result"]["role"] == "agent" and body["result"]["kind"] == "message"
    assert body["result"]["messageId"]
    assert body["result"]["contextId"] == "room-7"
    assert body["result"]["parts"] == [{"kind": "text", "text": "Grounded answer"}]
    assert seen == ["first\n\nsecond"]


@pytest.mark.parametrize("body, code", [
    ([], -32600),
    ({"jsonrpc": "1.0", "id": "x", "method": "message/send", "params": {}}, -32600),
    (request(method="tasks/get"), -32601),
    (request(parts=[]), -32602),
    (request(parts=[{"kind": "data", "data": {"x": 1}}]), -32602),
    (request(parts=[{"kind": "text", "text": "   "}]), -32602),
])
def test_json_rpc_validation_errors(server, body, code):
    port, _ = server
    status, _, raw = call(port, "POST", "/a2a", AUTH, body)
    response = json.loads(raw)
    assert status == 200
    assert response["jsonrpc"] == "2.0" and response["error"]["code"] == code


def test_malformed_json_is_a_parse_error(server):
    port, _ = server
    response = json.loads(call_raw(port, '{"jsonrpc":'))
    assert response["error"]["code"] == -32700


def test_questions_are_bounded_before_reaching_the_sidecar(server, seen):
    port, _ = server
    status, _, raw = call(port, "POST", "/a2a", AUTH, request(parts=[{"kind": "text", "text": "x" * (a2a_api.MAX_QUESTION_CHARS + 1)}]))
    assert status == 200 and json.loads(raw)["error"]["code"] == -32602
    assert seen == []


@pytest.mark.parametrize("length", [None, "not-a-number", "-1", "1_000", "+12", " 12", "１２", "9" * 5000])
def test_invalid_content_lengths_are_rejected_before_reading(server, length):
    class Handler:
        headers = {} if length is None else {"Content-Length": length}
        close_connection = False

        def __init__(self):
            self.sent = None
            self.read = False

        def _body(self, limit):
            self.read = True
            raise AssertionError("body must not be read")

        def _send(self, status, body):
            self.sent = status, body

    handler = Handler()
    a2a_api.message_send(handler, object())
    assert handler.sent[0] == 200 and handler.sent[1]["error"]["code"] == -32600
    assert handler.close_connection is True and handler.read is False


def test_oversized_content_length_is_rejected_before_reading(server):
    class Handler:
        headers = {"Content-Length": str(a2a_api.MAX_BODY_BYTES + 1)}
        close_connection = False

        def _body(self, limit):
            raise AssertionError("body must not be read")

        def _send(self, status, body):
            self.sent = status, body

    handler = Handler()
    a2a_api.message_send(handler, object())
    assert handler.sent[0] == 200 and handler.sent[1]["error"]["code"] == -32600
    assert handler.close_connection is True


def test_answer_text_falls_back_and_failed_events_take_precedence(server, monkeypatch):
    port, _ = server
    monkeypatch.setattr(agent_api, "ask", lambda *_: [{"type": "done", "answer": {"structured": {}, "text": "Fallback text"}}])
    status, _, raw = call(port, "POST", "/a2a", AUTH, request())
    assert status == 200 and json.loads(raw)["result"]["parts"][0]["text"] == "Fallback text"

    monkeypatch.setattr(agent_api, "ask", lambda *_: [
        {"type": "done", "answer": {"structured": {"markdown": "not returned"}}},
        {"type": "failed", "error": {"message": "/private/path failed"}},
    ])
    status, _, raw = call(port, "POST", "/a2a", AUTH, request())
    response = json.loads(raw)
    assert status == 200 and response["error"]["code"] == -32603
    assert "/private/path" not in raw.decode()


def test_sidecar_errors_are_json_rpc_and_do_not_leak_details(server, monkeypatch):
    port, _ = server
    def fail(*_):
        raise agent_api.SidecarError("/private/path failed")
    monkeypatch.setattr(agent_api, "ask", fail)
    status, _, raw = call(port, "POST", "/a2a", AUTH, request())
    response = json.loads(raw)
    assert status == 200 and response["error"]["code"] == -32603
    assert response["id"] == "request-1" and "/private/path" not in raw.decode()


def test_agent_routes_do_not_expose_a2a_to_the_sidecar(server):
    port, _ = server
    status, _, _ = call(port, "POST", "/a2a", {**AUTH, "X-KB-Client": "agent"}, request())
    assert status == 403


def test_ensure_token_is_concurrent_safe_and_enforces_permissions(tmp_path, monkeypatch):
    monkeypatch.setattr(a2a_api, "TOKEN_FILE", tmp_path / "a2a-token")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        values = list(pool.map(lambda _: a2a_api.ensure_token(), range(16)))
    assert len(set(values)) == 1 and all(values)
    assert ((tmp_path / "a2a-token").stat().st_mode & 0o777) == 0o600

    (tmp_path / "a2a-token").chmod(0o644)
    assert a2a_api.ensure_token() == values[0]
    assert ((tmp_path / "a2a-token").stat().st_mode & 0o777) == 0o600
