# Paper browser (Browse) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Browse view in the desktop app's rail that shows real publisher pages (ACS, ChemRxiv) signed in as the user, opens paper links, and saves the page's PDF into the local Zotero library.

**Architecture:** The web app (served by the local server at `/app/`) draws Browse's bar and tabs and asks the Tauri shell, through a short list of commands, to place one native child webview per tab over the content area. Save PDF fetches the PDF inside the page and hands it to the shell under a one-shot token; the shell posts it to the server, which keeps the file and queues an `attach` entry; the Veritas Zotero plugin fetches the file over HTTP and attaches it.

**Tech Stack:** Tauri 2 (Rust, `unstable` feature for `Window::add_child`), WKWebView on macOS; plain JS web app (`web/src`, `ui/src`); Python server (`server/`, pytest); Zotero 7 plugin (`zotero/content`, node:test with a fake Zotero); Playwright harness (`ui/dev/run.mjs`).

**Spec:** `docs/specs/027-paper-browser/spec.md` (APPROVED 2026-11-10). Read it first.

## Global Constraints

- Desktop app only. On the phone and in a web browser there is no Browse item and links behave as now.
- macOS: Browse only on macOS 14 and later (`data_store_identifier`); the app keeps `minimumSystemVersion` 11.0.
- At most 8 tabs; a ninth closes the oldest tab not shown.
- Address field: a URL, or a DOI → `https://doi.org/<doi>`; anything else → "Type a link or a DOI". No web search.
- Save guard: one file per Save press, from that tab's webview, within 2 minutes, at most 200 MB, body starts `%PDF-`.
- Copy, exact: "Save PDF to Zotero", "Saving…", "Saved to Zotero", "Waiting for Zotero", "Already in Zotero",
  "No PDF on this page", "The site sent a page, not the PDF (sign in first?)",
  "Saving PDFs works with a local Zotero library for now", "Sign out of sites", "Publisher PDF" (attachment title).
- Pages shown in Browse get no app command except the guarded PDF hand-over; the web app gets only the `browse_*`
  commands, granted to the local server's origin in the main window.
- Duplicate rule: same file content → not attached again ("Already in Zotero"); a different PDF on the item → the
  publisher's PDF is added as a second attachment titled "Publisher PDF". Content is compared by **MD5**, because that
  is what Zotero stores for an attachment (`item.attachmentHash`); this replaces the spec's "SHA-256", same rule.
- Commits end with the session's attribution lines. Never commit to `main`; work on `dev` or a feature branch.

## Review Focus

1. **Native webview drawn over HTML overlays.** The child webview sits above the web app, so the More menu, dialogs,
   toasts and the collection menu would be hidden under it. Expected: any overlay opening hides the shown webview, and
   closing it shows it again. Pinned in Task 5 (`overlays hide the page`).
2. **Window resize, rail fold, phone width.** Expected: the page always fills exactly the content area under the bar.
   Pinned in Task 5 (`the rect follows the layout`).
3. **Save pressed on a signed-out page.** The PDF address answers an HTML sign-in page. Expected: nothing reaches
   Zotero, and the button says "The site sent a page, not the PDF (sign in first?)". Pinned in Task 3
   (`a body that is not a PDF is refused`) and Task 4.
4. **Save pressed twice, or a page script calling the hand-over itself.** Expected: one file at most per press, and
   nothing without a press. Pinned in Task 3 (`a token is used once`, `no token, no file`).
5. **Zotero not running, or the plugin failing five times.** Expected: "Waiting for Zotero" while queued; after the
   fifth failed try the entry is marked failed and the kept file is removed. Pinned in Task 1
   (`a failed attach removes its file`).

---

### Task 0: Spike on the real app (macOS), and its gate

Throwaway code on a branch `spike/027-browse`; nothing from it is merged. Answers the spec's "Risks" 1-5.

**Files:**
- Create: `docs/specs/027-paper-browser/evidence/T0-spike.md` (kept and committed)
- Throwaway: `app/src-tauri/src/main.rs` (a hard-coded child webview), `app/src-tauri/Cargo.toml` (`unstable`)

- [ ] **Step 1:** On `spike/027-browse`, add `"unstable"` to the `tauri` features and, in `setup`, add a child webview
  to the main window at a fixed rect, `data_store_identifier` set, loading
  `https://pubs.acs.org/doi/10.1021/acsnano.6c11666` (the DOI measured in spec 022).
