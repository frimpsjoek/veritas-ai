# Spec: the server half of the in-app browser (GET /web/page, GET /web/pdf)

Status: APPROVED 2026-10-22 (user: "go ahead with all"), D1-D4 as recommended.
Written from the user's request of 2026-10-22, with a screenshot of the web app's link panel on
`doi.org/10.1021/acsnano.6c11666` showing "This page can't open here. Second Brain couldn't reach the page.":

- "lets open [it] we need to be able to open it"
- decided: spec first (2026-10-22).

Builds on the client half of the main computer's spec 015 B3/B4 (zotero-plugin `baf3655`, 2026-10-13: the browser
panel, `ui-src/src/web/browser-panel.js`, `browser-state.js`). Number 022: 015 to 017 are taken on the main
computer, 018 to 021 here.

## The problems

1. **The server has no `/web/page` or `/web/pdf`.** The panel asks `GET /web/page?url=...` (`browser-panel.js:94`)
   and the PDF reader `GET /web/pdf?url=...` (`browser-panel.js:137`). Neither route is in `http_api.py` on any
   branch of this clone (`git log --all -S"/web/page"` finds only specs); the dev server on port 27190 answers 404,
   which the panel shows as its default "couldn't reach the page" (`browser-state.js:49`). Every link fails, not
   only this one. The only implementation is the harness fake (`ui-src/dev/web-fixtures.mjs:113-123`).
2. **Publisher pages cannot be shown even with the route.** Measured 2026-10-22 for this DOI: doi.org redirects to
   `pubs.acs.org/...`, which answers `x-frame-options: SAMEORIGIN` (no iframe) and, to a server fetch, `403` with
   `cf-mitigated: challenge` (Cloudflare bot check, so no reader view). ACS, APS, RSC and Elsevier refuse
   non-browser requests (`paper_figures.py:9`). A paper link is the most common link in the app.
3. **The paper is often free elsewhere.** OpenAlex for this DOI (2026-10-22): `oa_status: green`,
   `best_oa_location.pdf_url = https://arxiv.org/pdf/2301.06171` (submitted version), and an abstract. The user's
   Zotero library may also hold the PDF already (`/zotero/pdf`, `pdf_route.py`).

## Goals

### G1. GET /web/page answers the panel's contract

Answer JSON, one of (the shapes the panel and `web-fixtures.mjs` already use):

