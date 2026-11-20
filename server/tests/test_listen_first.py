"""The port opens before anything that may touch a listed folder. On 2026-11-03 the desktop app's server hung four times
in opendir before it listened, and the app killed it after 90 s with nothing logged. Blocked folders here are a fake
(sources.resolved waits for a file); no test goes near a real ~/Documents."""
from __future__ import annotations

import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import pytest

import listen_first

SERVER = Path(__file__).resolve().parents[1]
FROZEN_ENTRY = SERVER.parent / "packaging" / "pyinstaller" / "veritas_server.py"
LOCAL = {"Host": "127.0.0.1"}


def call(port, method, path, headers=LOCAL, body=None, timeout=10):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.request(method, path, body=body, headers=headers)
    response = conn.getresponse()
    data = json.loads(response.read() or b"{}")
    conn.close()
    return response.status, data


class Real(BaseHTTPRequestHandler):
    """Stands in for http_api.Handler."""

    def do_GET(self):
        body = json.dumps({"route": self.path, "ready": True}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture()
def listener(monkeypatch):
    monkeypatch.setattr(listen_first, "_listener", None)
    monkeypatch.setattr(listen_first, "WAIT_SECONDS", 0.2)
    server = listen_first.listen(0)
    yield server, server.server_address[1]
    server.shutdown()
    server.server_close()


def test_ping_answers_not_ready_before_the_real_routes_exist(listener):
    _, port = listener
    assert call(port, "GET", "/ping") == (200, {"ok": True, "ready": False})


@pytest.mark.parametrize("method, path, body", [("GET", "/search?q=x", None), ("GET", "/status", None), ("GET", "/app/", None),
                                                ("POST", "/similar", b'{"text": "x"}')])
def test_other_routes_say_starting(listener, method, path, body):
    _, port = listener
    status, answer = call(port, method, path, body=body)
    assert status == 503 and "starting" in answer["error"] and answer["ready"] is False


@pytest.mark.parametrize("headers", [{**LOCAL, "Sec-Fetch-Site": "cross-site"}, {**LOCAL, "Origin": "http://evil.example"},
                                     {"Host": "mac.tail1234.ts.net", "X-Forwarded-For": "100.1.1.1"}])
def test_the_early_ping_is_for_the_mac_itself(listener, headers):
    """Another website gets no more than it does later, and the phone's token cannot be checked yet."""
    _, port = listener
    status, answer = call(port, "GET", "/ping", headers)
    assert status == 503 and "ok" not in answer


def test_the_real_routes_take_over(listener):
    server, port = listener
    listen_first.ready(server, Real)
    assert call(port, "GET", "/ping") == (200, {"route": "/ping", "ready": True})
    assert call(port, "GET", "/status", {**LOCAL, "Origin": "http://evil.example"})[1]["route"] == "/status"


def test_a_request_waiting_at_the_takeover_gets_the_real_answer(listener, monkeypatch):
    server, port = listener
    monkeypatch.setattr(listen_first, "WAIT_SECONDS", 10)
    answers = []
    waiting = threading.Thread(target=lambda: answers.append(call(port, "GET", "/status")))
    waiting.start()
    time.sleep(0.2)
    assert not answers, "it waits"
    listen_first.ready(server, Real)
    waiting.join(5)
    assert answers == [(200, {"route": "/status", "ready": True})]


def test_listen_opens_the_port_once(listener):
    server, _ = listener
    assert listen_first.listen(0) is server


@pytest.mark.parametrize("argv, expected", [(["kb.py", "serve", "--port", "1234"], 1234), (["kb.py", "serve", "--port=1235"], 1235),
                                            (["kb.py", "serve"], 27182)])
def test_if_serving_reads_the_port_as_the_command_line_does(monkeypatch, argv, expected):
    monkeypatch.delenv("KB_PORT", raising=False)
    opened = []
    monkeypatch.setattr(listen_first, "listen", opened.append)
    listen_first.if_serving(argv)
    assert opened == [expected]


@pytest.mark.parametrize("argv", [["kb.py"], ["kb.py", "index"], ["kb.py", "import-data", "--find"], ["pytest", "tests"]])
def test_every_other_command_opens_nothing(monkeypatch, argv):
    monkeypatch.setattr(listen_first, "listen", lambda port: pytest.fail("opened a port"))
    listen_first.if_serving(argv)


# --- whole processes, as the app, Homebrew and the launchd service start them ---------------------------------------

def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def scratch_env(tmp_path):
    home = tmp_path / "home"
    notes = home / "Documents" / "Vault"
    (notes / ".obsidian").mkdir(parents=True)
    (tmp_path / "data").mkdir()
    listed = tmp_path / "sources.json"
    listed.write_text(json.dumps({"version": 1, "folders": [{"name": "vault", "path": str(notes), "enabled": True, "skip": [], "main": True}]}))
    env = {**os.environ, "HOME": str(home), "VERITAS_DATA": str(tmp_path / "data"), "KB_SOURCES": str(listed), "KB_DB": str(tmp_path / "kb.sqlite"),
           "KB_BACKEND": "onnx", "KB_ABSTRACTS": "0", "PYTHONPATH": str(SERVER), "PATH": str(tmp_path)}  # no node on the PATH: no agent sidecar
    env.pop("KB_ZOTERO", None)
    env.pop("KB_VAULT", None)
    return env


def wait_for(check, seconds=60):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            found = check()
        except OSError:
            found = None
        if found:
            return found
        time.sleep(0.05)
    raise AssertionError("not within time")


def stop(process):
    process.send_signal(signal.SIGTERM)
    process.wait(20)


# The folder list hangs, as a stuck macOS permission prompt does, until the test creates a file.
BLOCKED = r"""
import os, pathlib, sys, time
sys.path.insert(0, os.environ["PYTHONPATH"])
import sources
real, release = sources.resolved, pathlib.Path(sys.argv[1])
def stuck():
    while not release.exists():
        time.sleep(0.02)
    return real()
sources.resolved = stuck
import listen_first
listen_first.WAIT_SECONDS = 0.2
sys.argv = ["kb.py", "serve", "--port", sys.argv[2]]
import kb
kb.main()
"""


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM")
def test_a_blocked_folder_list_leaves_the_server_answering(tmp_path):
    port, release, log = free_port(), tmp_path / "release", tmp_path / "server.log"
    with open(log, "ab") as out:
        process = subprocess.Popen([sys.executable, "-c", BLOCKED, str(release), str(port)], cwd=tmp_path, env=scratch_env(tmp_path),
                                   stdout=out, stderr=out)
    try:
        assert wait_for(lambda: call(port, "GET", "/ping")) == (200, {"ok": True, "ready": False})
        status, answer = call(port, "GET", "/search?q=x")
        assert status == 503 and "starting" in answer["error"]
        text = log.read_text()
        assert "starting" in text and f"listening on port {port}" in text and "sources read" not in text

        release.touch()
        wait_for(lambda: call(port, "GET", "/ping")[1]["ready"])
        assert call(port, "GET", "/status")[0] == 200
        text = log.read_text()
        stages = [text.index(s) for s in ("starting", f"listening on port {port}", "sources read", "index opened")]
        assert stages == sorted(stages), text
    finally:
        stop(process)


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM")
@pytest.mark.parametrize("command", [["kb.py", "serve"], [str(FROZEN_ENTRY), "serve"]], ids=["source-and-homebrew", "desktop-entry"])
def test_every_entry_point_comes_up_and_stops(tmp_path, command):
    port = free_port()
    log = tmp_path / "server.log"
    with open(log, "ab") as out:
        process = subprocess.Popen([sys.executable, *command, "--port", str(port)], cwd=SERVER, env=scratch_env(tmp_path), stdout=out, stderr=out)
    try:
        wait_for(lambda: call(port, "GET", "/ping")[1]["ready"])
        assert call(port, "GET", "/status")[0] == 200
        assert call(port, "GET", "/ping", {**LOCAL, "Sec-Fetch-Site": "cross-site"})[0] == 403, "the usual rules from here on"
    finally:
        stop(process)
    assert process.returncode == 0, log.read_text()
