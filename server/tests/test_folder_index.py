"""Indexing several folders (spec 018 U2): the main vault keeps bare paths, a plain folder gets `name:/` paths,
titles from headings and Markdown links; switching a folder off removes its rows; a missing folder keeps them."""
from __future__ import annotations

import pytest

import kb
import media
import sources


@pytest.fixture()
def setup(tmp_path, monkeypatch):
    vault = tmp_path / "vault"
    (vault / ".obsidian").mkdir(parents=True)
    (vault / "personal").mkdir()
    (vault / "personal" / "sleep.md").write_text("# Sleep\n\nNotes on sleep and [[Circadian]] rhythm.\n")
    papers = tmp_path / "papers"
    (papers / "sub").mkdir(parents=True)
    (papers / "review.md").write_text("---\ntags: [dft]\n---\n# Band gaps in DFT\n\nSee [the methods](sub/methods%20note.md).\n")
    (papers / "sub" / "methods note.md").write_text("Hybrid functionals and band gaps, no heading here.\n")
    (papers / "plain.txt").write_text("A text file about excitons.\n")
    (papers / "drafts").mkdir()
    (papers / "drafts" / "skip-me.md").write_text("# Draft\n\nnot indexed\n")
    (papers / "scan.pdf").write_bytes(b"%PDF-1.4 fixture")
    (papers / ".hidden").mkdir()
    (papers / ".hidden" / "x.md").write_text("# hidden\n")

    monkeypatch.setattr(sources, "FILE", tmp_path / "data" / "sources.json")
    monkeypatch.setattr(sources, "OUTPUT_DEFAULT", tmp_path / "home")
    sources.save([{"name": "vault", "path": str(vault), "enabled": True, "skip": [], "main": True},
                  {"name": "papers", "path": str(papers), "enabled": True, "skip": ["drafts/*"]},
                  {"name": "usb", "path": str(tmp_path / "unplugged"), "enabled": True, "skip": []}])
    monkeypatch.setattr(kb, "HOME", tmp_path)
    monkeypatch.setattr(kb, "DB_PATH", tmp_path / "data" / "kb.sqlite")
    monkeypatch.setattr(kb, "embed_pending", lambda *a, **k: 0)
    monkeypatch.setattr(kb, "index_zotero", lambda *a, **k: 0)
    monkeypatch.setattr(media, "extract", lambda root, rel: "Page one text about perovskite solar cells." * 2)

    def relayout():
        monkeypatch.setattr(kb, "LAYOUT", sources.resolved())
        monkeypatch.setattr(kb, "VAULT", kb.LAYOUT.main)

    relayout()
    return tmp_path, relayout


def run_index():
    return kb._index(False, False, kb.Progress())


def rows():
    db = kb.connect()
    return {p: (t, f, s) for p, t, f, s in db.execute("SELECT path, title, folder, source FROM notes")}


def test_every_folder_is_indexed_with_its_paths(setup):
    run_index()
    got = rows()
    assert got["personal/sleep.md"] == ("sleep", "personal", "personal")  # main vault: unchanged rules
    assert got["papers:/review.md"] == ("Band gaps in DFT", "papers", "papers")
    assert got["papers:/sub/methods note.md"] == ("methods note", "papers", "papers")
    assert got["papers:/plain.txt"][0] == "plain"
    assert got["papers:/scan.pdf"] == ("scan.pdf", "papers", "pdf")
    assert not any("drafts" in p or ".hidden" in p for p in got)
    db = kb.connect()
    assert ("papers:/review.md", "methods note") in set(db.execute("SELECT src, dst FROM links"))
    assert (db.execute("SELECT tags FROM notes WHERE path='papers:/review.md'").fetchone()[0]) == "dft"


def test_read_resolve_and_search_a_listed_folder(setup):
    run_index()
    note = kb.read_note("papers:/review.md")
    assert note["path"] == "papers:/review.md" and "Band gaps" in note["text"]
    assert kb.note_path("papers:/sub/methods note.md") == "papers:/sub/methods note.md"
    assert kb.note_path("personal/sleep.md") == "personal/sleep.md"
    with pytest.raises(ValueError):
        kb.resolve("papers:/../vault/personal/sleep.md")
    hits = kb.Searcher().search("band gaps hybrid functionals", limit=10, source="papers")
    assert hits and all(h["path"].startswith("papers:/") for h in hits)