- `{mode: "frame", url, title}` — the page allows framing: final URL after redirects is public https, no
  `x-frame-options` (or it allows the app's origin), no CSP `frame-ancestors` that excludes it.
- `{mode: "reader", url, title, byline?, html}` — framing refused (or `prefer=reader`) but the server could read the
  page: main text extracted, scripts, styles, forms and event attributes removed, links made absolute.
- `{mode: "pdf", url, title}` — the URL (after redirects) is a PDF.
- `{mode: "blocked", url, title, reason}` — nothing works; `reason` is a plain sentence saying why ("The publisher
  only answers web browsers (bot protection).", "The site took too long to answer.").

Only public http(s) hosts are fetched, checked again after every redirect (the `site_icons.py` guard: no localhost,
private or link-local addresses). Timeouts and size caps as in `site_icons.py` / `paper_figures.py`.

### G2. Paper links go to a copy the user can read

When the URL is a DOI (`doi.org/10.x/...`, `dx.doi.org`, or a publisher landing page whose DOI is in the URL), before
fetching the publisher, in this order:

1. **In the library**: the DOI matches a Zotero item with a PDF attachment → `{mode: "pdf", url:
   "https://doi.org/<doi>", title, source: "library"}`; the panel asks `/web/pdf` for that URL, which serves the
   library's file. (Corrected 2026-10-22: the panel's PDF reader never saves highlights, `browser-panel.js:141`, so
   highlighting a library copy stays in the library's own reader.)
2. **Open-access copy**: OpenAlex `best_oa_location.pdf_url` (then other OA locations with a `pdf_url`) →
   `{mode: "pdf", url, title, source: "open access", version: "submitted" | "accepted" | "published"}`. The panel
   bar says "Preprint (arXiv)" when the version is not the published one.
3. **Abstract**: no PDF anywhere → `{mode: "reader", title, byline, html: <abstract + "Open the publisher's page"
   link>, source: "openalex"}`.
4. Only then the publisher page itself (G1), which for most publishers ends as `blocked` with the bot-protection
   reason.

OpenAlex answers are cached by DOI for a day (`data/web-pages/`), with the polite-pool `mailto` the server already
sends elsewhere, if any (else none).

### G3. GET /web/pdf streams a PDF for the PDF reader

`GET /web/pdf?url=...`: fetches the URL (same public-host guard), checks the bytes start with `%PDF`, streams them
with `content-type: application/pdf`; `415 {"error": "This link is not a PDF"}` otherwise (the fixture's answer).
Supports `Range` like `/zotero/pdf` so PDF.js can load pages lazily, or the whole file under a cap (D3). Not stored.

### G4. The panel shows where the copy came from (client, small)

`browser-panel.js` `head()` shows `source` / `version` when present: "Your library", "Open access · preprint (arXiv)".
No other client change: the four modes already work in the harness.

## Success checks

- G1: `tests/test_web_page.py` with a local fake HTTP server: frame-allowed page → `frame`; `x-frame-options: DENY`
  → `reader` with scripts and `on*` attributes gone and links absolute; `prefer=reader` → `reader`; a PDF →
  `pdf`; 403 challenge → `blocked` with the bot-protection reason; timeout → `blocked`; a redirect to
  `127.0.0.1` or `10.x` → refused. Route wiring and auth in `test_http_security.py` (401 without token).
- G2: replayed OpenAlex JSON fixtures: DOI in library → library PDF first; green OA → arXiv PDF with
  `version: "submitted"`; closed with abstract → reader with abstract and publisher link; DOI recognised in
  `doi.org`, `dx.doi.org` and `pubs.acs.org/doi/10...` forms.
- G3: `%PDF` bytes streamed, non-PDF → 415, Range → 206 with the right bytes.
- G4: one harness check in `ui-src/dev/browser-checks.mjs` for the source line; existing 60 browser checks pass.
- Live, this Mac, dev server 27190: `doi.org/10.1021/acsnano.6c11666` opens the arXiv PDF 2301.06171 in the panel
  (screenshot recorded here); an arXiv abs page frames or reads; a Wikipedia article frames.
- Existing server tests pass (`KB_BACKEND=onnx .venv/bin/python -m pytest tests`).

## Decisions for the user (recommended first)

- D1. **Where to build**: here, now, on a branch `ai/web-page` off `ai/radar-seeds`, and merge with the main
  computer's version later if it has one (recommended: unblocks this Mac today); or wait for the main computer's
  obsidian-kb push and add only G2 on top.
- D2. **Order for a paper**: library PDF, then open-access PDF, then abstract, then publisher (recommended); or
  publisher first and fall back only when blocked (slower, and almost always blocked for ACS/APS/RSC/Elsevier).
- D3. **Reader text without new dependencies**: a stdlib extractor (`html.parser`: largest `<article>` / `<main>` /
  densest `<p>` block, an allow-list of tags) (recommended, matches the stdlib-only server); or add `trafilatura`
  (better extraction, ~10 MB of dependencies).
- D4. **Preprints**: open the OA copy straight away with the "Preprint" label (recommended); or show a card first
  ("Free preprint on arXiv — open it?").

## Non-goals

- Getting past publisher bot protection (no headless browser, no cookies, no proxies). The "Open in your browser"
  button stays for that, and the user's institutional sign-in happens there.
- Saving web pages or OA PDFs into Zotero (the existing Add to Zotero does that).
- Highlights on non-library PDFs (the panel already says to add the paper first).

## Progress

- [x] D1-D4 decided, spec approved [a604bf1]
- [x] G1 `/web/page` (frame / reader / pdf / blocked), public-host guard, tests [web_page.py; tests/test_web_page.py 31]
- [x] G2 DOI → library → OpenAlex OA → abstract, cache, tests (Zotero SQL tested on a schema copy)
- [x] G3 `/web/pdf` with Range, tests; route auth in tests/test_http_security.py
- [x] G4 source line in the panel [ZP ai/web-page: `sourceOf` in browser-state.js, unit 329/329; harness 1619 pass,
      new DOI check passes at 1280/700/360 px; 4 failures (3 weblib rail/More, 1 panels Add) fail the same on the
      base branch without this change, run with SB_BROWSER=system Chrome]
- [x] Full server suite: `KB_BACKEND=onnx .venv/bin/python -m pytest tests` 274 passed before the auth test, then
      test_http_security + test_web_page 60 passed (2026-10-22)
- [x] Live, dev server 27190 (2026-10-22): `doi.org/10.1021/acsnano.6c11666` → `{mode: pdf, url:
      arxiv.org/pdf/2301.06171, source: open access, version: submitted}`; `/web/pdf` 200 application/pdf 6.1 MB,
      Range 0-1023 → 206; `arxiv.org/abs/2301.06171` → reader (arXiv refuses frames); Wikipedia → frame
- [ ] The user opens the DOI in the web app's panel and confirms (no screenshot taken by the agent)
