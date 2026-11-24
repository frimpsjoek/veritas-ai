"""The text of a paper outside the library, from a legal free copy (spec 031 R3).

    paper_text(key, url, cache_path)   the PDF at `url` (an open-access copy the engine found: arXiv, Unpaywall,
                                       OpenAlex, Semantic Scholar, Europe PMC) as text, read once and cached under
                                       `key` (doi:<doi> or arxiv:<id>). The PDF itself is not kept.
    stats(cache_path)  clear(cache_path)   for Settings: how much is cached, and emptying it (D4)

Only http(s) addresses on the public internet are fetched (never this computer or a private network, also after a
redirect), at most PDF_MAX_BYTES, and only a file that starts with "%PDF-" counts: a login page or an error page is
refused, not read. arXiv is asked at the radar's pace (radar_api.fetch_arxiv_pdf). The cache is capped at
CACHE_MAX_BYTES of text; past it, the oldest entries go first.
"""
from __future__ import annotations

import ipaddress
import socket
import sqlite3
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

import media
import radar_api

PDF_MAX_BYTES = radar_api.PDF_MAX_BYTES
CACHE_MAX_BYTES = 2_000_000_000
MAX_PAGES = 60
USER_AGENT = "Veritas/1.0 (open-access paper reader)"


def _db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.execute("CREATE TABLE IF NOT EXISTS oa_text (key TEXT PRIMARY KEY, url TEXT, text TEXT, at REAL)")
    return db


def public_url(url: str) -> bool:
    """True for an http(s) address whose host is on the public internet (every address it resolves to)."""
    parts = urllib.parse.urlsplit(str(url or ""))
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except OSError:
        return False
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if not address.is_global:
            return False
    return bool(infos)


class _PublicOnly(urllib.request.HTTPRedirectHandler):
    """A redirect may only lead to another public address."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not public_url(newurl):
            raise ValueError("the copy redirects to an address that is not on the public internet")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_pdf(url: str, check=public_url) -> bytes:
    """The PDF at a public address; ValueError when it is not one, too large, or not a PDF."""
    arxiv = _arxiv(url)
    if arxiv:
        data = radar_api.fetch_arxiv_pdf(arxiv)
    else:
        if not check(url):
            raise ValueError("only addresses on the public internet are fetched")
        opener = urllib.request.build_opener(_PublicOnly)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*;q=0.5"})
        with opener.open(request, timeout=60) as response:
            data = response.read(PDF_MAX_BYTES + 1)
    if len(data) > PDF_MAX_BYTES:
        raise ValueError("PDF too large")
    if not data.startswith(b"%PDF-"):
        raise ValueError("what arrived is not a PDF (a login or error page)")
    return data


def _arxiv(url: str) -> str | None:
    parts = urllib.parse.urlsplit(str(url or ""))
    if parts.hostname not in ("arxiv.org", "export.arxiv.org", "www.arxiv.org"):
        return None
    path = parts.path.removeprefix("/pdf/").removeprefix("/abs/").removesuffix(".pdf")
    return radar_api.arxiv_id(path)


def paper_text(key: str, url: str, cache_path: Path, fetch=fetch_pdf) -> tuple[str, bool]:
    """(text, from_cache). Raises ValueError for a copy that cannot be read."""
    key = str(key or url).strip()[:300]
    db = _db(cache_path)
    try:
        row = db.execute("SELECT text FROM oa_text WHERE key=?", (key,)).fetchone()
        if row:
            return row[0], True
        data = fetch(url)
        with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
            tmp.write(data)
            tmp.flush()
            text = media.pdf_text(Path(tmp.name), max_pages=MAX_PAGES, ocr=False)
        if not text.strip():
            raise ValueError("the PDF has no text layer")
        db.execute("INSERT OR REPLACE INTO oa_text VALUES (?,?,?,?)", (key, url, text, time.time()))
        db.commit()
        _trim(db, CACHE_MAX_BYTES)
        return text, False
    finally:
        db.close()


def _trim(db: sqlite3.Connection, cap: int) -> None:
    """Oldest entries out until the cached text is under 80% of `cap`."""
    total = db.execute("SELECT COALESCE(SUM(LENGTH(text)), 0) FROM oa_text").fetchone()[0]
    if total <= cap:
        return
    for key, size in db.execute("SELECT key, LENGTH(text) FROM oa_text ORDER BY at").fetchall():
        if total <= cap * 0.8:
            break
        db.execute("DELETE FROM oa_text WHERE key=?", (key,))
        total -= size
    db.commit()


def stats(cache_path: Path) -> dict:
    db = _db(cache_path)
    try:
        papers, size = db.execute("SELECT COUNT(*), COALESCE(SUM(LENGTH(text)), 0) FROM oa_text").fetchone()
        return {"papers": papers, "bytes": size}
    finally:
        db.close()


def clear(cache_path: Path) -> dict:
    db = _db(cache_path)
    try:
        db.execute("DELETE FROM oa_text")
        db.commit()
        db.execute("VACUUM")
        return {"papers": 0, "bytes": 0}
    finally:
        db.close()
