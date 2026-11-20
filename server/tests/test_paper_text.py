"""Spec 031 R3: a free copy of a paper outside the library, as text. No network: fetch and the PDF reader are faked."""
from pathlib import Path

import pytest

import paper_text


def test_public_url_refuses_this_computer_private_networks_and_other_schemes():
    assert not paper_text.public_url("http://127.0.0.1:27182/note")
    assert not paper_text.public_url("http://localhost/x.pdf")
    assert not paper_text.public_url("http://192.168.1.10/x.pdf")
    assert not paper_text.public_url("http://10.0.0.1/x.pdf")
    assert not paper_text.public_url("file:///etc/passwd")
    assert not paper_text.public_url("ftp://example.org/x.pdf")
    assert not paper_text.public_url("not a url")


def test_fetch_pdf_refuses_a_non_public_address_before_any_request():
    with pytest.raises(ValueError, match="public internet"):
        paper_text.fetch_pdf("http://127.0.0.1/x.pdf")


def test_fetch_pdf_refuses_what_is_not_a_pdf(monkeypatch):
    class Response:
        def __init__(self, data): self.data = data
        def read(self, n): return self.data[:n]
        def __enter__(self): return self
        def __exit__(self, *a): return False

    class Opener:
        def __init__(self, data): self.data = data
        def open(self, request, timeout): return Response(self.data)

    monkeypatch.setattr(paper_text.urllib.request, "build_opener", lambda *a: Opener(b"<html>Sign in</html>"))
    with pytest.raises(ValueError, match="not a PDF"):
        paper_text.fetch_pdf("https://publisher.example/a.pdf", check=lambda url: True)
    monkeypatch.setattr(paper_text.urllib.request, "build_opener", lambda *a: Opener(b"%PDF-1.7 ..."))
    assert paper_text.fetch_pdf("https://publisher.example/a.pdf", check=lambda url: True).startswith(b"%PDF-")


def test_arxiv_addresses_go_through_the_radar_pace(monkeypatch):
    asked = []
    monkeypatch.setattr(paper_text.radar_api, "fetch_arxiv_pdf", lambda arxiv: asked.append(arxiv) or b"%PDF-1.5")
    assert paper_text.fetch_pdf("https://arxiv.org/pdf/2401.01234v2").startswith(b"%PDF-")
    assert asked == ["2401.01234"]


def test_paper_text_reads_once_then_comes_from_the_cache(tmp_path: Path, monkeypatch):
    fetched = []
    monkeypatch.setattr(paper_text.media, "pdf_text", lambda path, max_pages, ocr: "## Page 1\nCore holes shift the edge.")
    fetch = lambda url: fetched.append(url) or b"%PDF-1.4"
    cache = tmp_path / "paper-text.sqlite"
    text, cached = paper_text.paper_text("doi:10.1/x", "https://repo.example/x.pdf", cache, fetch=fetch)
    assert "Core holes" in text and cached is False
    text2, cached2 = paper_text.paper_text("doi:10.1/x", "https://repo.example/x.pdf", cache, fetch=fetch)
    assert text2 == text and cached2 is True and fetched == ["https://repo.example/x.pdf"]
    assert paper_text.stats(cache) == {"papers": 1, "bytes": len(text)}
    assert paper_text.clear(cache) == {"papers": 0, "bytes": 0}
    assert paper_text.stats(cache)["papers"] == 0


def test_a_pdf_without_text_is_an_error_and_is_not_cached(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(paper_text.media, "pdf_text", lambda path, max_pages, ocr: "  ")
    cache = tmp_path / "c.sqlite"
    with pytest.raises(ValueError, match="no text layer"):
        paper_text.paper_text("doi:10.1/y", "https://repo.example/y.pdf", cache, fetch=lambda url: b"%PDF-1.4")
    assert paper_text.stats(cache)["papers"] == 0


def test_the_cache_drops_the_oldest_past_its_cap(tmp_path: Path):
    db = paper_text._db(tmp_path / "c.sqlite")
    for n in range(10):
        db.execute("INSERT INTO oa_text VALUES (?,?,?,?)", (f"k{n}", "u", "x" * 100, float(n)))
    db.commit()
    paper_text._trim(db, cap=500)  # 1000 bytes cached, cap 500: down to 400 (80%), oldest first
    keys = [r[0] for r in db.execute("SELECT key FROM oa_text ORDER BY at")]
    assert keys == ["k6", "k7", "k8", "k9"]
