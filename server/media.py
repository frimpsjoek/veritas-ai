"""Text from the vault's PDFs and images, for the index.

PDFs: the text layer via pdfium; a page with no text layer (a scan) is rendered and read with OCR.
Images: OCR with Apple's Vision framework on macOS (on-device, accurate mode, ~0.3 s an image once warm); elsewhere
with Tesseract (the `tesseract` command) when it is installed. With neither, images read as empty and scanned pages
are skipped: only PDFs with a text layer are searchable (spec 024 G2; Settings > On this computer says which).

Results are cached in the index database (media_cache) by path, mtime and size, so a file is read once;
images with no text are cached too and never re-read. Only files with real text (MIN_TEXT characters) become
searchable documents.
"""
from __future__ import annotations

import functools
import io
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".heic", ".gif", ".tif", ".tiff", ".bmp"}
PDF_EXTENSIONS = {".pdf"}
SKIP_DIRS = {".obsidian", ".git", ".trash", ".smart-env", ".copilot", "node_modules"}
MIN_TEXT = 25  # characters; below this an image is a photo or decoration, not something to search

CACHE_SCHEMA = """CREATE TABLE IF NOT EXISTS media_cache (
  path TEXT PRIMARY KEY, mtime REAL, size INTEGER, kind TEXT, text TEXT)"""

_PDFIUM_LOCK = threading.Lock()  # pypdfium2 isn't safe to call from two threads at once


def media_files(vault: Path) -> dict[str, os.stat_result]:
    files = {}
    for root, dirs, names in os.walk(vault):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not (d.startswith(".") and d != ".attachments")]
        for name in names:
            ext = os.path.splitext(name)[1].lower()
            if ext in IMAGE_EXTENSIONS or ext in PDF_EXTENSIONS:
                path = os.path.join(root, name)
                files[os.path.relpath(path, vault)] = os.stat(path)
    return files


def kind_of(rel: str) -> str:
    return "pdf" if os.path.splitext(rel)[1].lower() in PDF_EXTENSIONS else "image"


def _vision_available() -> bool:
    try:
        import Vision  # noqa: F401  (pyobjc-framework-Vision)
        import Quartz  # noqa: F401
    except ImportError:
        return False
    return True


@functools.cache
def ocr_engine() -> str | None:
    """"vision" (macOS with pyobjc), "tesseract" (its command on PATH) or None: no OCR here."""
    if sys.platform == "darwin" and _vision_available():
        return "vision"
    return "tesseract" if shutil.which("tesseract") else None


def _tesseract(source: str, data: bytes | None = None) -> str:
    """Tesseract on a file, or on image bytes through stdin ("stdin"); the text comes back on stdout."""
    out = subprocess.run([shutil.which("tesseract") or "tesseract", source, "stdout"], input=data,
                         capture_output=True, timeout=300)
    return out.stdout.decode("utf-8", errors="replace").strip() if out.returncode == 0 else ""


def _vision_text(cg_image) -> str:
    import Vision

    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(True)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, None)
    handler.performRequests_error_([request], None)
    return "\n".join(o.topCandidates_(1)[0].string() for o in (request.results() or []))


def ocr_image(path: Path) -> str:
    engine = ocr_engine()
    if engine != "vision":
        return _tesseract(str(path)) if engine == "tesseract" else ""
    import Quartz
    from Foundation import NSURL

    source = Quartz.CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(str(path)), None)
    image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None) if source else None
    return _vision_text(image) if image is not None else ""


def _ocr_png(data: bytes) -> str:
    engine = ocr_engine()
    if engine != "vision":
        return _tesseract("stdin", data) if engine == "tesseract" else ""
    import Quartz
    from Foundation import NSData

    source = Quartz.CGImageSourceCreateWithData(NSData.dataWithBytes_length_(data, len(data)), None)
    image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None) if source else None
    return _vision_text(image) if image is not None else ""


def pdf_text(path: Path, max_pages: int = 300, ocr: bool = True) -> str:
    """Markdown with one '## Page N' section per page, so search results can open the PDF at that page. `ocr=False`
    skips pages with no text layer instead of reading them with OCR (arXiv PDFs, spec 021), as does having no OCR engine."""
    import pypdfium2 as pdfium

    ocr = ocr and ocr_engine() is not None

    with _PDFIUM_LOCK:
        pdf = pdfium.PdfDocument(str(path))
        sections = []
        try:
            for number in range(min(len(pdf), max_pages)):
                page = pdf[number]
                text = page.get_textpage().get_text_range().strip()
                if len(text) < 30 and not ocr:
                    continue
                if len(text) < 30:  # no text layer: a scanned page
                    buffer = io.BytesIO()
                    page.render(scale=2).to_pil().save(buffer, format="PNG")
                    text = _ocr_png(buffer.getvalue()).strip()
                if text:
                    sections.append(f"## Page {number + 1}\n\n{text}")
        finally:
            pdf.close()
    return "\n\n".join(sections)


def extract(vault: Path, rel: str) -> str:
    path = vault / rel
    try:
        return pdf_text(path) if kind_of(rel) == "pdf" else ocr_image(path)
    except Exception:  # noqa: BLE001 - an unreadable file is cached as empty, not retried every run
        return ""
