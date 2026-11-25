"""A2A 0.3.0 discovery and JSON-RPC message/send over the existing Ask sidecar.

The public card contains no credentials. Calls use a dedicated token, never the browser
credential or a loopback exception; http_api owns that authentication gate.
"""
from __future__ import annotations

import hmac
import ipaddress
import math
import os
import secrets
import sys
import threading
import uuid
from urllib.parse import urlsplit

import agent_api
import kb

TOKEN_FILE = kb.data_dir() / "a2a-token"
MAX_QUESTION_CHARS = 200_000
MAX_BODY_BYTES = MAX_QUESTION_CHARS + 65_536
PROVIDED_SOURCES_EXTENSION = "https://trinityscience.org/extensions/veritas/provided-sources/v1"
MAX_PROVIDED_SOURCES = 16
MAX_SOURCE_TITLE_CHARS = 512
MAX_SOURCE_TEXT_CHARS = 16_384
MAX_TOTAL_SOURCE_TEXT_CHARS = 128_000
MAX_SOURCE_CITATION_CHARS = 4_096
MAX_SOURCE_URI_CHARS = 2_048
_SOURCE_FIELDS = {"title", "text", "citation", "uri"}
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
        try:
            fd = os.open(TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            os.chmod(TOKEN_FILE, 0o600)
            return token()
        with os.fdopen(fd, "w") as handle:
            handle.write(value)
        return value


def authorized(headers) -> bool:
    scheme, _, sent = (headers.get("Authorization") or "").partition(" ")
    expected = token()
    return (scheme.lower() == "bearer" and bool(sent.strip()) and bool(expected)
            and hmac.compare_digest(sent.strip().encode(), expected.encode()))


def provided_sources_enabled() -> bool:
    """Personal evidence synthesis is a separate, default-off rollout decision."""
    return os.environ.get("VERITAS_A2A_PROVIDED_SOURCES_ENABLED") == "1"


def provided_sources_requested(headers) -> bool:
    """A2A extension activation uses complete, case-sensitive URI tokens."""
    values = headers.get_all("X-A2A-Extensions") if hasattr(headers, "get_all") else [headers.get("X-A2A-Extensions")]
    tokens = [token for value in values or [] for token in (value or "").split(",")]
    return any(token.strip() == PROVIDED_SOURCES_EXTENSION for token in tokens if token.strip())


def _provided_response_headers() -> dict:
    return {
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "X-A2A-Extensions": PROVIDED_SOURCES_EXTENSION,
    }


def agent_card() -> dict:
    """Public A2A discovery; /a2a resolves against this card's published URL."""
    card = {
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
    if provided_sources_enabled():
        card["capabilities"]["extensions"] = [{
            "uri": PROVIDED_SOURCES_EXTENSION,
            "description": "Answer only from bounded caller-supplied evidence, with no Veritas retrieval.",
            "required": False,
        }]
    return card


def valid_request_id(value) -> bool:
    if value is None:
        return True
    if isinstance(value, bool):
        return False
    if isinstance(value, float):
        return math.isfinite(value)
    return isinstance(value, (str, int))


def reply_error(handler, request_id, code: int, message: str, headers: dict | None = None) -> None:
    body = {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
    if headers is None:
        handler._send(200, body)
    else:
        handler._send(200, body, headers)


def _source_text(source: dict, field: str, cap: int, *, required: bool) -> str:
    value = source.get(field)
    if not isinstance(value, str):
        if required or field in source:
            raise RpcError(-32602, "Invalid params")
        return ""
    value = value.strip()
    if (required and not value) or len(value) > cap:
        raise RpcError(-32602, "Invalid params")
    return value


def parse_provided_sources(data) -> list[dict]:
    """Validate the complete evidence envelope without incorporating values into errors."""
    if not isinstance(data, dict) or set(data) != {"sources"}:
        raise RpcError(-32602, "Invalid params")
    sources = data["sources"]
    if not isinstance(sources, list) or not 1 <= len(sources) <= MAX_PROVIDED_SOURCES:
        raise RpcError(-32602, "Invalid params")
    normalized = []
    total_text = 0
    for source in sources:
        if not isinstance(source, dict) or not set(source) <= _SOURCE_FIELDS:
            raise RpcError(-32602, "Invalid params")
        title = _source_text(source, "title", MAX_SOURCE_TITLE_CHARS, required=True)
        text = _source_text(source, "text", MAX_SOURCE_TEXT_CHARS, required=True)
        citation = _source_text(source, "citation", MAX_SOURCE_CITATION_CHARS, required=False)
        raw_uri = source.get("uri")
        if isinstance(raw_uri, str) and any(ord(character) < 32 or ord(character) == 127 for character in raw_uri):
            raise RpcError(-32602, "Invalid params")
        uri = _source_text(source, "uri", MAX_SOURCE_URI_CHARS, required=False)
        if uri:
            try:
                parsed = urlsplit(uri)
                hostname = parsed.hostname
                parsed.port
                if hostname and ("[" in parsed.netloc or "]" in parsed.netloc):
                    ipaddress.IPv6Address(hostname)
                elif hostname:
                    final_label = hostname.rstrip(".").rsplit(".", 1)[-1].lower()
                    numeric = final_label.isascii() and final_label.isdigit()
                    hexadecimal = final_label.startswith("0x") and all(
                        character in "0123456789abcdef" for character in final_label[2:])
                    if numeric or hexadecimal:
                        ipaddress.IPv4Address(hostname)
            except ValueError:
                raise RpcError(-32602, "Invalid params") from None
            if (parsed.scheme.lower() not in {"http", "https"} or not hostname or "%" in hostname
                    or any(character.isspace() for character in hostname)
                    or any(ord(character) < 32 or ord(character) == 127 for character in uri)):
                raise RpcError(-32602, "Invalid params")
        total_text += len(text)
        if total_text > MAX_TOTAL_SOURCE_TEXT_CHARS:
            raise RpcError(-32602, "Invalid params")
        item = {"title": title, "text": text}
        if citation:
            item["citation"] = citation
        if uri:
            item["uri"] = uri
        normalized.append(item)
    return normalized


def parse_message(params, *, provided_sources: bool = False) -> tuple[str, str, list[dict] | None]:
    """Extract legacy text or one explicitly activated evidence envelope."""
    if not isinstance(params, dict) or not isinstance(params.get("message"), dict):
        raise RpcError(-32602, "Invalid params")
    message = params["message"]
    if message.get("role", "user") != "user" or message.get("kind", "message") != "message":
        raise RpcError(-32602, "Invalid params")
    parts = message.get("parts")
    if not isinstance(parts, list) or not parts:
        raise RpcError(-32602, "Invalid params")
    if provided_sources:
        if (len(parts) != 2 or any(not isinstance(part, dict) for part in parts)
                or [part.get("kind") for part in parts].count("text") != 1
                or [part.get("kind") for part in parts].count("data") != 1):
            raise RpcError(-32602, "Invalid params")
        text_part = next(part for part in parts if part.get("kind") == "text")
        data_part = next(part for part in parts if part.get("kind") == "data")
        if not isinstance(text_part.get("text"), str):
            raise RpcError(-32602, "Invalid params")
        texts = [text_part["text"]]
        sources = parse_provided_sources(data_part.get("data"))
    else:
        texts = []
        sources = None
        for part in parts:
            if not isinstance(part, dict) or part.get("kind") != "text" or not isinstance(part.get("text"), str):
                raise RpcError(-32602, "Invalid params")
            texts.append(part["text"])
    question = "\n\n".join(texts).strip()
    if not question or len(question) > MAX_QUESTION_CHARS:
        raise RpcError(-32602, "Invalid params")
    context_id = message.get("contextId") if isinstance(message.get("contextId"), str) else ""
    return question, context_id, sources


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


def answer_status(events: list[dict]) -> str:
    for event in reversed(events):
        if not isinstance(event, dict) or event.get("type") != "done":
            continue
        answer = event.get("answer")
        structured = answer.get("structured") if isinstance(answer, dict) else None
        if isinstance(structured, dict) and structured.get("status") in {"answered", "not_found"}:
            return structured["status"]
        return "answered"
    return "answered"


def message_send(handler, sidecar) -> None:
    """Validate one bounded JSON-RPC message/send and invoke the stateless Ask runtime."""
    request_id = None
    requested = provided_sources_requested(handler.headers)
    error_headers = _provided_response_headers() if requested else None
    raw_length = handler.headers.get("Content-Length")
    try:
        length = int(raw_length) if raw_length is not None and raw_length.isascii() and raw_length.isdigit() else -1
    except ValueError:  # absurd digit strings can exceed CPython's integer conversion limit
        length = -1
    if length < 0 or length > MAX_BODY_BYTES:
        handler.close_connection = True  # an invalid or oversized body was deliberately not consumed
        return reply_error(handler, None, -32600, "Invalid Request", error_headers)
    try:
        body = handler._body(limit=MAX_BODY_BYTES)
    except (ValueError, RecursionError):
        return reply_error(handler, None, -32700, "Parse error", error_headers)
    if not isinstance(body, dict):
        return reply_error(handler, None, -32600, "Invalid Request", error_headers)
    if valid_request_id(body.get("id")):
        request_id = body.get("id")
    if body.get("jsonrpc") != "2.0" or "id" not in body or not valid_request_id(body.get("id")):
        return reply_error(handler, request_id, -32600, "Invalid Request", error_headers)
    if body.get("method") != "message/send":
        return reply_error(handler, request_id, -32601, "Method not found", error_headers)
    provided = requested and provided_sources_enabled()
    if requested and not provided:
        return reply_error(handler, request_id, -32602, "Invalid params", error_headers)
    try:
        question, context_id, sources = parse_message(body.get("params"), provided_sources=provided)
        events = (agent_api.ask(sidecar, question, provided_sources=sources) if provided
                  else agent_api.ask(sidecar, question))
        text = answer_text(events)
    except RpcError as error:
        return reply_error(handler, request_id, error.code, str(error), error_headers)
    except Exception as error:
        detail = type(error).__name__ if provided else f"{type(error).__name__}: {error}"
        print(f"A2A request failed: {detail}", file=sys.stderr, flush=True)
        return reply_error(handler, request_id, -32603, "Veritas could not complete the request", error_headers)
    result = {
        "role": "agent",
        "kind": "message",
        "messageId": uuid.uuid4().hex,
        "parts": [{"kind": "text", "text": text}],
    }
    if context_id:
        result["contextId"] = context_id
    response = {"jsonrpc": "2.0", "id": request_id, "result": result}
    if not provided:
        handler._send(200, response)
        return
    result["extensions"] = [PROVIDED_SOURCES_EXTENSION]
    result["metadata"] = {PROVIDED_SOURCES_EXTENSION: {
        "status": answer_status(events),
        "sources": [{
            "id": f"S{index}",
            **{field: value for field, value in source.items() if field != "text"},
        } for index, source in enumerate(sources, start=1)],
    }}
    handler._send(200, response, _provided_response_headers())
