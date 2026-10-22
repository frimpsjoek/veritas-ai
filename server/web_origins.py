"""The web-app origins allowed to call this server from another site (phase 3): the hosted web app, a Tauri window.

    {"origins": ["https://example.github.io", "tauri://localhost"]}   in data/web-origins.json
    VERITAS_WEB_ORIGINS="https://a.example,http://127.0.0.1:8765"      added from the environment

A listed origin gets CORS headers, and every request from it must carry the Bearer token: it never gets the
loopback free pass or the sign-in cookie. Every other website stays refused.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

FILE = Path(__file__).resolve().parent / "data" / "web-origins.json"


def normalise(origin: str) -> str:
    """scheme://host[:port], lower-case, no path; ValueError when it is not an origin."""
    parts = urlsplit(origin.strip())
    if not parts.scheme or not parts.hostname:
        raise ValueError(f"{origin!r} is not an origin such as https://example.org")
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme.lower()}://{parts.hostname.lower()}{port}"


def _stored() -> list[str]:
    try:
        return list(json.loads(FILE.read_text(encoding="utf-8")).get("origins", []))
    except (OSError, ValueError):
        return []


def _save(origins: list[str]) -> None:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=FILE.parent, prefix=".web-origins-", delete=False) as tmp:
        json.dump({"origins": origins}, tmp, indent=2)
    Path(tmp.name).replace(FILE)


def allowed() -> set[str]:
    found = set()
    for origin in _stored() + [o for o in os.environ.get("VERITAS_WEB_ORIGINS", "").split(",") if o.strip()]:
        try:
            found.add(normalise(origin))
        except ValueError:
            continue
    return found


def add(origin: str) -> str:
    origin = normalise(origin)
    stored = [o for o in _stored() if o != origin]
    _save(stored + [origin])
    return origin


def remove(origin: str) -> None:
    origin = normalise(origin)
    _save([o for o in _stored() if o != origin])