- [ ] **Step 2:** `cargo tauri dev` from `app/src-tauri`. Record: does the article page load past Cloudflare (no
  challenge loop)? Resize the window: can the child follow `set_bounds`? Hide and show it.
- [ ] **Step 3:** Sign in through the user's institution in the child (the user does this; ask them). Quit, relaunch,
  reload: still signed in? Record it.
- [ ] **Step 4:** `eval` a script that `fetch`es `/doi/pdf/10.1021/acsnano.6c11666` with `credentials: 'include'` and
  sends the first bytes and the length back through an IPC command scoped to that webview. Record: status, whether
  the body starts `%PDF-`, size. If it fails, try the fallback (navigate a hidden child of the same store to the PDF
  address and take it from `on_download` / the navigation handler) and record that.
- [ ] **Step 5:** Open a ChemRxiv Engage link in the child and record whether it loads.
- [ ] **Step 6: Gate.** Write `evidence/T0-spike.md` with each answer and the channel chosen for D3 (IPC or fallback).
  **Stop and report to the user** if the ACS page does not load (Risk 2) or no way gets the PDF (Risk 3). Otherwise
  delete the spike branch and continue.
- [ ] **Step 7: Commit** the evidence file on `dev`: `git commit -m "Spec 027 T0: spike evidence (child webview, ACS, sign-in, PDF fetch)"`.

### Task 1: Server — the `attach` queue entry and its routes

**Files:**
- Modify: `server/pending_adds.py` (new entry kind `attach`; file keeping; failure clean-up)
- Modify: `server/http_api.py` (two routes; the route table in the module docstring)
- Test: `server/tests/test_pending_adds_attach.py`

**Interfaces:**
- Produces: `POST /zotero/attach-pdf?doi=&title=&url=` with the raw PDF as the body (`Content-Type: application/pdf`,
  up to 200 MB, Bearer token) → `200 {"status": "added" | "queued" | "failed", "id"?, "key"?, "message"?}`.
- Produces: `GET /zotero/pending-adds/file?id=<entry id>` → the PDF bytes (404 when gone). Used by the plugin.
- Produces: `pending_adds.attach_pdf(body: bytes, doi: str, title: str, url: str) -> dict` and the queue entry
  `{kind: "attach", doi, title, url, md5, file: "<id>.pdf"}`; files live in `web_app` data folder `/pdf-inbox/`.
- Plugin reply for an attach (Task 2): `{id, ok: true, key, already?: true}`; `already` turns the answer into
  `{"status": "added", "already": true, ...}`.

- [ ] **Step 1: Write the failing tests** (`server/tests/test_pending_adds_attach.py`, the fixtures of
  `test_pending_adds.py`):
  - `test_a_pdf_is_kept_and_queued`: `attach_pdf(b"%PDF-1.7 x", "10.1021/a.b", "T", "https://pubs.acs.org/doi/pdf/10.1021/a.b")`
    with Zotero not running → `status == "queued"`; the queue has one entry `kind == "attach"`,
    `md5 == hashlib.md5(b"%PDF-1.7 x").hexdigest()`; the file exists under `pdf-inbox/`.
  - `test_a_body_that_is_not_a_pdf_is_refused`: `b"<html>sign in"` → `status == "failed"`, message
    `"The site sent a page, not the PDF (sign in first?)"`, nothing queued, no file.
  - `test_an_online_default_library_says_local_only`: with `default_account()` returning an online account →
    `status == "failed"`, message `"Saving PDFs works with a local Zotero library for now"`.
  - `test_done_removes_the_file`: after `done([id])` the file is gone.
  - `test_a_failed_attach_removes_its_file`: five `attempt(id, "x")` → entry `failed`, file gone.
  - `test_the_plugin_reports_already`: `apply_now` patched to return `{id: {"ok": True, "key": "K", "already": True}}`
    → `{"status": "added", "already": True, "key": "K", "id": id}`.
  - `test_routes`: through the HTTP handler as other route tests do: `POST /zotero/attach-pdf` with a 201 MB
    Content-Length → 413; `GET /zotero/pending-adds/file?id=<id>` returns the bytes; unknown id → 404; both need the
    token (401 without).
- [ ] **Step 2:** Run `cd server && .venv/bin/python -m pytest tests/test_pending_adds_attach.py -q`. Expected: FAIL
  (no `attach_pdf`).
