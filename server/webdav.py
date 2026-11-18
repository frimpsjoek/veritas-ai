"""The narrow, independently authenticated Zotero personal-WebDAV protocol namespace.

This is intentionally not mounted through ordinary browser, agent, or sidecar routes.
It implements the operations used by Zotero.Sync.Storage.Mode.WebDAV, not a general
filesystem/DAV server. Zotero metadata itself remains at zotero.org.
"""
from __future__ import annotations

import base64
import binascii
import email.utils
import re
import socket
import sys
import threading
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from urllib.parse import quote, unquote, urlsplit

import zotero_storage

DAV_NS = "DAV:"
ET.register_namespace("D", DAV_NS)
VERIFY_SLOTS = threading.BoundedSemaphore(4)
XML_LIMIT = 64 * 1024


@dataclass(frozen=True)
class Route:
    username: str
    collection: str
    name: str | None


class DavError(Exception):
    def __init__(self, status: int, message: str, headers: dict | None = None, close: bool = False):
        super().__init__(message)
        self.status, self.message, self.headers, self.close = status, message, headers or {}, close


def matches(path: str) -> bool:
    try:
        parsed = urlsplit(path).path
        return parsed == "/webdav" or parsed.startswith("/webdav/")
    except (TypeError, ValueError):
        return False


def _answer(handler, status: int, body: bytes = b"", headers: dict | None = None,
            content_type: str = "text/plain; charset=utf-8", content_length: int | None = None) -> None:
    handler.send_response(status)
    for name, value in (headers or {}).items():
        handler.send_header(name, value)
    if status not in (204, 304):
        handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body) if content_length is None else content_length))
    handler.end_headers()
    if handler.command != "HEAD" and status not in (204, 304) and body:
        try:
            handler.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            handler.close_connection = True


def _route(raw_path: str) -> Route:
    try:
        parsed = urlsplit(raw_path)
        if parsed.query or parsed.fragment:
            raise ValueError
        lowered = parsed.path.lower()
        if "%2f" in lowered or "%5c" in lowered:
            raise ValueError("encoded path separators are not allowed")
        decoded = unquote(parsed.path, errors="strict")
        if "\x00" in decoded or "\\" in decoded:
            raise ValueError
        parts = decoded.split("/")
        if len(parts) < 3 or parts[0] or parts[1] != "webdav":
            raise ValueError
        username = parts[2]
        if not re.fullmatch(r"[A-Za-z0-9_-]{4,128}", username):
            raise ValueError
        rest = [part for part in parts[3:] if part]
        if not rest:
            return Route(username, "parent", None)
        if rest == ["zotero"]:
            return Route(username, "zotero", None)
        if len(rest) == 2 and rest[0] == "zotero":
            return Route(username, "file", zotero_storage.StorageService._name(rest[1]))
    except (UnicodeDecodeError, ValueError, zotero_storage.InvalidResource):
        pass
    raise DavError(404, "not found", close=True)


def _basic(handler, store: zotero_storage.StorageService, expected_username: str) -> str:
    supplied = handler.headers.get("Authorization") or ""
    scheme, _, encoded = supplied.partition(" ")
    if scheme.lower() != "basic" or not encoded or len(encoded) > 512:
        raise DavError(401, "valid Zotero WebDAV credentials are required",
                       {"WWW-Authenticate": 'Basic realm="Veritas Zotero"'}, close=True)
    try:
        decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
        username, separator, password = decoded.partition(":")
        if not separator or username != expected_username:
            raise ValueError
    except (ValueError, UnicodeDecodeError, binascii.Error):
        raise DavError(401, "valid Zotero WebDAV credentials are required",
                       {"WWW-Authenticate": 'Basic realm="Veritas Zotero"'}, close=True) from None
    if not VERIFY_SLOTS.acquire(blocking=False):
        raise DavError(429, "credential verification is busy; retry", close=True)
    try:
        tenant = store.authenticate(username, password)
    finally:
        VERIFY_SLOTS.release()
    if tenant is None:
        raise DavError(401, "valid Zotero WebDAV credentials are required",
                       {"WWW-Authenticate": 'Basic realm="Veritas Zotero"'}, close=True)
    return tenant


