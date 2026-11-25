"""A2A discovery and the dedicated-credential JSON-RPC bridge to the existing Ask runtime."""
from __future__ import annotations

import concurrent.futures
import http.client
import json
import threading
from email.message import Message
from http.server import ThreadingHTTPServer

import pytest

import a2a_api
import agent_api
import http_api


PROXIED = {"Host": "veritas.trinityscience.org", "X-Forwarded-Proto": "https"}
AUTH = {"Authorization": "Bearer a2a-secret"}
EXTENSION = "https://trinityscience.org/extensions/veritas/provided-sources/v1"


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


def provided_parts(sources=None, *, question="What changed?", extra_data=None):
    if sources is None:
        sources = [{
            "title": "Private experiment",
            "text": "Recall improved by 12 percent.",
            "citation": "Notebook 7, page 4",
            "uri": "https://example.org/private/item",
        }]
    data = {"sources": sources, **(extra_data or {})}
    return [{"kind": "text", "text": question}, {"kind": "data", "data": data}]


def provided_headers(extension=EXTENSION):
    return {**AUTH, "X-A2A-Extensions": extension}


def call(port, method, path, headers=None, body=None, *, local=False, include_headers=False):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    data = json.dumps(body).encode() if body is not None else None
    base = {"Host": f"127.0.0.1:{port}"} if local else PROXIED
    request_headers = {**base, **(headers or {})}
    if data is not None:
        request_headers["Content-Type"] = "application/json"
    conn.request(method, path, body=data, headers=request_headers)
    response = conn.getresponse()
    result = response.status, response.getheader("Set-Cookie"), response.read()
    headers_out = dict(response.getheaders()) if include_headers else None
    conn.close()
    return (*result, headers_out) if include_headers else result


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
    monkeypatch.delenv("VERITAS_A2A_PROVIDED_SOURCES_ENABLED", raising=False)
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


def test_provided_sources_is_default_off_for_discovery_and_activation(server, seen):
    port, _ = server
    status, _, raw = call(port, "GET", "/.well-known/agent-card.json")
    card = json.loads(raw)
    assert status == 200
    assert all(item.get("uri") != EXTENSION for item in card["capabilities"].get("extensions", []))

    status, _, raw, headers = call(port, "POST", "/a2a", provided_headers(), request(parts=provided_parts()), include_headers=True)
    assert status == 200 and json.loads(raw)["error"]["code"] == -32602
    assert headers["Cache-Control"] == "no-store"
    assert headers["X-A2A-Extensions"] == EXTENSION
    assert seen == []


def test_activated_provided_sources_forwards_bounded_evidence_and_safe_metadata(server, monkeypatch):
    port, _ = server
    monkeypatch.setenv("VERITAS_A2A_PROVIDED_SOURCES_ENABLED", "1")
    calls = []

    def fake_ask(_sidecar, question, *, provided_sources=None):
        calls.append((question, provided_sources))
        return [{"type": "done", "answer": {"structured": {"status": "answered", "markdown": "Improved [S1]."}, "text": "ignored"}}]

    monkeypatch.setattr(agent_api, "ask", fake_ask)
    _, _, card_raw = call(port, "GET", "/.well-known/agent-card.json")
    extensions = json.loads(card_raw)["capabilities"]["extensions"]
    assert any(extension["uri"] == EXTENSION and extension["required"] is False for extension in extensions)
    status, _, raw, headers = call(port, "POST", "/a2a", provided_headers(), request(parts=provided_parts(), context="shared-context"), include_headers=True)
    body = json.loads(raw)
    assert status == 200 and "error" not in body, body
    assert calls == [("What changed?", [{
        "title": "Private experiment",
        "text": "Recall improved by 12 percent.",
        "citation": "Notebook 7, page 4",
        "uri": "https://example.org/private/item",
    }])]
    result = body["result"]
    assert result["parts"] == [{"kind": "text", "text": "Improved [S1]."}]
    assert result["extensions"] == [EXTENSION] and result["contextId"] == "shared-context"
    metadata = result["metadata"][EXTENSION]
    assert metadata == {
        "status": "answered",
        "sources": [{
            "id": "S1",
            "title": "Private experiment",
            "citation": "Notebook 7, page 4",
            "uri": "https://example.org/private/item",
        }],
    }
    assert "12 percent" not in json.dumps(metadata)
    assert headers["Cache-Control"] == "no-store"
    assert headers["X-A2A-Extensions"] == EXTENSION


def test_provided_source_calls_do_not_reuse_context_or_evidence(server, monkeypatch):
    port, _ = server
    monkeypatch.setenv("VERITAS_A2A_PROVIDED_SOURCES_ENABLED", "1")
    calls = []

    def fake_ask(_sidecar, question, *, provided_sources=None):
        calls.append((question, provided_sources))
        return [{"type": "done", "answer": {"structured": {"status": "answered", "markdown": "Answer [S1]."}}}]

    monkeypatch.setattr(agent_api, "ask", fake_ask)
    for marker in ("marker-A", "marker-B"):
        sources = [{"title": marker, "text": f"Private evidence {marker}"}]
        status, _, raw = call(port, "POST", "/a2a", provided_headers(), request(parts=provided_parts(sources), context="same-context"))
        assert status == 200 and "result" in json.loads(raw)
    assert [call_[1][0]["text"] for call_ in calls] == ["Private evidence marker-A", "Private evidence marker-B"]
    assert "marker-B" not in json.dumps(calls[0])
    assert "marker-A" not in json.dumps(calls[1])


