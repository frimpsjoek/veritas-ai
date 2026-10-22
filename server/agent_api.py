"""agent_api.py: the Python server's part. It does not run agents. It supervises the Node sidecar (agentd,
agent/src/node/agentd.mjs), forwards /agent/* to it behind the existing auth, and owns the one new write:
reports into ai_notes/. The sidecar reaches the library through the existing agent routes (X-KB-Client: agent),
so privacy.json and the audit log need no change. No stream ever holds LOCK: forwarding is byte copying on the
request thread, and the sidecar's own long-poll (GET /agent/events) is just a slow ordinary response, not a
protocol http_api.py has to understand.

Every entry point here is defensive on purpose: `serve()` in http_api.py calls `supervise()` once at startup, and
a bug in this file must never be able to take the search server down with it.
"""
from __future__ import annotations

import http.client
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import paper_notes

AGENTD_ENTRY = Path("..") / "agent" / "dist" / "agentd.mjs"  # beside server/ in the repo; built with `cd agent && npm run build`
DEFAULT_KB_URL = "http://127.0.0.1:27182"
BACKOFF = (1, 2, 4, 8, 16, 30)  # seconds between restarts; caps and repeats at the last value
AI_NOTES_ROOT = "ai_notes"


@dataclass
class Sidecar:
    node: Path
    secret: str          # sent by the server on every forwarded request; the sidecar rejects anything else
    port: int | None = None   # None until the current process has printed its status line, or while it restarts
    proc: subprocess.Popen | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


def find_node() -> Path | None:
    """SECOND_BRAIN_NODE env, then ~/.local/bin/node, then PATH. None means /agent/* answers 503 with
    plain-language help, and the Zotero plugin falls back to its own runtime."""
    candidates = [os.environ.get("SECOND_BRAIN_NODE"), str(Path.home() / ".local" / "bin" / "node")]
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return Path(candidate)
    found = shutil.which("node")
    return Path(found) if found else None


def _agentd_entry() -> Path:
    # The production default is AGENTD_ENTRY, built by `cd zotero && ./build.sh` (or, inside agent/,
    # `npm run build`); dist/ is gitignored, same as editor-src's build output.
    # SECOND_BRAIN_AGENTD_ENTRY overrides it for pointing at a worktree build while developing agent/ itself.
    override = os.environ.get("SECOND_BRAIN_AGENTD_ENTRY")
    return Path(override) if override else Path(__file__).parent / AGENTD_ENTRY


def _spawn(sidecar: Sidecar, data_dir: Path, kb_url: str) -> subprocess.Popen | None:
    entry = _agentd_entry()
    if not entry.exists():
        return None
    env = {**os.environ, "SECOND_BRAIN_AGENTD_SECRET": sidecar.secret}
    return subprocess.Popen(
        [str(sidecar.node), str(entry), "--port", "0", "--data", str(data_dir), "--kb", kb_url],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
    )


def _supervise_loop(sidecar: Sidecar, data_dir: Path, kb_url: str) -> None:
    backoff_index = 0
    while True:
        try:
            proc = _spawn(sidecar, data_dir, kb_url)
        except Exception as error:  # never let a spawn failure kill the supervisor thread silently
            print(f"agent sidecar: failed to start: {error}", file=sys.stderr)
            proc = None
        if proc is None:
            # dist/agentd.mjs doesn't exist yet (never built, or a build is still in progress). Retrying with
            # the same backoff as a crash, instead of giving up this thread for good, means a server started
            # before `agent` was ever built picks up dist/agentd.mjs on its own once it appears, with no
            # restart required.
            delay = BACKOFF[min(backoff_index, len(BACKOFF) - 1)]
            backoff_index += 1
            time.sleep(delay)
            continue
        try:
            import json
            first_line = proc.stdout.readline() if proc.stdout else ""
            status = json.loads(first_line)
            with sidecar.lock:
                sidecar.proc, sidecar.port = proc, int(status["port"])
            backoff_index = 0  # a clean start resets the backoff
        except Exception as error:
            print(f"agent sidecar: bad status line: {error}", file=sys.stderr)
            with sidecar.lock:
                sidecar.proc, sidecar.port = proc, None
            try:
                proc.wait(timeout=5)
                # it died before announcing a port; its own words are the only clue to why
                said = (proc.stderr.read() if proc.stderr else "")[-2000:].strip()
                if said:
                    print(f"agent sidecar said: {said}", file=sys.stderr)
            except Exception:
                pass  # still running: nothing to report, wait for it below
        proc.wait()  # blocks until this generation exits
        with sidecar.lock:
            sidecar.port = None
        delay = BACKOFF[min(backoff_index, len(BACKOFF) - 1)]
        backoff_index += 1
        time.sleep(delay)


