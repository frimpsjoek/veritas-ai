"""Server side of Second Brain AI. Three jobs: supervise the Node sidecar, proxy /agent/* to it as a stream
without holding LOCK, and write report notes under paper_notes.WRITE_LOCK. No orchestration lives here."""

from __future__ import annotations

import subprocess
from http.server import BaseHTTPRequestHandler
from pathlib import Path

SIDECAR_PORT = 27183
AGENT_PREFIX = "/agent/"


def node_binary(settings_path: str | None) -> str | None:
    """Settings path, then ~/.local/bin/node, then PATH. None means the AI is off on the server; /agent/* returns 503 with a guide."""
    raise NotImplementedError


def start_sidecar(kb_dir: Path, data_dir: Path) -> subprocess.Popen | None:
    """`node zotero-plugin/agent-src/serve.js --port 27183 --kb http://127.0.0.1:27182 --data <data_dir>`.
    Idempotent: if 27183 already answers /agent/providers with our token, adopt it instead of starting another."""
    raise NotImplementedError


def proxy_agent(handler: BaseHTTPRequestHandler, route: str, body: bytes | None) -> None:
    """Forward to the sidecar and copy the response through chunk by chunk (SSE). Never takes LOCK.
    Sets no Content-Length on streamed responses; closes when the client or the sidecar closes.
    Auth already happened in Handler (localhost trusted, else bearer token)."""
    raise NotImplementedError


def write_ai_note(title: str, front_matter: dict, body: str) -> dict:
    """POST /ai-note (localhost only, not in AGENT_ROUTES). ai_notes/Literature Reviews/<date> <title>.md,
    collision-safe name and baseline hash under paper_notes.WRITE_LOCK. Returns {"path": ...}."""
    raise NotImplementedError


def export_report(path: str, fmt: str) -> Path:
    """md → copy; docx and pdf → pandoc when present, else 501 with a plain-language message."""
    raise NotImplementedError