def _length(handler, *, required: bool, limit: int | None = None) -> int:
    if handler.headers.get("Transfer-Encoding"):
        raise DavError(501, "chunked transfer is not supported", close=True)
    raw = handler.headers.get("Content-Length")
    if raw is None:
        if required:
            raise DavError(411, "Content-Length is required", close=True)
        return 0
    if not raw.isascii() or not raw.isdigit():
        raise DavError(400, "invalid Content-Length", close=True)
    if len(raw) > 19:
        raise DavError(413, "request body is too large", close=True)
    try:
        length = int(raw)
    except ValueError:
        raise DavError(400, "invalid Content-Length", close=True) from None
    if limit is not None and length > limit:
        raise DavError(413, "request body is too large", close=True)
    if length > zotero_storage.SQLITE_MAX:
        raise DavError(413, "request body is too large", close=True)
    return length


def _xml(handler, timeout_seconds: float) -> int:
    value = handler.headers.get("Depth", "0")
    if value.lower() == "infinity":
        raise DavError(403, "Depth: infinity is refused", close=True)
    depth = {"0": 0, "1": 1}.get(value)
    if depth is None:
        raise DavError(400, "Depth must be 0 or 1", close=True)
    length = _length(handler, required=False, limit=XML_LIMIT)
    previous_timeout = handler.connection.gettimeout()
    handler.connection.settimeout(timeout_seconds)
    try:
        raw = handler.rfile.read(length)
    finally:
        handler.connection.settimeout(previous_timeout)
    if len(raw) != length:
        raise DavError(400, "short XML body", close=True)
    if raw:
        if b"<!doctype" in raw.lower():
            raise DavError(400, "DTD is not allowed")
        try:
            ET.fromstring(raw)
        except ET.ParseError:
            raise DavError(400, "malformed XML") from None
    return depth


def _element(parent, name: str, text=None):
    node = ET.SubElement(parent, f"{{{DAV_NS}}}{name}")
    if text is not None:
        node.text = str(text)
    return node


def _response_xml(root, href: str, *, metadata: dict | None = None) -> None:
    response = _element(root, "response")
    _element(response, "href", href)
    propstat = _element(response, "propstat")
    prop = _element(propstat, "prop")
    if metadata is None:
        _element(prop, "getcontentlength", 0)
        resource = _element(prop, "resourcetype")
        _element(resource, "collection")
    else:
        _element(prop, "getcontentlength", metadata["size"])
        _element(prop, "getlastmodified", email.utils.formatdate(metadata["modified"], usegmt=True))
        _element(prop, "getetag", f'"{metadata["sha256"]}"')
    _element(propstat, "status", "HTTP/1.1 200 OK")


def _propfind(handler, route: Route, store: zotero_storage.StorageService, tenant: str) -> None:
    depth = _xml(handler, store.config.read_timeout_seconds)
    root = ET.Element(f"{{{DAV_NS}}}multistatus")
    base = urlsplit(handler.path).path
    if not base.endswith("/"):
        base += "/"
    if route.collection == "file":
        try:
            row = store.get(tenant, route.name)
        except FileNotFoundError:
            raise DavError(404, "not found") from None
        _response_xml(root, base.removesuffix("/"), metadata=row)
    else:
        _response_xml(root, base)
        if depth:
            if route.collection == "parent":
                _response_xml(root, base + "zotero/")
            else:
                for row in store.list(tenant):
                    _response_xml(root, base + quote(row["name"]), metadata=row)
    payload = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    _answer(handler, 207, payload, content_type='application/xml; charset="utf-8"')


