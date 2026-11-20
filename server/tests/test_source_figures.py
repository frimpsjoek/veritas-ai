"""Spec 035: an arXiv paper without an HTML page gets its first figure from its source files."""
import base64
import gzip
import io
import tarfile

from PIL import Image

import paper_figures as pf


def picture(fmt: str, size=(640, 400), colour="red") -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, colour).save(out, fmt)
    return out.getvalue()


def tar_gz(files: dict[str, bytes]) -> bytes:
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return out.getvalue()


MAIN = rb"""\documentclass{article}
\graphicspath{{figs/}{other/}}
\begin{document}
% \includegraphics{commented.png}
\input{sections/intro}
\includegraphics[width=\linewidth]{late}
\end{document}
"""
INTRO = rb"""\section{Intro}
\includegraphics[width=0.5\textwidth]{phonons.eps}
\includegraphics*[scale=0.4, width=\linewidth]{overview}
"""


def test_the_first_included_figure_follows_inputs_graphicspath_and_extensions():
    files = pf.source_files(tar_gz({"main.tex": MAIN, "sections/intro.tex": INTRO, "figs/phonons.eps": b"%!PS",
                                    "figs/overview.pdf": picture("PDF"), "other/late.png": picture("PNG"),
                                    "commented.png": picture("PNG"), "notes.tex": rb"\documentclass{x}\includegraphics{z}"}))
    assert pf.included_graphics(files) == ["figs/phonons.eps", "figs/overview.pdf", "other/late.png"]


def test_an_eps_figure_is_skipped_for_the_next_and_a_pdf_figure_is_drawn(tmp_path, monkeypatch):
    monkeypatch.setattr(pf, "FIGURE_DIR", tmp_path)
    body = tar_gz({"main.tex": MAIN, "sections/intro.tex": INTRO, "figs/phonons.eps": b"%!PS",
                   "figs/overview.pdf": picture("PDF", colour="blue"), "other/late.png": picture("PNG")})
    assert pf.source_figure("2611.00001", fetch=lambda aid: body) == "file:2611.00001.jpg"
    drawn = Image.open(tmp_path / "2611.00001.jpg")
    assert drawn.format == "JPEG" and drawn.width <= pf.FIGURE_WIDTH
    r, g, b = drawn.convert("RGB").getpixel((drawn.width // 2, drawn.height // 2))
    assert b > 200 and r < 60  # the blue PDF figure, not the red PNG after it


def test_a_single_gzipped_tex_and_a_wide_png_are_read(tmp_path, monkeypatch):
    monkeypatch.setattr(pf, "FIGURE_DIR", tmp_path)
    assert pf.source_files(gzip.compress(MAIN)) == {"main.tex": MAIN}
    body = tar_gz({"main.tex": rb"\documentclass{a}\includegraphics{wide.png}", "wide.png": picture("PNG", (2400, 800))})
    assert pf.source_figure("2611.00002", fetch=lambda aid: body)
    assert Image.open(tmp_path / "2611.00002.jpg").size == (1000, 333)


def test_a_pdf_source_gives_its_first_large_picture(tmp_path, monkeypatch):
    monkeypatch.setattr(pf, "FIGURE_DIR", tmp_path)
    pdf = io.BytesIO()
    logo = Image.new("RGB", (40, 40), "black")  # page 1: a picture too small to be a figure
    logo.save(pdf, "PDF", save_all=True, append_images=[Image.new("RGB", (900, 600), "green")])
    assert isinstance(pf.source_files(pdf.getvalue()), bytes)
    assert pf.source_figure("2605.29821", fetch=lambda aid: pdf.getvalue()) == "file:2605.29821.jpg"
    r, g, b = Image.open(tmp_path / "2605.29821.jpg").convert("RGB").getpixel((100, 100))
    assert g > 100 and r < 60


def test_no_drawable_figure_or_too_large_a_source_gives_none(tmp_path, monkeypatch):
    monkeypatch.setattr(pf, "FIGURE_DIR", tmp_path)
    eps_only = tar_gz({"main.tex": rb"\documentclass{a}\includegraphics{a.eps}", "a.eps": b"%!PS"})
    assert pf.source_figure("2611.00003", fetch=lambda aid: eps_only) is None
    assert pf.source_figure("2611.00004", fetch=lambda aid: None) is None  # source_bytes: larger than the limit
    assert not list(tmp_path.iterdir())


def test_source_downloads_are_spaced_three_seconds_apart(monkeypatch):
    now = [100.0]
    slept = []

    class Answer(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(pf.urllib.request, "urlopen", lambda req, timeout: Answer(b"x" * 10))
    monkeypatch.setattr(pf, "_last_source", [0.0])
    clock = lambda: now[0]  # noqa: E731

    def sleep(s):
        slept.append(s)
        now[0] += s

    assert pf.source_bytes("a", clock=clock, sleep=sleep) == b"x" * 10
    now[0] += 1.0
    pf.source_bytes("b", clock=clock, sleep=sleep)
    assert slept == [2.0]
    monkeypatch.setattr(pf, "SOURCE_LIMIT", 5)
    assert pf.source_bytes("c", clock=clock, sleep=sleep) is None


def test_a_kept_figure_is_answered_as_a_data_address_and_a_lost_one_is_found_again(tmp_path, monkeypatch):
    monkeypatch.setattr(pf, "CACHE", tmp_path / "figures.json")
    monkeypatch.setattr(pf, "FIGURE_DIR", tmp_path / "figs")
    monkeypatch.setattr(pf, "_cache", None)
    calls = []

    def find(doi, arxiv, url):
        calls.append(arxiv)
        (tmp_path / "figs").mkdir(exist_ok=True)
        (tmp_path / "figs" / "2611.00005.jpg").write_bytes(b"JPEG")
        return "file:2611.00005.jpg", True

    monkeypatch.setattr(pf, "_find", find)
    want = "data:image/jpeg;base64," + base64.b64encode(b"JPEG").decode()
    assert pf.figure(arxiv="2611.00005", now=0) == want
    assert pf.figure(arxiv="2611.00005", now=60) == want and calls == ["2611.00005"]
    (tmp_path / "figs" / "2611.00005.jpg").unlink()
    assert pf.figure(arxiv="2611.00005", now=120) == want and len(calls) == 2


def test_the_html_figure_comes_first_and_the_source_only_without_it(monkeypatch):
    asked = []
    monkeypatch.setattr(pf, "arxiv_figure", lambda aid: (asked.append("html"), "https://arxiv.org/html/x/f.png")[1])
    monkeypatch.setattr(pf, "source_figure", lambda aid: (asked.append("source"), "file:x.jpg")[1])
    assert pf._find("", "2611.00006", None) == ("https://arxiv.org/html/x/f.png", True) and asked == ["html"]
    monkeypatch.setattr(pf, "arxiv_figure", lambda aid: None)
    assert pf._find("", "2611.00006", None) == ("file:x.jpg", True)
