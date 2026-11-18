"""Tenant-scoped Zotero WebDAV credentials, durable immutable blobs, and quotas.

The Zotero data/metadata service remains zotero.org. This module only owns personal
WebDAV attachments. Immutable object IDs, a reservation journal, and a separate
garbage journal make crashes recoverable without exposing partially uploaded data.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import os
import re
import secrets
import sqlite3
import stat
import sys
import threading
import time
import uuid
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO
from urllib.parse import urlsplit

import fcntl

from user_store import TENANT

DEFAULT_POOL_BYTES = 50 * 1024**3
DEFAULT_USER_BYTES = 5 * 1024**3
SQLITE_MAX = 2**63 - 1
NAME = re.compile(r"^[A-Za-z0-9_-]{1,120}\.(?:zip|prop)$")
IDENTIFIER = re.compile(r"^[0-9a-f]{32}$")
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
CHUNK = 64 * 1024
MAX_FILES = 10_000  # Also bounds per-tenant PROPFIND and metadata work when blobs are tiny/empty.


class StorageError(RuntimeError):
    """A credential-free storage failure."""


class StorageDisabled(StorageError):
    """The operator has not supplied a valid public HTTPS configuration."""


class StorageBusy(StorageError):
    """Another Veritas process owns this attachment ledger."""


class StorageCorrupt(StorageError):
    """A tracked blob or private storage directory is inconsistent."""


class InvalidResource(StorageError, ValueError):
    """A potentially unsafe tenant/resource identifier."""


class QuotaExceeded(StorageError):
    def __init__(self, scope: str):
        super().__init__(f"{scope} attachment quota exceeded")
        self.scope = scope


class ShortBody(StorageError):
    """The request stream ended before its declared Content-Length."""


class UploadBusy(StorageError):
    """No per-tenant or global upload permit is currently available."""


@dataclass(frozen=True)
class PublicConfig:
    base: str | None
    pool_bytes: int = DEFAULT_POOL_BYTES
    user_bytes: int = DEFAULT_USER_BYTES
    read_timeout_seconds: float = 60.0
    pbkdf2_iterations: int = 200_000

    def __post_init__(self) -> None:
        object.__setattr__(self, "pool_bytes", self._positive(self.pool_bytes, "pool quota"))
        object.__setattr__(self, "user_bytes", self._positive(self.user_bytes, "user quota"))
        if (isinstance(self.read_timeout_seconds, bool)
                or not isinstance(self.read_timeout_seconds, (int, float))
                or not 0 < self.read_timeout_seconds <= 3600):
            raise ValueError("upload read timeout must be between 0 and 3600 seconds")
        if (isinstance(self.pbkdf2_iterations, bool) or not isinstance(self.pbkdf2_iterations, int)
                or not 1 <= self.pbkdf2_iterations <= 10_000_000):
            raise ValueError("PBKDF2 iterations must be between 1 and 10000000")

    @staticmethod
    def _positive(value, label: str) -> int:
        if isinstance(value, bool):
            raise ValueError(f"{label} must be a positive integer")
        if isinstance(value, str):
            if not value.isascii() or not value.isdigit() or len(value) > 19:
                raise ValueError(f"{label} must be a positive integer")
            value = int(value)
        if not isinstance(value, int) or not 0 < value <= SQLITE_MAX:
            raise ValueError(f"{label} must be a positive SQLite integer")
        return value

    def _url(self):
        if not isinstance(self.base, str):
            raise StorageDisabled("Zotero WebDAV is not configured")
        try:
            parsed = urlsplit(self.base)
            valid = (parsed.scheme == "https" and parsed.hostname is not None
                     and parsed.path == "/webdav" and not parsed.query and not parsed.fragment
                     and parsed.username is None and parsed.password is None)
            if not valid or parsed.port == 0:
                raise ValueError
        except (TypeError, ValueError):
            raise StorageDisabled("Zotero WebDAV requires a canonical HTTPS /webdav URL") from None
        return parsed

    @property
    def enabled(self) -> bool:
        try:
            self._url()
            return True
        except StorageDisabled:
            return False

    @property
    def host(self) -> str:
        return self._url().netloc.lower()

    def require_enabled(self) -> "PublicConfig":
        self._url()
        return self


@dataclass(frozen=True)
class Reservation:
    id: str
    tenant: str
    name: str
    object_id: str
    size: int


@dataclass(frozen=True)
class Attachment:
    """An open immutable blob plus its protocol metadata."""

    file: BinaryIO
    size: int
    sha256: str
    modified: int

    def read(self, *args, **kwargs):
        return self.file.read(*args, **kwargs)

    def close(self) -> None:
        self.file.close()

    def __enter__(self) -> "Attachment":
        return self

    def __exit__(self, *_args) -> None:
        self.close()


def public_config_from_environment() -> PublicConfig:
    return PublicConfig(
        os.environ.get("VERITAS_WEBDAV_PUBLIC_URL"),
        pool_bytes=os.environ.get("VERITAS_ZOTERO_STORAGE_BYTES", str(DEFAULT_POOL_BYTES)),
        user_bytes=os.environ.get("VERITAS_ZOTERO_USER_QUOTA_BYTES", str(DEFAULT_USER_BYTES)))


def trusted_transport(headers, peer: str, config: PublicConfig) -> bool:
    """Accept Basic credentials only from loopback development or the canonical HTTPS edge."""
    try:
        if not ipaddress.ip_address(peer).is_loopback:
            return False
    except ValueError:
        return False
    named = {str(name).lower() for name in headers.keys()}
    proxied = any(name.startswith(("x-forwarded-", "tailscale-", "forwarded")) for name in named)
    host = (headers.get("Host") or "").lower()
    if not proxied and host.rsplit(":", 1)[0] in {"127.0.0.1", "localhost"}:
        return True
    values = headers.get_all("X-Forwarded-Proto", []) if hasattr(headers, "get_all") else [
        headers.get("X-Forwarded-Proto")] if headers.get("X-Forwarded-Proto") is not None else []
    return len(values) == 1 and values[0].strip().lower() == "https" and "," not in values[0] and host == config.host


class StorageService:
    def __init__(self, users_root: Path, ledger_path: Path, config: PublicConfig, *, recover: bool = True):
        self.config = config.require_enabled()
        self.users_root = Path(users_root)
        self.ledger_path = Path(ledger_path)
        self._dir_lock = threading.Lock()
        self._claim_lock = threading.Lock()
        self._opening_claims: dict[str, int] = {}
        self._retiring_ids: set[str] = set()
        self._upload_global = threading.BoundedSemaphore(8)
        self._upload_tenants: dict[str, tuple[threading.BoundedSemaphore, int]] = {}
        self._closed = False
        self._lock_fd = None
        self._users_fd = None
        try:
            self._open_roots_and_lock()
            self._initialize_database()
            if recover:
                self._recover()
        except BaseException:
            self.close()
            raise

    def _open_roots_and_lock(self) -> None:
        self.users_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.ledger_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._users_fd = os.open(self.users_root, DIRECTORY_FLAGS)
        os.fchmod(self._users_fd, 0o700)
        data_fd = os.open(self.ledger_path.parent, DIRECTORY_FLAGS)
        try:
            os.fchmod(data_fd, 0o700)
            for name in (self.ledger_path.name,):
                fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=data_fd)
                os.fchmod(fd, 0o600)
                os.close(fd)
            self._lock_fd = os.open(self.ledger_path.name + ".lock",
                                    os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=data_fd)
            os.fchmod(self._lock_fd, 0o600)
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise StorageBusy("another Veritas process owns Zotero WebDAV storage") from None
        finally:
            os.close(data_fd)

    def _connect(self):
        db = sqlite3.connect(self.ledger_path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=30000")
        db.execute("PRAGMA synchronous=FULL")
        if db.execute("PRAGMA synchronous").fetchone()[0] != 2:
            db.close()
            raise StorageError("Zotero WebDAV ledger requires FULL synchronous commits")
        return db

    def _initialize_database(self) -> None:
        with closing(self._connect()) as db:
            journal = db.execute("PRAGMA journal_mode=WAL").fetchone()[0]
            if str(journal).lower() != "wal":
                raise StorageError("Zotero WebDAV ledger requires local SQLite WAL support")
            db.execute("PRAGMA synchronous=FULL")
            db.executescript("""
            CREATE TABLE IF NOT EXISTS credentials (
              tenant TEXT PRIMARY KEY CHECK(length(tenant)=64), username TEXT UNIQUE NOT NULL,
              salt BLOB NOT NULL, verifier BLOB NOT NULL, iterations INTEGER NOT NULL, created INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS files (
              tenant TEXT NOT NULL, name TEXT NOT NULL, object_id TEXT UNIQUE NOT NULL,
              size INTEGER NOT NULL, sha256 TEXT NOT NULL, modified INTEGER NOT NULL,
              PRIMARY KEY(tenant,name));
            CREATE TABLE IF NOT EXISTS reservations (
              id TEXT PRIMARY KEY, tenant TEXT NOT NULL, name TEXT NOT NULL, object_id TEXT UNIQUE NOT NULL,
              size INTEGER NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS garbage (
              object_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, size INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS counters (
              scope TEXT PRIMARY KEY, value INTEGER NOT NULL);
            """)
            if db.execute("SELECT 1 FROM counters WHERE scope='pool'").fetchone() is None:
                db.execute("BEGIN IMMEDIATE")
                try:
                    db.execute("INSERT INTO counters VALUES ('pool', ?)", (self._sum(db, None),))
                    for row in db.execute("""SELECT tenant FROM files UNION SELECT tenant FROM reservations
                                               UNION SELECT tenant FROM garbage"""):
                        db.execute("INSERT INTO counters VALUES (?, ?)",
                                   (f"tenant:{row[0]}", self._sum(db, row[0])))
                    db.execute("COMMIT")
                except BaseException:
                    db.execute("ROLLBACK")
                    raise
        for suffix in ("", "-wal", "-shm"):
            try:
                os.chmod(str(self.ledger_path) + suffix, 0o600)
            except FileNotFoundError:
                pass

    @staticmethod
    def _tenant(tenant: str) -> str:
        if not isinstance(tenant, str) or not TENANT.fullmatch(tenant):
            raise InvalidResource("invalid tenant")
        return tenant

    @staticmethod
    def _name(name: str) -> str:
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise InvalidResource("invalid Zotero attachment name")
        return name

    @staticmethod
    def _mkdir_open(parent: int, name: str) -> int:
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent)
        except FileExistsError:
            pass
        fd = os.open(name, DIRECTORY_FLAGS, dir_fd=parent)
        try:
            if not stat.S_ISDIR(os.fstat(fd).st_mode):
                raise StorageCorrupt("invalid Zotero attachment directory")
            os.fchmod(fd, 0o700)
            return fd
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            raise

    @contextmanager
    def _tenant_dirs(self, tenant: str):
        """Hold a tenant's directory descriptors only for one filesystem operation."""
        self._tenant(tenant)
        opened = []
        try:
            try:
                tenant_fd = self._mkdir_open(self._users_fd, tenant)
                opened.append(tenant_fd)
                storage_fd = self._mkdir_open(tenant_fd, "zotero-storage")
                opened.append(storage_fd)
                uploads_fd = self._mkdir_open(storage_fd, "uploads")
                opened.append(uploads_fd)
                objects_fd = self._mkdir_open(storage_fd, "objects")
                opened.append(objects_fd)
            except OSError as error:
                raise StorageCorrupt("cannot open Zotero attachment directories") from error
            yield tenant_fd, uploads_fd, objects_fd
        finally:
            for fd in reversed(opened):
                try:
                    os.close(fd)
                except OSError:
                    pass

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._users_fd is not None:
            try:
                os.close(self._users_fd)
            except OSError:
                pass
            self._users_fd = None
        if self._lock_fd is not None:
            try:
                os.close(self._lock_fd)
            except OSError:
                pass
            self._lock_fd = None

    def _drop_upload_reference(self, tenant: str) -> None:
        with self._dir_lock:
            tenant_slot, users = self._upload_tenants[tenant]
            if users <= 1:
                self._upload_tenants.pop(tenant, None)
            else:
                self._upload_tenants[tenant] = (tenant_slot, users - 1)

    @contextmanager
    def upload_slot(self, tenant: str):
        """Bound admitted streams without queuing unbounded ThreadingHTTPServer readers."""
        tenant = self._tenant(tenant)
        if not self._upload_global.acquire(blocking=False):
            raise UploadBusy("global upload capacity is busy")
        try:
            with self._dir_lock:
                tenant_slot, users = self._upload_tenants.get(
                    tenant, (threading.BoundedSemaphore(4), 0))
                self._upload_tenants[tenant] = (tenant_slot, users + 1)
            try:
                if not tenant_slot.acquire(blocking=False):
                    raise UploadBusy("tenant upload capacity is busy")
                try:
                    yield
                finally:
                    tenant_slot.release()
            finally:
                self._drop_upload_reference(tenant)
        finally:
            self._upload_global.release()

    def issue_credentials(self, tenant: str) -> dict:
        tenant = self._tenant(tenant)
        username = "vyt_" + secrets.token_urlsafe(18)
        password = secrets.token_urlsafe(32)
        salt = secrets.token_bytes(16)
        verifier = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, self.config.pbkdf2_iterations)
        created = int(time.time())
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("DELETE FROM credentials WHERE tenant=?", (tenant,))
                db.execute("INSERT INTO credentials VALUES (?,?,?,?,?,?)",
                           (tenant, username, salt, verifier, self.config.pbkdf2_iterations, created))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        return {"username": username, "password": password, "endpoint": f"{self.config.base}/{username}"}

    def authenticate(self, username: str, password: str) -> str | None:
        if (not isinstance(username, str) or not isinstance(password, str)
                or len(username) > 128 or len(password) > 256):
            return None
        with closing(self._connect()) as db:
            row = db.execute("SELECT tenant,salt,verifier,iterations FROM credentials WHERE username=?",
                             (username,)).fetchone()
        if row is None:
            # Verify something even for unknown names to avoid a large timing signal.
            salt, expected, iterations = b"\0" * 16, b"\0" * 32, self.config.pbkdf2_iterations
        else:
            salt, expected, iterations = row["salt"], row["verifier"], row["iterations"]
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
        if not hmac.compare_digest(candidate, expected) or row is None:
            return None
        # Rotation/revocation may finish while this deliberately expensive hash is running.
        # Authenticate only against the same credential version that was actually verified.
        with closing(self._connect()) as db:
            current = db.execute("SELECT salt,verifier,iterations FROM credentials WHERE username=?",
                                 (username,)).fetchone()
        if (current is None or current["salt"] != salt or current["verifier"] != expected
                or current["iterations"] != iterations):
            return None
        return row["tenant"]

    def revoke_credentials(self, tenant: str) -> bool:
        tenant = self._tenant(tenant)
        with closing(self._connect()) as db:
            return db.execute("DELETE FROM credentials WHERE tenant=?", (tenant,)).rowcount > 0

    @staticmethod
    def _sum(db: sqlite3.Connection, tenant: str | None) -> int:
        total = 0
        for table in ("files", "reservations", "garbage"):
            rows = (db.execute(f"SELECT size FROM {table} WHERE tenant=?", (tenant,)) if tenant is not None
                    else db.execute(f"SELECT size FROM {table}"))
            for row in rows:
                value = row[0]
                if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= SQLITE_MAX - total:
                    raise StorageCorrupt("invalid Zotero attachment usage accounting")
                total += value
        return total

    @staticmethod
    def _counter(db: sqlite3.Connection, scope: str) -> int:
        row = db.execute("SELECT value FROM counters WHERE scope=?", (scope,)).fetchone()
        value = 0 if row is None else row[0]
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= SQLITE_MAX:
            raise StorageCorrupt("invalid Zotero attachment usage counter")
        return value

    @staticmethod
    def _adjust_usage(db: sqlite3.Connection, tenant: str, amount: int) -> None:
        self = StorageService
        if isinstance(amount, bool) or not isinstance(amount, int):
            raise ValueError("usage delta must be an integer")
        for scope in ("pool", f"tenant:{tenant}"):
            value = self._counter(db, scope) + amount
            if not 0 <= value <= SQLITE_MAX:
                raise StorageCorrupt("Zotero attachment usage counter would overflow or become negative")
            db.execute("INSERT INTO counters VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value",
                       (scope, value))

    def _reconcile_usage(self) -> None:
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                tenants = {row[0] for row in db.execute("""SELECT tenant FROM files UNION SELECT tenant FROM reservations
                                                             UNION SELECT tenant FROM garbage""")}
                for scope, tenant in [("pool", None), *((f"tenant:{tenant}", tenant) for tenant in tenants)]:
                    db.execute("INSERT INTO counters VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value",
                               (scope, self._sum(db, tenant)))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

    def pool_used(self) -> int:
        with closing(self._connect()) as db:
            return self._counter(db, "pool")

    def status(self, tenant: str) -> dict:
        tenant = self._tenant(tenant)
        with closing(self._connect()) as db:
            issued = db.execute("SELECT 1 FROM credentials WHERE tenant=?", (tenant,)).fetchone() is not None
            used = self._counter(db, f"tenant:{tenant}")
        return {"enabled": True, "issued": issued, "user_used": used,
                "user_quota": self.config.user_bytes, "pool_quota": self.config.pool_bytes}

    def reserve(self, tenant: str, name: str, size: int) -> Reservation:
        tenant, name = self._tenant(tenant), self._name(name)
        if isinstance(size, bool) or not isinstance(size, int) or not 0 <= size <= SQLITE_MAX:
            raise InvalidResource("invalid attachment length")
        reservation_id, object_id = uuid.uuid4().hex, uuid.uuid4().hex
        with self._tenant_dirs(tenant):
            pass  # fail before creating a durable reservation on an unsafe directory
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                names = db.execute("""SELECT count(*) FROM (
                    SELECT name FROM files WHERE tenant=?
                    UNION SELECT name FROM reservations WHERE tenant=?)""", (tenant, tenant)).fetchone()[0]
                present = db.execute("""SELECT 1 FROM (
                    SELECT name FROM files WHERE tenant=? AND name=?
                    UNION SELECT name FROM reservations WHERE tenant=? AND name=? LIMIT 1)""",
                                     (tenant, name, tenant, name)).fetchone()
                if present is None and names >= MAX_FILES:
                    raise QuotaExceeded("attachment object count")
                usage = self._counter(db, f"tenant:{tenant}")
                if size > self.config.user_bytes - usage:
                    raise QuotaExceeded("user")
                pool = self._counter(db, "pool")
                if size > self.config.pool_bytes - pool:
                    raise QuotaExceeded("pool")
                db.execute("INSERT INTO reservations VALUES (?,?,?,?,?,?,'streaming')",
                           (reservation_id, tenant, name, object_id, size, int(time.time())),)
                self._adjust_usage(db, tenant, size)
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        return Reservation(reservation_id, tenant, name, object_id, size)

    def write_upload(self, reservation: Reservation, stream: BinaryIO) -> str:
        with self._tenant_dirs(reservation.tenant) as (_, uploads_fd, _):
            temporary = reservation.id + ".tmp"
            digest = hashlib.sha256()
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            fd = os.open(temporary, flags, 0o600, dir_fd=uploads_fd)
            try:
                remaining = reservation.size
                while remaining:
                    block = stream.read(min(CHUNK, remaining))
                    if not block:
                        raise ShortBody("attachment body ended before Content-Length")
                    view = memoryview(block)
                    while view:
                        written = os.write(fd, view)
                        if written <= 0:
                            raise OSError("attachment write made no progress")
                        view = view[written:]
                    digest.update(block)
                    remaining -= len(block)
                os.fsync(fd)
            finally:
                os.close(fd)
            return digest.hexdigest()

    @staticmethod
    def _unlink_at(directory: int, name: str) -> None:
        try:
            os.unlink(name, dir_fd=directory)
        except FileNotFoundError:
            pass

    def _publish_rows(self, reservation: Reservation, sha256: str):
        """Commit the complete active version before any old-object unlink."""
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                current = db.execute("SELECT state FROM reservations WHERE id=?", (reservation.id,)).fetchone()
                if current is None or current["state"] == "aborted":
                    raise StorageError("upload reservation is no longer pending")
                db.execute("UPDATE reservations SET state='renamed' WHERE id=?", (reservation.id,))
                old = db.execute("SELECT object_id,size FROM files WHERE tenant=? AND name=?",
                                 (reservation.tenant, reservation.name)).fetchone()
                if old is not None:
                    db.execute("INSERT INTO garbage VALUES (?,?,?)",
                               (old["object_id"], reservation.tenant, old["size"]))
                self._adjust_usage(db, reservation.tenant, -reservation.size)
                # Old active bytes move to garbage with no usage change. The new reservation
                # becomes the new active file; old size is released only by garbage cleanup.
                self._adjust_usage(db, reservation.tenant, reservation.size)
                db.execute("""INSERT INTO files VALUES (?,?,?,?,?,?)
                    ON CONFLICT(tenant,name) DO UPDATE SET
                    object_id=excluded.object_id,size=excluded.size,sha256=excluded.sha256,modified=excluded.modified""",
                           (reservation.tenant, reservation.name, reservation.object_id,
                            reservation.size, sha256, int(time.time())))
                db.execute("DELETE FROM reservations WHERE id=?", (reservation.id,))
                db.execute("COMMIT")
                return old
            except BaseException:
                db.execute("ROLLBACK")
                raise

    def publish(self, reservation: Reservation, sha256: str) -> str:
        if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
            raise ValueError("invalid upload digest")
        with self._tenant_dirs(reservation.tenant) as (_, uploads_fd, objects_fd):
            os.rename(reservation.id + ".tmp", reservation.object_id,
                      src_dir_fd=uploads_fd, dst_dir_fd=objects_fd)
            os.fsync(objects_fd)
        old = self._publish_rows(reservation, sha256)
        # After the visible-version commit, cleanup failure cannot fail the upload.
        if old is not None:
            self._safe_collect((old["object_id"], reservation.tenant))
        return "replaced" if old is not None else "created"

    def abort(self, reservation: Reservation) -> None:
        """Fence publication, durably unlink both locations, then remove the reservation."""
        self._tenant(reservation.tenant)
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                present = db.execute("SELECT 1 FROM reservations WHERE id=? AND state != 'aborted'",
                                     (reservation.id,)).fetchone()
                if present is None:
                    db.execute("COMMIT")
                    return
                db.execute("UPDATE reservations SET state='aborted' WHERE id=?", (reservation.id,))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        with self._tenant_dirs(reservation.tenant) as (_, uploads_fd, objects_fd):
            # The reservation remains if either unlink/fsync fails, for next-start recovery.
            self._unlink_at(uploads_fd, reservation.id + ".tmp")
            os.fsync(uploads_fd)
            self._unlink_at(objects_fd, reservation.object_id)
            os.fsync(objects_fd)
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                removed = db.execute("DELETE FROM reservations WHERE id=? AND state='aborted'",
                                     (reservation.id,)).rowcount
                if removed:
                    self._adjust_usage(db, reservation.tenant, -reservation.size)
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

    def _claim(self, object_id: str) -> bool:
        with self._claim_lock:
            if object_id in self._retiring_ids:
                return False
            self._opening_claims[object_id] = self._opening_claims.get(object_id, 0) + 1
            return True

    def _finish_open(self, tenant: str, object_id: str) -> None:
        collect = False
        with self._claim_lock:
            count = self._opening_claims.get(object_id, 0)
            if count <= 1:
                self._opening_claims.pop(object_id, None)
                collect = object_id in self._retiring_ids
            else:
                self._opening_claims[object_id] = count - 1
        if collect:
            self._safe_collect((object_id, tenant))

    def open_read(self, tenant: str, name: str) -> Attachment:
        tenant, name = self._tenant(tenant), self._name(name)
        for _attempt in range(3):
            with closing(self._connect()) as db:
                row = db.execute("SELECT object_id,size,sha256,modified FROM files WHERE tenant=? AND name=?",
                                 (tenant, name)).fetchone()
            if row is None:
                raise FileNotFoundError(name)
            object_id = row["object_id"]
            if not self._claim(object_id):
                continue
            try:
                with self._tenant_dirs(tenant) as (_, _, objects_fd):
                    fd = os.open(object_id, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=objects_fd)
                details = os.fstat(fd)
                if not stat.S_ISREG(details.st_mode) or details.st_size != row["size"]:
                    os.close(fd)
                    raise StorageCorrupt("active Zotero attachment is missing or inconsistent")
                return Attachment(os.fdopen(fd, "rb"), row["size"], row["sha256"], row["modified"])
            except FileNotFoundError:
                # A committed replacement raced this lookup. Re-read the active row.
                continue
            finally:
                self._finish_open(tenant, object_id)
        raise FileNotFoundError(name)

    def get(self, tenant: str, name: str) -> dict:
        tenant, name = self._tenant(tenant), self._name(name)
        with closing(self._connect()) as db:
            row = db.execute("SELECT name,size,sha256,modified FROM files WHERE tenant=? AND name=?",
                             (tenant, name)).fetchone()
        if row is None:
            raise FileNotFoundError(name)
        return dict(row)

    def list(self, tenant: str) -> list[dict]:
        tenant = self._tenant(tenant)
        with closing(self._connect()) as db:
            return [dict(row) for row in db.execute(
                "SELECT name,size,sha256,modified FROM files WHERE tenant=? ORDER BY name", (tenant,))]

    def delete(self, tenant: str, name: str) -> bool:
        tenant, name = self._tenant(tenant), self._name(name)
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute("SELECT object_id,size FROM files WHERE tenant=? AND name=?", (tenant, name)).fetchone()
                if row is None:
                    db.execute("COMMIT")
                    return False
                db.execute("DELETE FROM files WHERE tenant=? AND name=?", (tenant, name))
                db.execute("INSERT INTO garbage VALUES (?,?,?)", (row["object_id"], tenant, row["size"]))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        self._safe_collect((row["object_id"], tenant))
        return True

    def _remove_garbage_row(self, object_id: str, tenant: str) -> None:
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute("SELECT size FROM garbage WHERE object_id=? AND tenant=?",
                                 (object_id, tenant)).fetchone()
                if row is not None:
                    self._adjust_usage(db, tenant, -row["size"])
                db.execute("DELETE FROM garbage WHERE object_id=? AND tenant=?", (object_id, tenant))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

    def _collect_if_eligible(self, entry: tuple[str, str]) -> bool:
        object_id, tenant = entry
        with self._claim_lock:
            self._retiring_ids.add(object_id)
            if self._opening_claims.get(object_id, 0):
                return False
        try:
            with self._tenant_dirs(tenant) as (_, _, objects_fd):
                self._unlink_at(objects_fd, object_id)
                os.fsync(objects_fd)
            self._remove_garbage_row(object_id, tenant)
        finally:
            with self._claim_lock:
                if not self._opening_claims.get(object_id, 0):
                    self._retiring_ids.discard(object_id)
        return True

    def _safe_collect(self, entry: tuple[str, str]) -> None:
        try:
            self._collect_if_eligible(entry)
        except (OSError, sqlite3.Error, StorageError) as error:
            print(f"Zotero attachment cleanup deferred: {type(error).__name__}", file=sys.stderr, flush=True)

    def _recover(self) -> None:
        with closing(self._connect()) as db:
            active = [dict(row) for row in db.execute("SELECT * FROM files")]
            pending = [dict(row) for row in db.execute("SELECT * FROM reservations")]
            garbage = [dict(row) for row in db.execute("SELECT * FROM garbage")]
        referenced = {row["object_id"] for row in (*active, *pending, *garbage)}
        for row in active:
            with self._tenant_dirs(row["tenant"]) as (_, _, objects_fd):
                try:
                    info = os.stat(row["object_id"], dir_fd=objects_fd, follow_symlinks=False)
                except OSError:
                    raise StorageCorrupt("active Zotero attachment is missing") from None
            if not stat.S_ISREG(info.st_mode) or info.st_size != row["size"]:
                raise StorageCorrupt("active Zotero attachment is inconsistent")
        active_ids = {row["object_id"] for row in active}
        for row in pending:
            if row["object_id"] in active_ids:
                raise StorageCorrupt("upload reservation is both active and pending")
            with self._tenant_dirs(row["tenant"]) as (_, uploads_fd, objects_fd):
                self._unlink_at(uploads_fd, row["id"] + ".tmp")
                os.fsync(uploads_fd)
                self._unlink_at(objects_fd, row["object_id"])
                os.fsync(objects_fd)
            with closing(self._connect()) as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    removed = db.execute("DELETE FROM reservations WHERE id=?", (row["id"],)).rowcount
                    if removed:
                        self._adjust_usage(db, row["tenant"], -row["size"])
                    db.execute("COMMIT")
                except BaseException:
                    db.execute("ROLLBACK")
                    raise
        for row in garbage:
            self._safe_collect((row["object_id"], row["tenant"]))
        tenants = {row["tenant"] for row in (*active, *pending, *garbage)}
        # Rows alone do not cover legacy crash leftovers: find every existing tenant too.
        tenants.update(name for name in os.listdir(self._users_fd) if TENANT.fullmatch(name))
        for tenant in tenants:
            with self._tenant_dirs(tenant) as (_, uploads_fd, objects_fd):
                for name in os.listdir(uploads_fd):
                    if not re.fullmatch(r"[0-9a-f]{32}\.tmp", name):
                        raise StorageCorrupt("unexpected Zotero attachment upload")
                    self._unlink_at(uploads_fd, name)
                os.fsync(uploads_fd)
                for name in os.listdir(objects_fd):
                    if not IDENTIFIER.fullmatch(name):
                        raise StorageCorrupt("unexpected Zotero attachment object")
                    if name not in referenced:
                        self._unlink_at(objects_fd, name)
                os.fsync(objects_fd)
        self._reconcile_usage()
