"""Spec 032: where a paper's PDF is kept. No network: the download is faked; Zotero's presence is patched."""
import json
from pathlib import Path

import pytest

import paper_store

PDF = b"%PDF-1.7 invented"


@pytest.fixture
def no_zotero(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(paper_store.zotero, "ZOTERO", tmp_path / "no-zotero")
    monkeypatch.setattr(paper_store.kb, "VAULT", tmp_path / "vault")
    return tmp_path / "vault" / "Papers"


@pytest.fixture
def with_zotero(tmp_path: Path, monkeypatch):
    (tmp_path / "Zotero").mkdir()
    monkeypatch.setattr(paper_store.zotero, "ZOTERO", tmp_path / "Zotero")
    monkeypatch.setattr(paper_store.pending_adds, "default_account", lambda: None)
    calls = {"attach": [], "add": []}
    monkeypatch.setattr(paper_store.pending_adds, "attach_pdf", lambda body, doi, title, url: calls["attach"].append((body, doi, title, url)) or {"status": "queued", "id": "e1"})
    monkeypatch.setattr(paper_store.pending_adds, "add_papers", lambda papers: calls["add"].append(papers) or [{"status": "queued", "id": "e2"}])
    return calls


def test_the_rule_zotero_when_a_local_library_exists_else_the_folder(no_zotero, monkeypatch, tmp_path):
    assert paper_store.target() == "folder"
    (tmp_path / "Z").mkdir()
    monkeypatch.setattr(paper_store.zotero, "ZOTERO", tmp_path / "Z")
    monkeypatch.setattr(paper_store.pending_adds, "default_account", lambda: None)
    assert paper_store.target() == "zotero"
    # an online default library: this app does not upload files to it, so the folder
    monkeypatch.setattr(paper_store.pending_adds, "default_account", lambda: object())
    assert paper_store.target() == "folder"


def test_file_name_is_author_year_title_and_safe():
    assert paper_store.file_name({"authors": ["Chen, Ann"], "year": 2021, "title": "Winter diets: of field/voles?"}) == "Chen 2021 - Winter diets of field voles.pdf"
    assert paper_store.file_name({"authors": ["Ann Chen"], "year": "2021-03", "title": "The $GW$ method"}) == "Chen 2021 - The GW method.pdf"
    assert paper_store.file_name({"title": "x" * 200}).startswith("x" * 90)
    assert paper_store.file_name({}) == "Untitled.pdf"


def test_without_zotero_the_pdf_goes_to_the_papers_folder_with_what_it_is(no_zotero):
    got = paper_store.keep({"title": "Winter diets of field voles", "authors": ["Chen, Ann"], "year": 2021, "doi": "10.9999/V"}, "https://repo.example/v.pdf", fetch=lambda url: PDF)
    assert got == {"status": "kept", "where": "folder", "path": "Papers/Chen 2021 - Winter diets of field voles.pdf", "downloaded": True}
    assert (no_zotero / "Chen 2021 - Winter diets of field voles.pdf").read_bytes() == PDF
    meta = json.loads((no_zotero / "Chen 2021 - Winter diets of field voles.json").read_text())
    assert meta["doi"] == "10.9999/v" and meta["url"] == "https://repo.example/v.pdf" and meta["title"] == "Winter diets of field voles"


def test_the_same_file_twice_is_kept_once_and_a_different_one_never_overwrites(no_zotero):
    paper = {"title": "T", "authors": ["Chen, A"], "year": 2021}
    first = paper_store.keep(paper, "https://x/a.pdf", fetch=lambda url: PDF)
    again = paper_store.keep(paper, "https://x/a.pdf", fetch=lambda url: PDF)
    other = paper_store.keep(paper, "https://x/b.pdf", fetch=lambda url: PDF + b" other")
    assert again == {**first, "already": True}
    assert other["path"] == "Papers/Chen 2021 - T (2).pdf"
    assert sorted(p.name for p in no_zotero.glob("*.pdf")) == ["Chen 2021 - T (2).pdf", "Chen 2021 - T.pdf"]


def test_without_zotero_a_copy_that_cannot_be_read_fails_and_saves_nothing(no_zotero):
    def refused(url):
        raise ValueError("HTTP Error 403: Forbidden")
    got = paper_store.keep({"title": "T"}, "https://pub.example/t.pdf", fetch=refused)
    assert got["status"] == "failed" and "403" in got["message"] and not no_zotero.exists()
    assert paper_store.keep({"title": "T"}, "https://x", fetch=lambda url: b"<html>sign in")["status"] == "failed"


def test_with_zotero_the_pdf_is_downloaded_now_and_held_for_the_plugin(with_zotero):
    got = paper_store.keep({"title": "T", "doi": "10.1/x"}, "https://repo.example/t.pdf", fetch=lambda url: PDF)
    assert got == {"status": "queued", "id": "e1", "where": "zotero", "downloaded": True}
    assert with_zotero["attach"] == [(PDF, "10.1/x", "T", "https://repo.example/t.pdf")]


def test_with_zotero_a_copy_that_cannot_be_downloaded_is_queued_as_an_add_the_plugin_finishes(with_zotero):
    def refused(url):
        raise ValueError("HTTP Error 403: Forbidden")
    got = paper_store.keep({"title": "T", "doi": "10.1/x"}, "https://pub.example/t.pdf", fetch=refused)
    assert got["where"] == "zotero" and got["downloaded"] is False and got["status"] == "queued" and "403" in got["message"]
    assert with_zotero["add"] == [[{"title": "T", "doi": "10.1/x", "pdf": "https://pub.example/t.pdf"}]]
    assert with_zotero["attach"] == []


def test_bytes_from_browse_are_kept_without_a_download(no_zotero):
    got = paper_store.keep({"title": "Browse paper", "doi": "10.1/b"}, "https://pub.example/b.pdf", body=PDF, fetch=lambda url: pytest.fail("no download"))
    assert got["where"] == "folder" and got["status"] == "kept"


def test_free_copies_are_tried_in_turn(no_zotero):
    tried = []
    def fetch(url):
        tried.append(url)
        if "publisher" in url:
            raise ValueError("HTTP Error 403: Forbidden")
        return PDF
    got = paper_store.keep({"title": "T"}, ["https://publisher.example/t.pdf", "https://repo.example/t.pdf"], fetch=fetch)
    assert got["status"] == "kept" and tried == ["https://publisher.example/t.pdf", "https://repo.example/t.pdf"]
    assert json.loads((no_zotero / "T.json").read_text())["url"] == "https://repo.example/t.pdf"
