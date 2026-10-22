"""Design stub only. New server-side surface added alongside http_api.py:

GET  /agent/status                             provider status (found/signed-in/rate-limit) per configured provider
POST /agent/chat            SSE                {conversationId, text, providerId} -> AgentEvent stream (as JSON
                                                lines over SSE), proxied 1:1 from the sidecar's EmbeddedCore.chat()
POST /agent/interrupt                           {conversationId}
POST /agent/review/start                        ReviewSpec -> {id}
POST /agent/review/:id/resume
GET  /agent/review/:id/events        SSE        ReviewEvent stream
POST /agent/review/:id/cancel
GET  /agent/mcp                                 McpToolServer's JSON-RPC surface (initialize/tools/list/tools/call),
                                                 backed by the *server's own* ToolRegistry (kb.py + privacy.json) —
                                                 this is the endpoint Claude Code's --mcp-config points at when
                                                 the review or chat runs server-side.

Same rules as http_api.py: LOCK is never held across a stream (search must keep its current latency while a
chat or review is open), X-KB-Client: agent routes still go through privacy.json, stderr from the sidecar is
cleaned before any of it reaches a client (a lesson from LexImmigration's codexOutput.ts).
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Iterator


class SidecarSupervisor:
    """Owns the one Node child process that hosts @second-brain/agent-core server-side. Spawned lazily on first
    /agent/* request, restarted on crash with backoff, stdout/stderr piped and cleaned before logging. This is the
    server's half of "one JS core, no Python port" — Python here is a process manager and an HTTP/SSE front door,
    never re-implements orchestration, prompts, or the citation validator.
    """

    def __init__(self, entry_script: Path, data_dir: Path) -> None:
        raise NotImplementedError

    def ensure_running(self) -> None:
        """Idempotent: a call while already running is a no-op (per make-operations-idempotent)."""
        raise NotImplementedError

    def rpc(self, method: str, params: dict) -> dict:
        """One request/response call to the sidecar over its own internal channel (local HTTP loopback or
        stdio-JSON-RPC — an implementation detail the rest of agent_api.py does not need to know)."""
        raise NotImplementedError

    def stream(self, method: str, params: dict) -> Iterator[dict]:
        """Streaming variant backing /agent/chat and /agent/review/:id/events."""
        raise NotImplementedError

    def stop(self) -> None:
        raise NotImplementedError


def handle_agent_chat(handler, body: dict) -> None:  # noqa: ANN001 — mirrors http_api.py's Handler style
    """SSE response. Never acquires kb.LOCK; delegates to the sidecar, which owns the ConversationStore write."""
    raise NotImplementedError


def handle_agent_review_start(handler, body: dict) -> dict:  # noqa: ANN001
    raise NotImplementedError


def handle_agent_mcp(handler, body: dict) -> dict:  # noqa: ANN001
    """JSON-RPC over the server's own ToolRegistry (search_library/read_source/search_scholarly built from kb.py).
    Every returned ToolSpec carries annotations.readOnlyHint = True, unconditionally — see tools.d.ts."""
    raise NotImplementedError
