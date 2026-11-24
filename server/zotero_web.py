"""A Zotero library read online, through the Zotero Web API (phase 2 task 4): for a library that is not on this computer.

An account entry in sources.json, {"name", "kind": "zotero-web", "user_id", "enabled"}, has no folder. Its API key
lives in the system's key store, service "second-brain", account "zotero-web:<user_id>" (the stores the agent's
hidden keys already use, agent/src/secrets.js; spec 020, spec 024 G2): the macOS login Keychain, Windows Credential
Manager, or the Linux Secret Service. When none is usable, the agent's owner-only file <data>/agent/secrets.json.
VERITAS_ZOTERO_KEY overrides all of them, for tests.

Items are indexed as <name>:/zotero/KEY. The library is re-read only when its version (Last-Modified-Version)
changes; one request checks it. A failed request never removes what is already indexed.
"""
from __future__ import annotations

import base64
import html
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlencode

import paths
import zotero

API = "https://api.zotero.org"
OPENER = urllib.request.urlopen  # replaced in tests
KEYCHAIN_SERVICE = "second-brain"
SKIP_TYPES = ("attachment", "note", "annotation")


class ZoteroWebError(RuntimeError):
    """The Web API refused or failed (bad key 403, rate limit 429, server error, no network)."""


def keychain_account(user_id: str) -> str:
    return f"zotero-web:{user_id}"


# What a store says when it cannot be used here (no Keychain for this login, no D-Bus session over SSH, no
# Credential Manager): the key then goes to the owner-only file, as in the agent.
UNUSABLE = re.compile(r"keychain cannot be found|no default keychain|user interaction is not allowed|d-bus|dbus|"
                      r"org\.freedesktop\.secrets|not provided by any|prompt dismissed|no credential manager", re.I)
STORE_NAMES = {"darwin": "the Keychain", "win32": "Windows Credential Manager"}  # anything else: the Secret Service


def _credential_args(op: str, account: str) -> list[str]:
    """Windows PowerShell reading or writing one Credential Manager entry (its PasswordVault), as in the agent: the
    script names only the account; a key to write comes on stdin. Exit 44: no such entry, 3: no Credential Manager."""
    script = f"""$ErrorActionPreference = 'Stop'
$op = '{op}'
$name = '{account}'
try {{
  [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $vault = New-Object Windows.Security.Credentials.PasswordVault
}} catch {{ [Console]::Error.WriteLine("no credential manager: $_"); exit 3 }}
$found = $null
try {{ $found = $vault.Retrieve('{KEYCHAIN_SERVICE}', $name) }} catch {{ }}
if ($op -eq 'set') {{
  $value = [Console]::In.ReadToEnd().TrimEnd([char]13, [char]10)
  if ($found) {{ $vault.Remove($found) }}
  $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential('{KEYCHAIN_SERVICE}', $name, $value)))
}} elseif (-not $found) {{ exit 44 }}
else {{ $found.RetrievePassword(); [Console]::Out.Write($found.Password) }}
"""
    return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
            base64.b64encode(script.encode("utf-16-le")).decode()]


def _system_store(op: str, account: str, key: str | None = None):
    """One "get" or "set" on this system's key store, the key always on stdin; None when the system has none installed."""
    if sys.platform == "darwin":  # `security -i` reads the whole command from stdin
        args, data = (["security", "-i"], f'add-generic-password -U -s {KEYCHAIN_SERVICE} -a {account} -w "{key}"\n') \
            if op == "set" else (["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], None)
    elif sys.platform == "win32":
        args, data = ["powershell.exe", *_credential_args(op, account)], key
    else:  # secret-tool reads the secret from stdin
        args, data = (["secret-tool", "store", f"--label=Veritas: {account}", "service", KEYCHAIN_SERVICE,
                       "account", account] if op == "set" else
                      ["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", account]), key
    if not shutil.which(args[0]):
        return None
    try:
        return subprocess.run(args, input=data, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None


def _secrets_file():
    return paths.data_dir() / "agent" / "secrets.json"  # the agent's own file (its --data is <data>/agent)


def _read_file() -> dict:
    try:
        return json.loads(_secrets_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_file(entries: dict) -> None:
    """Owner-only (0600) from the first byte, replaced in one step."""
    file = _secrets_file()
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=file.parent, prefix=".secrets-")  # mkstemp creates it 0600
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        json.dump(entries, out, indent=2)
    os.replace(tmp, file)


def get_key(user_id: str) -> str | None:
    if os.environ.get("VERITAS_ZOTERO_KEY"):
        return os.environ["VERITAS_ZOTERO_KEY"]
    if not re.fullmatch(r"\d{1,12}", str(user_id)):
        return None
    out = _system_store("get", keychain_account(user_id))
    if out is not None and out.returncode == 0 and out.stdout.strip():
        return out.stdout.strip()
    return _read_file().get(keychain_account(user_id)) or None  # kept there when no store was usable


def store_key(user_id: str, key: str) -> None:
    """Into the system's key store with the key on stdin, so it never shows in `ps`; the owner-only file when the
    system has no usable store."""
    if not re.fullmatch(r"[A-Za-z0-9]{8,64}", key):
        raise ZoteroWebError("a Zotero API key is letters and digits only")
    if not re.fullmatch(r"\d{1,12}", str(user_id)):
        raise ZoteroWebError("the Zotero user ID is a number")
    out = _system_store("set", keychain_account(user_id), key)
    if out is not None and out.returncode == 0:
        return
    if out is not None and not UNUSABLE.search(out.stderr or ""):
        store = STORE_NAMES.get(sys.platform, "the Secret Service")
        raise ZoteroWebError(f"could not save the Zotero key in {store}: {(out.stderr or '').strip()}")
    _write_file({**_read_file(), keychain_account(user_id): key})


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
                "item_type": data.get("itemType"), "collection_keys": list(data.get("collections", [])),
                "abstract": data.get("abstractNote", ""), "notes": notes, "date": data.get("date", ""),
                "venue": data.get("publicationTitle") or data.get("proceedingsTitle") or data.get("bookTitle") or "",
                "url": data.get("url", ""), "user_id": entry.get("user_id", "")}
        docs.append(AccountDoc(it["key"], data.get("title") or "(untitled)", text, tags, float(max(versions)), meta,
                               prefix=prefix))
    return docs
