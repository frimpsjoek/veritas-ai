"""The folders the index reads (spec 018): a list in data/sources.json, each folder recognised by what is in it.

    {"version": 1, "folders": [{"name": "second-brain", "path": "/Users/me/Documents/Second-Brain",
                                "enabled": true, "skip": []}, ...]}

A folder holding zotero.sqlite is a Zotero library, one holding .obsidian/ is an Obsidian vault, anything else is a
plain folder of notes, PDFs and images. The kind is detected on every read and never stored, so a folder that gains
.obsidian/ later simply becomes a vault.

The main folder is the vault seeded from today's setup ("main": true), else the first enabled Obsidian vault, else the
home folder (~/Second-Brain-Home). It keeps bare
relative paths in the index and is what kb.VAULT means, so everything that writes notes (AI notes, digests, paper
notes, skills) writes there. Every other folder's paths carry a `<name>:/` prefix. One Zotero library is read; a
second enabled one is reported as ignored.

Without sources.json the list is today's setup, computed in memory: KB_VAULT or ~/Documents/Second-Brain, then
KB_ZOTERO or the library Zotero's own prefs point at. Nothing is written until seed() or a change.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILE = Path(os.environ.get("KB_SOURCES", ROOT / "data" / "sources.json"))
DEFAULT_VAULT = Path.home() / "Documents" / "Second-Brain"
HOME_FOLDER = Path.home() / "Second-Brain-Home"
ZOTERO_PROFILES = Path.home() / "Library" / "Application Support" / "Zotero" / "Profiles"

NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
# Names become source labels and path prefixes: none may read as a label the index already gives.
RESERVED = {"zotero", "pdf", "image", "personal", "notion", "clippings", "youtube", "people", "copilot", "home"}


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
    kind: str = "plain"  # detected: zotero | obsidian | plain | missing
    main: bool = False  # set on the vault seeded from today's setup, so it stays the main folder as it is

    @property
    def prefix(self) -> str:
        return f"{self.name}:/"


@dataclass
class Layout:
    main: Path
    main_is_vault: bool
    zotero: Path | None
    others: list[Folder]  # enabled non-Zotero folders other than the main one, read with their prefix
    ignored: list[Folder]  # enabled but not read (a second Zotero library, a missing path)
    folders: list[Folder]  # every entry, as listed


def detect(path: Path) -> str:
    if not path.is_dir():
        return "missing"
    if (path / "zotero.sqlite").is_file():
        return "zotero"
    if (path / ".obsidian").is_dir():
        return "obsidian"
    return "plain"


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
    """Today's setup as a folder list: the vault, then the Zotero library."""
    entries = []
    vault = os.environ.get("KB_VAULT")
    vault_path = Path(vault) if vault else DEFAULT_VAULT
    if vault or vault_path.is_dir():
        entries.append({"name": slug(vault_path.name), "path": str(vault_path), "enabled": True, "skip": [],
                        "main": True})
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
        path = Path(e["path"]).expanduser()
        out.append(Folder(e["name"], path, bool(e.get("enabled", True)), list(e.get("skip") or []), detect(path),
                          bool(e.get("main"))))
    return out


def resolved() -> Layout:
    listed = folders()
    enabled = [f for f in listed if f.enabled]
    ignored = [f for f in enabled if f.kind == "missing"]
    libraries = [f for f in enabled if f.kind == "zotero"]
    ignored += libraries[1:]
    # The seeded vault stays main even without .obsidian/ (a vault never opened on this machine), so its paths
    # never change; otherwise the first Obsidian vault; otherwise the home folder.
    vaults = [f for f in enabled if f.main and f.kind in ("obsidian", "plain")] + [f for f in enabled if f.kind == "obsidian"]
    main = vaults[0].path if vaults else HOME_FOLDER
    others = [f for f in enabled if f.kind in ("obsidian", "plain") and f.path.resolve() != main.resolve()]
    return Layout(main, bool(vaults), libraries[0].path if libraries else None, others, ignored, listed)


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
