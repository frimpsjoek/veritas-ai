# PyInstaller spec for the Veritas server as one executable (spec 024 G3), a sidecar of the desktop app (app/).
# Build: packaging/pyinstaller/build.sh  ->  dist/veritas-server[.exe]
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_dynamic_libs

SERVER = Path(SPECPATH).resolve().parents[1] / "server"

# Every server module, since several are imported inside functions; server.py (the MCP entry point) is not part of
# the HTTP server and pulls in the whole mcp package.
modules = sorted(p.stem for p in SERVER.glob("*.py") if p.stem not in {"server", "eval"})

# The desktop app runs the ONNX backend everywhere (KB_BACKEND=onnx): MLX and the onnx converter stay out. Apple
# Vision (pyobjc) is not in requirements.txt, so OCR in the app matches a source install without it.
excludes = ["mlx", "mlx_embed", "onnx", "pytest", "_pytest", "mcp", "tkinter", "Vision", "Quartz", "Foundation"]
modules = [m for m in modules if m not in excludes]

a = Analysis(
    [str(Path(SPECPATH) / "veritas_server.py")],
    pathex=[str(SERVER)],
    binaries=collect_dynamic_libs("onnxruntime") + collect_dynamic_libs("pypdfium2_raw"),
    # the sources too, as plain files: kb.py and http_api.py read their own files' mtimes to notice an update
    datas=[(str(p), ".") for p in SERVER.glob("*.py")],
    hiddenimports=modules + ["tantivy", "pypdfium2", "pypdfium2_raw", "numpy", "onnxruntime", "tokenizers",
                             "PIL.Image", "markdown", "truststore"],
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
