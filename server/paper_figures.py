"""A paper's graphical abstract (or first figure) for the web app's Home, found without a key and cached.

Tried in order, each only when it applies:
1. arXiv: the first figure of the paper's HTML page (arxiv.org/html/<id>).
2. Springer, Nature and BMC: the first figure, whose address follows from the DOI
   (10.1038/s41524-026-02351-z -> .../41524_2026_2351_Fig1_HTML.png), checked to exist.
3. The article page's own preview image (og:image / twitter:image), unless it is a logo or a journal cover.

ACS, APS, RSC and Elsevier refuse these requests, so their papers have none. Answers (an image or none) are kept in
data/web/paper-figures.json; a "none" is asked again after a week. The browser loads the image from the publisher.
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

import kb

CACHE = kb.HOME / "data" / "web" / "paper-figures.json"
RETRY_NONE_S = 7 * 24 * 3600
TIMEOUT_S = 8
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
GENERIC = re.compile(r"logo|cover|default|placeholder|favicon|social|share|banner|sprite|icon", re.I)
SPRINGER = re.compile(r"10\.(?:1038|1007|1186)/s(\d+)-(\d{3})-(\d+)-\w", re.I)
ARXIV_ID = re.compile(r"(\d{4}\.\d{4,5})(v\d+)?")

_lock = threading.Lock()
_cache: dict | None = None


def _load() -> dict:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(CACHE.read_text())
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save() -> None:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_cache))
    tmp.replace(CACHE)


def _get(url: str, limit: int = 600_000) -> tuple[int, str, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,image/*;q=0.9,*/*;q=0.8"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return r.status, r.geturl(), r.read(limit)


def springer_figure(doi: str) -> str | None:
    """The first-figure address Springer Nature uses for this DOI, or None when the DOI is not theirs."""
    m = SPRINGER.fullmatch(doi.strip())
    if not m:
        return None
    journal, yy, number = m.groups()
    year = 2000 + int(yy[-2:])
    return (f"https://media.springernature.com/lw685/springer-static/image/art%3A{urllib.parse.quote(doi.strip(), safe='')}"
            f"/MediaObjects/{journal}_{year}_{int(number)}_Fig1_HTML.png")


def arxiv_id(arxiv: str | None, url: str | None) -> str | None:
    text = arxiv or (url if url and "arxiv" in url.lower() else "")
    m = ARXIV_ID.search(text or "")
    return m.group(1) if m else None


def preview_image(html: str, page: str) -> str | None:
    """og:image or twitter:image from an article page, made absolute; None for a logo or cover."""
    for pattern in (r'<meta[^>]+(?:property|name)=["\'](?:og:image|twitter:image)["\'][^>]*content=["\']([^"\']+)',
                    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\'](?:og:image|twitter:image)["\']'):
        m = re.search(pattern, html, re.I)
        if m:
            src = urllib.parse.urljoin(page, m.group(1).replace("&amp;", "&"))
            return None if GENERIC.search(urllib.parse.urlparse(src).path) else src
    return None


def _find(doi: str, arxiv: str | None, url: str | None) -> str | None:
    aid = arxiv_id(arxiv, url)
    if aid:
        try:
            status, page, body = _get(f"https://arxiv.org/html/{aid}")
            html = body.decode("utf8", "ignore")
            m = re.search(r'<img[^>]+src="([^"]+)"[^>]*class="ltx_graphics', html) or re.search(r'class="ltx_graphics[^"]*"[^>]*src="([^"]+)"', html)
            if status == 200 and m:
                return urllib.parse.urljoin(page, m.group(1))
        except Exception:
            pass
    if doi:
        guess = springer_figure(doi)
        if guess:
            try:
                status, _, _ = _get(guess, limit=64)
                if status == 200:
                    return guess
            except Exception:
                pass
        try:
            status, page, body = _get(f"https://doi.org/{urllib.parse.quote(doi.strip(), safe='/')}")
            if status == 200:
                return preview_image(body.decode("utf8", "ignore"), page)
        except Exception:
            pass
    return None


def figure(doi: str = "", arxiv: str | None = None, url: str | None = None, now: float | None = None) -> str | None:
    key = (doi or arxiv_id(arxiv, url) or url or "").strip().lower()
    if not key:
        return None
    now = time.time() if now is None else now
    with _lock:
        hit = _load().get(key)
    if hit and (hit.get("image") or now - hit.get("at", 0) < RETRY_NONE_S):
        return hit.get("image")
    image = _find(doi, arxiv, url)
    with _lock:
        _load()[key] = {"image": image, "at": now}
        _save()
    return image
