"""Durable tenant WebDAV credentials, immutable blobs, and quotas."""
from __future__ import annotations

import hashlib
import io
import os
import signal
import sqlite3
import subprocess
import sys
import threading
from contextlib import ExitStack
from pathlib import Path

import pytest

import zotero_storage

TENANT_A = "a" * 64
TENANT_B = "b" * 64
PUBLIC = "https://veritas.trinityscience.org/webdav"


def make_store(tmp_path, pool=20, user=10, name="storage.sqlite"):
    store = zotero_storage.StorageService(
        tmp_path / "users", tmp_path / name,
        zotero_storage.PublicConfig(PUBLIC, pool_bytes=pool, user_bytes=user, pbkdf2_iterations=100))
    return store


@pytest.fixture
def store(tmp_path):
    service = make_store(tmp_path)
    yield service
    service.close()


def write(store, tenant, name, payload):
    reservation = store.reserve(tenant, name, len(payload))
    digest = store.write_upload(reservation, io.BytesIO(payload))
    outcome = store.publish(reservation, digest)
    return outcome


CRASH_WORKER = r'''
import io, os, signal, sys
from pathlib import Path
sys.path.insert(0, os.getcwd())
import zotero_storage as z
phase = sys.argv[2]
root = Path(sys.argv[1])
def die():
    os.kill(os.getpid(), signal.SIGKILL)
class CrashStore(z.StorageService):
    def _publish_rows(self, reservation, digest):
        if phase == "rename":
            die()
        return super()._publish_rows(reservation, digest)
    def _safe_collect(self, entry):
        if phase in {"published", "delete_committed"}:
            die()
        return super()._safe_collect(entry)
    def _remove_garbage_row(self, object_id, tenant):
        if phase in {"unlinked", "delete_unlinked"}:
            die()
        return super()._remove_garbage_row(object_id, tenant)
store = CrashStore(root / "users", root / "storage.sqlite", z.PublicConfig(
    "https://veritas.trinityscience.org/webdav", pool_bytes=1000, user_bytes=100,
    pbkdf2_iterations=100))
tenant = "a" * 64
if phase == "delete_committed" or phase == "delete_unlinked":
    store.delete(tenant, "PAPER001.prop")
    raise RuntimeError("delete was supposed to crash")
reservation = store.reserve(tenant, "PAPER001.prop", 4)
if phase == "reserve":
    die()
digest = store.write_upload(reservation, io.BytesIO(b"new!"))
if phase == "temp":
    die()
store.publish(reservation, digest)
raise RuntimeError("replacement was supposed to crash")
'''


def test_every_ledger_connection_uses_full_synchronous(store):
    with store._connect() as db:
        assert db.execute("PRAGMA synchronous").fetchone()[0] == 2


def test_usage_counters_track_transitions_and_recovery(store, tmp_path):
    def counters(db):
        return dict(db.execute("SELECT scope,value FROM counters"))

    with sqlite3.connect(store.ledger_path) as db:
        assert counters(db)["pool"] == 0
    reservation = store.reserve(TENANT_A, "PAPER001.prop", 5)
    with sqlite3.connect(store.ledger_path) as db:
        assert counters(db) == {"pool": 5, f"tenant:{TENANT_A}": 5}
    digest = store.write_upload(reservation, io.BytesIO(b"12345"))
    assert store.publish(reservation, digest) == "created"
    write(store, TENANT_A, "PAPER001.prop", b"new")
    write(store, TENANT_B, "OTHER001.prop", b"other")
    with sqlite3.connect(store.ledger_path) as db:
        assert counters(db) == {"pool": 8, f"tenant:{TENANT_A}": 3, f"tenant:{TENANT_B}": 5}
    assert store.delete(TENANT_A, "PAPER001.prop") is True
    with sqlite3.connect(store.ledger_path) as db:
        assert counters(db) == {"pool": 5, f"tenant:{TENANT_A}": 0, f"tenant:{TENANT_B}": 5}
    store.close()
    with sqlite3.connect(tmp_path / "storage.sqlite") as db:
        db.execute("UPDATE counters SET value=999 WHERE scope='pool'")
    recovered = make_store(tmp_path)
    assert recovered.pool_used() == 5
    recovered.close()


