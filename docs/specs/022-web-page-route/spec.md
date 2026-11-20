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

## 2026-10-29: arXiv paper view and cleaner reader

The user (2026-10-28): the reader view for web pages, arXiv in particular, "is terrible"; keep the app's look. Seen
on `arxiv.org/abs/2607.25690` (`evidence/arxiv-before.png`): the title twice in two fonts ("Title:" glued on), the
byline "Zhumagulov, Yaroslav, Félisaz, Johan, …" (citation_author is "Last, First"), the whole page body (arXiv's
`<main>` holds every sidebar: breadcrumb, "View PDF", submission history, "Full-text links", browse context,
"Loading…", the arXivLabs toggles, "Disable MathJax"), raw TeX (`F\'elisaz`, `PtSe$_2$`), the abstract as a grey quote.

What changed:

- **arXiv links answer a paper** (`web_page.arxiv_of`, `arxiv_paper`, `_arxiv`). `arxiv.org/abs|pdf|html/<id>`, any
  version, old-style ids (`radar_api.arxiv_id`), and the arXiv DOI `10.48550/arXiv.<id>`: `{mode: reader, source:
  arxiv, title, byline, abstract, math: true, paper: {arxiv, version, submitted, revised, subjects [{code, name,
  primary}], doi, comment}, links: [PDF, Full text]}`. Metadata from the arXiv API (Atom, stdlib XML), subject names
  and the "HTML (experimental)" address from the abstract page, which is also the fallback (citation_* tags,
  dateline); kept a day in `data/web-pages/arxiv/`. TeX accents become letters on the server; `$…$` is left for the
  panel. A `/pdf/` link stays the PDF reader unless the reader is asked for. `/html/<id>` is the LaTeXML article
  under the same header (`<math>` → `$alttext$`, figure captions kept, author block, dates and footer dropped), with
  PDF and Abstract buttons. A DOI's abstract-only answer (OpenAlex) has the same shape (abstract, Publisher's page).
- **The generic reader is cleaner for every site** (`reader()`): text outside any kept block becomes a paragraph, so
  each piece of the page can be weighed; hidden and screen-reader-only text is skipped. Without an `<article>`
  (`<main>` is pruned too): empty and link-heavy blocks, breadcrumb headings, short lines printed twice or more,
  sections that are mostly furniture with little text left, and short blocks matching a few phrases ("Toggle",
  "(What is …?)", "Loading...", "Cite as", "Submission history", cookie banners …) go; a section under a furniture
  heading goes with it. Every page: the block(s) repeating the title near the top go, a site suffix ("| Quanta
  Magazine") leaves the title, glued "Title:/Authors:/Abstract:" labels go, "Abstract" becomes a small label
  (`h2.sbw-reader-label`) over plain text, "Last, First" bylines flip, six names then "et al.".
- **Panel** (`browser-panel.js`, `readerPlan`/`mathParts` in `browser-state.js`): one font family (the note's prose
  font) for title, byline and text; abstract under the small label; subject chips small and muted; PDF / Full text /
  Publisher's page as quiet header buttons (in the panel; "Original page" of a paper opens outside, since the paper
  answer comes back for its own address); KaTeX (the chat's `mathNode`) only for answers marked `math`, so "$5 and
  $10" on an ordinary page stays money.
- **← in the panel** always does something: the page before, or on the first page it closes the panel (focus back
  to the link). The panel keeps its own history, so the desktop app's web view behaves the same.

Evidence (2026-10-29):

- Tests first: `tests/test_web_arxiv.py` (10: id forms, accents, API answer, abstract-page fallback, no HTML version,
  pdf vs reader, LaTeXML full text, unknown id, old-style id, arXiv DOI), `tests/test_web_page.py` +6 (the real abs
  page as a fixture, `fixtures/web_page/arxiv-abs-2607.25690.html`, fetched once: no chrome phrase left, title once,
  byline flipped, abstract label; an `<article>` blog keeps every paragraph; a div page keeps its paragraphs and drops
  link lists and repeated labels; "$5 and $10" not math, MathML is; byline flip; site-suffixed title). Web unit
  tests: `readerPlan` (one font class, abstract label, math only when marked, chips/meta/links), `mathParts`
  (PtSe$_2$, money), `stepBack`. Harness (`dev/browser-checks.mjs`, system Chrome): title once in the same computed
  font family as the text, abstract label with TeX drawn, chips and header buttons, prices not math, ← on the first
  page closes; 81 browser checks pass at 1280/700/360 px.
- Live (scratch server from the worktree, scratch `VERITAS_DATA`): `/web/page?url=https://arxiv.org/abs/2607.25690
  &prefer=reader` → `source: arxiv`, byline "Yaroslav Zhumagulov, Johan Félisaz, Stepan S. Tsirkin, Denis Kochan,
  Oleg V. Yazyev", v2, submitted 28 Jul 2026, revised 25 Oct 2026, three subjects, PDF + Full text
  (`arxiv.org/html/2607.25690v2`); the HTML full text reads with 227 formulas as `$…$` and 3 figure captions; a Quanta
  article keeps its text and loses "Read Later" and the related-story list. Screenshots (gitignored, local):
  `evidence/arxiv-after.png`, `evidence/arxiv-html-after.png`, `evidence/quanta-after.png`.
- Open: in-page anchors of the full text (`#bib.bib7`, `#S1`) reload the page in the panel instead of scrolling (the
  reader drops ids); `Read Later`-like lines that appear once and site-specific promos ("Click to tell Google …")
  stay; the user's own look at the panel.

## 2026-10-29 (later): a closed paper's landing page, the publisher outside, ← from Home

The user, with a screenshot of `doi.org/10.1021/acs.jctc.6c01423` (JCTC, closed) in the panel: header "Abstract only",
title, authors, then the abstract as one plain block starting with a literal "Abstract", then "Only the abstract is
open. Open the publisher's page."; "Back does not work at all"; the publisher link does not work well (ACS, Elsevier
and Wiley answer the panel with a Cloudflare check); the page is bland.

