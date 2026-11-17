"""Owner-only per-user identity, browser-session, and Globus credential storage.

Tenant directory names are derived from the verified Globus subject; callers never
supply usernames or paths. This module performs no network I/O.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import threading
import time
from pathlib import Path

TENANT = re.compile(r"^[0-9a-f]{64}$")


def _private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)


def _read_json(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _valid_expiry(value) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def _write_json(path: Path, value: dict) -> None:
    _private_dir(path.parent)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_urlsafe(8)}.tmp")
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


class UserStore:
    def __init__(self, root: Path, sessions_file: Path, now=time.time):
        self.root = Path(root)
        self.sessions_file = Path(sessions_file)
        self.now = now
        self._session_lock = threading.Lock()
        self._tenant_lock = threading.Lock()
        self._tenant_locks: dict[str, threading.Lock] = {}
        sessions = _read_json(self.sessions_file) or {}
        self._sessions = {key: value for key, value in sessions.items()
                          if isinstance(key, str) and isinstance(value, dict)}

    @staticmethod
    def tenant_id(subject: str) -> str:
        if not isinstance(subject, str) or not subject:
            raise ValueError("Globus subject is required")
        return hashlib.sha256(subject.encode("utf-8")).hexdigest()

    @staticmethod
    def _valid_tenant(tenant: str) -> str:
        if not isinstance(tenant, str) or not TENANT.fullmatch(tenant):
            raise ValueError("invalid tenant")
        return tenant

    def _lock_for(self, tenant: str) -> threading.Lock:
        self._valid_tenant(tenant)
        with self._tenant_lock:
            return self._tenant_locks.setdefault(tenant, threading.Lock())

    @staticmethod
    def _session_hash(raw_session: str) -> str:
        return hashlib.sha256(raw_session.encode("utf-8")).hexdigest()

    def create_session(self, profile: dict, ttl: int) -> str:
        tenant = self.tenant_id(profile.get("sub"))
        raw = secrets.token_urlsafe(32)
        current = float(self.now())
        record = {
            "tenant": tenant,
            "created": current,
            "expires": current + int(ttl),
            "name": str(profile.get("name") or ""),
            "preferred_username": str(profile.get("preferred_username") or ""),
        }
        with self._session_lock:
            self._sessions = {key: value for key, value in self._sessions.items()
                              if isinstance(value.get("expires"), (int, float)) and value["expires"] > current}
            self._sessions[self._session_hash(raw)] = record
            _write_json(self.sessions_file, self._sessions)
        return raw

    def principal(self, raw_session: str) -> dict | None:
        if not isinstance(raw_session, str) or not raw_session:
            return None
        with self._session_lock:
            record = self._sessions.get(self._session_hash(raw_session))
            if not record:
                return None
            expires = record.get("expires")
            if not _valid_expiry(expires) or expires <= float(self.now()):
                return None
            tenant = record.get("tenant")
            if not isinstance(tenant, str) or not TENANT.fullmatch(tenant):
                return None
            return {
                "kind": "globus",
                "tenant": tenant,
                "name": str(record.get("name") or ""),
                "preferred_username": str(record.get("preferred_username") or ""),
            }

    def revoke_session(self, raw_session: str) -> None:
        if not isinstance(raw_session, str) or not raw_session:
            return
        with self._session_lock:
            if self._sessions.pop(self._session_hash(raw_session), None) is not None:
                _write_json(self.sessions_file, self._sessions)

    def save_profile(self, tenant: str, profile: dict) -> None:
        self._valid_tenant(tenant)
        if tenant != self.tenant_id(profile.get("sub")):
            raise ValueError("profile does not belong to tenant")
        safe = {name: str(profile.get(name) or "") for name in ("sub", "name", "preferred_username", "email")}
        _private_dir(self.root)
        with self._lock_for(tenant):
            _write_json(self.root / tenant / "identity.json", safe)

    def save_inference(self, tenant: str, token: dict) -> None:
        self._valid_tenant(tenant)
        if not isinstance(token, dict):
            raise ValueError("invalid inference token")
        required = ("access_token", "refresh_token", "resource_server", "client_id")
        if any(not isinstance(token.get(name), str) or not token[name] for name in required):
            raise ValueError("invalid inference token")
        if not _valid_expiry(token.get("expires_at")):
            raise ValueError("invalid inference expiry")
        safe = {name: token[name] for name in (*required, "expires_at")}
        _private_dir(self.root)
        with self._lock_for(tenant):
            _write_json(self.root / tenant / "globus-tokens.json", safe)

    def inference(self, tenant: str) -> dict | None:
        self._valid_tenant(tenant)
        value = _read_json(self.root / tenant / "globus-tokens.json")
        if not value or not _valid_expiry(value.get("expires_at")):
            return None
        if any(not isinstance(value.get(name), str) or not value[name]
               for name in ("access_token", "refresh_token", "resource_server", "client_id")):
            return None
        return {name: value[name] for name in
                ("access_token", "refresh_token", "resource_server", "client_id", "expires_at")}