- [ ] **Step 3:** Implement `attach_pdf` in `pending_adds.py` (queue through `_queue_entry("attach", ...)`, then
  `apply_now`, then `_outcome`, extended to pass `already`); file removal in `done` and in `attempt` when an entry turns
  `failed`. Add the routes in `http_api.py`: read the body with a 200 MB limit (the existing `_body` caps at 1 MB, so
  a raw-body reader is needed), check `%PDF-` there too.
- [ ] **Step 4:** Run the new tests and `.venv/bin/python -m pytest -q`. Expected: all pass.
- [ ] **Step 5: Commit**: `git commit -m "Server: queue a page's PDF for Zotero (attach entries, spec 027 G3)"`.

### Task 2: Zotero plugin — apply `attach`

**Files:**
- Modify: `zotero/content/pending-adds.js` (`apply` dispatches `attach`; new `attach(entry)`)
- Test: `zotero/test/pending-adds-attach.test.mjs` (the fake-Zotero style of `pending-adds.test.mjs`)

**Interfaces:**
- Consumes: Task 1's entry `{id, kind: "attach", doi, title, url, md5}` and `GET /zotero/pending-adds/file?id=`
  (through `this.sb` the way the class already calls the server).
- Produces: `attach(entry) -> Promise<{key: string, already?: true}>`; `run()` passes `already` into its result row.

- [ ] **Step 1: Write the failing tests:**
  - `an attach on an item without that file adds "Publisher PDF"`: `find` returns an item with no attachments →
    `Zotero.Attachments.importFromFile` called once with `parentItemID` of the item and `title: "Publisher PDF"`; the
    attachment's `url` field is set to `entry.url`; result `{key: <attachment key>}`.
  - `an attach whose file is already there is not added again`: the item has a PDF attachment whose
    `attachmentHash` resolves to `entry.md5` → no import; result `{key: <that attachment key>, already: true}`.
  - `an attach on an item with a different PDF adds a second one`: existing hash differs → one import.
  - `an attach for a paper not in Zotero adds the item first`: `find` returns null → `Discover.add` called with
    `{title, doi}`, then one import under the new item.
  - `the file is fetched from the server and the temp file removed`: the fake `sb` serves bytes for the id; the
    temp file written for the import no longer exists after `attach`.
- [ ] **Step 2:** `node --test zotero/test/pending-adds-attach.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement `attach(entry)` (fetch bytes, write to `Zotero.getTempDirectory()`, import, set `url`,
  `saveTx`, remove the temp file in `finally`).
- [ ] **Step 4:** Run the new test and `node --test zotero/test/`. Expected: all pass. Run `./check.sh` part for the
  Zotero scripts (it parses them as classic scripts).
- [ ] **Step 5: Commit**: `git commit -m "Zotero plugin: attach a page's PDF, once per file (spec 027 G3)"`.

### Task 3: Shell — the pure rules (Rust)

**Files:**
- Create: `app/src-tauri/src/browse/rules.rs`
- Create: `app/src-tauri/src/browse/mod.rs` (only `pub mod rules;` in this task)
- Modify: `app/src-tauri/src/main.rs` (`mod browse;`)

**Interfaces:**
- Produces:
  - `pub fn address_target(text: &str) -> Result<Url, &'static str>`: an http(s) URL as given; a DOI (`10.<4-9
    digits>/<suffix>`, optionally `doi:` or a doi.org URL) → `https://doi.org/<doi>`; else
    `Err("Type a link or a DOI")`.
  - `pub fn pdf_address(page_url: &Url, meta_pdf: Option<&str>, doi: Option<&str>) -> Option<Url>`: `citation_pdf_url`
    when it is http(s), made absolute against the page; else for an ACS page or a 10.1021 DOI
    `https://pubs.acs.org/doi/pdf/<doi>`; else `None`.
  - `pub struct Guard` with `pub fn issue(&mut self, tab: &str, now: Instant) -> String` (random 32-byte hex token) and
    `pub fn accept(&mut self, tab: &str, token: &str, now: Instant, body: &[u8]) -> Result<(), &'static str>`.
  - `pub const MAX_PDF: usize = 200 * 1024 * 1024; pub const TOKEN_TTL: Duration = Duration::from_secs(120);`

