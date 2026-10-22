"""Skills: user-written instructions kept in the vault, one folder per skill (spec 011 U3).

    <vault>/Second Brain/Skills/<name>/SKILL.md

The server only stores and serves the files; reading the frontmatter, hashing and the length cap belong to the
agent engine, which is what runs them. What lives here is what must not depend on the client being careful: a name
is one path segment (no separators, no `..`), a save is atomic, an oversize save is refused, and a delete moves the
folder into Skills/.trash (the indexer skips dot folders) and never removes it.
"""
from __future__ import annotations

import hashlib
import re
import shutil
import tempfile
import time
from pathlib import Path

import kb

FOLDER = "Second Brain/Skills"
FILE = "SKILL.md"
TRASH = ".trash"
MAX_BYTES = 64_000  # a skill is a prompt; the engine cuts what it sends far below this
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$")


class BadName(ValueError):
    pass


class TooLarge(ValueError):
    pass


def root() -> Path:
    return kb.VAULT / FOLDER


def check_name(name: str) -> str:
    """One folder name, nothing that could reach outside Skills/. Raises BadName."""
    if not isinstance(name, str) or not NAME.match(name) or ".." in name or name.endswith((" ", ".")):
        raise BadName("a skill name is letters, digits, spaces, '.', '_' or '-' (at most 64), with no slashes")
    return name


def _inside(path: Path) -> bool:
    """True when `path` is not a symlink and really lives under the Skills root."""
    if path.is_symlink():
        return False
    try:
        path.resolve().relative_to(root().resolve())
    except ValueError:
        return False
    return True


def _entry(folder: Path, with_text: bool) -> dict | None:
    file = folder / FILE
    if not _inside(folder) or not _inside(file) or not file.is_file():
        return None
    size = file.stat().st_size
    entry = {"name": folder.name, "size": size, "mtime": int(file.stat().st_mtime), "oversize": size > MAX_BYTES, "text": None}
    if with_text and size <= MAX_BYTES:
        data = file.read_bytes()
        entry["text"] = data.decode("utf-8", errors="replace")
        entry["hash"] = hashlib.sha256(data).hexdigest()
    return entry


def list_skills() -> list[dict]:
    base = root()
    if not base.is_dir():
        return []
    found = [_entry(f, True) for f in sorted(base.iterdir()) if f.is_dir() and not f.name.startswith(".")]
    return [e for e in found if e]


def get_skill(name: str) -> dict | None:
    folder = root() / check_name(name)
    return _entry(folder, True)


def put_skill(name: str, text: str) -> dict:
    check_name(name)
    data = text.encode("utf-8")
    if len(data) > MAX_BYTES:
        raise TooLarge(f"a skill is at most {MAX_BYTES // 1000} KB")
    folder = root() / name
    if folder.is_symlink() or (folder / FILE).is_symlink():
        raise BadName("that skill folder is a link; skills must be real folders inside Skills/")
    folder.mkdir(parents=True, exist_ok=True)
    if not _inside(folder):
        raise BadName("that skill folder is outside Skills/")
    with tempfile.NamedTemporaryFile(dir=folder, prefix=".skill-", delete=False) as tmp:
        tmp.write(data)
    Path(tmp.name).replace(folder / FILE)  # atomic: Obsidian never sees half a file
    return _entry(folder, True)


def trash_skill(name: str) -> bool:
    """Moves the folder to Skills/.trash/<name>-<time>. False when there was no such skill."""
    folder = root() / check_name(name)
    if not folder.is_dir() or not _inside(folder):
        return False
    dest = root() / TRASH / f"{name}-{time.strftime('%Y%m%dT%H%M%S')}"
    n = 1
    while dest.exists():
        dest = dest.with_name(f"{dest.name}-{n}")
        n += 1
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(folder), str(dest))
    return True
