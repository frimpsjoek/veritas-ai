"""Veritas output folder (phase 2 task 1): notes go to ~/Documents/Veritas unless a listed vault is chosen."""
from __future__ import annotations

import http.client
import json
import threading
from http.server import ThreadingHTTPServer

import pytest

import http_api
import kb
import sources


@pytest.fixture()
def home(tmp_path, monkeypatch):
    for var in ("KB_VAULT", "KB_ZOTERO"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(sources, "FILE", tmp_path / "data" / "sources.json")
    monkeypatch.setattr(sources, "OUTPUT_DEFAULT", tmp_path / "Documents" / "Veritas")
    monkeypatch.setattr(sources, "ZOTERO_PROFILES", tmp_path / "Profiles")
    monkeypatch.setattr(sources.Path, "home", lambda: tmp_path)
    return tmp_path


def vault(path):
    (path / ".obsidian").mkdir(parents=True)
    return path


def test_default_output_is_veritas_folder(home):
    v = vault(home / "notes")
    sources.save([{"name": "notes", "path": str(v), "enabled": True, "skip": []}])
    layout = sources.resolved()
    assert layout.main == home / "Documents" / "Veritas" and not layout.main_is_vault
    assert [f.name for f in layout.others] == ["notes"] and layout.others[0].prefix == "notes:/"
    assert not (home / "Documents" / "Veritas").exists()  # created when first written, not on read


def test_main_flag_still_wins(home):
    v = vault(home / "notes")
    sources.save([{"name": "notes", "path": str(v), "enabled": True, "skip": [], "main": True}])
    layout = sources.resolved()
    assert layout.main == v and layout.main_is_vault and layout.others == []


def test_set_output_to_listed_vault(home):
    v = vault(home / "notes")
    sources.save([{"name": "notes", "path": str(v), "enabled": True, "skip": []}])
    sources.set_output("notes")
    assert sources.resolved().main == v
    sources.set_output(None)
    assert sources.resolved().main == home / "Documents" / "Veritas"
    assert not any(e.get("main") for e in sources.load())


def test_set_output_rejects_zotero_and_unknown(home):
    lib = home / "Zotero"
    lib.mkdir()
    (lib / "zotero.sqlite").write_bytes(b"")
    sources.save([{"name": "zotero", "path": str(lib), "enabled": True, "skip": []}])
    with pytest.raises(sources.SourceError):
        sources.set_output("zotero")
    with pytest.raises(sources.SourceError):
        sources.set_output("nowhere")


def test_bare_path_falls_back_to_listed_folder(home, monkeypatch):
    v = vault(home / "notes")
    (v / "ai_notes").mkdir()
    (v / "ai_notes" / "old.md").write_text("# old\n")
    sources.save([{"name": "notes", "path": str(v), "enabled": True, "skip": []}])
    monkeypatch.setattr(kb, "DB_PATH", home / "data" / "kb.sqlite")
    kb.reload_layout()
    try:
        assert kb.resolve("ai_notes/old.md") == (v / "ai_notes" / "old.md").resolve()
    finally:
        monkeypatch.undo()
        kb.reload_layout()


def test_output_route(home, monkeypatch):
    v = vault(home / "notes")
    sources.save([{"name": "notes", "path": str(v), "enabled": True, "skip": []}])
    monkeypatch.setattr(kb, "HOME", home)
    monkeypatch.setattr(kb, "DB_PATH", home / "data" / "kb.sqlite")
    monkeypatch.setattr(kb, "index_running", lambda: False)
    monkeypatch.setattr(http_api, "start_indexing", lambda reread: None)
    kb.reload_layout()
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def call(method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        conn.request(method, path, body=json.dumps(body).encode() if body is not None else None,
                     headers={"Content-Type": "application/json"})
        res = conn.getresponse()
        out = res.status, json.loads(res.read() or b"null")
        conn.close()
        return out

    try:
        status, report = call("GET", "/sources")
        assert status == 200 and report["output"] == {"name": None, "path": str(home / "Documents" / "Veritas")}
        status, _ = call("PATCH", "/sources/output", {"name": "notes"})
        assert status == 200
        status, report = call("GET", "/sources")
        assert report["output"] == {"name": "notes", "path": str(v)}
        status, _ = call("PATCH", "/sources/output", {"name": "nowhere"})
        assert status == 400
    finally:
        server.shutdown()
        monkeypatch.undo()
        kb.reload_layout()


def test_new_output_folder_restarts_the_agent_so_chats_follow(home, monkeypatch):
    v = vault(home / "notes")
    sources.save([{"name": "notes", "path": str(v), "enabled": True, "skip": []}])
    monkeypatch.setattr(kb, "DB_PATH", home / "data" / "kb.sqlite")
    monkeypatch.setattr(kb, "index_running", lambda: True)  # no index run from this test
    kb.reload_layout()
    restarts = []
    monkeypatch.setattr(http_api.agent_api, "restart", lambda sidecar: restarts.append(sidecar))
    monkeypatch.setattr(http_api, "AGENT_SIDECAR", "sidecar")
    try:
        http_api.sources_changed()  # nothing moved
        assert restarts == []
        sources.set_output("notes")
        http_api.sources_changed()
        assert restarts == ["sidecar"]
    finally:
        monkeypatch.undo()
        kb.reload_layout()
