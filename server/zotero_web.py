"""A Zotero library read online, through the Zotero Web API (phase 2 task 4): for a library that is not on this computer.

An account entry in sources.json, {"name", "kind": "zotero-web", "user_id", "enabled"}, has no folder. Its API key
lives in the macOS login Keychain, service "second-brain", account "zotero-web:<user_id>" (the store the agent's
hidden keys already use; spec 020); VERITAS_ZOTERO_KEY overrides it, for tests and for machines without a Keychain.

Items are indexed as <name>:/zotero/KEY. The library is re-read only when its version (Last-Modified-Version)
changes; one request checks it. A failed request never removes what is already indexed.
"""
from __future__ import annotations

import html
import json
import os
import re
import secrets
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlencode

import zotero

API = "https://api.zotero.org"
OPENER = urllib.request.urlopen  # replaced in tests
KEYCHAIN_SERVICE = "second-brain"
SKIP_TYPES = ("attachment", "note", "annotation")


class ZoteroWebError(RuntimeError):
    """The Web API refused or failed (bad key 403, rate limit 429, server error, no network)."""


def keychain_account(user_id: str) -> str:
    return f"zotero-web:{user_id}"


def get_key(user_id: str) -> str | None:
    if os.environ.get("VERITAS_ZOTERO_KEY"):
        return os.environ["VERITAS_ZOTERO_KEY"]
    try:
        out = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a",
                              keychain_account(user_id), "-w"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def store_key(user_id: str, key: str) -> None:
    out = subprocess.run(["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a",
                          keychain_account(user_id), "-w", key], capture_output=True, text=True, timeout=10)
    if out.returncode != 0:
        raise ZoteroWebError(f"could not save the Zotero key in the Keychain: {out.stderr.strip()}")


class Client:
    def __init__(self, user_id: str, key: str, opener=None):
        self.user_id, self.key, self._opener = user_id, key, opener

    def _request(self, method: str, path: str, params: dict | None = None, body=None, headers: dict | None = None):
        url = f"{API}/users/{self.user_id}{path}" + (f"?{urlencode(params)}" if params else "")
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Zotero-API-Key": self.key, "Zotero-API-Version": "3", **({"Content-Type": "application/json"} if data else {}),
            **(headers or {})})
        try:
            with (self._opener or OPENER)(request, timeout=30) as res:
                return json.loads(res.read() or b"null"), res.headers
        except urllib.error.HTTPError as error:
            raise ZoteroWebError(f"Zotero Web API {method} {path}: HTTP {error.code}") from None
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise ZoteroWebError(f"Zotero Web API {method} {path}: {error}") from None

    def version(self) -> int:
        """The library's current version, from one tiny request."""
        _, headers = self._request("GET", "/items", {"limit": 1, "format": "json"})
        return int(headers.get("Last-Modified-Version", 0))

    def items(self, page: int = 100) -> tuple[list[dict], int]:
        """Every item (top-level and children), paged, with the library version."""
        out, start, version = [], 0, 0
        while True:
            batch, headers = self._request("GET", "/items", {"format": "json", "start": start, "limit": page})
            version = int(headers.get("Last-Modified-Version", version))
            out += batch or []
            total = int(headers.get("Total-Results", 0))
            if not batch or len(batch) < page or (total and len(out) >= total):
                return out, version
            start += page

    def fulltext(self, key: str) -> str | None:
        try:
            body, _ = self._request("GET", f"/items/{key}/fulltext")
        except ZoteroWebError:
            return None  # most attachments have no indexed text; that is not an error
        return (body or {}).get("content")

    def create(self, item: dict) -> str:
        """Adds one item to the library and returns its new key."""
        body, _ = self._request("POST", "/items", body=[item], headers={"Zotero-Write-Token": secrets.token_hex(16)})
        made = (body or {}).get("successful", {}).get("0")
        if not made:
            raise ZoteroWebError(f"Zotero did not add the item: {(body or {}).get('failed')}")
        return made["key"]


@dataclass
class AccountDoc(zotero.ZoteroDoc):
    prefix: str = ""

    @property
    def path(self) -> str:
        return self.prefix + zotero.PREFIX + self.key


def _plain(note_html: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", note_html or "")).strip()


def documents(entry: dict, client: Client) -> list[AccountDoc]:
    """One document per top-level item: metadata, abstract and the item's child notes."""
    items, _ = client.items()
    children: dict[str, list[dict]] = {}
    for it in items:
        parent = it["data"].get("parentItem")
        if parent:
            children.setdefault(parent, []).append(it)
    prefix = f"{entry['name']}:/"
    docs = []
    for it in items:
        data = it["data"]
        if data.get("itemType") in SKIP_TYPES or data.get("parentItem"):
            continue
        authors = [" ".join(p for p in (c.get("firstName"), c.get("lastName")) if p) or c.get("name", "")
                   for c in data.get("creators", [])]
        year = (re.search(r"\d{4}", data.get("date", "")) or [None])[0]
        notes = [_plain(c["data"].get("note", "")) for c in children.get(it["key"], []) if c["data"].get("itemType") == "note"]
        parts = [data.get("title", ""), ", ".join(a for a in authors if a), year or "", data.get("DOI", ""),
                 data.get("abstractNote", ""), *notes]
        text = "\n\n".join(p for p in parts if p)
        versions = [it.get("version", 0)] + [c.get("version", 0) for c in children.get(it["key"], [])]
        tags = [t["tag"] for t in data.get("tags", []) if t.get("tag")]
        meta = {"library": entry["name"], "doi": data.get("DOI") or None, "year": year, "authors": authors,
                "item_type": data.get("itemType"), "collection_keys": list(data.get("collections", []))}
        docs.append(AccountDoc(it["key"], data.get("title") or "(untitled)", text, tags, float(max(versions)), meta,
                               prefix=prefix))
    return docs