def test_reservation_hot_path_never_scans_usage_rows(store, monkeypatch):
    def fail(*_args):
        raise AssertionError("reservation called the full-table usage scan")
    monkeypatch.setattr(store, "_sum", fail)
    reservation = store.reserve(TENANT_A, "PAPER001.prop", 3)
    digest = store.write_upload(reservation, io.BytesIO(b"new"))
    assert store.publish(reservation, digest) == "created"
    assert store.status(TENANT_A)["user_used"] == 3
    assert store.pool_used() == 3


def test_single_attachment_lookup_does_not_call_collection_list(store, monkeypatch):
    write(store, TENANT_A, "PAPER001.prop", b"one")
    write(store, TENANT_A, "OTHER001.prop", b"two")
    monkeypatch.setattr(store, "list", lambda _tenant: pytest.fail("single lookup called full list"))
    row = store.get(TENANT_A, "PAPER001.prop")
    assert row["name"] == "PAPER001.prop" and row["size"] == 3
    assert row["sha256"] == hashlib.sha256(b"one").hexdigest()


def test_failed_abort_cleanup_keeps_reservation_and_recovers_all_tenant_dirs(store, monkeypatch):
    reservation = store.reserve(TENANT_A, "PAPER001.prop", 3)
    store.write_upload(reservation, io.BytesIO(b"new"))
    with store._tenant_dirs(TENANT_A) as (_, uploads_fd, objects_fd):
        os.rename(reservation.id + ".tmp", reservation.object_id,
                  src_dir_fd=uploads_fd, dst_dir_fd=objects_fd)  # crash-shaped renamed/unpublished reservation
    real_unlink = store._unlink_at
    seen = 0

    def fail_after_first(path, name):
        nonlocal seen
        seen += 1
        real_unlink(path, name)
        if seen == 1:
            raise OSError("injected cleanup failure")

    monkeypatch.setattr(store, "_unlink_at", fail_after_first)
    with pytest.raises(OSError):
        store.abort(reservation)
    with sqlite3.connect(store.ledger_path) as db:
        assert db.execute("SELECT count(*) FROM reservations WHERE id=?", (reservation.id,)).fetchone()[0] == 1
    monkeypatch.undo()
    store.close()
    recovered = make_store(store.ledger_path.parent)
    assert recovered.pool_used() == 0
    with recovered._tenant_dirs(TENANT_A) as (_, _, objects_fd):
        assert os.listdir(objects_fd) == []
    recovered.close()


def test_credentials_are_hashed_rotated_revoked_and_tenant_scoped(store):
    issued = store.issue_credentials(TENANT_A)
    raw = issued["password"]
    assert set(issued) == {"username", "password", "endpoint"}
    assert store.authenticate(issued["username"], raw) == TENANT_A
    assert store.authenticate(issued["username"].upper(), raw) is None
    content = store.ledger_path.read_bytes()
    assert raw.encode() not in content and issued["username"].encode() in content
    assert store.ledger_path.stat().st_mode & 0o777 == 0o600
    second = store.issue_credentials(TENANT_A)
    assert second["username"] != issued["username"]
    assert store.authenticate(issued["username"], raw) is None
    other = store.issue_credentials(TENANT_B)
    store.revoke_credentials(TENANT_A)
    assert store.authenticate(second["username"], second["password"]) is None
    assert store.authenticate(other["username"], other["password"]) == TENANT_B


