"""GET /site-icon?domain=chemrxiv.org | ?openalex=S123: the icon a site gives itself (journals, databases, feeds,
outside sources), so the web app can show each source by its own logo.

The server fetches it once and keeps it in data/site-icons/, so the browser never asks the site; a site with no icon
is remembered for a week. When the site itself will not answer a non-browser (bot protection), DuckDuckGo's public icon
service is asked instead, then Google's. Only public https sites are asked (no localhost or private addresses, also after a
redirect), only images up to ICON_MAX_BYTES are kept. Journals are found by their OpenAlex id (its homepage_url).
"""
from __future__ import annotations

import html.parser
import ipaddress
import json
import re
import socket
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

import kb

FOLDER = "site-icons"
ICON_MAX_BYTES = 512_000
PAGE_MAX_BYTES = 1_000_000
MISS_DAYS = 7
TIMEOUT = 10
DOMAIN = re.compile(r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
TYPES = {"image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/ico": "ico", "image/svg+xml": "svg",
         "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
_lock = threading.Lock()


class Refused(ValueError):
    """Not a public site this server will ask."""


def folder() -> Path:
    path = kb.HOME / "data" / FOLDER
    path.mkdir(parents=True, exist_ok=True)
    return path


def public_host(host: str) -> None:
    """Raises Refused unless every address the name resolves to is a public one."""
    if not DOMAIN.match(host or ""):
        raise Refused(f"not a site name: {host!r}")
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError as error:
        raise Refused(f"{host} does not resolve") from error
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if not address.is_global:
            raise Refused(f"{host} is not a public address")


class _Checked(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        url = urllib.parse.urlparse(newurl)
        if url.scheme != "https":
            raise Refused("redirect away from https")
        public_host(url.hostname or "")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_Checked)


def _get(url: str, limit: int) -> tuple[bytes, str]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise Refused("only https")
    public_host(parsed.hostname or "")
    request = urllib.request.Request(url, headers={"User-Agent": "SecondBrain/1.0 (site icon)", "Accept": "*/*"})
    with _opener.open(request, timeout=TIMEOUT) as response:
        data = response.read(limit + 1)
        kind = response.headers.get_content_type()
    if len(data) > limit:
        raise ValueError("too large")
    return data, kind


class _Links(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.icons: list[tuple[int, str]] = []

    def handle_starttag(self, tag, attrs):
        if tag != "link":
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        rel = a.get("rel", "").lower().split()
        href = a.get("href", "")
        if not href:
            return
        # Larger, cleaner marks first: the apple-touch-icon is usually the logo at 180 px; an SVG icon scales.
        if "apple-touch-icon" in rel:
            self.icons.append((0, href))
        elif "icon" in rel and (a.get("type") == "image/svg+xml" or href.lower().endswith(".svg")):
            self.icons.append((1, href))
        elif "icon" in rel:
            self.icons.append((2, href))


def icon_urls(page_url: str, page: bytes) -> list[str]:
    parser = _Links()
    try:
        parser.feed(page.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 - a broken page just has no icon links
        pass
    found = [urllib.parse.urljoin(page_url, href) for _, href in sorted(parser.icons)]
    return found + [urllib.parse.urljoin(page_url, "/favicon.ico")]


def _index() -> dict:
    path = folder() / "index.json"
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def _save_index(index: dict) -> None:
    path = folder() / "index.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(index))
    tmp.replace(path)


def domain_of_openalex(source_id: str, get=_get) -> str | None:
    sid = re.sub(r"^https?://openalex\.org/", "", str(source_id or ""))
    if not re.fullmatch(r"S\d{1,12}", sid):
        raise Refused("not an OpenAlex source id")
    try:
        data, _ = get(f"https://api.openalex.org/sources/{sid}?select=homepage_url", 200_000)
    except Refused:
        raise
    except Exception:  # noqa: BLE001 - an unknown id, OpenAlex away or its daily limit: no icon now, not an error
        return None
    homepage = (json.loads(data) or {}).get("homepage_url") or ""
    return urllib.parse.urlparse(homepage).hostname or ""  # "" = the journal has no homepage (a real miss)


def site_icon(domain: str | None = None, openalex: str | None = None, get=_get) -> tuple[Path, str] | None:
    """(file, content type) of the site's icon, fetched once and kept; None when the site has none."""
    key = f"openalex:{openalex}" if openalex else (domain or "").lower().strip().removeprefix("www.")
    with _lock:
        index = _index()
        hit = index.get(key)
        if hit and hit.get("file") and (folder() / hit["file"]).is_file():
            return folder() / hit["file"], hit["type"]
        if hit and not hit.get("file") and time.time() - hit.get("at", 0) < MISS_DAYS * 86400:
            return None
    host = domain_of_openalex(openalex, get) if openalex else key
    if host is None:
        return None  # OpenAlex could not be asked just now: try again next time rather than remember a miss
    result = None
    if host:
        host = host.lower().removeprefix("www.")
        tries = []
        try:
            page, _ = get(f"https://{host}/", PAGE_MAX_BYTES)
            tries = icon_urls(f"https://{host}/", page)
        except Refused:
            raise
        except Exception:  # noqa: BLE001 - no home page (or one that only answers browsers): the conventional place
            tries = [f"https://{host}/favicon.ico"]
        # Sites behind bot protection answer 403 to anything but a browser; DuckDuckGo's public icon service has
        # their icon. Asked last, once, and kept like the rest.
        tries.append(f"https://icons.duckduckgo.com/ip3/{host}.ico")
        tries.append(f"https://www.google.com/s2/favicons?domain={host}&sz=64")  # Google's, when DuckDuckGo has none
        for url in tries:
            try:
                data, kind = get(url, ICON_MAX_BYTES)
            except Refused:
                continue
            except Exception:  # noqa: BLE001
                continue
            if kind not in TYPES or not data:
                continue
            name = f"{re.sub(r'[^a-z0-9.-]+', '_', key.lower())}.{TYPES[kind]}"
            (folder() / name).write_bytes(data)
            result = (folder() / name, kind)
            break
    with _lock:
        index = _index()
        index[key] = {"file": result[0].name, "type": result[1], "at": time.time()} if result else {"file": None, "at": time.time()}
        _save_index(index)
    return result
