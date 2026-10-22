"""agent_api.py: the Python server's part. It does not run agents. It supervises the Node sidecar, forwards
/agent/* to it behind the existing auth, and owns the one new write: reports into ai_notes/.
The sidecar reaches the library through the existing agent routes (X-KB-Client: agent), so privacy.json and the
audit log need no change. No stream ever holds LOCK: forwarding is byte copying on the request thread."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Sidecar:
    port: int            # 127.0.0.1 only; never exposed through tailscale serve
    secret: str          # sent by the server on every forwarded request; the sidecar rejects anything else
    node: Path


def find_node() -> Path | None:
    """Setting, then ~/.local/bin/node, then PATH. None means /agent/* answers 503 with plain-language help,
    and the Zotero plugin falls back to its own runtime."""
    raise NotImplementedError


def supervise(data_dir: Path) -> Sidecar | None:
    """Start `node agent-src/dist/agentd.mjs --port 0 --data data/agent --kb http://127.0.0.1:27182`,
    read the chosen port from its first stdout line, restart with backoff if it exits. Killed with the server."""
    raise NotImplementedError


def forward(handler, sidecar: Sidecar, method: str, path: str) -> None:
    """Called from Handler for /agent/* after _allowed(). Copies the request and streams the response back
    unbuffered (SSE stays SSE; long-poll stays long-poll). Adds no policy of its own beyond auth."""
    raise NotImplementedError


def create_ai_note(folder: str, title: str, markdown: str, review_id: str) -> dict:
    """POST /ai-note (localhost + sidecar secret only, not an agent route). Under paper_notes.WRITE_LOCK:
    if a note in `folder` already has this review_id in front matter, return it; else create
    '<folder>/YYYY-MM-DD <title>.md' with a collision-safe name. Returns {"path": vault-relative path}."""
    raise NotImplementedError
