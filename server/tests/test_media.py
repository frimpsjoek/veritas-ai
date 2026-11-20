"""media.py: which OCR engine reads scans and images on each system (spec 024 G2)."""
from __future__ import annotations

import shutil
import sys
import types

import pytest

import media


@pytest.fixture()
def engine(monkeypatch):
    """Pins the system and what is installed; returns a setter."""
    def pin(system, vision=False, tesseract=None):
        monkeypatch.setattr(media.sys, "platform", system)
        monkeypatch.setattr(media, "_vision_available", lambda: vision)
        monkeypatch.setattr(media.shutil, "which", lambda name: tesseract if name == "tesseract" else None)
        media.ocr_engine.cache_clear()
    yield pin
    media.ocr_engine.cache_clear()


def test_engine_per_system(engine):
    engine("darwin", vision=True, tesseract="/opt/homebrew/bin/tesseract")
    assert media.ocr_engine() == "vision"
    engine("darwin", vision=False, tesseract="/opt/homebrew/bin/tesseract")  # a Python without pyobjc
    assert media.ocr_engine() == "tesseract"
    engine("linux", tesseract="/usr/bin/tesseract")
    assert media.ocr_engine() == "tesseract"
    engine("win32", tesseract=r"C:\Program Files\Tesseract-OCR\tesseract.exe")
    assert media.ocr_engine() == "tesseract"
    engine("linux")
    assert media.ocr_engine() is None


def test_tesseract_reads_the_image_through_stdin(engine, monkeypatch):
    engine("linux", tesseract="/usr/bin/tesseract")
    seen = {}

    def run(args, **kw):
        seen.update(args=args, input=kw.get("input"))
        return types.SimpleNamespace(returncode=0, stdout=b"Hello scan\n", stderr=b"")

    monkeypatch.setattr(media.subprocess, "run", run)
    assert media._ocr_png(b"\x89PNG data") == "Hello scan"
    assert seen == {"args": ["/usr/bin/tesseract", "stdin", "stdout"], "input": b"\x89PNG data"}


def test_without_an_engine_images_read_as_empty_and_scans_are_skipped(engine, tmp_path):
    import pypdfium2 as pdfium

    engine("linux")
    pdf = pdfium.PdfDocument.new()
    pdf.new_page(200, 200)  # a page with no text layer, like a scan
    pdf.save(str(tmp_path / "scan.pdf"))
    pdf.close()
    (tmp_path / "photo.png").write_bytes(b"\x89PNG")
    assert media.pdf_text(tmp_path / "scan.pdf") == ""
    assert media.ocr_image(tmp_path / "photo.png") == ""


@pytest.mark.skipif(not shutil.which("tesseract"), reason="tesseract not installed")
def test_real_tesseract_reads_a_rendered_page(engine, tmp_path):
    from PIL import Image, ImageDraw, ImageFont

    engine(sys.platform if sys.platform != "darwin" else "linux", tesseract=shutil.which("tesseract"))
    image = Image.new("RGB", (900, 160), "white")
    try:
        font = ImageFont.load_default(size=56)
    except TypeError:  # an older Pillow
        font = ImageFont.load_default()
    ImageDraw.Draw(image).text((20, 40), "Perovskite solar cell", fill="black", font=font)
    image.save(tmp_path / "words.png")
    assert "solar" in media.ocr_image(tmp_path / "words.png").lower()


def test_status_says_which_engine(engine, monkeypatch):
    import http_api

    engine("linux", tesseract="/usr/bin/tesseract")
    monkeypatch.setattr(http_api, "_coverage", {"at": 9e18, "rows": [], "stats": {}})
    monkeypatch.setattr(http_api.kb, "index_running", lambda: False)
    assert http_api.index_status()["ocr"] == "tesseract"
