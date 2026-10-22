# Plan: Reading radar (spec 012)

Date: 2026-10-11. Repos: `~/obsidian-kb` (server, specs) and `~/obsidian-kb/zotero-plugin` (engine `agent-src`,
shared UI `ui-src`). Decisions: spec Status line (approved 2026-10-11).

## 1. Already built (do not rebuild)

- Slice 0, custom schedules: `agent-src/src/schedule.js` (`{days, times}`), migration in `routine-store.read`, the
  When row in `ui-src/src/chat/routines-view.js` / `routines-data.js`. Shipped in 0.45.2.
- Routines: `routines.js` (`validateDraft`, `planSince`, `newRows`), `routine-store.js`, `routine-scheduler.js`
  (60 s tick, slot claimed before the run), `core.js` `executeRoutine` (~1106) with `runWatch` / `runDigest`.
- The `N new` badge: a `routine_run` record with `added` on the session (`sessions.js` `newsOf`).
- `scholarly.js`: 7 sources with `since` (openalex, semanticscholar, arxiv, crossref, europepmc, biorxiv, chemrxiv),
  `abstractsByDoi`. No per-source status, no `date`, no OpenAlex id or `referenced_works`.
- `mcp-hub.js`: tools listed per server; output is text only.
- Papers results and the table artifact (`store.writeResult`, `artifact-table.js`, `artifact-panel.js`).
- Server: `POST /similar` (notes near one text). No embedding or scoring route, no "list library items" route.
- No RSS/Atom parser anywhere. arXiv Atom is parsed with regexes in `scholarly.js` (works in Node and Gecko).

## 2. Data shapes (named before any code)

```js
/** Routine gains `kind` ('watch' | 'digest' | 'radar'; missing = today's behavior) and, for a radar, `radar`. */
/** @typedef {{
 *   scope: Scope,                                   // library | collections | project (existing Scope)
 *   profile: { topics: Weighted[], authors: Followed[], journals: Followed[] },
 *   sources: RadarSource[],
 *   size: { fresh: number, older: number },         // daily default 8 + 1, weekly 15 + 5
 *   note: boolean,                                  // write a vault note per digest (default true)
 * }} RadarConfig
 * @typedef {{ text: string, weight: number, origin: 'seed'|'user'|'learned' }} Weighted
 * @typedef {{ name: string, openalexId: string|null, weight: number, origin: 'seed'|'user'|'learned' }} Followed
 * @typedef {{ id: string, on: boolean } & (
 *     { kind: 'database', db: ScholarlySource }
 *   | { kind: 'feed', url: string, title: string }
 *   | { kind: 'journal', openalexId: string, name: string, issn: string|null }
 *   | { kind: 'author', openalexId: string, name: string }
 *   | { kind: 'mcp', server: string, tool: string })} RadarSource
 */
```

Per-radar state lives **beside** the routine, not in it, because the scheduler rewrites the routine record on every
run (separate before serializing): `<dataDir>/radar/<routineId>/state.json`

```js
/** @typedef {{
 *   seen: Record<PaperId, { at: string, verdict: 'shown'|'added'|'later'|'dismissed' }>,
 *   sourceStatus: Record<sourceId, { at: string, items: number, error: string|null, quietRuns: number }>,
 *   feedCache: Record<url, { etag: string|null, modified: string|null }>,
 *   refs: Record<doi, { at: string, ids: string[] }>,      // OpenAlex referenced_works per library DOI, 30-day TTL
 *   examples: { positive: Example[], negative: Example[] },  // text of papers acted on, for scoring
 * }} RadarState
 * PaperId = 'doi:<lower>' | 'arxiv:<id>' | 'title:<normalised>' (first that exists)
 */
```

One normalised item for every source: `RadarItem = {id, doi, arxiv, openalexId, title, authors, venue, date, year,
abstract, url, links[], sources[]}`. Merging joins on DOI, then arXiv id, then normalised title; a preprint and its
journal version keep both `links`.

Scoring weights live in one table (`radar-score.js` `WEIGHTS`), and every row stores its parts
(`why: {similarity, author, journal, topic, negative}`) so "why is this here" is answerable.

## 3. Server additions (Python, `radar_api.py`, wired into `http_api.py`)

