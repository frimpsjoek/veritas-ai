"""Serves the newest Zotero xpi and Obsidian build to the plugins themselves (spec 006).

Lockstep: the server only ever reports a version once BOTH a Zotero xpi (zotero/dist/second-brain-*.xpi)
and an Obsidian build (obsidian/dist-versions/<version>/{main.js,manifest.json,styles.css}) for that same
version exist. `install.sh` publishes the Obsidian side; `build.sh` publishes the Zotero side (unchanged) --
building is publishing, no separate step.

Read-only, token-checked by http_api.py the same as every other route; not in AGENT_ROUTES.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

ZOTERO_XPI_RE = re.compile(r"^second-brain-(\d+\.\d+\.\d+)\.xpi$")
OBSIDIAN_FILES = ("main.js", "manifest.json", "styles.css")


def _parse_semver(v: str) -> tuple[int, int, int] | None:
    m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", v)
    if not m:
        return None
    return tuple(int(x) for x in m.groups())  # type: ignore[return-value]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def zotero_versions(dist_dir: Path) -> dict[str, Path]:
    """version -> xpi path, for every well-formed second-brain-X.Y.Z.xpi in dist_dir."""
    out: dict[str, Path] = {}
    if not dist_dir.is_dir():
        return out
    for p in dist_dir.iterdir():
        m = ZOTERO_XPI_RE.match(p.name)
        if m and _parse_semver(m.group(1)):
            out[m.group(1)] = p
    return out


def obsidian_versions(dist_root: Path) -> dict[str, Path]:
    """version -> its directory, for every dist-versions/<version>/ that has all three files."""
    out: dict[str, Path] = {}
    if not dist_root.is_dir():
        return out
    for p in dist_root.iterdir():
        if not p.is_dir() or not _parse_semver(p.name):
            continue
        if all((p / name).is_file() for name in OBSIDIAN_FILES):
            out[p.name] = p
    return out


def lockstep_version(zotero_dist: Path, obsidian_dist_root: Path) -> str | None:
    """The highest version present as both a Zotero xpi and a complete Obsidian build, or None."""
    both = set(zotero_versions(zotero_dist)) & set(obsidian_versions(obsidian_dist_root))
    if not both:
        return None
    return max(both, key=_parse_semver)  # type: ignore[arg-type]


def latest_zotero(zotero_dist: Path, obsidian_dist_root: Path) -> dict | None:
    version = lockstep_version(zotero_dist, obsidian_dist_root)
    if version is None:
        return None
    path = zotero_versions(zotero_dist)[version]
    return {"version": version, "sha256": _sha256(path), "url": f"/plugins/zotero/xpi?version={version}",
            "filename": path.name}


def zotero_xpi_path(zotero_dist: Path, obsidian_dist_root: Path, version: str) -> Path | None:
    """The xpi for `version`, only if it is (still) the lockstep version -- refuses to serve a version that has
    fallen out of lockstep (e.g. its Obsidian build was removed) or one that was never offered."""
    if version != lockstep_version(zotero_dist, obsidian_dist_root):
        return None
    return zotero_versions(zotero_dist).get(version)


def latest_obsidian(zotero_dist: Path, obsidian_dist_root: Path) -> dict | None:
    version = lockstep_version(zotero_dist, obsidian_dist_root)
    if version is None:
        return None
    directory = obsidian_versions(obsidian_dist_root)[version]
    return {"version": version, "files": {name: _sha256(directory / name) for name in OBSIDIAN_FILES}}


def obsidian_file_path(zotero_dist: Path, obsidian_dist_root: Path, version: str, name: str) -> Path | None:
    if name not in OBSIDIAN_FILES or version != lockstep_version(zotero_dist, obsidian_dist_root):
        return None
    directory = obsidian_versions(obsidian_dist_root).get(version)
    return (directory / name) if directory else None
