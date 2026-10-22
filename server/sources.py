"""The folders the index reads (spec 018): a list in data/sources.json, each folder recognised by what is in it.

    {"version": 1, "folders": [{"name": "second-brain", "path": "/Users/me/Documents/Second-Brain",
                                "enabled": true, "skip": []}, ...]}

A folder holding zotero.sqlite is a Zotero library, one holding .obsidian/ is an Obsidian vault, anything else is a
plain folder of notes, PDFs and images (connectors.py). The kind is detected on every read and never stored, so a folder that gains
.obsidian/ later simply becomes a vault.

The main folder is the output folder: the listed folder marked "main": true (set_output, or KB_VAULT when seeding),
else ~/Documents/Veritas, created when first written. It keeps bare relative paths in the index and is what kb.VAULT
means, so everything that writes notes (AI notes, digests, paper notes, skills, chats) writes there. Every other
folder's paths carry a `<name>:/` prefix. Every enabled Zotero library is read: the default one ("default_library",
else the first) as zotero/KEY, the others as <name>:/zotero/KEY.

Without sources.json the list is computed in memory: KB_VAULT if set (as the output folder), then KB_ZOTERO or the
library Zotero's own prefs point at. Nothing is written until seed() or a change.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import connectors

ROOT = Path(__file__).resolve().parent
FILE = Path(os.environ.get("KB_SOURCES", ROOT / "data" / "sources.json"))
OUTPUT_DEFAULT = Path.home() / "Documents" / "Veritas"  # where notes go unless a listed vault is chosen
ZOTERO_PROFILES = Path.home() / "Library" / "Application Support" / "Zotero" / "Profiles"

NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
# Names become source labels and path prefixes: none may read as a label the index already gives.
RESERVED = {"output", "zotero", "pdf", "image", "personal", "notion", "clippings", "youtube", "people", "copilot", "home"}


class SourceError(ValueError):
    """A bad name, or a folder that cannot or must not be read."""


class DuplicateSource(SourceError):
    """That name or folder is already in the list."""


@dataclass
class Folder:
    name: str
    path: Path
    enabled: bool = True
    skip: list[str] = field(default_factory=list)
    kind: str = "plain"  # detected through connectors.REGISTRY: zotero | obsidian | pdf | plain | ... | missing
    main: bool = False  # the output folder: notes are written here
    default_library: bool = False  # the Zotero library "+ Add" goes to

    @property
    def prefix(self) -> str:
        return f"{self.name}:/"


@dataclass
class Account:
    """A source reached online instead of in a folder (kind "zotero-web": a Zotero library through the Web API)."""
    name: str
    kind: str
    user_id: str
    enabled: bool = True
    default_library: bool = False

    @property
    def prefix(self) -> str:
        return f"{self.name}:/"


@dataclass
class Layout:
    main: Path
    main_is_vault: bool
    zotero: Path | None  # the default library (the one "+ Add" and unprefixed zotero/KEY paths mean)
    others: list[Folder]  # enabled non-Zotero folders other than the main one, read with their prefix
    ignored: list[Folder]  # enabled but not read (a missing path)
    folders: list[Folder]  # every entry, as listed
    libraries: list[Folder] = field(default_factory=list)  # enabled Zotero libraries, the default first
    accounts: list[Account] = field(default_factory=list)  # enabled online sources (Zotero Web API)


def detect(path: Path) -> str:
    """The folder's kind from the connector registry (zotero, obsidian, pdf, plain, ...) or "missing"."""
    return connectors.detect(path)


def _notes(f: Folder) -> bool:
    """Read by the notes stages (an Obsidian vault, a notes folder, a PDF folder, or a registered kind like them)."""
    return connectors.indexed_as(f.kind) in ("obsidian", "plain")


def zotero_prefs() -> Path | None:
    return next(ZOTERO_PROFILES.glob("*/prefs.js"), None) if ZOTERO_PROFILES.is_dir() else None