@pytest.mark.parametrize("parts, private_marker", [
    ([{"kind": "text", "text": "Question without evidence"}], None),
    (provided_parts([]), None),
    (provided_parts({}), None),
    (provided_parts([{"title": " ", "text": "Private title marker"}]), "Private title marker"),
    (provided_parts([{"title": "Private unknown marker", "text": "Evidence", "id": "caller-controlled"}]), "Private unknown marker"),
    (provided_parts([{"title": "Valid", "text": "Evidence", "uri": "javascript:private-uri-marker"}]), "private-uri-marker"),
    (provided_parts([{"title": "Valid", "text": "Evidence", "uri": "https://example.org/private\nmarker"}]), "private\nmarker"),
    (provided_parts([{"title": "Valid", "text": "Evidence", "uri": "https://example.org/private\n"}]), None),
    (provided_parts([{"title": "Valid", "text": "Evidence", "uri": "https://:80/private"}]), None),
    (provided_parts([{"title": "Valid", "text": "Evidence", "uri": "https://example.org:99999/private"}]), None),
    (provided_parts([{"title": "Valid", "text": "Evidence", "uri": "https://%2F/item"}]), None),
    (provided_parts([{"title": "Valid", "text": "Evidence", "uri": "https://exa mple.com/item"}]), None),
    (provided_parts([{"title": "x" * 513, "text": "Evidence"}]), None),
    (provided_parts([{"title": "Valid", "text": "x" * 16385}]), None),
    (provided_parts([{"title": str(i), "text": "Evidence"} for i in range(17)]), None),
    (provided_parts([{"title": str(i), "text": "x" * 16000} for i in range(8)] + [{"title": "last", "text": "x"}]), None),
    (provided_parts(None, extra_data={"web": True}), None),
    (provided_parts() + [{"kind": "data", "data": {"sources": [{"title": "Extra", "text": "Extra"}]}}], None),
    ([{"kind": "text", "text": "one"}, {"kind": "text", "text": "two"}, *provided_parts()[1:]], None),
    ([*provided_parts()[:1], {"kind": "file", "file": {"uri": "https://example.org/private"}}], None),
])
def test_invalid_provided_sources_fail_before_the_sidecar_without_echoing_evidence(server, seen, monkeypatch, parts, private_marker):
    port, _ = server
    monkeypatch.setenv("VERITAS_A2A_PROVIDED_SOURCES_ENABLED", "1")
    status, _, raw, headers = call(port, "POST", "/a2a", provided_headers(), request(parts=parts), include_headers=True)
    body = json.loads(raw)
    assert status == 200 and body["error"] == {"code": -32602, "message": "Invalid params"}
    assert private_marker is None or private_marker not in raw.decode()
    assert headers["Cache-Control"] == "no-store" and headers["X-A2A-Extensions"] == EXTENSION
    assert seen == []


@pytest.mark.parametrize("header, accepted", [
    (f"  {EXTENSION} , ,{EXTENSION} ", True),
    (f"https://evil.example/?next={EXTENSION}", False),
    (EXTENSION.upper(), False),
])
def test_provided_source_activation_uses_exact_header_tokens(server, seen, monkeypatch, header, accepted):
    port, _ = server
    monkeypatch.setenv("VERITAS_A2A_PROVIDED_SOURCES_ENABLED", "1")

    def fake_ask(_sidecar, question, *, provided_sources=None):
        seen.append(question)
        return [{"type": "done", "answer": {"structured": {"status": "answered", "markdown": "Answer [S1]."}}}]

    monkeypatch.setattr(agent_api, "ask", fake_ask)
    status, _, raw = call(port, "POST", "/a2a", provided_headers(header), request(parts=provided_parts()))
    assert status == 200
    assert ("result" in json.loads(raw)) is accepted
    if not accepted:
        assert seen == []


def test_repeated_extension_header_lines_are_parsed_as_a_token_list():
    headers = Message()
    headers["X-A2A-Extensions"] = "https://example.org/unrelated-extension"
    headers["X-A2A-Extensions"] = EXTENSION
    assert a2a_api.provided_sources_requested(headers)


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


def test_deeply_nested_json_is_a_parse_error(server):
    port, _ = server
    response = json.loads(call_raw(port, "[" * 100000 + "]" * 100000))
    assert response["error"]["code"] == -32700


def test_finite_numeric_ids_are_supported_but_non_finite_ids_are_invalid(server):
    port, _ = server
    payload = request()
    payload["id"] = 1.5
    status, _, raw = call(port, "POST", "/a2a", AUTH, payload)
    assert status == 200 and json.loads(raw)["id"] == 1.5

    payload["id"] = float("nan")
    status, _, raw = call(port, "POST", "/a2a", AUTH, payload)
    response = json.loads(raw)
    assert status == 200 and response["error"]["code"] == -32600
    assert response["id"] is None


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
