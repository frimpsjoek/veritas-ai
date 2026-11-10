"""Which saved chats name a Zotero item whose attachment text the guard rejects (spec 026 R22).

A chat that read such an item's full text (the agent's `read_source` -> `/note?path=zotero/KEY`, or the MCP
`read_note`) may hold a quote of a foreign, possibly private, document in its answer. The chat store keeps two
forms: JSONL under <data>/agent/chats (every record: user text, the assistant's answer with its citations and
passages) and a Markdown mirror in the notes folder (user and assistant text only; `agent/src/chat-markdown.js`).
Neither form records tool calls as such, so this looks for the item's key anywhere in a record: as a path
`zotero/KEY`, a citation `[@KEY]` (the agent's citekey is the Zotero key: `agent/src/library-http.js`), or a
`citekey` field. It prints paths and counts only, never a line of a chat.

Claude Code and Claude Desktop keep full transcripts, tool results included, so there a `search_notes` result naming
`zotero/KEY` is found too. What it cannot tell: Veritas's own chats do not store a search snippet unless the answer
cites the item, so a Veritas chat that saw a snippet and did not cite the key is not listed. A listed file names the
key; whether it holds the foreign text itself takes a person opening it.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import paths

KEY = r"[A-Z0-9]{8}"
MENTION = re.compile(rf"zotero/({KEY})\b|\[@({KEY})\]|\"citekey\":\s*\"({KEY})\"")


def mentions(text: str) -> set[str]:
    """Every Zotero item key a chat's text names, in any of the three forms."""
    return {next(g for g in m.groups() if g) for m in MENTION.finditer(text)}


def scan_file(path: Path, foreign: set[str]) -> dict | None:
    """{path, keys, records} when the file names a foreign key: `records` counts the JSONL records that do (1 for a
    Markdown mirror). None when it does not. Carries no text."""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if path.suffix == ".jsonl":
        hits: set[str] = set()
        records = 0
        for line in raw.splitlines():
            if not line.strip():
                continue
            found = mentions(line) & foreign
            if found:
                hits |= found
                records += 1
        return {"path": str(path), "keys": sorted(hits), "records": records} if hits else None
    found = mentions(raw) & foreign
    return {"path": str(path), "keys": sorted(found), "records": 1} if found else None


def scan(folders: list[Path], foreign: set[str]) -> list[dict]:
    """Every chat file (JSONL or .md) under `folders` that names a foreign key, sorted by path."""
    out = []
    for folder in folders:
        if not folder.is_dir():
            continue
        for file in sorted(folder.rglob("*")):
            if file.suffix in (".jsonl", ".md") and file.is_file():
                hit = scan_file(file, foreign)
                if hit:
                    out.append(hit)
    return out


def default_folders() -> list[Path]:
    import kb

    folders = [paths.data_dir() / "agent" / "chats"]
    vault = getattr(kb, "VAULT", None)
    if vault:
        folders.append(Path(vault) / "chats")
    home = Path.home()
    folders += [home / ".claude" / "projects",  # Claude Code: full transcripts, tool results included
                home / "Library" / "Application Support" / "Claude" / "claude-code-sessions",
                home / "Library" / "Application Support" / "Claude" / "local-agent-mode-sessions"]
    return folders


def foreign_keys() -> set[str]:
    """Item keys with at least one attachment the guard rejects (foreign or unknown), from `zotero.audit_text()`."""
    import zotero

    return {row["item"] for row in zotero.audit_text() if row["decision"] in ("foreign", "unknown")}


def cli(folders: list[str], keys_file: str | None) -> None:
    if keys_file:
        foreign = {line.strip() for line in Path(keys_file).read_text().splitlines() if line.strip()}
    else:
        foreign = foreign_keys()
    where = [Path(f).expanduser() for f in folders] or default_folders()
    hits = scan(where, foreign)
    for hit in hits:
        print(f"{hit['path']}\t{len(hit['keys'])} foreign key(s): {' '.join(hit['keys'])}\t{hit['records']} record(s)")
    scanned = sum(1 for folder in where if folder.is_dir() for f in folder.rglob("*") if f.suffix in (".jsonl", ".md"))
    print(f"audit-chats: {len(hits)} of {scanned} chat files in {', '.join(str(f) for f in where)} name one of "
          f"{len(foreign)} foreign item keys", file=sys.stderr)