def zotero_data_dir(prefs: Path | None) -> Path:
    """Where Zotero keeps its library: the custom data directory when Zotero is set to use one, else ~/Zotero."""
    if prefs and prefs.is_file():
        text = prefs.read_text(encoding="utf-8", errors="replace")
        use = re.search(r'user_pref\("extensions\.zotero\.useDataDir", (true|false)\)', text)
        custom = re.search(r'user_pref\("extensions\.zotero\.dataDir", "((?:[^"\\]|\\.)*)"\)', text)
        if custom and (use is None or use.group(1) == "true"):
            return Path(json.loads(f'"{custom.group(1)}"'))
    return Path.home() / "Zotero"


def discover_zotero(prefs: Path | None = None) -> Path | None:
    folder = zotero_data_dir(prefs if prefs is not None else zotero_prefs())
    return folder if (folder / "zotero.sqlite").is_file() else None


def slug(text: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:32].strip("-")
    return name or "folder"


def unique_name(base: str, taken: set[str]) -> str:
    name, n = base, 2
    while name in taken or name in RESERVED:
        name = f"{base[:28]}-{n}"
        n += 1
    return name


def check_name(name: str, taken: set[str]) -> str:
    if not NAME.match(name):
        raise SourceError("a name is 1-32 lower-case letters, digits or hyphens, starting with a letter or digit")
    if name in RESERVED:
        raise SourceError(f"{name!r} is used by the index itself; pick another name")
    if name in taken:
        raise DuplicateSource(f"there is already a folder named {name!r}")
    return name


def defaults() -> list[dict]:
    """The starting folder list: KB_VAULT (as the output folder) when set, then the Zotero library."""
    entries = []
    vault = os.environ.get("KB_VAULT")
    if vault:
        entries.append({"name": slug(Path(vault).name), "path": vault, "enabled": True, "skip": [], "main": True})
    zotero_env = os.environ.get("KB_ZOTERO")
    zotero_path = Path(zotero_env) if zotero_env else discover_zotero()
    # Only a real library: a KB_ZOTERO without zotero.sqlite would otherwise be read as a plain folder.
    if zotero_path and detect(zotero_path) == "zotero":
        entries.append({"name": "zotero", "path": str(zotero_path), "enabled": True, "skip": []})
    return entries


def load() -> list[dict] | None:
    """The stored list, or None when there is no sources.json yet."""
    if not FILE.is_file():
        return None
    data = json.loads(FILE.read_text(encoding="utf-8"))
    return list(data.get("folders", []))


def save(entries: list[dict]) -> None:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps({"version": 1, "folders": entries}, indent=2, ensure_ascii=False) + "\n"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=FILE.parent, prefix=".sources-", delete=False) as tmp:
        tmp.write(body)
    Path(tmp.name).replace(FILE)  # atomic: a reader never sees half a list


def seed() -> list[dict]:
    """Writes sources.json from today's setup if there is none; returns the stored list."""
    entries = load()
    if entries is None:
        entries = defaults()
        save(entries)
    return entries


def folders() -> list[Folder]:
    entries = load()
    entries = defaults() if entries is None else entries
    out = []
    for e in entries:
        if "path" not in e:
            continue  # an online account (accounts())
        path = Path(e["path"]).expanduser()
        out.append(Folder(e["name"], path, bool(e.get("enabled", True)), list(e.get("skip") or []), detect(path),
                          bool(e.get("main")), bool(e.get("default_library"))))
    return out


def accounts() -> list[Account]:
    entries = load() or []
    return [Account(e["name"], e.get("kind", ""), str(e.get("user_id", "")), bool(e.get("enabled", True)),
                    bool(e.get("default_library"))) for e in entries if "path" not in e]


def add_account(kind: str, user_id: str, *, key: str | None = None, name: str | None = None) -> dict:
    """Adds an online source; its API key (when given) goes to the Keychain, never to sources.json."""
    if kind != "zotero-web":
        raise SourceError(f"unknown kind of online source {kind!r}")
    if not re.fullmatch(r"\d{1,12}", str(user_id)):
        raise SourceError("the Zotero user ID is the number shown at zotero.org/settings/keys")
    entries = load()
    entries = defaults() if entries is None else entries
    taken = {e["name"] for e in entries}
    name = unique_name("zotero-online", taken) if name is None else check_name(name, taken)
    if key:
        import zotero_web
        zotero_web.store_key(str(user_id), key)
    entry = {"name": name, "kind": kind, "user_id": str(user_id), "enabled": True}
    entries.append(entry)
    save(entries)
    return entry


