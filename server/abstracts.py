"""Abstracts for Zotero items that have none, from OpenAlex, kept in data/abstracts.json; Zotero is never changed.

About a quarter of a typical library has no abstract (APS, ACS, RSC and others often do not send one to Zotero),
so search, related papers and the reading radar judged those papers on their title alone. OpenAlex has most of
them (Elsevier withholds its abstracts there too). Looked up 50 DOIs a request; a DOI OpenAlex has no abstract for
is asked again after RETRY_DAYS. `fill` needs the network and never raises; `cached` only reads the file.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.parse
import urllib.request

import kb

FILE = "abstracts.json"
BATCH = 50
RETRY_DAYS = 30
BACKOFF_S = 3600  # after an error (rate limit, network), the next try waits this long
TIMEOUT_S = 20
UA = "Veritas (https://github.com/frimpsjoek/veritas-ai)"
_lock = threading.Lock()
_cache: dict | None = None


def _path():
    return kb.data_dir() / FILE


def _load() -> dict:
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(_path().read_text())
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save() -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(_cache or {}))
    tmp.replace(path)


def from_index(inverted: dict | None) -> str:
    """OpenAlex's abstract_inverted_index back to plain text."""
    if not inverted:
        return ""
    words = sorted((at, word) for word, places in inverted.items() for at in places)
    return " ".join(word for _, word in words)


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.loads(r.read())


def stamp() -> float:
    """When the abstracts file last changed (0 when there is none): part of the index's Zotero change check."""
    try:
        return _path().stat().st_mtime
    except OSError:
        return 0.0


def cached(doi: str) -> tuple[str, str, float] | None:
    """(abstract, source, when) kept for this DOI, or None."""
    with _lock:
        hit = _load().get(doi.strip().lower())
    return (hit["text"], hit["source"], hit["at"]) if hit and hit.get("text") else None


def fill(dois: list[str], get=_get, now: float | None = None) -> int:
    """Looks up the DOIs not yet known (or a none older than RETRY_DAYS); returns how many abstracts were found."""
    now = time.time() if now is None else now
    with _lock:
        known = _load()
        if now - known.get("_error_at", {}).get("at", -BACKOFF_S) < BACKOFF_S:
            return 0
        todo = sorted({d.strip().lower() for d in dois if d and d.strip()}
                      - {k for k, v in known.items() if v.get("text") or now - v.get("at", 0) < RETRY_DAYS * 86400})
    found = 0
    for start in range(0, len(todo), BATCH):
        batch = todo[start:start + BATCH]
        params = {"filter": "doi:" + "|".join(batch), "per-page": BATCH, "select": "doi,abstract_inverted_index"}
        if os.environ.get("OPENALEX_API_KEY"):
            params["api_key"] = os.environ["OPENALEX_API_KEY"]
        try:
            works = get(f"https://api.openalex.org/works?{urllib.parse.urlencode(params)}").get("results", [])
        except Exception:  # noqa: BLE001 - OpenAlex away or rate-limited: noted, so the next index run tries again
            with _lock:
                _load()["_error_at"] = {"at": now}
                _save()  # the file's change also makes the next index run read Zotero again
            return found
        texts = {str(w.get("doi") or "").lower().removeprefix("https://doi.org/"): from_index(w.get("abstract_inverted_index"))
                 for w in works}
        with _lock:
            cache = _load()
            for doi in batch:
                text = texts.get(doi, "")
                cache[doi] = {"text": text, "source": "openalex" if text else None, "at": now}
                found += bool(text)
            cache.pop("_error_at", None)
            _save()
    return found
