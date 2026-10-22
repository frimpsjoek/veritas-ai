# Spec: seed-paper radar on arXiv

Status: APPROVED 2026-10-20 (user: "go and keep going"), D1-D4 as recommended (own papers via OpenAlex; full text for candidates past the abstract cut; window since last run, max 7 days; up to 15 a day). Numbered 021 on 2026-10-21 (015 to 017 are taken on the main computer).
Written from the user's requests of 2026-10-20:

- "with the reading server we need to index the whole papers and use the arxiv api to find relevant papers and lets
  have an onboarding that lets users decide which papers to use and then we compare all the new papers against and
  have a threshold"
- "we start from the users original papers to decide which papers to use and also we also connect arxiv api for
  finding the information"
- "also can we get arxiv api as well and also can people also follow and add rss feed but only relevant feeds will be
  added to their daily reads"
- decided: seeds are papers and whole collections (2026-10-20).

Part 3 of the plan "progress, keys, seeds, superuser". Builds on the reading radar (specs 012, 014): its routine,
sources, digest, ratings and onboarding page stay; this adds seeds, arXiv as the main finder, and seed scoring.

## The problems

1. **The radar compares every new paper with one average of the whole library** (`radar_api.score`, centroid of all
   paper vectors, `radar_api.py:105-129`). A library with several lines of work averages them into a point near
   none of them, and the scores bunch up: on 2026-10-11 real matches scored 0.61-0.86 and an unrelated text 0.68,
   against a floor of 0.70 (`radar-score.js:23`).
2. **Nothing says which papers matter most.** The user's own papers are the clearest statement of their research,
   and nothing uses them.
3. **arXiv is searched with five words of one topic phrase** (`scholarly.js:63`, 20 results), so what it finds
   depends on how topics happen to be worded, not on the papers the user cares about.
4. **New papers are judged on their abstract only**; the library side already uses whole papers (`kb.py:915`
   note vectors are the mean of all chunks, Zotero full text included).

## Goals

### G1. Onboarding starts from the user's own papers

- First step of the radar's Sources page (spec 014 G1), before topics: **"Your papers"**.
  - The user gives their name (and, optional, ORCID). OpenAlex finds their author record (`radar-setup.js:49`
    already matches names) and lists their works, newest first; each one found in the Zotero library is marked
    "in your library".
  - The user ticks which ones the radar should start from (all ticked by default). Papers not yet in the library
    can be added to Zotero from here (existing Add to Zotero).
- Second step **"More papers like these"**: pick further seed papers from the library (search and tick) or whole
  Zotero collections (each paper in them is a seed).
- The seed count shows ("14 seed papers"); the radar needs at least 3.
- Stored in the radar routine: `radar.seeds = { mine: [zotero keys], papers: [zotero keys], collections: [keys],
  author: { name, orcid?, openalexId? } }`; `validateRadar` keeps it (`radar.js:208`).

### G2. arXiv finds candidates from the seeds

- Each run asks the arXiv API for new submissions (since the last run, at most 7 days back) with queries built from
  the seeds: the key phrases of each seed's title and abstract (the existing phrase extraction, `radar_api`
  profile), grouped so one query covers several close seeds; plus the arXiv categories the seeds were posted in.
- arXiv's terms are kept: one request every 3 seconds, at most 100 results a query, a per-run budget.
- Other databases and feeds keep working as today; arXiv is the default for a new radar.

### G2b. arXiv as a visible source; RSS feeds filtered the same way

- arXiv shows in the radar's Sources as its own source with an on/off switch and the categories it watches (taken
  from the seeds, editable). The arXiv API needs no key; nothing to set up.
- arXiv category feeds (`https://rss.arxiv.org/rss/<category>`, e.g. `cond-mat.mtrl-sci`) can be followed like any
  feed; the categories of the user's seeds are offered as one-click chips.
- Any RSS or Atom feed can still be followed (spec 014 G1: paste an address). **Every item from every source (arXiv
  API, feeds, journals, databases) goes through the same seed comparison and threshold (G3, G4)**: a feed adds to the
  daily reads only the items close enough to a seed. The Sources page shows, per feed, how many items it gave in the
  last 7 days and how many were kept ("cond-mat.mtrl-sci: 312 seen, 9 kept"), so a feed that never gives anything
  relevant is easy to spot and drop.

### G3. Whole papers on both sides, compared seed by seed

- Seeds: the whole-paper vector the index already has (`note_matrix`, `kb.py:915`).
- Candidates: abstract first; those that pass a lower pre-threshold have their full text read from the arXiv PDF
  (pdfium on the server, as for vault PDFs), embedded as whole papers, and scored again. The text is cached by arXiv
  id; PDFs are not kept.
- Score = the highest similarity to any seed; the closest seed is kept. A candidate below the threshold is dropped.
  Followed authors, journals, topics and dismissed papers adjust it as today (`radar-score.js` weights).