def resolved() -> Layout:
    listed = folders()
    enabled = [f for f in listed if f.enabled]
    ignored = [f for f in enabled if f.kind == "missing"]
    libraries = [f for f in enabled if f.kind == "zotero"]
    libraries.sort(key=lambda f: not f.default_library)  # stable: the marked one first, else list order
    # The folder marked main stays the output even without .obsidian/ (a vault never opened on this machine), so its
    # paths never change; otherwise ~/Documents/Veritas.
    vaults = [f for f in enabled if f.main and _notes(f)]
    main = vaults[0].path if vaults else OUTPUT_DEFAULT
    others = [f for f in enabled if _notes(f) and f.path.resolve() != main.resolve()]
    return Layout(main, bool(vaults), libraries[0].path if libraries else None, others, ignored, listed, libraries,
                  [a for a in accounts() if a.enabled])


def add(path: str | Path, name: str | None = None) -> Folder:
    folder = Path(path).expanduser()
    if not folder.is_absolute():
        raise SourceError("give the folder's full path")
    if not folder.is_dir() or not os.access(folder, os.R_OK | os.X_OK):
        raise SourceError(f"{folder} is not a folder this computer can read")
    # Whatever is listed becomes readable through the API (also from the phone with the token): never the whole disk,
    # the whole home folder, or anything inside a hidden folder such as ~/.ssh.
    real = folder.resolve()
    if real == Path(real.anchor) or real == Path.home().resolve() or any(part.startswith(".") for part in real.parts):
        raise SourceError(f"{folder} is too broad or hidden; pick the folder that holds your notes")
    entries = load()
    entries = defaults() if entries is None else entries
    if any(Path(e["path"]).expanduser().resolve() == real for e in entries):
        raise DuplicateSource(f"{folder} is already in the list")
    taken = {e["name"] for e in entries}
    kind = detect(folder)
    # "zotero" is reserved for the label, which is exactly what the first library should be called.
    library_name = kind == "zotero" and "zotero" not in taken
    if name is None:
        name = "zotero" if library_name else unique_name(slug(folder.name), taken)
    elif not (library_name and name == "zotero"):
        check_name(name, taken)
    entries.append({"name": name, "path": str(folder), "enabled": True, "skip": []})
    save(entries)
    return Folder(name, folder, True, [], kind)


def set_output(name: str | None) -> None:
    """Where Veritas writes notes: a listed Obsidian vault or notes folder by name, or None for ~/Documents/Veritas."""
    entries = load()
    entries = defaults() if entries is None else entries
    if name is not None:
        match = next((e for e in entries if e["name"] == name and "path" in e), None)
        if match is None:
            raise SourceError(f"there is no folder named {name!r}")
        kind = detect(Path(match["path"]).expanduser())
        if kind not in connectors.REGISTRY or not connectors.REGISTRY[kind].writes_notes:
            raise SourceError(f"{name!r} is not a notes folder; pick an Obsidian vault or a folder of notes")
    for e in entries:
        e.pop("main", None)
        if e["name"] == name:
            e["main"] = True
    save(entries)


def set_default_library(name: str) -> None:
    """The Zotero library "+ Add" goes to and unprefixed zotero/KEY paths mean."""
    entries = load()
    entries = defaults() if entries is None else entries
    match = next((e for e in entries if e["name"] == name), None)
    if match is None or detect(Path(match["path"]).expanduser()) != "zotero":
        raise SourceError(f"there is no Zotero library named {name!r}")
    for e in entries:
        e.pop("default_library", None)
    match["default_library"] = True
    save(entries)


def update(name: str, *, enabled: bool | None = None, skip: list[str] | None = None) -> None:
    entries = load()
    entries = defaults() if entries is None else entries
    for e in entries:
        if e["name"] == name:
            if enabled is not None:
                e["enabled"] = bool(enabled)
            if skip is not None:
                e["skip"] = [str(s) for s in skip]
            save(entries)
            return
    raise KeyError(name)


def remove(name: str) -> None:
    entries = load()
    entries = defaults() if entries is None else entries
    kept = [e for e in entries if e["name"] != name]
    if len(kept) == len(entries):
        raise KeyError(name)
    save(kept)
