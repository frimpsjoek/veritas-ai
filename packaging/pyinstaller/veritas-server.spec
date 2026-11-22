# PyInstaller spec for the Veritas server as one executable (spec 024 G3), a sidecar of the desktop app (app/).
# Build: packaging/pyinstaller/build.sh  ->  dist/veritas-server[.exe]
import sys
from pathlib import Path

import platform

from PyInstaller.utils.hooks import collect_all, collect_dynamic_libs

SERVER = Path(SPECPATH).resolve().parents[1] / "server"

# Every server module, since several are imported inside functions; server.py (the MCP entry point) is not part of
# the HTTP server and pulls in the whole mcp package.
modules = sorted(p.stem for p in SERVER.glob("*.py") if p.stem not in {"server", "eval"})

# Spec 036: on a Mac with Apple Silicon the app embeds with MLX on the GPU (KB_BACKEND=mlx, server.rs), so mlx and
# its Metal library are bundled there; everywhere else onnxruntime runs a fused copy of the model, made once with
# onnxruntime's transformer optimizer (onnx and sympy). Apple Vision (pyobjc) is not in requirements.txt, so OCR in
# the app matches a source install without it.
APPLE_SILICON = sys.platform == "darwin" and platform.machine() == "arm64"
excludes = ["pytest", "_pytest", "mcp", "tkinter", "Vision", "Quartz", "Foundation"] + ([] if APPLE_SILICON else ["mlx", "mlx_embed"])
modules = [m for m in modules if m not in excludes]
mlx_datas, mlx_binaries, mlx_hidden = collect_all("mlx") if APPLE_SILICON else ([], [], [])

a = Analysis(
    [str(Path(SPECPATH) / "veritas_server.py")],
    pathex=[str(SERVER)],
    binaries=collect_dynamic_libs("onnxruntime") + collect_dynamic_libs("pypdfium2_raw") + mlx_binaries,
    # the sources too, as plain files: kb.py and http_api.py read their own files' mtimes to notice an update
    datas=[(str(p), ".") for p in SERVER.glob("*.py")] + mlx_datas,
    hiddenimports=modules + ["tantivy", "pypdfium2", "pypdfium2_raw", "numpy", "onnxruntime", "tokenizers",
                             "PIL.Image", "markdown", "truststore", "onnx", "onnx.numpy_helper", "sympy",
                             "onnxruntime.transformers.optimizer"] + mlx_hidden,
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name="veritas-server",
    console=True,  # a console program: the app starts it hidden and reads nothing from a window
    upx=False,
    strip=False,
    target_arch=None,
    codesign_identity=None,
)