def _get(handler, route: Route, store: zotero_storage.StorageService, tenant: str) -> None:
    if route.collection != "file":
        raise DavError(405, "collections cannot be downloaded")
    try:
        attachment = store.open_read(tenant, route.name)
    except FileNotFoundError:
        raise DavError(404, "not found") from None
    with attachment:
        kind = "application/zip" if route.name.endswith(".zip") else "text/xml"
        handler.send_response(200)
        for name, value in {
            "Content-Type": kind,
            "Content-Length": str(attachment.size),
            "ETag": f'"{attachment.sha256}"',
            "Last-Modified": email.utils.formatdate(attachment.modified, usegmt=True),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        }.items():
            handler.send_header(name, value)
        handler.end_headers()
        if handler.command != "HEAD":
            while True:
                block = attachment.read(zotero_storage.CHUNK)
                if not block:
                    break
                handler.wfile.write(block)


def _put(handler, route: Route, store: zotero_storage.StorageService, tenant: str) -> None:
    if route.collection != "file":
        raise DavError(405, "PUT requires an attachment resource", close=True)
    length = _length(handler, required=True)
    reservation = None
    published = False
    timeout = store.config.read_timeout_seconds
    previous_timeout = handler.connection.gettimeout()
    try:
        with store.upload_slot(tenant):
            handler.connection.settimeout(timeout)
            try:
                reservation = store.reserve(tenant, route.name, length)
                digest = store.write_upload(reservation, handler.rfile)
                outcome = store.publish(reservation, digest)
                published = True
            finally:
                handler.connection.settimeout(previous_timeout)
            _answer(handler, 201 if outcome == "created" else 204)
    finally:
        if reservation is not None and not published:
            try:
                store.abort(reservation)
            except (OSError, zotero_storage.StorageError) as error:
                print(f"Zotero upload rollback deferred: {type(error).__name__}", file=sys.stderr, flush=True)


def dispatch(handler, store: zotero_storage.StorageService, config: zotero_storage.PublicConfig) -> None:
    """Handle one request already identified as native by http_api._native_dav()."""
    try:
        if not zotero_storage.trusted_transport(handler.headers, handler.client_address[0], config):
            raise DavError(403, "the configured HTTPS endpoint is required", close=True)
        if handler.command == "OPTIONS":
            return _answer(handler, 204, headers={
                "DAV": "1, 2", "Allow": "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL"})
        route = _route(handler.path)
        tenant = _basic(handler, store, route.username)
        if handler.command == "PROPFIND":
            return _propfind(handler, route, store, tenant)
        if handler.command in {"GET", "HEAD"}:
            return _get(handler, route, store, tenant)
        if handler.command == "PUT":
            return _put(handler, route, store, tenant)
        if handler.command == "DELETE":
            if route.collection != "file":
                raise DavError(405, "collections cannot be deleted")
            try:
                deleted = store.delete(tenant, route.name)
            except FileNotFoundError:
                deleted = False
            if not deleted:
                raise DavError(404, "not found")
            return _answer(handler, 204)
        if handler.command == "MKCOL":
            raise DavError(405, "the Zotero collection already exists")
        raise DavError(405, "method not allowed", {"Allow": "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL"})
    except DavError as error:
        if error.close:
            handler.close_connection = True
        return _answer(handler, error.status, (error.message + "\n").encode(), error.headers)
    except zotero_storage.QuotaExceeded:
        handler.close_connection = True
        return _answer(handler, 507, b"Zotero attachment storage quota exceeded\n")
    except zotero_storage.ShortBody:
        handler.close_connection = True
        return _answer(handler, 400, b"attachment body ended before Content-Length\n")
    except zotero_storage.UploadBusy:
        handler.close_connection = True
        return _answer(handler, 429, b"too many simultaneous attachment uploads; retry\n")
    except socket.timeout:
        handler.close_connection = True
        return _answer(handler, 408, b"attachment upload timed out\n")
    except (BrokenPipeError, ConnectionResetError):
        handler.close_connection = True
        return None
