"""A paper's graphical abstract (or first figure) for the web app's Home, found without a key and cached.

Tried in order, each only when it applies:
1. arXiv: the first figure of the paper's HTML page (arxiv.org/html/<id>).
2. Springer, Nature and BMC: the first figure, whose address follows from the DOI
   (10.1038/s41524-026-02351-z -> .../41524_2026_2351_Fig1_HTML.png), checked to exist.
3. The paper's arXiv preprint, found through OpenAlex: its first figure (ACS, APS, RSC and Elsevier refuse requests
   that do not come from a browser, so a preprint is the only way to a figure for most of their papers).
4. The article page's own preview image (og:image / twitter:image), unless it is a logo or a journal cover.

Answers are kept in data/web/paper-figures.json. A "none" every source answered is asked again after a week; a none
caused by an error (a timeout, no network) after an hour. The browser loads the image from its source.
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import kb

CACHE = kb.data_dir() / "web" / "paper-figures.json"
RETRY_NONE_S = 7 * 24 * 3600
RETRY_ERROR_S = 3600  # a none that came from an error (timeout, network), not from every source saying no
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


def arxiv_figure(aid: str) -> str | None:
    """The first figure of an arXiv paper's HTML page, or None when it has none (raises on a network error)."""
    status, page, body = _get(f"https://arxiv.org/html/{aid}")
    html = body.decode("utf8", "ignore")
    m = re.search(r'<img[^>]+src="([^"]+)"[^>]*class="ltx_graphics', html) or re.search(r'class="ltx_graphics[^"]*"[^>]*src="([^"]+)"', html)
    return urllib.parse.urljoin(page, m.group(1)) if status == 200 and m else None


def preprint_of(doi: str) -> str | None:
    """The arXiv id of a journal paper's preprint, from OpenAlex's locations; None when it has none."""
    _, _, body = _get(f"https://api.openalex.org/works/doi:{urllib.parse.quote(doi.strip(), safe='/')}?select=locations,ids", limit=400_000)
    m = re.search(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})", body.decode("utf8", "ignore"))
    return m.group(1) if m else None


def _find(doi: str, arxiv: str | None, url: str | None) -> tuple[str | None, bool]:
    """(image, settled): settled is False when a source could not be asked (an error), so a none is retried soon."""
    settled = True

    def attempt(fn, *args):
        nonlocal settled
        try:
            return fn(*args)
        except urllib.error.HTTPError:  # the site answered (403 bot check, 404): a real no
            return None
        except Exception:  # noqa: BLE001 - a timeout or no network: skipped, and the none is retried soon
            settled = False
            return None

    aid = arxiv_id(arxiv, url)
    if aid:
        found = attempt(arxiv_figure, aid)
        if found:
            return found, True
    if doi:
        guess = springer_figure(doi)
        if guess and attempt(lambda: _get(guess, limit=64)[0] == 200):
            return guess, True
        if not aid:
            preprint = attempt(preprint_of, doi)
            found = attempt(arxiv_figure, preprint) if preprint else None
            if found:
                return found, True
        page = attempt(lambda: _get(f"https://doi.org/{urllib.parse.quote(doi.strip(), safe='/')}"))
        if page and page[0] == 200:
            found = preview_image(page[2].decode("utf8", "ignore"), page[1])
            if found:
                return found, True
    return None, settled


def figure(doi: str = "", arxiv: str | None = None, url: str | None = None, now: float | None = None) -> str | None:
    key = (doi or arxiv_id(arxiv, url) or url or "").strip().lower()
    if not key:
        return None
    now = time.time() if now is None else now
    with _lock:
        hit = _load().get(key)
    retry = RETRY_NONE_S if (hit or {}).get("settled", True) else RETRY_ERROR_S
    if hit and (hit.get("image") or now - hit.get("at", 0) < retry):
        return hit.get("image")
    image, settled = _find(doi, arxiv, url)
    with _lock:
        _load()[key] = {"image": image, "at": now, **({} if settled else {"settled": False})}
        _save()
    return image