What changed:

- **← from Home works (no code change needed).** The screenshot's build predates `3a41cff` (← on the first page closed
  nothing and was greyed out until then). Reproduced on this branch in the harness for the exact flow: Home's radar
  list → a paper's title (`host.openLink` → `browserHook`, the abstract-only answer) → ← closes the panel, the hash
  stays `#/home`, and nothing opens it again (the "viewed" call and count refresh after the click do not repaint or
  re-open); the same paper again → ← closes again; a second paper opened from the first → ← returns to the first. New
  checks in `ui/dev/browser-checks.mjs`.
- **A closed paper is a landing page** (`web_page._landing`, `crossref`, `jats_html`, `journal_of`, `published_of`,
  `citation_of`). Asked only when there is no library or open-access PDF: OpenAlex (now also `publication_date`,
  `biblio`, `open_access`) and the Crossref record (kept a day in `data/web-pages/crossref/`, like OpenAlex). The answer
  keeps the reader shape and adds `abstract_html` (Crossref's JATS as `<p>` paragraphs, `<h3>` for a structured
  abstract's section titles, lists; `sub`, `sup`, italic and bold kept; every other tag dropped, no attributes; the
  `<jats:title>Abstract</jats:title>` and a leading capitalised "Abstract" word gone, "Abstract reasoning …" kept;
  OpenAlex's words as one paragraph when Crossref has none) and `paper: {doi, journal, published, volume, issue,
  pages, citation}`: journal on one line (Crossref's "Journal of Chemical Theory\nand Computation" collapsed),
  "28 Oct 2026". `abstract` stays plain text, `html` is empty (the client draws the access note).
- **The publisher's page opens outside.** Links carry `kind: "outside"` and point at `https://doi.org/<doi>` (not
  OpenAlex's landing URL); the header button, the DOI line and the access note all call
  `host.openLink(url, {outside: true})` (system browser), with Lucide's external-link line icon. A free copy OpenAlex
  knows (`open_access.oa_url`) is a "PDF" / "Free copy" button that opens in the panel; for this DOI OpenAlex says
  closed, so there is none. The bar's "Original page" is hidden on a landing page (the button and ↗ already go there).
- **Panel** (`readerPlan` `landing`, `abstractHtml`, `doi`, `citation`; `browser-panel.js` `landingFoot`, `figureOf`,
  `copyText`): the same order and font family as the arXiv view: title, authors, a quiet line "Journal · date ·
  volume (issue), pages", buttons (Publisher's page ↗, Copy citation with a quote icon, copies through the clipboard
  with a notice), "Abstract" label over the paragraphs, then a rule, "DOI 10.x/…" and "Only the abstract is open
  here. Read it on the publisher's page ↗". A graphical abstract only when Home's figure finder (`/paper-figure`,
  `paper_figures.py`: the publisher page's preview image only when that page answers, or a figure at a known address)
  has one; the image stays hidden until it loads and goes on an error, so nothing is faked and the page stands
  without one (this DOI has none: ACS answers 403/410).

Evidence (2026-10-29):

- Server tests: `tests/test_web_page.py` (closed paper → `kind: outside` at doi.org, `abstract_html`; the JCTC
  OpenAlex + Crossref answers stored as `fixtures/web_page/jctc-6c01423.json` → journal, date, one paragraph, no
  "jats"/"Abstract", no PDF, the citation, the publisher never asked, both answers cached; without Crossref the
  OpenAlex words lose their "Abstract"; eight JATS cases (sub/sup/italic, structured sections, an `onclick`, "Abstract
  reasoning", MathML text, lists, escaped `<script>`, empty); volume/pages/free PDF; Crossref fallbacks for journal and
  date). 59 passed with `test_web_arxiv.py`.
- Web unit: `readerPlan` landing (meta line, html abstract, DOI, citation, only the publisher outside, arXiv
  unchanged). Harness (`SB_ONLY=browser`, system Chrome): 102 browser checks pass at 1280/700/360 px, including the
  Home → ← flow above and the landing page (journal · date, paragraphs under one label, sub and italic kept, the three
  outside links all `{outside: true}` to doi.org with the panel still open, no PDF, no "Original page", one computed
  font family for title, authors, abstract and footer, the figure only for the fixture that has one, no sideways
  scroll). Screenshots (gitignored): `ui/dev/out/browser-landing-{1280,700,360}.png`.
- Live (this Mac, scratch data folder, real network): `web_page.page("https://doi.org/10.1021/acs.jctc.6c01423")` in
  0.7 s → `source: openalex`, journal "Journal of Chemical Theory and Computation", "28 Oct 2026", three authors, one
  abstract paragraph starting "We develop", links = [Publisher's page (outside)]. That answer drawn in the harness:
  `evidence/jctc-landing-1280-light.png`, `evidence/jctc-landing-1280-dark.png`, `evidence/jctc-landing-390-light.png`.
- Open: the user's own look in the desktop app (rebuilt from this branch); no publisher page is fetched just for its
  og:image (it would add seconds and is refused by ACS/Elsevier/Wiley anyway).
