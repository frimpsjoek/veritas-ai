"""A2A 0.3.0 discovery and JSON-RPC message/send over the existing Ask sidecar.

The public card contains no credentials. Calls use a dedicated token, never the browser
credential or a loopback exception; http_api owns that authentication gate.
"""
from __future__ import annotations

import hmac
import os
import secrets
import sys
import threading
import uuid

import agent_api
import kb

TOKEN_FILE = kb.data_dir() / "a2a-token"
MAX_QUESTION_CHARS = 200_000
MAX_BODY_BYTES = MAX_QUESTION_CHARS + 65_536
_TOKEN_LOCK = threading.Lock()


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def token() -> str:
    """Read without creating: deletion is revocation until the next service start."""
    try:
        return TOKEN_FILE.read_text().strip()
    except OSError:
        return ""


def ensure_token() -> str:
    """Create the A2A-only credential at service startup with mode 0600."""
    with _TOKEN_LOCK:
        existing = token()
        if TOKEN_FILE.exists():
            os.chmod(TOKEN_FILE, 0o600)
            return existing
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        value = secrets.token_urlsafe(32)
        fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(value)
        return value


def authorized(headers) -> bool:
    scheme, _, sent = (headers.get("Authorization") or "").partition(" ")
    expected = token()
    return (scheme.lower() == "bearer" and bool(sent.strip()) and bool(expected)
            and hmac.compare_digest(sent.strip().encode(), expected.encode()))


def agent_card() -> dict:
    """Public A2A discovery; /a2a resolves against this card's published URL."""
    return {
        "protocolVersion": "0.3.0",
        "name": "Veritas",
        "description": "Library-grounded research question answering over Veritas notes and papers.",
        "version": "1.0.0",
        "url": "/a2a",
        "preferredTransport": "JSONRPC",
        "provider": {"organization": "Veritas", "url": "https://github.com/frimpsjoek/veritas-ai"},
        "capabilities": {"streaming": False, "pushNotifications": False},
        "securitySchemes": {"veritasBearer": {"type": "http", "scheme": "bearer"}},
        "security": [{"veritasBearer": []}],
        "skills": [{
            "id": "library-question-answering",
            "name": "Library question answering",
            "description": "Answer research questions using the user's Veritas notes and papers.",
            "tags": ["knowledge-base", "literature-search", "citations"],
        }],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/markdown"],
        "x-trinity": {"id": "veritas", "domains": ["research-knowledge", "literature-search"]},
    }


def valid_request_id(value) -> bool:
    return value is None or (isinstance(value, (str, int)) and not isinstance(value, bool))


def reply_error(handler, request_id, code: int, message: str) -> None:
    handler._send(200, {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def parse_message(params) -> tuple[str, str]:
    """Extract only text from a message; extra A2A fields are forward-compatible."""
    if not isinstance(params, dict) or not isinstance(params.get("message"), dict):
        raise RpcError(-32602, "Invalid params")
    message = params["message"]
    if message.get("role", "user") != "user" or message.get("kind", "message") != "message":
        raise RpcError(-32602, "Invalid params")
    parts = message.get("parts")
    if not isinstance(parts, list) or not parts:
        raise RpcError(-32602, "Invalid params")
    texts = []
    for part in parts:
        if not isinstance(part, dict) or part.get("kind") != "text" or not isinstance(part.get("text"), str):
            raise RpcError(-32602, "Invalid params")
        texts.append(part["text"])
    question = "\n\n".join(texts).strip()
    if not question or len(question) > MAX_QUESTION_CHARS:
        raise RpcError(-32602, "Invalid params")
    context_id = message.get("contextId") if isinstance(message.get("contextId"), str) else ""
    return question, context_id


def answer_text(events: list[dict]) -> str:
    if any(isinstance(event, dict) and event.get("type") == "failed" for event in events):
        raise RpcError(-32603, "Veritas could not complete the request")
    for event in reversed(events):
        if not isinstance(event, dict) or event.get("type") != "done":
            continue
        answer = event.get("answer")
        if not isinstance(answer, dict):
            continue
        structured = answer.get("structured")
        markdown = structured.get("markdown") if isinstance(structured, dict) else None
        for value in (markdown, answer.get("text")):
            if isinstance(value, str) and value.strip():
                return value.strip()
    raise RpcError(-32603, "Veritas could not complete the request")


def message_send(handler, sidecar) -> None:
    """Validate one bounded JSON-RPC message/send and invoke the stateless Ask runtime."""
    request_id = None
    raw_length = handler.headers.get("Content-Length")
    try:
        length = int(raw_length) if raw_length is not None and raw_length.isascii() and raw_length.isdigit() else -1
    except ValueError:  # absurd digit strings can exceed CPython's integer conversion limit
        length = -1
    if length < 0 or length > MAX_BODY_BYTES:
        handler.close_connection = True  # an invalid or oversized body was deliberately not consumed
        return reply_error(handler, None, -32600, "Invalid Request")
    try:
        body = handler._body(limit=MAX_BODY_BYTES)
    except ValueError:
        return reply_error(handler, None, -32700, "Parse error")
    if not isinstance(body, dict):
        return reply_error(handler, None, -32600, "Invalid Request")
    if valid_request_id(body.get("id")):
        request_id = body.get("id")
    if body.get("jsonrpc") != "2.0" or "id" not in body or not valid_request_id(body.get("id")):
        return reply_error(handler, request_id, -32600, "Invalid Request")
    if body.get("method") != "message/send":
        return reply_error(handler, request_id, -32601, "Method not found")
    try:
        question, context_id = parse_message(body.get("params"))
        events = agent_api.ask(sidecar, question)
        text = answer_text(events)
    except RpcError as error:
        return reply_error(handler, request_id, error.code, str(error))
    except Exception as error:
        print(f"A2A request failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return reply_error(handler, request_id, -32603, "Veritas could not complete the request")
    result = {
        "role": "agent",
        "kind": "message",
        "messageId": uuid.uuid4().hex,
        "parts": [{"kind": "text", "text": text}],
    }
    if context_id:
        result["contextId"] = context_id
    handler._send(200, {"jsonrpc": "2.0", "id": request_id, "result": result})
