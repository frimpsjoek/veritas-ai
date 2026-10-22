"""/sources routes and `kb.py sources` (spec 018 U3)."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

import http_api
import kb
import sources


@pytest.fixture
def api(tmp_path, monkeypatch):
    vault = tmp_path / "vault"
    (vault / ".obsidian").mkdir(parents=True)
    papers = tmp_path / "papers"
    papers.mkdir()
    monkeypatch.setattr(sources, "FILE", tmp_path / "data" / "sources.json")
    monkeypatch.setattr(sources, "OUTPUT_DEFAULT", tmp_path / "home")
    sources.save([{"name": "vault", "path": str(vault), "enabled": True, "skip": [], "main": True}])
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "data" / "kb.sqlite")
    monkeypatch.setattr(kb, "index_running", lambda: False)
    runs = []
    monkeypatch.setattr(http_api, "start_indexing", lambda reread: runs.append(reread))
    kb.reload_layout()
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def call(method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=data, headers={"Content-Type": "application/json", **(headers or {})})
        res = conn.getresponse()
        payload = json.loads(res.read() or b"null")
        conn.close()
        return res.status, payload

    yield call, papers, runs, tmp_path
    server.shutdown()
    server.server_close()
    monkeypatch.undo()
    kb.reload_layout()


def test_list_add_switch_off_remove(api):
    call, papers, runs, _ = api
    status, report = call("GET", "/sources")
    assert status == 200 and [(f["name"], f["role"]) for f in report["folders"]] == [("vault", "main")]
    status, report = call("POST", "/sources", {"path": str(papers)})
    assert status == 201 and report["name"] == "papers" and report["kind"] == "plain"
    assert ("papers", "listed") in [(f["name"], f["role"]) for f in report["folders"]]
    assert runs == [None] and [f.name for f in kb.LAYOUT.others] == ["papers"]  # this process follows at once
    status, report = call("PATCH", "/sources/papers", {"enabled": False, "skip": ["drafts/*"]})
    assert status == 200 and ("papers", "off") in [(f["name"], f["role"]) for f in report["folders"]]
    assert kb.LAYOUT.others == []
    status, report = call("DELETE", "/sources/papers")
    assert status == 200 and [f["name"] for f in report["folders"]] == ["vault"]
    assert len(runs) == 3


def test_refusals(api, tmp_path):
    call, papers, runs, root = api
    call("POST", "/sources", {"path": str(papers)})
    assert call("POST", "/sources", {"path": str(papers)})[0] == 409
    other = root / "other"
    other.mkdir()
    assert call("POST", "/sources", {"path": str(other), "name": "papers"})[0] == 409
    assert call("POST", "/sources", {"path": str(other), "name": "Bad Name"})[0] == 400
    assert call("POST", "/sources", {"path": str(root / "nowhere")})[0] == 400
    assert call("POST", "/sources", {"path": "/"})[0] == 400
    hidden = root / ".secret"
    hidden.mkdir()
    assert call("POST", "/sources", {"path": str(hidden)})[0] == 400
    assert call("POST", "/sources", {"path": "relative/path"})[0] == 400
    assert call("PATCH", "/sources/nope", {"enabled": True})[0] == 404
    assert call("PATCH", "/sources/papers", {"skip": "drafts"})[0] == 400
    assert call("DELETE", "/sources/nope")[0] == 404
    assert call("POST", "/sources", {"path": str(other)}, {"X-KB-Client": "agent"})[0] == 403
    assert call("GET", "/sources", headers={"X-KB-Client": "agent"})[0] == 403
    assert call("PATCH", "/sources/papers", {"enabled": False}, {"X-KB-Client": "agent"})[0] == 403
    assert call("POST", "/sources", {"path": str(other)}, {"Origin": "https://evil.example"})[0] == 403


def test_cli(api, capsys):
    _, papers, _, _ = api
    kb.sources_cli("add", str(papers), "pp")
    out = capsys.readouterr().out
    assert "added pp" in out and "listed" in out
    kb.sources_cli("off", "pp", None)
    assert "off" in capsys.readouterr().out
    with pytest.raises(SystemExit):
        kb.sources_cli("remove", "nope", None)