- Each paper in the digest says why: "Close to *<seed title>* (0.84)".

### G4. A threshold that is calibrated, not guessed

- The default threshold is set on the user's own library when the radar is created: seeds against each other
  (should pass), seeds against random recent arXiv papers from other fields (should fail); the threshold sits where
  the two separate, and the numbers are saved with the radar. Shown in the radar's settings ("Keep papers at least
  this close: 0.78") and adjustable (superuser mode, part 4, shows the calibration numbers).

## Success checks

- G1: harness: name → works listed with "in your library" marks, ticking, collections step, seed count, save writes
  `radar.seeds`; unit tests for `validateRadar` with seeds and the OpenAlex author lookup (replayed JSON).
- G2: unit tests for query building from seeds and for arXiv paging and the 3 s spacing (fake clock); a live run
  against arXiv on this Mac.
- G2b: unit tests: feed items scored and dropped below the threshold like any other; per-feed seen/kept counts in the
  radar state; arXiv category chips from the seeds' categories; harness for the arXiv source row and the counts.
- G3: server tests: per-seed max similarity and closest seed on a fixture index; full-text second pass on a fixture
  PDF; cache hit on a second run.
- G4: calibration on the user's real library recorded in this spec (seed-seed and seed-random distributions, the
  chosen threshold); then a live radar run whose top 10 the user rates (target 7 of 10 relevant, as spec 012
  Slice 5).
- Existing radar tests pass; a radar without seeds behaves as before.

## Decisions for the user (recommended first)

- D1. **"Your original papers"** means the papers you wrote, found through OpenAlex by name or ORCID
  (recommended); or the papers in one Zotero collection you name ("My papers").
- D2. **Full text of new arXiv papers**: only for candidates that pass the abstract pre-threshold, about 20-40 a
  day (recommended, polite to arXiv and fast); or every candidate; or abstracts only.
- D3. **Window**: new submissions since the last run, at most 7 days back (recommended); or a fixed 1 day.
- D4. **Digest size**: up to 15 papers a day above the threshold (recommended), or everything above it.

## Non-goals

- Changing the embedding model (part 4).
- Other preprint servers' full text (bioRxiv, chemRxiv keep abstracts only).
- Recommending papers the user wrote (they are seeds, never results).

## Calibration on the real library (2026-10-21, this Mac, dev server)

Seeds: the user's 7 usable papers found through OpenAlex (5 in this Zotero library, 2 by abstract), arXiv category
found: `cond-mat.mtrl-sci`.

- First calibration (far fields only): abstract threshold 0.701 (related p25 0.743, unrelated p95 0.658), whole paper
  0.774 (related p25 0.782, unrelated p95 0.765; 4-5 related, 8 unrelated whole papers). Live run: 15 kept, 13 of
  them closest to one long methods seed ("Generalized Substrate Screening GW"), much of the field let through.
- Change (decision recorded here): calibration also takes 40 of the day's papers from the seeds' own category. Their
  mean similarity to each seed is that seed's baseline (0.56-0.68 abstract, 0.64-0.80 whole), subtracted before the
  closest seed is taken; the threshold is never below the 90th percentile of the field (FIELD_KEEP). Thresholds are
  now margins: abstract +0.067 (seed-seed median +0.111, far fields p95 +0.004), whole paper +0.033. Ranking and the
  why line use the plain similarity; only keep-or-drop uses the margin.
- Second live run: 9 kept, closest seeds spread over three of the user's papers. By eye: electron-phonon coupling,
  ML for MOFs, Janus HfSSe monolayers and a flat-band surface state fit; planetary NH3-H2, stick-slip friction and
  number-theoretic spectra do not (all three matched to the one seed outside the library, a pharma-chemistry paper
  used by its abstract). The user's rating of a run's top 10 (target 7 relevant) decides further tuning.

## Progress

- [x] Server: seed scoring, whole arXiv papers (cached, 3 s apart), calibration with field baselines [obsidian-kb 37e24f3, d2155b8, 9f56bdb; test_radar_api.py 30]
- [x] Sidecar told the server's real port (a server on any port but 27182 gave an AI blind to the library) [4d64ef6]
- [x] Engine: seeds in the config, arXiv RSS listings + phrase search, whole-paper pass, own papers via OpenAlex with namesake choice, calibration, per-source seen/kept [ZP 239f8d9, 1b7ae0b, 0fa3067, e79c86a, fba8ea7; agent-src 790/790]
- [x] Onboarding: Your papers, More papers like these, calibrate on save [ZP a5c0492; ui-src unit 323/323; harness web 381 / weblib 159 / webphone 36]
- [x] Live on real data: own papers found (right namesake), calibration, two radar runs (numbers above)
- [ ] The user rates the top 10 of a run (target 7 of 10 relevant); tuning follows from that
