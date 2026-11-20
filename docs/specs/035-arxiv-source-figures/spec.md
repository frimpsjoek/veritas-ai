# Spec 035: an arXiv paper's first figure from its source files

Status: APPROVED 2026-11-20 (user: "yes write a spec and start", "go on").

## What happens today

Home shows a paper's first figure (or graphical abstract) next to its words, from the server's figure finder
(`server/paper_figures.py`, `GET /paper-figure`). For an arXiv paper it reads the paper's HTML page
(arxiv.org/html/<id>). Many papers have no HTML page: arXiv answers 404 when the authors' LaTeX was not converted.
Of 6 arXiv papers on Home without a figure (checked 2026-11-20), 4 had no HTML page. Those papers show no picture.

## Goals

- R1. When an arXiv paper's HTML page has no figure (404, or a page without one), the finder reads the paper's
  source files (arxiv.org/e-print/<id>: a gzipped tar of the LaTeX, one gzipped .tex, or the PDF itself) and takes the first figure
  the paper includes: the first `\includegraphics` in the main .tex file (the one with `\documentclass`), following
  `\input`/`\include` in place, with `\graphicspath` and the usual extensions (.png .jpg .jpeg .pdf).
- R2. A PNG or JPEG figure is used as it is; a PDF figure is drawn (its first page) with pypdfium2, already in the app.
  An EPS figure or a missing file is skipped for the next included figure. When the source is a PDF (no LaTeX; seen
  live: 2605.29821), the figure is the first picture embedded in its first 60 pages at least 300 x 200 pixels, cut
  from the drawn page at the picture's place (a figure drawn as vectors in such a PDF is not found).
- R3. The figure is kept on the user's computer as a JPEG at most 1000 px wide (`<data>/web/paper-figures/<id>.jpg`)
  and `/paper-figure` answers it as a `data:image/jpeg;base64,...` address, so Home, Read later and the reader show
  it in the app, Zotero and Obsidian alike without a new route. The JSON cache stores only the file name.
- R4. Polite to arXiv: at most one source download every 3 seconds (one lock across the server), a source larger
  than 40 MB is not read past that limit (no figure), and every answer is cached like today's (a none is asked again
  after a week, a none from an error after an hour).
- R5. Existing behaviour stays: an HTML page with a figure is still used first; journal papers are unchanged.

## Not in scope

- ACS, Elsevier and other publishers that refuse automated requests: no browser imitation (decided earlier).
- EPS or TikZ figures (would need Ghostscript or a TeX install).

## Way of working

Unit tests with a small built tar (main file, an \input, a \graphicspath, PNG and PDF figures, EPS only, a PDF
source), the rate lock tested with a fake clock; then live: the 4 papers without HTML from 2026-11-20
(2605.29821, 2609.09923, 2610.34354, 2611.12018) through the repo server.