def test_exact_quota_replacement_delete_and_short_body(store):
    assert store.config.pool_bytes == 20 and store.config.user_bytes == 10
    assert write(store, TENANT_A, "PAPER001.prop", b"1234567890") == "created"
    with pytest.raises(zotero_storage.QuotaExceeded):
        store.reserve(TENANT_A, "OTHER001.prop", 1)
    with pytest.raises(zotero_storage.QuotaExceeded):
        store.reserve(TENANT_B, "OTHER001.prop", 11)
    with pytest.raises(zotero_storage.QuotaExceeded):
        store.reserve(TENANT_A, "PAPER001.prop", 1)  # old 10 + new 1 exceeds the user's ten bytes
    assert store.delete(TENANT_A, "PAPER001.prop") is True
    reservation = store.reserve(TENANT_A, "PAPER001.prop", 5)
    with pytest.raises(zotero_storage.ShortBody):
        store.write_upload(reservation, io.BytesIO(b"1234"))
    store.abort(reservation)
    assert store.status(TENANT_A)["user_used"] == 0
    assert write(store, TENANT_A, "PAPER001.prop", b"1234") == "created"
    with store.open_read(TENANT_A, "PAPER001.prop") as attachment:
        assert attachment.read() == b"1234"
    assert write(store, TENANT_A, "PAPER001.prop", b"abcde") == "replaced"  # old 4 + new 5 fits
    assert store.status(TENANT_A)["user_used"] == 5
    assert store.delete(TENANT_A, "PAPER001.prop") is True
    assert store.status(TENANT_A)["user_used"] == 0


def test_two_tenants_share_pool_but_not_files(store):
    write(store, TENANT_A, "PAPER001.prop", b"A" * 10)
    write(store, TENANT_B, "PAPER001.prop", b"B" * 5)
    with store.open_read(TENANT_A, "PAPER001.prop") as attachment:
        assert attachment.read() == b"A" * 10
    with store.open_read(TENANT_B, "PAPER001.prop") as attachment:
        assert attachment.read() == b"B" * 5
    assert store.status(TENANT_A)["user_used"] == 10
    assert store.status(TENANT_B)["user_used"] == 5


