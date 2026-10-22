"""Single-use tickets (phase 3): what an iframe or a PDF.js request of the hosted web app sends instead of the token.

A page on another origin can put the token in a fetch's Authorization header, but not on an <iframe src>. It asks
POST /web/ticket {"route", "query"} (with the token) and puts the ticket in the frame's URL: valid once, for 120 s,
for exactly that route and query. The long-lived token never travels in a URL.
"""
from __future__ import annotations

import secrets
import threading
import time

TTL = 120.0
# The routes a frame, an image or PDF.js loads directly.
ROUTES = frozenset({"/web/page", "/web/pdf", "/zotero/pdf", "/file", "/folder-file"})
_issued: dict[str, tuple[float, str, tuple]] = {}
_lock = threading.Lock()


def _key(query: dict) -> tuple:
    return tuple(sorted((str(k), str(v)) for k, v in query.items() if k != "ticket"))


def issue(route: str, query: dict) -> str:
    if route not in ROUTES:
        raise ValueError(f"no tickets for {route}")
    ticket = secrets.token_urlsafe(24)
    now = time.monotonic()
    with _lock:
        for t in [t for t, (at, _, _) in _issued.items() if now - at > TTL]:
            del _issued[t]
        _issued[ticket] = (now, route, _key(query))
    return ticket


def redeem(ticket: str, route: str, query: dict) -> bool:
    """True once, for the route and query the ticket was issued for, within TTL."""
    with _lock:
        entry = _issued.pop(ticket, None)
    if entry is None:
        return False
    at, issued_route, issued_query = entry
    return time.monotonic() - at <= TTL and issued_route == route and issued_query == _key(query)