def test_switching_off_removes_rows_but_missing_keeps_them(setup):
    tmp_path, relayout = setup
    run_index()
    # The unplugged drive comes back with a file, is indexed, then goes missing again: its rows stay.
    usb = tmp_path / "unplugged"
    usb.mkdir()
    (usb / "kept.md").write_text("# Kept\n\nstill here\n")
    relayout()
    run_index()
    assert "usb:/kept.md" in rows()
    (usb / "kept.md").unlink()
    usb.rmdir()
    relayout()
    run_index()
    assert "usb:/kept.md" in rows()
    # Switching papers off removes its notes and its PDF.
    sources.update("papers", enabled=False)
    relayout()
    run_index()
    got = rows()
    assert not any(p.startswith("papers:/") for p in got)
    assert "personal/sleep.md" in got


def test_no_vault_only_a_plain_folder(setup, monkeypatch):
    tmp_path, relayout = setup
    sources.save([{"name": "papers", "path": str(tmp_path / "papers"), "enabled": True, "skip": []}])
    relayout()
    assert kb.VAULT == tmp_path / "home" and not kb.LAYOUT.main_is_vault
    run_index()
    got = rows()
    assert "papers:/review.md" in got and not any(p.startswith("personal/") for p in got)


def test_zotero_routes_say_needs_zotero_without_a_library(tmp_path, monkeypatch):
    import http.client
    import json
    import threading
    from http.server import ThreadingHTTPServer

    import http_api
    import zotero

    monkeypatch.setattr(zotero, "ZOTERO", tmp_path / "no-zotero-library")
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        conn.request("GET", "/zotero/pdf?key=ABCD2345")
        res = conn.getresponse()
        assert res.status == 409 and json.loads(res.read())["error"] == "needs_zotero"
        conn.request("POST", "/zotero/add", body=b'{"papers": []}', headers={"Content-Type": "application/json"})
        res = conn.getresponse()
        assert res.status == 409 and json.loads(res.read())["error"] == "needs_zotero"
        conn.close()
    finally:
        server.shutdown()
        server.server_close()


def test_folder_file_streams_indexed_documents_only(setup):
    import http.client
    import threading
    from http.server import ThreadingHTTPServer

    import http_api

    tmp_path, _ = setup
    run_index()
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_api.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    def get(path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        conn.request("GET", path, headers=headers or {})
        res = conn.getresponse()
        body = res.read()
        conn.close()
        return res, body

    try:
        res, body = get("/folder-file?path=papers:/scan.pdf")
        assert res.status == 200 and body == b"%PDF-1.4 fixture"
        assert res.getheader("Content-Type") == "application/pdf"
        res, body = get("/folder-file?path=papers:/scan.pdf", {"Range": "bytes=0-3"})
        assert res.status == 206 and body == b"%PDF"
        assert get("/folder-file?path=papers:/review.md")[0].status == 404  # a note, not a document
        assert get("/folder-file?path=papers:/../vault/personal/sleep.md")[0].status == 404
        assert get("/folder-file?path=papers:/scan.pdf", {"X-KB-Client": "agent"})[0].status == 403
    finally:
        server.shutdown()
        server.server_close()


def test_images_of_a_listed_folder_note_resolve_beside_it(setup):
    import paper_notes
    tmp_path, _ = setup
    (tmp_path / "papers" / "figs").mkdir()
    (tmp_path / "papers" / "figs" / "plot.png").write_bytes(b"\x89PNG fake")
    (tmp_path / "secret.png").write_bytes(b"\x89PNG secret")
    found = paper_notes.image_file(path="figs/plot.png", note="papers:/review.md")
    assert found == (tmp_path / "papers" / "figs" / "plot.png").resolve()
    assert paper_notes.image_file(path="../secret.png", note="papers:/review.md") is None, "nothing outside the folder"
