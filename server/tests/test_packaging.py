"""server/pyproject.toml, the veritas-kb library (spec 035 R7): the wheel holds every module the engine imports, and
(opt-in, VERITAS_WHEEL_TEST=1, needs the network for dependencies) installs into a clean venv that can create,
ingest, search, close and reopen an index outside the checkout."""
from __future__ import annotations

import ast
import os
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

SERVER = Path(__file__).resolve().parent.parent
PROJECT = tomllib.loads((SERVER / "pyproject.toml").read_text())


def _name(requirement: str) -> str:
    return re.sub(r"[-_.]+", "-", re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", requirement).group(1)).lower()


def _module_level_imports(path: Path) -> set[str]:
    """Top-level names imported when the module loads (not inside functions or classes)."""
    names: set[str] = set()

    def visit(nodes):
        for node in nodes:
            if isinstance(node, ast.Import):
                names.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
            elif isinstance(node, (ast.If, ast.Try, ast.With)):
                for field in ("body", "orelse", "finalbody", "handlers"):
                    for child in getattr(node, field, []):
                        visit(child.body if isinstance(child, ast.ExceptHandler) else [child])

    visit(ast.parse(path.read_text(encoding="utf-8")).body)
    return names


def test_py_modules_cover_the_engine():
    modules = PROJECT["tool"]["setuptools"]["py-modules"]
    assert "veritas_kb" in modules and "kb" in modules and "keyword_index" in modules
    for module in modules:
        assert (SERVER / f"{module}.py").exists(), module
        siblings = {name for name in _module_level_imports(SERVER / f"{module}.py") if (SERVER / f"{name}.py").exists()}
        assert siblings <= set(modules), f"{module} imports {sorted(siblings - set(modules))} at load"
    assert "http_api" not in modules and "server" not in modules  # the app runs from a checkout


def test_py_modules_hold_the_files_kb_checks_at_import():
    import kb

    modules = set(PROJECT["tool"]["setuptools"]["py-modules"])
    assert {path.stem for path in kb._CODE} <= modules  # kb stats each at import (code_is_current)


def test_dependencies_and_extras_are_in_requirements():
    pinned = {_name(line) for line in (SERVER / "requirements.txt").read_text().splitlines()
              if line.strip() and not line.startswith("#")}
    project = PROJECT["project"]
    for requirement in project["dependencies"]:
        assert _name(requirement) in pinned, requirement
    for extra, requirements in project["optional-dependencies"].items():
        for requirement in requirements:
            if "sys_platform == 'darwin'" in requirement:
                continue  # MLX: never in requirements.txt (the app bundles exclude it; installed by hand on Macs)
            assert _name(requirement) in pinned, f"[{extra}] {requirement}"
    mlx = project["optional-dependencies"]["mlx"]
    # kb.Embedder falls back to onnxruntime when MLX fails (or off macOS), so [mlx] carries it everywhere (round 2, M2)
    assert "onnxruntime>=1.20" in mlx and "onnxruntime>=1.20" in project["optional-dependencies"]["onnx"]
    assert all("sys_platform == 'darwin'" in r for r in mlx if _name(r) != "onnxruntime")


def test_version_is_the_librarys_own():
    assert PROJECT["project"]["name"] == "veritas-kb" and PROJECT["project"]["version"] == "0.1.0"


ROUND_TRIP = r'''
import sys
from pathlib import Path
import numpy as np, re, zlib
import kb, veritas_kb
from veritas_kb import Document, KnowledgeBase
venv = Path(sys.argv[1]).resolve()
assert venv in Path(kb.__file__).resolve().parents, kb.__file__
assert venv in Path(veritas_kb.__file__).resolve().parents, veritas_kb.__file__

class Hash:
    mlx = None
    def __call__(self, texts, query=False, batch_size=16):
        out = np.zeros((len(texts), kb.DIM), dtype=np.float32)
        for row, text in zip(out, texts):
            for word in re.findall(r"[a-z]+", text.lower()):
                row[zlib.crc32(word.encode()) % kb.DIM] += 1
            row /= max(np.linalg.norm(row), 1e-9)
        return out

db = Path("u/knowledgebase/zotero/index/kb.sqlite")
filler = " Ordinary words about measurements and samples." * 4
docs = [Document(f"zotero/K{i}", t, f"# {t}\n\n{t}.{filler}") for i, t in
        enumerate(["Spin waves in garnets", "Excitons in quantum dots", "Phonons in graphene"])]
with KnowledgeBase(db, embedder=Hash()) as index:
    assert index.apply(add=docs) == {"added": 3, "removed": 0}
    assert index.embed_pending() > 0
    hits = index.search("excitons quantum dots")
    assert hits[0]["path"] == "zotero/K1", hits
    assert index.similar_to_text("Phonons in graphene, measured in samples" + filler)[0]["path"] == "zotero/K2"
with KnowledgeBase(db, embedder=Hash()) as index:
    assert index.search("spin waves")[0]["path"] == "zotero/K0"
    assert index.stats()["chunks_with_vectors"] == index.stats()["chunks"]
print("round trip ok:", kb.__file__)
'''


@pytest.mark.skipif(os.environ.get("VERITAS_WHEEL_TEST") != "1", reason="opt-in: VERITAS_WHEEL_TEST=1 (network)")
def test_wheel_round_trip(tmp_path):
    def run(*cmd, cwd=tmp_path):
        out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=900)
        assert out.returncode == 0, f"{cmd}\n{out.stdout}\n{out.stderr}"
        return out.stdout

    # Built from a copy: an in-tree build would leave build/ and *.egg-info in the checkout.
    source = tmp_path / "src"
    shutil.copytree(SERVER, source, ignore=shutil.ignore_patterns(
        "data", "models", ".venv", "__pycache__", "tests", "build", "*.egg-info"))
    run(sys.executable, "-m", "pip", "wheel", str(source), "--no-deps", "-w", str(tmp_path / "dist"))
    wheel = next((tmp_path / "dist").glob("veritas_kb-0.1.0-*.whl"))
    run(sys.executable, "-m", "venv", str(tmp_path / "venv"))
    python = tmp_path / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    run(str(python), "-m", "pip", "install", "-q", f"{wheel}[onnx]")
    (tmp_path / "work").mkdir()
    (tmp_path / "work" / "round_trip.py").write_text(ROUND_TRIP)
    env_free = {k: v for k, v in os.environ.items() if not k.startswith(("KB_", "VERITAS_", "PYTHON"))}
    out = subprocess.run([str(python), "-I", "round_trip.py", str(tmp_path / "venv")], cwd=tmp_path / "work",
                         capture_output=True, text=True, timeout=300,
                         env={**env_free, "KB_SOURCES": str(tmp_path / "work" / "sources.json"),
                              "KB_ZOTERO": str(tmp_path / "work" / "no-zotero"),
                              "VERITAS_DATA": str(tmp_path / "work" / "veritas-data")})
    assert out.returncode == 0, out.stderr
    assert "round trip ok" in out.stdout
    print(out.stdout)