def supervise(data_dir: Path, kb_url: str = DEFAULT_KB_URL) -> Sidecar | None:
    """Start the sidecar and keep it running, restarting with backoff if it exits. Call `shutdown()` before the
    server replaces itself (os.execv), since swapping the process image doesn't stop the child on its own."""
    node = find_node()
    if node is None:
        return None
    data_dir.mkdir(parents=True, exist_ok=True)
    sidecar = Sidecar(node=node, secret=secrets.token_urlsafe(32))
    threading.Thread(target=_supervise_loop, args=(sidecar, data_dir, kb_url), daemon=True).start()
    return sidecar


def shutdown(sidecar: Sidecar | None) -> None:
    if sidecar is None:
        return
    with sidecar.lock:
        proc = sidecar.proc
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()


def _missing_node_help() -> str:
    return ("Second Brain AI needs Node.js. Install it (e.g. `brew install node`) or set SECOND_BRAIN_NODE to "
            "the node binary, then restart the server. The rest of the search server is unaffected.")


def forward(handler, sidecar: Sidecar | None, method: str, path: str) -> None:
    """Called from Handler for /agent/* after _allowed(). `path` is what follows the `/agent` prefix (e.g.
    "/events?after=5"). Copies the request and returns the sidecar's response verbatim: no policy of its own
    beyond auth, and it never touches LOCK or WRITE_LOCK."""
    if sidecar is None:
        handler._send(503, {"error": "second brain ai is unavailable", "help": _missing_node_help()})
        return
    with sidecar.lock:
        port = sidecar.port
    if port is None:
        handler._send(503, {"error": "the agent sidecar is (re)starting", "help": "try again in a few seconds"})
        return

    length = int(handler.headers.get("Content-Length") or 0)
    body = handler.rfile.read(length) if length else b""
    # Long-polls return within 25s; a blocking send or ask lasts as long as the model takes.
    timeout = 30 if (path or "").startswith("/events") else 900
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(method, path or "/", body=body, headers={
            "Authorization": f"Bearer {sidecar.secret}",
            "Content-Type": handler.headers.get("Content-Type", "application/json"),
        })
        response = conn.getresponse()
        data = response.read()
        status, content_type = response.status, response.getheader("Content-Type", "application/json")
    except (OSError, TimeoutError) as error:
        handler._send(503, {"error": f"the agent sidecar did not respond: {error}"})
        return
    finally:
        conn.close()

    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def _sanitize_title(title: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]', "-", title).strip()
    return cleaned or "Untitled"


def _review_id_pattern(review_id: str) -> "re.Pattern[str]":
    return re.compile(rf'^review_id:\s*"?{re.escape(review_id)}"?\s*$', re.M)


def _existing_by_review_id(folder: Path, review_id: str) -> Path | None:
    if not folder.is_dir():
        return None
    pattern = _review_id_pattern(review_id)
    for candidate in sorted(folder.glob("*.md")):
        try:
            head = candidate.read_text(encoding="utf-8", errors="ignore")[:2000]
        except OSError:
            continue
        if pattern.search(head):
            return candidate
    return None


def _yaml_value(value) -> str:
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(paper_notes._yaml(v) for v in value) + "]"
    return paper_notes._yaml(value)


def create_ai_note(folder: str, title: str, markdown: str, review_id: str, front_matter: dict | None = None) -> dict:
    """POST /ai-note (localhost + sidecar secret only; deliberately not one of AGENT_ROUTES, so an agent process
    can never call it). Under paper_notes.WRITE_LOCK: if a note in `folder` already carries this review_id in
    front matter, return it unchanged; else create '<folder>/YYYY-MM-DD <title>.md' with a collision-safe name.
    `front_matter` (question, scope, model, sources, from report.js's renderReport) is merged in after the
    fields this function itself owns (type, title, review_id, created), which always take precedence."""
    import kb  # imported lazily: agent_api must be importable stand-alone for its own tests

    vault = kb.VAULT.resolve()
    target_dir = (vault / folder).resolve()
    if not (target_dir == vault / AI_NOTES_ROOT or str(target_dir).startswith(str(vault / AI_NOTES_ROOT) + os.sep)):
        raise PermissionError("ai notes may only be written under ai_notes/")

    with paper_notes.WRITE_LOCK:
        existing = _existing_by_review_id(target_dir, review_id)
        if existing is not None:
            return {"path": str(existing.relative_to(vault))}

        target_dir.mkdir(parents=True, exist_ok=True)
        base_name = f"{time.strftime('%Y-%m-%d')} {_sanitize_title(title)}"
        path = target_dir / f"{base_name}.md"
        n = 2
        while path.exists():
            path = target_dir / f"{base_name} {n}.md"
            n += 1
        fields = {
            "type": "literature-review",
            "title": title,
            "review_id": review_id,
            "created": time.strftime("%Y-%m-%d"),
            **{k: v for k, v in (front_matter or {}).items() if k not in ("type", "title", "review_id", "created")},
        }
        lines = ["---", *(f"{k}: {_yaml_value(v)}" for k, v in fields.items()), "---", ""]
        path.write_text("\n".join(lines) + "\n" + markdown, encoding="utf-8")
        return {"path": str(path.relative_to(vault))}