- `GET /zotero/items?collections=K1,K2` returns `[{key, doi, title, year, citekey}]` from `notes.meta` (agent route).
- `POST /radar/score {scope, positives[], negatives[], items:[{id, text}]}` returns `{id: {similarity, negative}}`:
  cosine of each item to the scope centroid (mean of the scope's `zotero/` note vectors, shifted toward positives),
  and the highest cosine to any negative example. Embeds with the existing `Embedder` under `LOCK`. Batches of 64.
- `POST /radar/profile {scope}` returns the seed profile: top terms (title + abstract TF-IDF against the whole
  library), frequent authors, frequent venues. No model call.
- `PUT /digests/<file>` writes `Second Brain/Digests/<file>.md` in the vault (path-guarded, like `/skills`).

The radar needs embeddings, so it runs where the server runs (agentd). Zotero's standalone runtime hides "New radar".

## 4. Units

| Unit | Roadmap slice | Content | Version |
|---|---|---|---|
| R1 | Slice 1 | feeds.js (RSS/Atom, ETag), radar-sources.js (5 kinds, per-source status), merge, seen set, radar-score.js, server `radar_api.py`, `runRadar` in core.js | 0.47.0 |
| R2 | Slice 2 | profile seed route + `radar.profile` API, Radar sheet (Profile lists, Sources, Size, When), starter card | 0.48.0 |
| R3 | Slice 3 | Worth reading: OpenAlex `referenced_works` per library DOI (cached), counts, rank, "Cited by N papers in your library" | 0.49.0 |
| R4 | Slice 4 | Digest view (New / Worth reading tables, summary line), row actions with 5 s undo, learning, vault note | 0.50.0 |
| R5 | Slice 5 | Real runs on the user's library, tune `WEIGHTS`, user rates top 10 | 0.50.x |

Order with spec 013 (see its plan): 013 W0 (security, 0.46.0) and R1 build in parallel; R1 has no UI.

### R1. Sources, merge, seen set, scoring (0.47.0)
- `agent-src/src/feeds.js`: `parseFeed(xml)` for RSS 2.0, RSS 1.0/RDF and Atom with regexes (no DOMParser: Node has
  none), DOI and arXiv id pulled from link, guid and body; `fetchFeed(fetch, url, cache)` sends If-None-Match /
  If-Modified-Since and treats 304 as "nothing new".
- `agent-src/src/radar-sources.js`: one fetcher per `RadarSource.kind`. database = `searchScholarly` per topic with
  `since` and a per-source result; journal = OpenAlex `primary_location.source.id` + `from_publication_date`;
  author = OpenAlex `authorships.author.id` + date; mcp = `hub.call(server, tool, {query})` (new small method) +
  a text-to-papers parser (DOIs, arXiv ids, titles); feed = `fetchFeed`. Each returns `{items, error}`; a failure
  never throws out of the run. Politeness: one request at a time per host, 120 requests per run, OpenAlex `mailto`.
- `scholarly.js`: add `date` (publication_date) and `openalexId`; export a per-source variant used by the radar.
- `agent-src/src/radar.js`: `normalise`, `mergeItems`, `dropKnown(items, libraryItems, seen)`, `pickTop`.
- `agent-src/src/radar-score.js`: `WEIGHTS`, `score(items, server)` (calls `/radar/score`), followed author +0.15,
  watched journal +0.10, topic match +0.05 per topic, negative penalty `-0.3 * max(0, neg - 0.8) / 0.2`, score floor.
- `radar-state.js`: read/write `RadarState` atomically (same pattern as routine-store).
- `core.js`: `routine.kind === 'radar'` goes to `runRadar` in `executeRoutine`; `validateDraft` and `update` carry
  `kind` and `radar`. R1's `runRadar` writes the New papers result and the `routine_run` record (UI in R4).
- Tests: `feeds.test.js` (RSS 2.0, Atom, RDF, CDATA, entities, 304), `radar.test.js` (merge of a preprint and its
  journal version, drop library + seen, quiet day writes nothing), `radar-score.test.js` (weights, why parts,
  10 negatives on a topic push it down: spec check 7), `radar-sources.test.js` (a broken feed sets an error and the
  run finishes: spec check 4), Python `tests/test_radar_api.py` (score order, scope centroid, items route).

### R2. Profile and setup (0.48.0)
- `radar.profile(scope)` (engine) calls `/radar/profile`, then resolves authors and journals to OpenAlex ids
  (`/authors?search=`, `/sources?search=`), keeping the match label for the user to confirm.
- UI `ui-src/src/chat/radar-sheet.js` + `radar-data.js`: a sibling of `RoutineSheet`, opened from a new "Reading
  radar" starter card. Sections: Name, Scope, Profile (Topics / Authors / Journals with remove and add), Sources
  (database checkboxes, "Add a feed or journal" box that takes a URL, a journal name or an ISSN, connected MCP tools,
  each with its status line), Size, When (reuses the When row). "Tidy with AI" behind the ellipsis menu.
- Real check: create a radar from the user's library in real Zotero; screenshot the profile (spec check 1).

### R3. Worth reading (0.49.0)
- `agent-src/src/radar-older.js`: library DOIs in scope, then OpenAlex `filter=doi:a|b|...` (50 per request,
  `select=id,doi,referenced_works`), cached in `state.refs` for 30 days; count references cited by >= 3 scope papers;
  add references shared by this run's New rows; drop library and seen; fetch metadata for the top 20 ids; rank by
  count, then similarity. Each row's `why.citedBy` lists up to 3 citing library titles.
- Test: fixture graph (spec check 6: every row not in the library, counts match the fixture).

### R4. Digest view, actions, learning (0.50.0)
- Digest session: summary line ("14 new from 6 sources, 5 worth reading, chemRxiv failed (timeout)"), two papers
  results titled New and Worth reading, "why read this" lines from one model call over the top rows' abstracts
  (at most 20 lines; rows without an abstract say so).
- Row actions in `artifact-table.js` for radar results only: Add to Zotero (Zotero host; others queue through
  `/zotero/edits`), Read later (Zotero tag "Read later"), Not relevant. Each calls `radar.feedback(routineId,
  paperId, verdict)`; a toast offers undo for 5 s.
- Learning: added/later texts join `examples.positive`, dismissed join `examples.negative`; authors and venues of
  added papers gain +0.05 weight (origin 'learned'), shown in the profile with undo; 3 dismissals in a row from one
  source raise a quiet suggestion on that source line.
- Vault note: `Second Brain/Digests/YYYY-MM-DD <name>.md` with both lists as Markdown tables (`PUT /digests/`).
- Real-Zotero harness `t-radar.js`: create radar with a fake feed + fixture sources, run now, digest opens, badge,
  Not relevant + undo, second run shows no repeats (spec checks 3, 9).

### R5. Real runs and publish (0.50.x)
- Daily radar on the user's library: 6+ sources, under 3 minutes, model calls only for "why" lines (spec check 2).
- The user rates the top 10 New rows of two runs; tune `WEIGHTS` until 7 of 10 are relevant (spec check 5).
  This is the one check that needs the user.

## 5. Verification per unit

Unit tests (`agent-src npm test`, `ui-src npm test`, `pytest tests`), typecheck in agent-src, ui-src and obsidian-plugin
(strict tsc), the real-Zotero harness for every UI unit (fresh profile per test, `SB_SERVER=http://127.0.0.1:9`
for local tests, delete the profile copy after), the Obsidian check over CDP, and the perf gate numbers unchanged.
Publish = bump both manifests, build the xpi, `obsidian-plugin/install.sh` (check its exit code), restart agentd.

## 6. Results

### R1 (2026-10-11; server c528d3d + db72b68 merged 58f9fdd; engine ai/r1-radar cf1e3e1..)
- Live run against the real server and real sources (scratchpad `radar-live.mjs`): arXiv, chemRxiv, the arXiv
  cond-mat.mtrl-sci feed, a broken feed, npj Computational Materials (journal) and Giulia Galli (author), since 7 days:
  4.1 s, 14 requests, 5 of 6 sources answered, the broken feed recorded `fetch failed` and the run finished.
  Top 8 all on topic (ML interatomic potentials for phonons, phonon-limited mobility from first principles, ...).
- Similarity over 162 fresh candidates: min 0.61, p10 0.68, median 0.73, p90 0.79, max 0.86. Floor set to 0.70.
- Feeds checked live: Physical Review B (100 items, DOI + date, ETag gives 304 on the second fetch), Science (36).
  arXiv RSS is empty on weekends (`skipDays`). **Nature redirects feed requests to a cookie sign-in** and **ACS
  answers 403** to non-browser clients: both are reached as journals through OpenAlex instead. R2's "Add a feed"
  box must say so and offer "Add the journal by name".
- Fixed in review: scoring more than 500 candidates failed the run (server cap); now sent in batches of 500
  (test: 1200 items, 3 calls). Server scoring held the search lock for the whole call; now per batch of 64.

### R1b (2026-10-11, ZP e17bd63 + preset commit)
- MCP hub HTTP client does the streamable-HTTP handshake (2025-03-26, Mcp-Session-Id, notifications/initialized,
  re-init on a lost session). Hugging Face (anonymous) connects live; radar preset = hf_fs search + trending (Daily
  Papers by date rejects 2026 dates). Markdown-table parser reads hf_fs output; MCP rows older than `since` dropped.

### R2 (0.47.0; ZP 99e4c68..fef8553 merged b3a4f26, server d74dcf0)
- `radar.profile` / `radar.checkSource` (radar-setup.js), radar-sheet.js + radar-data.js + shared when-row.js.
- Seed topics rewritten on the server as 2-3 word title phrases (singular/plural merged, fragments absorbed): live
  whole-library seed = quantum dots, machine learning, neural networks, electronic structure, density functional
  theory, covalent organic frameworks, ... Real Zotero t-radar-setup 11/11 against the live server.
- Release note: Obsidian's strict tsc rejected untyped params in radar.js after the xpi was built; build.sh now runs
  that check first (87b2a1a).

### R3 (0.46.0; ZP 727e597..e8a87ed)
- worthReading: library DOIs (newest 400) -> OpenAlex referenced_works (cached 30 days) -> cited by >= 3 scope papers
  or >= 2 New rows -> top 20 metadata -> rank. Live: E(3)-equivariant GNNs for interatomic potentials (cited by 51),
  Materials Project (37), Behler-Parrinello NN PES (35), CGCNN (26), GNoME (25); 9 requests, 2.2 s. Hand check 51/51,
  35/35. A run with no New rows stays quiet (no older search either), per the spec wording.

