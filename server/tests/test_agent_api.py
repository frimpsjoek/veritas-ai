"""agent_api.py: forwarding, the 503-without-Node fallback, /ai-note collision+dedupe, and that a private note
never reaches an agent through the ordinary /search route agent_api forwards nothing special for."""
from __future__ import annotations

import http.server
import io
import json
import socketserver
import threading
import time
from pathlib import Path

import pytest

import agent_api
import kb
import paper_notes


class FakeHandler:
    """A minimal stand-in for http_api.Handler: just what agent_api.forward touches."""

    def __init__(self, body: bytes = b"", content_type: str = "application/json"):
        self.headers = {"Content-Length": str(len(body)), "Content-Type": content_type}
        self.rfile = io.BytesIO(body)
        self.sent = None       # (status, body) from _send
        self.response = None   # (status, headers dict, body bytes) from the raw send_response path

    def _send(self, status, body):
        self.sent = (status, body)

    def send_response(self, status):
        self.response = [status, {}, b""]

    def send_header(self, name, value):
        self.response[1][name] = value

    def end_headers(self):
        pass

    class _W:
        def __init__(self, outer):
            self.outer = outer

        def write(self, data):
            self.outer.response[2] += data

    @property
    def wfile(self):
        return FakeHandler._W(self)


# ---------- forward() ----------

def test_forward_without_node_is_503_with_help():
    handler = FakeHandler()
    agent_api.forward(handler, None, "GET", "/conversations")
    status, body = handler.sent
    assert status == 503
    assert "help" in body


def test_forward_while_restarting_is_503():
    sidecar = agent_api.Sidecar(node=Path("/usr/bin/node"), secret="s", port=None)
    handler = FakeHandler()
    agent_api.forward(handler, sidecar, "GET", "/conversations")
    assert handler.sent[0] == 503


def test_forward_copies_a_real_response_verbatim():
    """A tiny stand-in HTTP server plays the sidecar's part, so this exercises the real socket path, not a mock."""

    class Echo(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.headers.get("Authorization") == "Bearer topsecret"
            data = json.dumps({"echo": self.path}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):
            pass

    server = socketserver.TCPServer(("127.0.0.1", 0), Echo)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        sidecar = agent_api.Sidecar(node=Path("/usr/bin/node"), secret="topsecret", port=port)
        handler = FakeHandler()
        agent_api.forward(handler, sidecar, "GET", "/conversations?after=3")
        status, headers, body = handler.response
        assert status == 200
        assert json.loads(body) == {"echo": "/conversations?after=3"}
    finally:
        server.shutdown()


def test_forward_when_the_sidecar_is_unreachable_is_503_not_a_crash():
    sidecar = agent_api.Sidecar(node=Path("/usr/bin/node"), secret="s", port=1)  # nothing listens on port 1
    handler = FakeHandler()
    agent_api.forward(handler, sidecar, "GET", "/conversations")
    assert handler.sent[0] == 503


# ---------- /ai-note ----------

@pytest.fixture()
def vault(tmp_path, monkeypatch):
    monkeypatch.setattr(kb, "VAULT", tmp_path)
    return tmp_path


def test_create_ai_note_writes_under_ai_notes_with_front_matter(vault):
    result = agent_api.create_ai_note("ai_notes/Literature Reviews", "My Review", "# Body\n", "rev-1")
    path = vault / result["path"]
    assert path.exists()
    text = path.read_text()
    assert "review_id: \"rev-1\"" in text
    assert text.endswith("# Body\n")


def test_create_ai_note_merges_extra_front_matter_but_keeps_its_own_fields_authoritative(vault):
    result = agent_api.create_ai_note(
        "ai_notes/Literature Reviews", "My Review", "# Body\n", "rev-1",
        {"question": "Does X help Y?", "scope": "the whole library", "model": "codex/gpt-5", "sources": ["library", "scholarly"], "title": "Ignored"},
    )
    text = (vault / result["path"]).read_text()
    assert 'question: "Does X help Y?"' in text
    assert "sources: [\"library\", \"scholarly\"]" in text
    assert 'title: "My Review"' in text  # the caller's own field wins over a same-named frontMatter entry
    assert 'type: "literature-review"' in text


def test_create_ai_note_is_deduplicated_by_review_id(vault):
    first = agent_api.create_ai_note("ai_notes/Literature Reviews", "My Review", "v1", "rev-1")
    second = agent_api.create_ai_note("ai_notes/Literature Reviews", "My Review", "v2 (should be ignored)", "rev-1")
    assert first == second
    assert (vault / first["path"]).read_text().endswith("v1")


def test_create_ai_note_is_collision_safe_for_a_new_review_id(vault):
    first = agent_api.create_ai_note("ai_notes/Literature Reviews", "My Review", "v1", "rev-1")
    second = agent_api.create_ai_note("ai_notes/Literature Reviews", "My Review", "v2", "rev-2")
    assert first["path"] != second["path"]


def test_create_ai_note_refuses_to_write_outside_ai_notes(vault):
    with pytest.raises(PermissionError):
        agent_api.create_ai_note("Papers", "Not allowed here", "x", "rev-1")
    with pytest.raises(PermissionError):
        agent_api.create_ai_note("ai_notes/../Papers", "Traversal", "x", "rev-1")


# ---------- privacy: an agent-forwarded route never sees what /search itself wouldn't return ----------

def test_agent_routes_do_not_include_ai_note_or_agent_control_paths():
    # http_api.AGENT_ROUTES is the actual gate; this pins the contract this module relies on so a future edit
    # to that set can't silently let an agent process reach /ai-note or /agent/*.
    import http_api

    assert "/ai-note" not in http_api.AGENT_ROUTES
    assert not any(route.startswith("/agent") for route in http_api.AGENT_ROUTES)


def test_sidecar_is_told_the_port_the_server_runs_on(monkeypatch):
    import http_api
    seen = {}
    monkeypatch.setattr(http_api.agent_api, "supervise", lambda data, kb_url: seen.setdefault("kb_url", kb_url) and None)
    monkeypatch.setattr(http_api, "token", lambda: "t")
    class Stop(Exception):
        pass
    def no_server(*a, **k):
        raise Stop
    monkeypatch.setattr(http_api, "ThreadingHTTPServer", no_server)
    try:
        http_api.serve(27190)
    except Stop:
        pass
    assert seen["kb_url"] == "http://127.0.0.1:27190"