- [ ] **Step 1: Write the failing tests** (in `rules.rs`, `#[cfg(test)]`):
  - `address_target`: `"https://pubs.acs.org/doi/10.1021/x"` → same; `"10.1021/acsnano.6c11666"` and
    `"doi:10.1021/acsnano.6c11666"` → `https://doi.org/10.1021/acsnano.6c11666`; `"vole burrows"` and
    `"javascript:alert(1)"` and `"file:///etc/passwd"` → `Err("Type a link or a DOI")`.
  - `pdf_address`: meta `"/doi/pdf/10.1021/x"` on `https://pubs.acs.org/doi/10.1021/x` →
    `https://pubs.acs.org/doi/pdf/10.1021/x`; no meta, DOI `10.1021/x` → the ACS path; no meta, DOI `10.1103/y` →
    `None`; meta `"javascript:..."` → falls through to the DOI rule.
  - `a token is used once`: `issue` then `accept(... b"%PDF-1.7")` → `Ok`; the same token again → `Err`.
  - `no token, no file`: `accept` with a token never issued → `Err`.
  - `a token from another tab is refused`, `a token after two minutes is refused`, `more than 200 MB is refused`.
  - `a body that is not a PDF is refused`: `b"<!doctype html>"` → `Err("The site sent a page, not the PDF (sign in first?)")`.
- [ ] **Step 2:** `cd app/src-tauri && cargo test browse::rules`. Expected: FAIL (not defined).
- [ ] **Step 3:** Implement the three items (the `url` crate is already in the tree through tauri; tokens from
  `getrandom` or `rand` if present in `Cargo.lock`, else add `getrandom`).
- [ ] **Step 4:** `cargo test`. Expected: all pass (the existing `web.rs` tests too).
- [ ] **Step 5: Commit**: `git commit -m "Desktop app: Browse's address, PDF-address and hand-over rules (spec 027)"`.

### Task 4: Shell — tabs as child webviews, the commands and the save

