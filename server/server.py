"""MCP server for agents: a thin client of the index server (kb.py serve, http_api.py).

Each agent session used to load its own copy of the index (~500 MB) and re-index on its own timer; old copies
kept running old code. Now every session asks the one server on 127.0.0.1:27182, starting it if needed, so the
index lives in memory once and is always current code (the server restarts itself when its code changes).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import paths
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from mcp.server.mcpserver import MCPServer

HOME = Path(__file__).resolve().parent
BASE = f"http://127.0.0.1:{os.environ.get('KB_PORT', '27182')}"

mcp = MCPServer("veritas", instructions=(
    "Search the user's notes (Obsidian vault and other folders) and Zotero library (papers with abstracts, "
    "the user's highlights and notes, and full text). Start with search_notes; it returns short snippets with paths. "
    "Call read_note only for results that look relevant, and pass `heading` to read one section of a long note. "
    "Sources: 'personal' (the user's own notes, trust most), 'zotero' (papers; path zotero/KEY, cite as [@citekey]), "
    "'Notion' (imported notes and braindumps), 'Clippings'/'youtube' (saved web pages and transcripts), 'ai_notes' "
    "(AI-generated research, ranked a little lower). Cite note paths, or citekeys for papers, when answering. "
    "Read only what the question needs: snippets from search often suffice; read one section rather than a whole "
    "note. Some notes are private and never returned."))


def _get(route: str, **params) -> object:
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{BASE}{route}" + (f"?{query}" if query else "")
    # Marks the request as an agent's: the server applies privacy.json (private notes hidden, size caps) and logs it.
    request = urllib.request.Request(url, headers={"X-KB-Client": "agent"})
    for attempt in range(2):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(json.load(error).get("error", str(error))) from None
        except (urllib.error.URLError, ConnectionError):
            if attempt:
                raise RuntimeError("the vault index server is not running and could not be started") from None
            _start_server()


def _start_server() -> None:
    """Starts kb.py serve in its own session (it outlives this agent) and waits for it."""
    subprocess.Popen([sys.executable, str(HOME / "kb.py"), "serve"], cwd=HOME, start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=open(paths.data_dir() / "serve.log", "a"))
    for _ in range(90):
        try:
            urllib.request.urlopen(f"{BASE}/ping", timeout=2)
            return
        except (urllib.error.URLError, ConnectionError):
            time.sleep(1)


@mcp.tool()
def search_notes(query: str, limit: int = 8, source: str | None = None, folder: str | None = None,
                 tag: str | None = None) -> list[dict]:
    """Find notes by keywords or meaning (hybrid BM25 + embedding search).

    Returns up to `limit` notes, best first, each with path, source, tags, modified date and up to two
    matching passages (heading + snippet).
    Optional filters: source ('personal', 'zotero', 'ai_notes', 'Notion', 'Clippings', 'youtube', 'People', 'copilot'),
    folder (a vault folder such as 'ai_notes/perplexity'), tag (without '#').
    """
    return _get("/search", q=query, limit=max(1, min(limit, 30)), source=source, folder=folder, tag=tag)


@mcp.tool()
def read_note(path: str, heading: str | None = None, max_chars: int = 12000, offset: int = 0) -> dict:
    """Read a note by vault-relative path or bare note name, or a Zotero paper by zotero/KEY or @citekey.
    Long notes come in pages of up to 12,000 characters: when `truncated` is true, call again with
    `offset=next_offset` only if you need more. Prefer `heading` to read one section (for papers: Abstract,
    My notes, Highlights, Full text). Notes the user marked private are not available."""
    return _get("/note", path=path, heading=heading, max_chars=max_chars, offset=offset)


@mcp.tool()
def note_links(path: str) -> dict:
    """Wikilinks out of a note and the notes that link back to it."""
    return _get("/links", path=path)


@mcp.tool()
def related_notes(path: str, limit: int = 10) -> dict:
    """Notes related to one note: its wikilinks and backlinks, notes with the most similar meaning (linked or
    not), and notes sharing its rarer tags. Use it to explore around a note found with search_notes."""
    return _get("/related", path=path, limit=max(1, min(limit, 30)))


@mcp.tool()
def recent_notes(days: int = 7, folder: str | None = None, limit: int = 50) -> list[dict]:
    """Notes modified in the last `days` days, newest first."""
    return _get("/recent", days=days, folder=folder, limit=limit)


@mcp.tool()
def index_status() -> dict:
    """Note and chunk counts per source and when the index was last updated."""
    return _get("/status")


if __name__ == "__main__":
    mcp.run()