def test_concurrent_reservations_cannot_oversubscribe_pool(store):
    started = threading.Barrier(5)
    results = []
    lock = threading.Lock()

    def run(index):
        started.wait()
        try:
            write(store, TENANT_A if index % 2 else TENANT_B, f"PAPER{index:03d}.prop", b"x" * 4)
            outcome = "ok"
        except zotero_storage.QuotaExceeded:
            outcome = "full"
        with lock:
            results.append(outcome)

    threads = [threading.Thread(target=run, args=(index,)) for index in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results.count("ok") <= 5
    assert store.pool_used() <= 20 and store.status(TENANT_A)["user_used"] <= 10
    assert store.status(TENANT_B)["user_used"] <= 10
    with sqlite3.connect(store.ledger_path) as db:
        physical = sum(row[0] for row in db.execute(
            "SELECT size FROM files UNION ALL SELECT size FROM reservations UNION ALL SELECT size FROM garbage"))
    # Counters may be temporarily stale only outside a transaction; at quiescence they must exactly match rows.
    assert store.pool_used() == physical


@pytest.mark.skipif(not Path("/proc/self/fd").is_dir(), reason="descriptor counts require procfs")
def test_tenant_directory_descriptors_are_bounded_across_operations_and_recovery(store, tmp_path):
    def count_fds():
        return len(os.listdir("/proc/self/fd"))

    baseline = count_fds()
    for index in range(8):
        tenant = f"{index + 1:064x}"
        write(store, tenant, "PAPER001.prop", b"x")
    assert count_fds() == baseline
    store.close()
    recovered = make_store(tmp_path)
    assert count_fds() == baseline
    with recovered.open_read(f"{8:064x}", "PAPER001.prop") as attachment:
        assert attachment.read() == b"x"
    assert count_fds() == baseline
    recovered.close()


def test_second_instance_cannot_initialize_or_run_recovery(tmp_path):
    first = make_store(tmp_path)
    try:
        with pytest.raises(zotero_storage.StorageBusy):
            make_store(tmp_path)
    finally:
        first.close()


def test_invalid_resource_and_tenant_are_refused(store):
    for tenant in (None, "", "../../etc", "A" * 64):
        with pytest.raises(ValueError):
            store.status(tenant)
    for name in ("../a.prop", "a/b.prop", ".hidden.prop", "a.txt", "a%2fb.prop",
                 "lastsync", "lastsync.txt", "a prop.prop", "\\x.prop", "a\x00.prop"):
        with pytest.raises(ValueError):
            store.reserve(TENANT_A, name, 1)


def test_abort_after_commit_preserves_the_published_blob(store):
    reservation = store.reserve(TENANT_A, "PAPER001.prop", 4)
    digest = store.write_upload(reservation, io.BytesIO(b"good"))
    assert store.publish(reservation, digest) == "created"
    store.abort(reservation)
    with store.open_read(TENANT_A, "PAPER001.prop") as attachment:
        assert attachment.read() == b"good"


@pytest.mark.parametrize("phase,expected", [
    ("reserve", b"old"), ("temp", b"old"), ("rename", b"old"),
    ("published", b"new!"), ("unlinked", b"new!"),
    ("delete_committed", None), ("delete_unlinked", None),
])
def test_sigkill_at_every_publication_boundary_recovers(tmp_path, phase, expected):
    store = make_store(tmp_path, pool=1_000, user=100)
    write(store, TENANT_A, "PAPER001.prop", b"old")
    store.close()
    done = subprocess.run([sys.executable, "-c", CRASH_WORKER, str(tmp_path), phase],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    assert done.returncode == -signal.SIGKILL, done.stderr.decode()[-1000:]
    recovered = make_store(tmp_path, pool=1_000, user=100)
    try:
        if expected is None:
            with pytest.raises(FileNotFoundError):
                recovered.open_read(TENANT_A, "PAPER001.prop")
        else:
            with recovered.open_read(TENANT_A, "PAPER001.prop") as attachment:
                assert attachment.read() == expected
        with sqlite3.connect(recovered.ledger_path) as db:
            assert db.execute("SELECT count(*) FROM reservations").fetchone()[0] == 0
            assert db.execute("SELECT count(*) FROM garbage").fetchone()[0] == 0
            committed = db.execute("SELECT coalesce(sum(size),0) FROM files").fetchone()[0]
        assert recovered.pool_used() == committed
    finally:
        recovered.close()


def active_object(store):
    with sqlite3.connect(store.ledger_path) as db:
        row = db.execute("SELECT object_id FROM files WHERE tenant=? AND name='PAPER001.prop'",
                         (TENANT_A,)).fetchone()
        assert row is not None
        return row[0]


def test_competing_collector_and_reader_use_the_same_retirement_gate(store, monkeypatch):
    write(store, TENANT_A, "PAPER001.prop", b"old")
    old_id = active_object(store)
    original_claim = store._claim
    original_collect = store._safe_collect
    lookup_done = threading.Event()
    allow_claim = threading.Event()
    publish_committed = threading.Event()
    allow_publisher_cleanup = threading.Event()
    result, errors = {}, []

    def delayed_claim(object_id):
        lookup_done.set()
        assert allow_claim.wait(5)
        return original_claim(object_id)

    def delayed_collect(entry):
        publish_committed.set()
        assert allow_publisher_cleanup.wait(5)
        return original_collect(entry)

    def reader():
        try:
            with store.open_read(TENANT_A, "PAPER001.prop") as attachment:
                result["data"] = attachment.read()
        except BaseException as error:
            errors.append(error)

    def writer():
        try:
            write(store, TENANT_A, "PAPER001.prop", b"new!")
        except BaseException as error:
            errors.append(error)

    monkeypatch.setattr(store, "_claim", delayed_claim)
    monkeypatch.setattr(store, "_safe_collect", delayed_collect)
    read_thread = threading.Thread(target=reader)
    write_thread = threading.Thread(target=writer)
    read_thread.start()
    assert lookup_done.wait(5)  # reader has looked up old data, but has not claimed it for opening
    write_thread.start()
    assert publish_committed.wait(5)  # garbage is committed; publisher has not collected it yet
    original_collect((old_id, TENANT_A))  # a competing collector must use the same retirement gate
    allow_claim.set()
    read_thread.join(5)
    allow_publisher_cleanup.set()
    write_thread.join(5)
    assert not errors and result["data"] == b"new!"
    assert not read_thread.is_alive() and not write_thread.is_alive()


def test_pending_open_defers_garbage_until_the_descriptor_is_safe(store, monkeypatch):
    write(store, TENANT_A, "PAPER001.prop", b"old")
    old_id = active_object(store)
    original_open = zotero_storage.os.open
    before_open = threading.Event()
    allow_open = threading.Event()
    result, errors = {}, []

    def delayed_open(name, *args, **kwargs):
        if name == old_id:
            before_open.set()
            assert allow_open.wait(5)
        return original_open(name, *args, **kwargs)

    def reader():
        try:
            with store.open_read(TENANT_A, "PAPER001.prop") as attachment:
                result["data"] = attachment.read()
        except BaseException as error:
            errors.append(error)

    monkeypatch.setattr(zotero_storage.os, "open", delayed_open)
    thread = threading.Thread(target=reader)
    thread.start()
    assert before_open.wait(5)  # claim acquired; filesystem open has not happened
    assert write(store, TENANT_A, "PAPER001.prop", b"new") == "replaced"
    allow_open.set()
    thread.join(5)
    assert not errors and result["data"] == b"old"
    assert active_object(store) != old_id


def test_post_commit_cleanup_failure_does_not_fail_publication(store, monkeypatch):
    write(store, TENANT_A, "PAPER001.prop", b"old")
    old_id = active_object(store)
    with monkeypatch.context() as patch:
        def fail_unlink(*_args):
            raise OSError("injected cleanup failure")
        patch.setattr(store, "_unlink_at", fail_unlink)
        assert write(store, TENANT_A, "PAPER001.prop", b"new") == "replaced"
        with store.open_read(TENANT_A, "PAPER001.prop") as attachment:
            assert attachment.read() == b"new"
        with sqlite3.connect(store.ledger_path) as db:
            assert db.execute("SELECT count(*) FROM garbage WHERE object_id=?", (old_id,)).fetchone()[0] == 1
            assert db.execute("SELECT size FROM garbage WHERE object_id=?", (old_id,)).fetchone()[0] == 3
    store._safe_collect((old_id, TENANT_A))
    with sqlite3.connect(store.ledger_path) as db:
        assert db.execute("SELECT count(*) FROM garbage").fetchone()[0] == 0


def test_object_count_is_bounded_without_blocking_replacement(store, monkeypatch):
    monkeypatch.setattr(zotero_storage, "MAX_FILES", 2)
    write(store, TENANT_A, "PAPER001.prop", b"")
    write(store, TENANT_A, "PAPER002.prop", b"")
    with pytest.raises(zotero_storage.QuotaExceeded):
        store.reserve(TENANT_A, "PAPER003.prop", 0)
    assert write(store, TENANT_A, "PAPER002.prop", b"new") == "replaced"


@pytest.mark.parametrize("component", ["tenant", "storage", "uploads", "objects"])
def test_symlinked_storage_ancestors_fail_closed(store, tmp_path, component):
    tenant_root = store.users_root / TENANT_A
    outside = tmp_path / "outside"
    outside.mkdir()
    if component == "tenant":
        tenant_root.symlink_to(outside, target_is_directory=True)
    else:
        (tenant_root / "zotero-storage").mkdir(parents=True)
        if component == "storage":
            (tenant_root / "zotero-storage").rmdir()
            (tenant_root / "zotero-storage").symlink_to(outside, target_is_directory=True)
        else:
            (tenant_root / "zotero-storage" / component).symlink_to(outside, target_is_directory=True)
    with pytest.raises(zotero_storage.StorageCorrupt):
        store.reserve(TENANT_A, "PAPER001.prop", 1)
    assert list(outside.iterdir()) == []
    with sqlite3.connect(store.ledger_path) as db:
        assert db.execute("SELECT count(*) FROM reservations").fetchone()[0] == 0


def test_upload_admission_is_bounded_per_tenant_and_globally(store):
    with ExitStack() as stack:
        for _ in range(4):
            stack.enter_context(store.upload_slot(TENANT_A))
        with pytest.raises(zotero_storage.UploadBusy):
            with store.upload_slot(TENANT_A):
                pass
        for _ in range(4):
            stack.enter_context(store.upload_slot(TENANT_B))
        third = "c" * 64
        with pytest.raises(zotero_storage.UploadBusy):
            with store.upload_slot(third):
                pass