**Files:**
- Modify: `app/src-tauri/src/browse/mod.rs` (state, commands, events)
- Modify: `app/src-tauri/src/main.rs` (manage `browse::Tabs`, register commands)
- Modify: `app/src-tauri/Cargo.toml` (`tauri` features + `"unstable"`)
- Create: `app/src-tauri/capabilities/browse.json`
- Modify: `app/src-tauri/capabilities/default.json` (description only: the web app now has the browse commands)
- Modify: `app/src-tauri/src/server.rs` (expose the data folder's `api-token` path, if not already reachable)

**Interfaces:**
- Consumes: Task 3 rules; Task 1 `POST /zotero/attach-pdf`.
- Produces (commands, all `async`, errors as `String` the web app shows as is):
  `browse_available() -> bool` (false below macOS 14);
  `browse_open(tab: String, text: String) -> Result<(), String>` (creates the tab's webview if new; at most 8, a ninth
  closes the oldest not shown and emits `browse://closed {tab}`);
  `browse_show(tab: String, rect: Rect) -> ()` with `Rect {x, y, width, height}` in CSS pixels of the main webview;
  `browse_hide() -> ()`; `browse_back(tab)`, `browse_forward(tab)`, `browse_reload(tab)`, `browse_close(tab)`;
  `browse_save_pdf(tab: String) -> ()` (result comes as an event); `browse_sign_out() -> ()`.
- Produces (events to the main window): `browse://state {tab, url, title, canGoBack, canGoForward, loading}`,
  `browse://saved {tab, status: "saving" | "added" | "queued" | "already" | "failed", message?}`,
  `browse://new-tab {tab, url}` (a page asked for a new window), `browse://closed {tab}`.
- Hand-over channel: as chosen in T0 (`browse_pdf_bytes(token, data)` scoped by `browse.json` to remote https pages and
  to that command only, the Guard deciding; or the download fallback).

- [ ] **Step 1: Write the failing test** for the one pure piece left here, the eviction order:
  `fn evict(open: &[(String, Instant)], shown: &str) -> Option<String>` → the oldest tab that is not `shown`
  (`#[test] a_ninth_tab_closes_the_oldest_not_shown`).
- [ ] **Step 2:** `cargo test browse`. Expected: FAIL.
- [ ] **Step 3:** Implement the tab state and the commands (`Window::add_child` + `WebviewBuilder` with
  `data_store_identifier` = a fixed 16-byte id for Browse, `on_page_load` / `on_navigation` → `browse://state`,
  `on_new_window` → `browse://new-tab`; `browse_save_pdf` reads `citation_pdf_url` / `citation_doi` by `eval`ing a
  script that calls back through the hand-over with the issued token, then posts the accepted body to
  `POST /zotero/attach-pdf` with `Authorization: Bearer <api-token>` via `reqwest`, mapping the reply to
  `browse://saved`). `browse_sign_out` removes the Browse data store (`WKWebsiteDataStore.remove(forIdentifier:)` via
  Tauri's API if present, else the platform call) and closes all tabs.
- [ ] **Step 4:** `cargo test` passes; `cargo build` from `app/src-tauri` passes; `./check.sh` (its cargo check part)
  passes.
- [ ] **Step 5:** `capabilities/browse.json`: identifier `browse`, `windows: ["main"]`, `remote.urls:
  ["http://127.0.0.1:*/app/*"]`, permissions: only the `browse_*` commands (app-defined permissions via
  `app/src-tauri/permissions/browse.toml`). Check by hand in `cargo tauri dev`: the web app's console can call
  `browse_available`; a page in a Browse tab calling `browse_open` is refused.
- [ ] **Step 6: Commit**: `git commit -m "Desktop app: Browse tabs as child webviews, Save PDF to Zotero (spec 027 G1-G5)"`.

### Task 5: Web app — the Browse view and the desktop bridge

**Files:**
- Create: `web/src/desktop.js` (the bridge: `desktopBridge(win) -> Bridge | null`)
- Create: `web/src/browse-view.js` (the view)
- Create: `web/src/browse-state.js` (pure: tab list, eviction mirror, save-state text)
- Modify: `web/src/shell.js` (rail item `{ view: 'browse', label: 'Browse', icon: 'globe' }` when the bridge says
  available; `TITLES.browse = 'Browse'`; hide the page on overlays)
- Modify: `ui/src/sources/route.js` (`case 'browse': return { view: 'browse' }` and its `formatRoute`)
- Modify: `ui/src/icons.js` (a `globe` icon if none, Lucide's, at the shared 16 px box)
- Modify: `web/src/views.css` (the bar and tabs, in the existing tokens)
- Test: `web/test/browse-state.test.js`

**Interfaces:**
- Consumes: Task 4 commands and events, through `Bridge`.
- Produces: `Bridge = { available: Promise<boolean>, invoke(cmd, args), on(event, fn) -> unsubscribe }` (wrapping
  `window.__TAURI__.core.invoke` and `.event.listen`; `null` when `window.__TAURI__` is absent);
  `createBrowseView(doc, bridge, host) -> { el, open(url: string), show(), hide() }`;
  `saveLabel(state) -> string` in `browse-state.js` mapping `browse://saved` statuses to the Global Constraints copy
  ("saving" → "Saving…", "added" → "Saved to Zotero", "queued" → "Waiting for Zotero", "already" → "Already in
  Zotero", "failed" → the message).

- [ ] **Step 1: Write the failing tests** (`web/test/browse-state.test.js`): `saveLabel` for each status;
  the tab-list reducer: open adds a tab and shows it, a ninth closes the oldest not shown, `browse://closed` removes,
  `browse://state` updates title and the ‹ › states, `browse://new-tab` adds and shows.
- [ ] **Step 2:** `cd web && npm test` (or `node --test test/browse-state.test.js`). Expected: FAIL.
- [ ] **Step 3:** Implement `browse-state.js`, `desktop.js`, `browse-view.js` (bar: tabs with close, **+**, ‹ ›,
  reload, the address field, Reader → `host.openLink(url, { reader: true })` into today's panel, Save; a
  `ResizeObserver` on the page area sends `browse_show(tab, rect)`; `hide()` sends `browse_hide`), and the shell wiring:
  the rail item only when `await bridge.available`; leaving the view calls `hide()`; every overlay the shell opens
  (More menu, `dialogs.js` confirm / prompt / notice, the collection menu) calls `hide()` while open and `show()` after.
- [ ] **Step 4:** Tests pass; `npm run build` in `web/` passes; the ui typecheck in `./check.sh` passes.
- [ ] **Step 5: Commit**: `git commit -m "Web app: the Browse view, its bar and tabs, on the desktop bridge (spec 027 G1)"`.

### Task 6: Paper links open in Browse; Sign out of sites

**Files:**
- Modify: `ui/src/links.js` (`isPaperUrl(url: string) -> boolean`; `planOpen` gains `'browse'`)
- Modify: `web/src/host.js` (`setBrowse(fn)`; `openLink` sends paper URLs to it when set, unless `opts.reader`)
- Modify: `web/src/shell.js` (sets `host.setBrowse` when Browse is available: open a tab and go to `#/browse`)
- Modify: `web/src/pages.js` (Settings: **Sign out of sites** button under the desktop app's section, only with the
  bridge, confirm first, then `browse_sign_out`)
- Test: `ui/test/links.test.js` (existing file if present, else create)

**Interfaces:**
- Consumes: Task 5 `createBrowseView(...).open(url)`, `Bridge`.
- Produces: `planOpen(url, opts, { mode, hasBrowser, hasBrowse }) -> 'scheme' | 'outside' | 'inside' | 'browse'`.

- [ ] **Step 1: Write the failing tests:** `isPaperUrl` true for `https://doi.org/10.1021/x`,
  `https://pubs.acs.org/doi/10.1021/x`, `https://arxiv.org/abs/2608.23130`,
  `https://chemrxiv.org/engage/chemrxiv/article-details/66c9d14420ac769e5fb4ddd1`; false for
  `https://example.org/blog`. `planOpen` → `'browse'` for a paper URL with `hasBrowse`; `'inside'` for a paper URL
  with `opts.reader`; `'outside'` for a ⌘-click (`opts.outside`) whatever else.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests pass; the existing `browser-state.test.js` and harness `SB_ONLY=browser` still pass.
- [ ] **Step 5: Commit**: `git commit -m "Paper links open in Browse in the desktop app; Sign out of sites (spec 027 G2, G4)"`.

### Task 7: Harness checks with a fake bridge

**Files:**
- Create: `ui/dev/browse-checks.mjs` (`runBrowseChecks(browser, origin) -> {failures, count}`)
- Modify: `ui/dev/run.mjs` (suite `browse`, in the summary line)
- Modify: `ui/dev/web-fixtures.mjs` (`fakeDesktop(page)`: injects `window.__TAURI__` with a recording `invoke` and an
  event emitter before the app loads)

**Interfaces:**
- Consumes: the web app at `/app/index.html` (as the other real-host checks), Tasks 5-6.

- [ ] **Step 1: Write the checks** at 1280 and 720 px:
  - without the fake bridge there is no Browse rail item; with it there is;
  - a paper title on Home opens a tab: `browse_open` recorded with its URL, the route is `#/browse`;
  - `the rect follows the layout`: after a viewport resize, the last `browse_show` rect equals the page area's
    bounding box (±1 px);
  - `overlays hide the page`: opening the More menu records `browse_hide`; closing it records `browse_show`;
  - the address field: Enter on `vole burrows` shows "Type a link or a DOI" when the fake `invoke` rejects with it;
  - Save: emitting each `browse://saved` status shows the Global Constraints copy in the button's place;
  - no sideways scroll; logged no errors.
- [ ] **Step 2:** `cd ui && SB_ONLY=browse node dev/run.mjs`. Expected: the checks fail before Tasks 5-6, pass after.
- [ ] **Step 3:** `VERITAS_BROWSER=1 ./check.sh`. Expected: "check.sh: all parts passed".
- [ ] **Step 4: Commit**: `git commit -m "Harness: Browse checks on a fake desktop bridge (spec 027 G6)"`.

### Task 8: Build, install, check by hand

**Files:**
- Create: `docs/specs/027-paper-browser/evidence/T8-manual.md`

- [ ] **Step 1:** Build as in the earlier rebuilds: server sidecar (`packaging/pyinstaller/build.sh` with
  `PYTHON=packaging/pyinstaller/.venv-build/bin/python`), the Zotero plugin xpi (the repo's build), web
  (`cd web && npm run build`), then `cd app/src-tauri && cargo tauri build --bundles app --config
  '{"bundle":{"createUpdaterArtifacts":false}}'`.
- [ ] **Step 2:** Quit Veritas, keep the old app in the scratchpad, install the new one in `~/Applications`, relaunch;
  install the new plugin xpi in Zotero (the user does this; ask them).
- [ ] **Step 3:** With the user: open an ACS paper they have access to from Home; it opens in Browse signed in; Save
  PDF to Zotero → "Saved to Zotero"; the item in Zotero has "Publisher PDF"; Save again → "Already in Zotero"; a
  ChemRxiv Engage link opens; quit and relaunch → still signed in. Record each in `T8-manual.md`.
- [ ] **Step 4: Commit** the evidence and update the spec's status line to IMPLEMENTED with the date.
