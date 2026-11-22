"""Indexing benchmark (spec 036): how long a knowledge-base build takes and how much memory it needs.

    python bench_index.py embed --data DIR --out WORK [--sample 3000] [--seed 0] [--backend onnx]
    python bench_index.py text  --data DIR --out WORK

The live index is never touched: DIR/kb.sqlite is copied (SQLite backup from a read-only connection) to WORK, and
every run is a child process pointed at the copy (VERITAS_DATA=WORK), so its peak memory is its own.

- embed: the vectors of a fixed random sample of passages (seeded) are deleted from the copy and kb.embed_pending
  makes them again: the real path of stage 2, with the sample's mix of note and paper passages.
- text: stage 1 of a full build (notes, PDFs and images from the media cache, Zotero) with embedding switched off,
  and without refreshing paper notes' References (that writes in the vault).

Prints one JSON line per run: seconds, passages per second (embed), peak resident memory in MB. WORK holds library
text, so it must be outside this repository.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import resource
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def peak_footprint_mb() -> float | None:
    """This process's peak physical footprint (what Activity Monitor shows; on Apple Silicon it counts GPU memory,
    which the resident size misses), macOS only."""
    if sys.platform != "darwin":
        return None
    import ctypes

    class Info(ctypes.Structure):  # struct rusage_info_v4, sys/resource.h
        _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(f"f{i}", ctypes.c_uint64) for i in range(28)] + [
            ("lifetime_max_phys_footprint", ctypes.c_uint64)] + [(f"g{i}", ctypes.c_uint64) for i in range(6)]

    info = Info()
    if ctypes.CDLL("/usr/lib/libproc.dylib").proc_pid_rusage(os.getpid(), 4, ctypes.byref(info)):
        return None
    return round(info.lifetime_max_phys_footprint / 1e6, 1)


def copy_index(data: Path, work: Path) -> Path:
    work.mkdir(parents=True, exist_ok=True)
    target = work / "kb.sqlite"
    for suffix in ("", "-wal", "-shm"):
        (work / f"kb.sqlite{suffix}").unlink(missing_ok=True)
    src = sqlite3.connect(f"file:{data / 'kb.sqlite'}?mode=ro", uri=True)
    dst = sqlite3.connect(target)
    src.backup(dst)
    src.close()
    dst.close()
    for name in ("sources.json", "abstracts.json"):
        if (data / name).exists():
            shutil.copy2(data / name, work / name)
    models = work / "models"
    if not models.exists() and (data / "models").exists():
        models.symlink_to(data / "models")
    return target


def child(code: str, work: Path, backend: str) -> dict:
    env = {**os.environ, "VERITAS_DATA": str(work), "KB_DB": str(work / "kb.sqlite"), "KB_BACKEND": backend}
    before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    started = time.perf_counter()
    out = subprocess.run([sys.executable, "-c", code], cwd=HERE, env=env, capture_output=True, text=True)
    seconds = time.perf_counter() - started
    if out.returncode:
        raise SystemExit(out.stderr[-3000:])
    peak = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    if peak <= before:
        print("warning: peak memory not above an earlier child's; run one benchmark per process", file=sys.stderr)
    scale = 1 if sys.platform == "darwin" else 1024  # ru_maxrss: bytes on macOS, kilobytes on Linux
    result = json.loads(out.stdout.strip().splitlines()[-1])
    return {**result, "wall_seconds": round(seconds, 2), "peak_mb": round(peak * scale / 1e6, 1)}


EMBED = """
import json, resource, time, kb, bench_index
db = kb.connect()
t, r0 = time.perf_counter(), resource.getrusage(resource.RUSAGE_SELF)
n = kb.embed_pending(db, verbose=False)
r1 = resource.getrusage(resource.RUSAGE_SELF)
cpu = r1.ru_utime + r1.ru_stime - r0.ru_utime - r0.ru_stime
print(json.dumps({"embedded": n, "seconds": round(time.perf_counter() - t, 2), "cpu_seconds": round(cpu, 1),
                  "footprint_mb": bench_index.peak_footprint_mb()}))
"""

TEXT = """
import json, time, kb
kb.embed_pending = lambda *a, **k: 0
kb.refresh_paper_references = lambda paths: None  # it writes paper notes in the vault: never from a benchmark
t = time.perf_counter()
r = kb.index(full=True, verbose=False)
import bench_index
print(json.dumps({"notes": r.get("notes"), "seconds": round(time.perf_counter() - t, 2),
                  "footprint_mb": bench_index.peak_footprint_mb()}))
"""


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("mode", choices=["embed", "text"])
    p.add_argument("--data", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--sample", type=int, default=3000)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--backend", default="onnx")
    p.add_argument("--label", default="")
    a = p.parse_args()
    if HERE in a.out.resolve().parents:
        raise SystemExit("--out holds library text: put it outside the repository")
    db_path = copy_index(a.data, a.out)
    if a.mode == "embed":
        db = sqlite3.connect(db_path)
        ids = [r[0] for r in db.execute("SELECT id FROM chunks ORDER BY id")]
        sample = random.Random(a.seed).sample(ids, min(a.sample, len(ids)))
        db.executemany("DELETE FROM vecs WHERE id=?", [(i,) for i in sample])
        db.commit()
        db.close()
        result = child(EMBED, a.out, a.backend)
        result["per_second"] = round(result["embedded"] / max(result["seconds"], 1e-9), 1)
    else:
        result = child(TEXT, a.out, a.backend)
    print(json.dumps({"mode": a.mode, "label": a.label, "sample": a.sample, "seed": a.seed, "backend": a.backend,
                      **result}))


if __name__ == "__main__":
    main()
